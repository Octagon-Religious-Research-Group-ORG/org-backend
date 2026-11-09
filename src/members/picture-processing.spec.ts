import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import { preparePicture } from './picture-processing';

/** Real pictures through the real sharp: mocking it would prove nothing here. */
async function png(width = 20, height = 10) {
  return sharp({
    create: { width, height, channels: 3, background: '#336699' },
  })
    .png()
    .toBuffer();
}

describe('preparePicture', () => {
  it('re-encodes a real picture to WebP', async () => {
    const image = await preparePicture(await png());
    expect(image.contentType).toBe('image/webp');
    expect((await sharp(image.data).metadata()).format).toBe('webp');
  });

  it.each(['jpeg', 'webp', 'gif'] as const)('accepts %s', async (format) => {
    const input = await sharp(await png())
      .toFormat(format)
      .toBuffer();
    await expect(preparePicture(input)).resolves.toMatchObject({
      contentType: 'image/webp',
    });
  });

  it('applies the camera rotation, then strips the metadata', async () => {
    const input = await sharp(await png(20, 10))
      .jpeg()
      .withExif({ IFD0: { Copyright: 'SYNTHETIC-SECRET' } })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const image = await preparePicture(input);
    const out = await sharp(image.data).metadata();
    expect([out.width, out.height]).toEqual([10, 20]);
    expect(out.exif).toBeUndefined();
    expect(image.data.includes('SYNTHETIC-SECRET')).toBe(false);
  });

  it('shrinks a very large picture', async () => {
    const image = await preparePicture(await png(2400, 1200));
    expect([image.width, image.height]).toEqual([1600, 800]);
  });

  it.each([
    ['text', Buffer.from('this is not a picture at all')],
    ['a truncated PNG header', Buffer.from('89504e470d0a1a0a', 'hex')],
    [
      'an SVG',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
      ),
    ],
  ])('refuses %s, whatever the upload claimed', async (_name, input) => {
    await expect(preparePicture(input)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
