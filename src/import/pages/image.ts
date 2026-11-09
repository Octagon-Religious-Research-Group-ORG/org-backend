import sharp from 'sharp';

/** Longest side of a stored profile image, in pixels. */
export const MAX_IMAGE_SIDE = 1600;

/** The limit for the laptop-only import CLI; server uploads pass a lower one. */
export const IMPORT_MAX_INPUT_PIXELS = 120_000_000;

export interface ProcessedImage {
  data: Buffer;
  width: number;
  height: number;
  contentType: 'image/webp';
}

/**
 * Converts an uploaded or imported picture to the stored form: upright
 * (EXIF rotation applied; gallery photos came out sideways without
 * it), at most 1600 px on the longest side, WebP. Metadata (EXIF, GPS) is not
 * copied to the output.
 *
 * @throws Error when the bytes are not an image sharp can read
 */
export async function processImage(
  input: Uint8Array,
  limitInputPixels: number = IMPORT_MAX_INPUT_PIXELS,
): Promise<ProcessedImage> {
  const { data, info } = await sharp(input, { limitInputPixels })
    .rotate()
    .resize({
      width: MAX_IMAGE_SIDE,
      height: MAX_IMAGE_SIDE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 80 })
    .toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
    contentType: 'image/webp',
  };
}
