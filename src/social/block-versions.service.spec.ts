import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  BlockVersionsService,
  MAX_APPEND_ATTEMPTS,
} from './block-versions.service';
import { MAX_BLOCK_TEXT_LENGTH } from './schemas/block-version.schema';
import { computeVersionHash, GENESIS_HASH } from './version-chain';

interface QueryChain<T> {
  sort: jest.Mock<QueryChain<T>>;
  select: jest.Mock<QueryChain<T>>;
  lean: jest.Mock<QueryChain<T>>;
  exec: jest.Mock<Promise<T>>;
}

function query<T>(value: T): QueryChain<T> {
  const chain = {} as QueryChain<T>;
  chain.sort = jest.fn(() => chain);
  chain.select = jest.fn(() => chain);
  chain.lean = jest.fn(() => chain);
  chain.exec = jest.fn(() => Promise.resolve(value));
  return chain;
}

const duplicateKey = Object.assign(new Error('E11000 duplicate key'), {
  code: 11000,
});

function setup(heads: Array<{ seq: number; hash: string } | null>) {
  const versionModel = {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((doc: Record<string, unknown>) =>
      Promise.resolve({ _id: `v${String(doc.seq)}`, ...doc }),
    ),
  };
  for (const head of heads)
    versionModel.findOne.mockReturnValueOnce(query(head));
  const blockModel = {
    updateOne: jest.fn(() => ({ exec: jest.fn().mockResolvedValue({}) })),
  };
  const service = new BlockVersionsService(
    versionModel as never,
    blockModel as never,
  );
  return { service, versionModel, blockModel };
}

const input = {
  blockId: 'blk-1',
  text: 'We are all one.',
  authorUserId: 'user_a',
};

describe('BlockVersionsService.appendVersion', () => {
  it('starts a new block at seq 1 from the genesis hash', async () => {
    const { service, versionModel, blockModel } = setup([null]);

    const created = (await service.appendVersion(input)) as unknown as Record<
      string,
      unknown
    >;

    const written = versionModel.create.mock.calls[0][0];
    expect(written).toMatchObject({ seq: 1, prevHash: GENESIS_HASH, ...input });
    expect(written.hash).toBe(
      computeVersionHash(
        written as unknown as Parameters<typeof computeVersionHash>[0],
      ),
    );
    expect(created._id).toBe('v1');
    expect(blockModel.updateOne).toHaveBeenCalledWith(
      { blockId: 'blk-1', currentVersionSeq: { $lt: 1 } },
      { $set: { currentVersionId: 'v1', currentVersionSeq: 1 } },
    );
  });

  it('chains a new version onto the current head', async () => {
    const head = { seq: 4, hash: 'b'.repeat(64) };
    const { service, versionModel } = setup([head]);

    await service.appendVersion(input);

    expect(versionModel.create.mock.calls[0][0]).toMatchObject({
      seq: 5,
      prevHash: head.hash,
    });
  });

  it('retries on top of the winner when another save takes the same seq', async () => {
    const { service, versionModel, blockModel } = setup([
      { seq: 1, hash: 'b'.repeat(64) },
      { seq: 2, hash: 'c'.repeat(64) },
    ]);
    versionModel.create.mockRejectedValueOnce(duplicateKey);

    await service.appendVersion(input);

    expect(versionModel.create).toHaveBeenCalledTimes(2);
    expect(versionModel.create.mock.calls[1][0]).toMatchObject({
      seq: 3,
      prevHash: 'c'.repeat(64),
    });
    expect(blockModel.updateOne).toHaveBeenCalledTimes(1);
  });

  it('gives up with a conflict after repeated races', async () => {
    const { service, versionModel, blockModel } = setup(
      Array.from({ length: MAX_APPEND_ATTEMPTS }, () => null),
    );
    versionModel.create.mockRejectedValue(duplicateKey);

    await expect(service.appendVersion(input)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(versionModel.create).toHaveBeenCalledTimes(MAX_APPEND_ATTEMPTS);
    expect(blockModel.updateOne).not.toHaveBeenCalled();
  });

  it('rethrows any other database error without retrying', async () => {
    const { service, versionModel } = setup([null]);
    versionModel.create.mockRejectedValueOnce(new Error('network down'));

    await expect(service.appendVersion(input)).rejects.toThrow('network down');
    expect(versionModel.create).toHaveBeenCalledTimes(1);
  });

  it('rejects text over the length limit before touching the database', async () => {
    const { service, versionModel } = setup([]);

    await expect(
      service.appendVersion({
        ...input,
        text: 'x'.repeat(MAX_BLOCK_TEXT_LENGTH + 1),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(versionModel.findOne).not.toHaveBeenCalled();
  });
});

describe('BlockVersionsService.verifyBlock', () => {
  it('verifies the stored chain', async () => {
    const fields = {
      blockId: 'blk-1',
      seq: 1,
      text: 't',
      authorUserId: 'user_a',
      createdAt: new Date('2026-10-11T05:00:00.000Z'),
      prevHash: GENESIS_HASH,
    };
    const stored = [{ ...fields, hash: computeVersionHash(fields) }];
    const { service, versionModel } = setup([]);
    versionModel.find.mockReturnValueOnce(query(stored));

    await expect(service.verifyBlock('blk-1')).resolves.toEqual({
      valid: true,
      length: 1,
      headHash: stored[0].hash,
    });
    expect(versionModel.find).toHaveBeenCalledWith({ blockId: 'blk-1' });
  });
});
