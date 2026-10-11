import sharp from 'sharp';
import { MAX_IMAGE_SIDE, processImage } from './image';

describe('processImage', () => {
  it('shrinks a large picture to WebP within the size limit', async () => {
    const png = await sharp({
      create: { width: 3200, height: 1600, channels: 3, background: '#f00' },
    })
      .png()
      .toBuffer();

    const result = await processImage(png);

    expect(result).toEqual(
      expect.objectContaining({
        width: MAX_IMAGE_SIDE,
        height: 800,
        contentType: 'image/webp',
      }),
    );
    expect((await sharp(result.data).metadata()).format).toBe('webp');
  });

  it('applies the EXIF rotation and never enlarges', async () => {
    // Stored 40x20 with orientation 6 ("rotate 90° clockwise to view").
    const jpeg = await sharp({
      create: { width: 40, height: 20, channels: 3, background: '#00f' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const result = await processImage(jpeg);

    expect([result.width, result.height]).toEqual([20, 40]);
    expect((await sharp(result.data).metadata()).orientation).toBeUndefined();
  });

  it('rejects bytes that are not an image', async () => {
    await expect(processImage(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});
