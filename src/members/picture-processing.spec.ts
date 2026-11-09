import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import sharp from 'sharp';
import * as imageModule from '../import/pages/image';
import {
  MAX_JPEG_PICTURE_PIXELS,
  MAX_PICTURE_PIXELS,
  MAX_WAITING_PICTURES,
  PICTURE_DECODE_TIMEOUT_SECONDS,
  preparePicture,
  SerialGate,
} from './picture-processing';

/** Real pictures through the real sharp: mocking it would prove nothing here. */
async function png(width = 20, height = 10) {
  return sharp({
    create: { width, height, channels: 3, background: '#336699' },
  })
    .png()
    .toBuffer();
}

afterEach(() => jest.restoreAllMocks());

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

  it('answers the same for bytes with a good header that will not decode', async () => {
    jest
      .spyOn(imageModule, 'processImage')
      .mockRejectedValueOnce(new Error('decode'));
    await expect(preparePicture(await png())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses more than the pixel cap from the header, decoding nothing', async () => {
    const decode = jest.spyOn(imageModule, 'processImage');
    const error = await preparePicture(
      await png(MAX_PICTURE_PIXELS / 1000 + 1, 1000),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toMatch(/too large/);
    expect(decode).not.toHaveBeenCalled();
  });

  it('accepts a picture exactly at the cap, and asks for that limit', async () => {
    const decode = jest.spyOn(imageModule, 'processImage');
    await expect(preparePicture(await png(6000, 6000))).resolves.toMatchObject({
      width: 1600,
      height: 1600,
    });
    expect(decode).toHaveBeenCalledWith(
      expect.anything(),
      MAX_PICTURE_PIXELS,
      expect.any(Number),
    );
  });

  it('refuses a 16-bit picture that would decode past the memory limit', async () => {
    const decode = jest.spyOn(imageModule, 'processImage');
    const input = await sharp({
      create: {
        width: 5000,
        height: 5000,
        channels: 4,
        background: { r: 9, g: 9, b: 9, alpha: 0.5 },
      },
    })
      .toColourspace('rgb16')
      .png({ compressionLevel: 9 })
      .toBuffer();
    await expect(preparePicture(input)).rejects.toThrow(/too large/);
    expect(decode).not.toHaveBeenCalled();
  });

  it('gives every decode a time limit', async () => {
    const decode = jest.spyOn(imageModule, 'processImage');
    await preparePicture(await png());
    expect(decode).toHaveBeenCalledWith(
      expect.anything(),
      MAX_PICTURE_PIXELS,
      PICTURE_DECODE_TIMEOUT_SECONDS,
    );
  });

  it('answers a timed-out decode cleanly and frees the slot', async () => {
    const input = await png();
    jest
      .spyOn(imageModule, 'processImage')
      .mockRejectedValueOnce(new Error('timeout: 42% complete'));
    const error = await preparePicture(input).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toMatch(/too long/);
    expect((error as BadRequestException).message).not.toMatch(/timeout|%/);

    await expect(preparePicture(input)).resolves.toMatchObject({
      contentType: 'image/webp',
    });
  });

  it('keeps sharp working in one thread with no cache', () => {
    expect(sharp.concurrency()).toBe(1);
    expect(sharp.cache().memory.max).toBe(0);
    expect(sharp.cache().items.max).toBe(0);
  });

  it('decodes one at a time, and tells the rest to try again', async () => {
    const input = await png();
    let active = 0;
    let highest = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    jest.spyOn(imageModule, 'processImage').mockImplementation(async () => {
      active += 1;
      highest = Math.max(highest, active);
      await gate;
      active -= 1;
      return {
        data: Buffer.from('x'),
        width: 1,
        height: 1,
        contentType: 'image/webp',
      };
    });

    const accepted = MAX_WAITING_PICTURES + 1;
    const running = Array.from({ length: accepted }, () =>
      preparePicture(input),
    );
    // Sharp reads each header off the main thread, so give those a moment.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(preparePicture(input)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    release();
    await expect(Promise.all(running)).resolves.toHaveLength(accepted);
    expect(highest).toBe(1);
  });
});

describe('the JPEG cap', () => {
  function withHeader(header: Partial<sharp.Metadata>) {
    jest.spyOn(sharp.prototype, 'metadata').mockResolvedValueOnce({
      channels: 3,
      depth: 'uchar',
      isProgressive: false,
      chromaSubsampling: '4:2:0',
      ...header,
    });
    return jest.spyOn(imageModule, 'processImage').mockResolvedValueOnce({
      data: Buffer.from('x'),
      width: 1600,
      height: 1200,
      contentType: 'image/webp',
    });
  }
  const refusal = async () =>
    preparePicture(Buffer.from('bytes')).then(
      () => undefined,
      (e: unknown) => e as BadRequestException,
    );

  it('accepts a real 48 MP JPEG through the real pipeline', async () => {
    const input = await sharp({
      create: { width: 8000, height: 6000, channels: 3, background: '#223344' },
      limitInputPixels: false,
    })
      .jpeg()
      .toBuffer();
    await expect(preparePicture(input)).resolves.toMatchObject({
      width: 1600,
      height: 1200,
    });
  });

  it.each([
    ['48 MP', 8000, 6000],
    ['108 MP', 12000, 9000],
  ])(
    'takes a standard %s JPEG and decodes it under the JPEG limit',
    async (_n, width, height) => {
      const decode = withHeader({ format: 'jpeg', width, height });
      await expect(preparePicture(Buffer.from('x'))).resolves.toBeDefined();
      expect(decode).toHaveBeenCalledWith(
        expect.anything(),
        MAX_JPEG_PICTURE_PIXELS,
        PICTURE_DECODE_TIMEOUT_SECONDS,
      );
    },
  );

  it('refuses a JPEG past its cap, from the header', async () => {
    const decode = withHeader({
      format: 'jpeg',
      width: MAX_JPEG_PICTURE_PIXELS / 1000 + 1,
      height: 1000,
    });
    const error = await refusal();
    expect(error?.message).toMatch(/110 megapixels/);
    expect(error?.message).toMatch(/36 megapixels/);
    expect(decode).not.toHaveBeenCalled();
  });

  it.each(['png', 'webp', 'gif'])(
    'keeps the lower cap for %s, whatever else the upload claimed',
    async (format) => {
      const decode = withHeader({
        format: format as keyof sharp.FormatEnum,
        width: 8000,
        height: 6000,
      });
      expect((await refusal())?.message).toMatch(/too large/);
      expect(decode).not.toHaveBeenCalled();
    },
  );

  describe('progressive', () => {
    it('allows 4:2:0 up to the same memory as the other formats', async () => {
      const decode = withHeader({
        format: 'jpeg',
        width: 8000,
        height: 6000,
        isProgressive: true,
      });
      await expect(preparePicture(Buffer.from('x'))).resolves.toBeDefined();
      expect(decode).toHaveBeenCalled();
    });

    it.each([
      ['48 MP 4:4:4', 8000, 6000, '4:4:4'],
      ['108 MP 4:2:0', 12000, 9000, '4:2:0'],
      ['18.1 MP CMYK', 4300, 4210, '4:4:4:4'],
      ['an unknown layout, counted as the largest', 4300, 4210, undefined],
    ])('refuses %s before decoding', async (_n, width, height, layout) => {
      const decode = withHeader({
        format: 'jpeg',
        width,
        height,
        isProgressive: true,
        chromaSubsampling: layout,
      });
      expect((await refusal())?.message).toMatch(/progressive/);
      expect(decode).not.toHaveBeenCalled();
    });

    it('does not apply to a standard JPEG of the same size', async () => {
      const decode = withHeader({
        format: 'jpeg',
        width: 8000,
        height: 6000,
        chromaSubsampling: '4:4:4',
      });
      await expect(preparePicture(Buffer.from('x'))).resolves.toBeDefined();
      expect(decode).toHaveBeenCalled();
    });
  });
});

describe('SerialGate', () => {
  it('runs tasks in order, one at a time', async () => {
    const gate = new SerialGate(5);
    const log: string[] = [];
    let finishFirst: () => void = () => undefined;
    const first = gate.run(
      () =>
        new Promise<void>((resolve) => {
          log.push('first');
          finishFirst = resolve;
        }),
    );
    const second = gate.run(() => {
      log.push('second');
      return Promise.resolve('done');
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(log).toEqual(['first']);
    finishFirst();
    await first;
    await expect(second).resolves.toBe('done');
    expect(log).toEqual(['first', 'second']);
  });

  it('refuses past the queue, not before it', async () => {
    const gate = new SerialGate(1);
    let finish: () => void = () => undefined;
    const first = gate.run(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const second = gate.run(() => Promise.resolve());
    await expect(gate.run(() => Promise.resolve())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await new Promise((resolve) => setImmediate(resolve));
    finish();
    await Promise.all([first, second]);
  });

  it('moves on after a task fails', async () => {
    const gate = new SerialGate(1);
    await expect(
      gate.run(() => Promise.reject(new Error('task'))),
    ).rejects.toThrow('task');
    await expect(gate.run(() => Promise.resolve(1))).resolves.toBe(1);
  });
});
