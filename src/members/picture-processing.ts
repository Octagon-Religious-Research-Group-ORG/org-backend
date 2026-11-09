import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import sharp from 'sharp';
import { type ProcessedImage, processImage } from '../import/pages/image';

/** Largest upload accepted; phone photos fit, and it is rationed per account. */
export const MAX_PICTURE_BYTES = 10 * 1024 * 1024;

/**
 * Most pixels a picture may have, read from its header before anything is
 * decoded. A few hundred kilobytes of PNG can claim a hundred megapixels and
 * take far more memory than the host has. JPEG has its own cap below.
 */
export const MAX_PICTURE_PIXELS = 36_000_000;

/**
 * JPEG cap. A JPEG is read at 1/4 or 1/8 scale here, so a 108 MP phone photo
 * needs about 90 MB (measured), far less than a 36 MP PNG (about 260 MB).
 */
export const MAX_JPEG_PICTURE_PIXELS = 110_000_000;

/**
 * Most memory a decoded picture may take: the cap in 8-bit colour with
 * transparency. A 16-bit PNG needs twice that per pixel (measured: 422 MB at
 * 36 MP against 201 MB for 8-bit), so it is refused at half the pixels.
 */
export const MAX_DECODED_BYTES = MAX_PICTURE_PIXELS * 4;

/**
 * Most seconds one picture may spend being decoded and converted. A picture at
 * the cap takes about a second, so this only stops one that has stuck, which
 * would otherwise hold the only slot for good.
 */
export const PICTURE_DECODE_TIMEOUT_SECONDS = 30;

/** Pictures allowed to wait for their turn; a third is told to try again. */
export const MAX_WAITING_PICTURES = 2;

const PICTURE_FORMATS: ReadonlySet<string> = new Set([
  'jpeg',
  'png',
  'webp',
  'gif',
]);

const NOT_A_PICTURE =
  'That file is not a picture we can read. Please use a JPEG, PNG, WebP or GIF.';
const TOO_MANY_PIXELS = `That picture is too large to process. Please use a JPEG of at most ${MAX_JPEG_PICTURE_PIXELS / 1_000_000} megapixels, or another picture of at most ${MAX_PICTURE_PIXELS / 1_000_000} megapixels.`;
const PROGRESSIVE_TOO_LARGE =
  'That JPEG is saved in progressive form, which is too large to process at this size. Please save it as a standard JPEG, or use a smaller picture.';
const TOOK_TOO_LONG =
  'That picture took too long to process. Please try a smaller one.';
const BUSY =
  'We are processing other pictures right now. Please try again in a moment.';

// This module is loaded by the server only, never by the import CLI: memory
// matters more here than speed, and a picture does not need a libvips cache.
sharp.cache(false);
sharp.concurrency(1);

/**
 * Runs one task at a time and lets a short queue wait, so concurrent uploads
 * cannot decode side by side. Anyone past the queue is refused rather than
 * held, because each waiting upload is already in memory.
 */
export class SerialGate {
  private running = false;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly maxWaiting: number) {}

  /** @throws ServiceUnavailableException when the queue is full */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.enter();
    try {
      return await task();
    } finally {
      this.leave();
    }
  }

  private enter(): Promise<void> {
    if (!this.running) {
      this.running = true;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.maxWaiting) {
      throw new ServiceUnavailableException(BUSY);
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private leave() {
    const next = this.waiting.shift();
    if (next) next();
    else this.running = false;
  }
}

const gate = new SerialGate(MAX_WAITING_PICTURES);

/** Stored colour samples per pixel of a JPEG; an unknown layout counts as the most. */
const JPEG_SAMPLES_PER_PIXEL: Readonly<Record<string, number>> = {
  '4:2:0': 1.5,
  '4:1:1': 1.5,
  '4:2:2': 2,
  '4:4:0': 2,
  '4:4:4': 3,
  '4:4:4:4': 4,
};

/**
 * A progressive JPEG cannot be shrunk while it is read: every coefficient (two
 * bytes per sample) is held until the last scan. Measured at 48 MP: 231 MB for
 * 4:2:0, 366 MB for 4:4:4; at 108 MP, 404 MB for 4:2:0.
 */
function progressiveJpegBytes(header: sharp.Metadata) {
  const samples =
    JPEG_SAMPLES_PER_PIXEL[header.chromaSubsampling ?? ''] ??
    JPEG_SAMPLES_PER_PIXEL['4:4:4:4'];
  return header.width * header.height * samples * 2;
}

function decodedBytes(header: sharp.Metadata) {
  const bytesPerSample = header.depth === 'uchar' ? 1 : 2;
  return header.width * header.height * header.channels * bytesPerSample;
}

/** Checks the header, then decodes: nothing is decoded from a refused file. */
async function convert(input: Buffer): Promise<ProcessedImage> {
  let header: sharp.Metadata;
  try {
    header = await sharp(input, { limitInputPixels: false }).metadata();
  } catch {
    throw new BadRequestException(NOT_A_PICTURE);
  }
  if (!PICTURE_FORMATS.has(header.format)) {
    throw new BadRequestException(NOT_A_PICTURE);
  }
  const isJpeg = header.format === 'jpeg';
  const maxPixels = isJpeg ? MAX_JPEG_PICTURE_PIXELS : MAX_PICTURE_PIXELS;
  if (
    header.width * header.height > maxPixels ||
    (!isJpeg && decodedBytes(header) > MAX_DECODED_BYTES)
  ) {
    throw new BadRequestException(TOO_MANY_PIXELS);
  }
  if (
    isJpeg &&
    header.isProgressive &&
    progressiveJpegBytes(header) > MAX_DECODED_BYTES
  ) {
    throw new BadRequestException(PROGRESSIVE_TOO_LARGE);
  }
  try {
    return await processImage(input, maxPixels, PICTURE_DECODE_TIMEOUT_SECONDS);
  } catch (error) {
    // sharp's documented way to tell a timeout: its message says so.
    throw new BadRequestException(
      error instanceof Error && error.message.includes('timeout')
        ? TOOK_TOO_LONG
        : NOT_A_PICTURE,
    );
  }
}

/**
 * Checks what the bytes really are, whatever the upload claims, and re-encodes
 * them to the stored form: upright, at most 1600 px, WebP, no metadata. SVG is
 * refused on purpose: it is a program as much as a picture. One picture is
 * converted at a time in each server process.
 *
 * @throws BadRequestException when the bytes are not an accepted picture, or
 *   have more than {@link MAX_PICTURE_PIXELS} pixels
 * @throws ServiceUnavailableException when too many pictures are waiting
 */
export function preparePicture(input: Buffer): Promise<ProcessedImage> {
  return gate.run(() => convert(input));
}
