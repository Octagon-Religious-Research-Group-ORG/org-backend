import { Readable, Writable } from 'node:stream';
import mongoose from 'mongoose';
import { PictureStore } from './picture-store.service';

const ID = '507f1f77bcf86cd799439011';
const ID_2 = '507f1f77bcf86cd799439012';
const oid = (id: string) => new mongoose.Types.ObjectId(id);
const LIVE = { role: 'picture', contentType: 'image/webp' };

function setup(files: Array<Record<string, unknown>> = []) {
  const written: Buffer[] = [];
  const upload = Object.assign(
    new Writable({
      write(chunk: Buffer, _enc, done) {
        written.push(chunk);
        done();
      },
    }),
    { id: oid(ID) },
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
  const updateOne = jest.fn(() => Promise.resolve({}));
  const collection = jest.fn(() => ({ updateOne }));
  const store = new PictureStore({ db: { collection } } as never);
  return { store, bucket, written, factory, collection, updateOne };
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

  it('reads a live profile picture', async () => {
    const { store, bucket } = setup([{ _id: oid(ID), metadata: LIVE }]);
    await expect(store.read(ID)).resolves.toEqual({
      data: Buffer.from('webp'),
      fileId: ID,
    });
    expect(bucket.openDownloadStream).toHaveBeenCalledWith(oid(ID));
  });

  it.each([
    ['is missing', []],
    ['has no metadata', [{ _id: 'x' }]],
    ['is not a WebP', [{ _id: 'x', metadata: { ...LIVE, contentType: 'x' } }]],
    ['is gallery-only', [{ _id: 'x', metadata: { ...LIVE, role: 'gallery' } }]],
    [
      'is retired',
      [{ _id: 'x', metadata: { ...LIVE, retiredAt: new Date(0) } }],
    ],
  ])('reads nothing when the file %s', async (_name, files) => {
    const { store, bucket } = setup(files);
    await expect(store.read(ID)).resolves.toBeUndefined();
    expect(bucket.openDownloadStream).not.toHaveBeenCalled();
  });

  it('never queries with an id that is not an ObjectId', async () => {
    const { store, bucket, collection } = setup();
    await expect(store.read('not-an-id')).resolves.toBeUndefined();
    await expect(store.remove('not-an-id')).resolves.toBeUndefined();
    await expect(
      store.retire('not-an-id', new Date()),
    ).resolves.toBeUndefined();
    await expect(store.livePictures(['not-an-id'])).resolves.toEqual(new Set());
    expect(bucket.find).not.toHaveBeenCalled();
    expect(bucket.delete).not.toHaveBeenCalled();
    expect(collection).not.toHaveBeenCalled();
  });

  it('finds which files are live profile pictures', async () => {
    const { store, bucket } = setup([
      { _id: oid(ID), metadata: LIVE },
      { _id: oid(ID_2), metadata: { ...LIVE, role: 'gallery' } },
    ]);
    await expect(store.livePictures([ID, ID_2])).resolves.toEqual(
      new Set([ID]),
    );
    expect(bucket.find).toHaveBeenCalledWith({
      _id: { $in: [oid(ID), oid(ID_2)] },
    });
  });

  it('asks the database nothing for an empty list', async () => {
    const { store, bucket } = setup();
    await expect(store.livePictures([])).resolves.toEqual(new Set());
    expect(bucket.find).not.toHaveBeenCalled();
  });

  it('picks the listed file that is the profile picture, wherever it is', async () => {
    const { store } = setup([{ _id: oid(ID_2), metadata: LIVE }]);
    await expect(store.currentPicture([ID, ID_2])).resolves.toBe(ID_2);
  });

  it('has no picture for a gallery-only list', async () => {
    const { store } = setup([
      { _id: oid(ID), metadata: { ...LIVE, role: 'gallery' } },
    ]);
    await expect(store.currentPicture([ID])).resolves.toBeUndefined();
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

  it('retires a file with a date and leaves it in the bucket', async () => {
    const { store, bucket, collection, updateOne } = setup();
    const at = new Date('2026-11-09T00:00:00Z');
    await store.retire(ID, at);
    expect(collection).toHaveBeenCalledWith('profileimages.files');
    expect(updateOne).toHaveBeenCalledWith(
      { _id: oid(ID), 'metadata.retiredAt': { $exists: false } },
      { $set: { 'metadata.retiredAt': at } },
    );
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it('removes a file by id', async () => {
    const { store, bucket } = setup();
    await store.remove(ID);
    expect(bucket.delete).toHaveBeenCalledWith(oid(ID));
  });
});
