import mongoose, { type Connection, Types } from 'mongoose';
import { MongoImportStore } from './mongo-store';

type Row = Record<string, unknown>;

/** Just enough of the driver's collection API, over arrays. */
function fakeDb(data: Record<string, Row[]>) {
  const matches = (row: Row, filter: Row) =>
    Object.entries(filter).every(([key, wanted]) => {
      const condition = wanted as { $in?: unknown[] };
      return condition.$in
        ? condition.$in.map(String).includes(String(row[key]))
        : String(row[key]) === String(wanted);
    });
  return {
    collection: (name: string) => ({
      find: (filter: Row = {}) => ({
        project: () => ({
          toArray: () =>
            Promise.resolve(
              (data[name] ?? []).filter((row) => matches(row, filter)),
            ),
        }),
      }),
      deleteMany: (filter: Row) => {
        const before = data[name] ?? [];
        data[name] = before.filter((row) => !matches(row, filter));
        return Promise.resolve({
          deletedCount: before.length - data[name].length,
        });
      },
    }),
  };
}

function storeOver(data: Record<string, Row[]>) {
  const connection = {
    models: {},
    model: () => ({}),
    db: fakeDb(data),
  } as unknown as Connection;
  return new MongoImportStore(connection);
}

describe('MongoImportStore.removeImported', () => {
  const deleted: unknown[] = [];

  beforeEach(() => {
    deleted.length = 0;
    jest.spyOn(mongoose.mongo, 'GridFSBucket').mockImplementation(
      () =>
        ({
          find: () => ({
            toArray: () => Promise.resolve([{ _id: 'file1' }]),
          }),
          delete: (id: unknown) => {
            deleted.push(id);
            return Promise.resolve();
          },
        }) as never,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  const ids = {
    imported: new Types.ObjectId(),
    failed: new Types.ObjectId(),
    otherFailed: new Types.ObjectId(),
    otherImported: new Types.ObjectId(),
    native: new Types.ObjectId(),
  };

  const rowsFor = (profileId: Types.ObjectId) => ({ profileId });

  function dataset(): Record<string, Row[]> {
    return {
      socialprofiles: [
        { _id: ids.imported, slug: 'alpha', source: 'migrated' },
        { _id: ids.otherImported, slug: 'gamma', source: 'migrated' },
        { _id: ids.native, slug: 'beta', source: 'native' },
      ],
      importrecords: [
        { profileId: ids.imported, slug: 'alpha' },
        // A failed import of a requested address: record, but no profile.
        { profileId: ids.failed, slug: 'alpha' },
        { profileId: ids.otherFailed, slug: 'gamma' },
      ],
      belieftabs: [
        rowsFor(ids.imported),
        rowsFor(ids.failed),
        rowsFor(ids.otherFailed),
        rowsFor(ids.otherImported),
      ],
      profileblocks: [
        { ...rowsFor(ids.imported), blockId: 'b-imported' },
        { ...rowsFor(ids.failed), blockId: 'b-failed' },
        { ...rowsFor(ids.otherFailed), blockId: 'b-other' },
      ],
      comments: [rowsFor(ids.failed), rowsFor(ids.otherFailed)],
      blockversions: [
        { blockId: 'b-imported' },
        { blockId: 'b-failed' },
        { blockId: 'b-other' },
      ],
    };
  }

  it('removes the requested imports and what their failures left', async () => {
    const data = dataset();

    const counts = await storeOver(data).removeImported(['alpha']);

    expect(counts).toEqual(
      expect.objectContaining({
        blockversions: 2,
        belieftabs: 2,
        profileblocks: 2,
        comments: 1,
        importrecords: 2,
        socialprofiles: 1,
        images: 1,
      }),
    );
    expect(deleted).toEqual(['file1']);
  });

  it('never touches another import, finished or failed, or a native profile', async () => {
    const data = dataset();

    await storeOver(data).removeImported(['alpha']);

    expect(data.socialprofiles.map((row) => row._id)).toEqual([
      ids.otherImported,
      ids.native,
    ]);
    expect(data.belieftabs.map((row) => row.profileId)).toEqual([
      ids.otherFailed,
      ids.otherImported,
    ]);
    expect(data.blockversions).toEqual([{ blockId: 'b-other' }]);
    expect(data.importrecords.map((row) => row.slug)).toEqual(['gamma']);
  });

  it('leaves a profile alone when an old record names its address but it lives on', async () => {
    const data = dataset();
    const renamed = new Types.ObjectId();
    data.socialprofiles.push({
      _id: renamed,
      slug: 'alpha-renamed',
      source: 'migrated',
    });
    data.importrecords.push({ profileId: renamed, slug: 'alpha' });
    data.belieftabs.push(rowsFor(renamed));

    await storeOver(data).removeImported(['alpha']);

    expect(data.belieftabs).toContainEqual(rowsFor(renamed));
  });

  it('leaves rows with no import record of the requested address alone', async () => {
    const data = dataset();
    const stranger = new Types.ObjectId();
    data.belieftabs.push(rowsFor(stranger));

    await storeOver(data).removeImported(['alpha']);

    expect(data.belieftabs).toContainEqual(rowsFor(stranger));
  });
});

describe('MongoImportStore.readBack', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reads every kind of row, and pictures by id', async () => {
    const profileId = new Types.ObjectId();
    const fileId = new Types.ObjectId();
    const find = jest.fn(() => ({
      lean: () => ({
        exec: () => Promise.resolve([{ rowOf: 'something' }]),
      }),
    }));
    const finds: unknown[] = [];
    jest.spyOn(mongoose.mongo, 'GridFSBucket').mockImplementation(
      () =>
        ({
          find: (filter: unknown) => {
            finds.push(filter);
            return {
              toArray: () =>
                Promise.resolve([
                  {
                    _id: fileId,
                    length: 7,
                    metadata: {
                      profileSlug: 'a',
                      source: 'p.jpeg',
                      role: 'picture',
                    },
                  },
                ]),
            };
          },
        }) as never,
    );
    const connection = {
      models: {},
      model: () => ({ find }),
      db: {},
    } as unknown as Connection;

    const snapshot = await new MongoImportStore(connection).readBack(
      profileId,
      ['b1'],
      [fileId.toHexString()],
    );

    expect(snapshot.profile).toEqual({ rowOf: 'something' });
    expect(snapshot.images).toEqual([
      {
        id: fileId.toHexString(),
        profileSlug: 'a',
        source: 'p.jpeg',
        role: 'picture',
        bytes: 7,
      },
    ]);
    expect(finds).toEqual([{ _id: { $in: [fileId] } }]);
    expect(find).toHaveBeenCalledWith({ blockId: { $in: ['b1'] } });
    expect(find).toHaveBeenCalledWith({ profileId });
  });

  it('says so when the profile row is not there', async () => {
    jest
      .spyOn(mongoose.mongo, 'GridFSBucket')
      .mockImplementation(
        () =>
          ({ find: () => ({ toArray: () => Promise.resolve([]) }) }) as never,
      );
    const connection = {
      models: {},
      model: () => ({
        find: () => ({ lean: () => ({ exec: () => Promise.resolve([]) }) }),
      }),
      db: {},
    } as unknown as Connection;

    const snapshot = await new MongoImportStore(connection).readBack(
      new Types.ObjectId(),
      [],
      [],
    );

    expect(snapshot.profile).toBeNull();
  });
});
