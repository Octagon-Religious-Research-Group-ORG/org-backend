import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import { type ProcessedImage, processImage } from '../import/pages/image';

/** Largest upload accepted; phone photos fit, and it is rationed per account. */
export const MAX_PICTURE_BYTES = 10 * 1024 * 1024;

const PICTURE_FORMATS: ReadonlySet<string> = new Set([
  'jpeg',
  'png',
  'webp',
  'gif',
]);

const NOT_A_PICTURE =
  'That file is not a picture we can read. Please use a JPEG, PNG, WebP or GIF.';

/**
 * Checks what the bytes really are, whatever the upload claims, and re-encodes
 * them to the stored form: upright, at most 1600 px, WebP, no metadata. SVG is
 * refused on purpose: it is a program as much as a picture.
 *
 * @throws BadRequestException when the bytes are not an accepted picture
 */
export async function preparePicture(input: Buffer): Promise<ProcessedImage> {
  try {
    const { format } = await sharp(input, {
      limitInputPixels: 120_000_000,
    }).metadata();
    if (!PICTURE_FORMATS.has(format)) throw new Error('format');
    return await processImage(input);
  } catch {
    throw new BadRequestException(NOT_A_PICTURE);
  }
}
