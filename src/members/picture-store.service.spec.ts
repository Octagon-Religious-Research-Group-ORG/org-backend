import { Readable, Writable } from 'node:stream';
import mongoose from 'mongoose';
import { PictureStore } from './picture-store.service';

const ID = '507f1f77bcf86cd799439011';

function setup(files: Array<Record<string, unknown>> = []) {
  const written: Buffer[] = [];
  const upload = Object.assign(
    new Writable({
      write(chunk: Buffer, _enc, done) {
        written.push(chunk);
        done();
      },
    }),
    { id: new mongoose.Types.ObjectId(ID) },
  );
  const bucket = {
    find: jest.fn(() => ({ toArray: () => Promise.resolve(files) })),
    openDownloadStream: jest.fn(() =>
      Readable.from([Buffer.from('we'), Buffer.from('bp')]),
    ),
    openUploadStream: jest.fn(() => upload),
    delete: jest.fn(() => Promise.resolve()),
  };
  const factory = jest
    .spyOn(mongoose.mongo, 'GridFSBucket')
    .mockImplementation(() => bucket as never);
  const store = new PictureStore({ db: {} } as never);
  return { store, bucket, written, factory };
}

afterEach(() => jest.restoreAllMocks());

describe('PictureStore', () => {
  it('always uses the profileimages bucket', async () => {
    const { store, factory } = setup();
    await store.read(ID);
    expect(factory).toHaveBeenCalledWith(expect.anything(), {
      bucketName: 'profileimages',
    });
  });

  it('reads a stored WebP', async () => {
    const _id = new mongoose.Types.ObjectId(ID);
    const { store, bucket } = setup([
      { _id, metadata: { contentType: 'image/webp' } },
    ]);
    await expect(store.read(ID)).resolves.toEqual({
      data: Buffer.from('webp'),
      fileId: ID,
    });
    expect(bucket.openDownloadStream).toHaveBeenCalledWith(_id);
  });

  it.each([
    ['is missing', []],
    ['has no metadata', [{ _id: 'x' }]],
    ['is not a WebP', [{ _id: 'x', metadata: { contentType: 'text/html' } }]],
  ])('reads nothing when the file %s', async (_name, files) => {
    const { store, bucket } = setup(files);
    await expect(store.read(ID)).resolves.toBeUndefined();
    expect(bucket.openDownloadStream).not.toHaveBeenCalled();
  });

  it('never queries with an id that is not an ObjectId', async () => {
    const { store, bucket } = setup();
    await expect(store.read('not-an-id')).resolves.toBeUndefined();
    await expect(store.remove('not-an-id')).resolves.toBeUndefined();
    expect(bucket.find).not.toHaveBeenCalled();
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it('reports the role a file was stored with', async () => {
    const { store } = setup([{ metadata: { role: 'gallery' } }]);
    await expect(store.roleOf(ID)).resolves.toBe('gallery');
    await expect(setup([]).store.roleOf(ID)).resolves.toBeUndefined();
  });

  it('stores a picture with the fields the bucket needs', async () => {
    const { store, bucket, written } = setup();
    const id = await store.store(
      {
        data: Buffer.from('img'),
        width: 2,
        height: 3,
        contentType: 'image/webp',
      },
      'quiet-fern',
    );
    expect(id).toBe(ID);
    expect(Buffer.concat(written)).toEqual(Buffer.from('img'));
    expect(bucket.openUploadStream).toHaveBeenCalledWith('quiet-fern.webp', {
      metadata: {
        profileSlug: 'quiet-fern',
        role: 'picture',
        contentType: 'image/webp',
        width: 2,
        height: 3,
      },
    });
  });

  it('removes a file by id', async () => {
    const { store, bucket } = setup();
    await store.remove(ID);
    expect(bucket.delete).toHaveBeenCalledWith(new mongoose.Types.ObjectId(ID));
  });
});
