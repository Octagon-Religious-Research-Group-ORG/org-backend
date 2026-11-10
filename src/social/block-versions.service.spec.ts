import mongoose from 'mongoose';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  BlockVersionsService,
  MAX_APPEND_ATTEMPTS,
  STALE_EDIT_REFUSAL,
} from './block-versions.service';
import {
  EMPTY_BLOCK_TEXT_REFUSAL,
  MAX_BLOCK_TEXT_LENGTH,
} from './schemas/block-version.schema';
import {
  computeVersionHash,
  GENESIS_HASH,
  type StoredVersion,
  verifyChain,
} from './version-chain';

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
    findOne: jest.fn(),
    exists: jest.fn(() => Promise.resolve({ _id: 'block' })),
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

  describe('an edit based on a version (expectedSeq)', () => {
    it('saves on top of exactly that version', async () => {
      const { service, versionModel } = setup([
        { seq: 4, hash: 'b'.repeat(64) },
      ]);
      const saved = await service.appendVersion({ ...input, expectedSeq: 4 });
      expect(saved.seq).toBe(5);
      expect(versionModel.create).toHaveBeenCalledTimes(1);
    });

    it('writes nothing when a newer version exists', async () => {
      const { service, versionModel, blockModel } = setup([
        { seq: 5, hash: 'b'.repeat(64) },
      ]);
      await expect(
        service.appendVersion({ ...input, expectedSeq: 4 }),
      ).rejects.toThrow(STALE_EDIT_REFUSAL);
      expect(versionModel.create).not.toHaveBeenCalled();
      expect(blockModel.updateOne).not.toHaveBeenCalled();
    });

    it('treats a block with no versions as version 0', async () => {
      const ok = setup([null]);
      await ok.service.appendVersion({ ...input, expectedSeq: 0 });
      expect(ok.versionModel.create).toHaveBeenCalledTimes(1);
      const stale = setup([null]);
      await expect(
        stale.service.appendVersion({ ...input, expectedSeq: 1 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses instead of retrying when it loses the race for the next seq', async () => {
      // The second read still shows the old head (a lagging read), so only
      // the no-retry rule, not the head check, can stop a second insert.
      const { service, versionModel, blockModel } = setup([
        { seq: 1, hash: 'b'.repeat(64) },
        { seq: 1, hash: 'b'.repeat(64) },
      ]);
      versionModel.create.mockRejectedValueOnce(duplicateKey);
      await expect(
        service.appendVersion({ ...input, expectedSeq: 1 }),
      ).rejects.toThrow(STALE_EDIT_REFUSAL);
      expect(versionModel.create).toHaveBeenCalledTimes(1);
      expect(blockModel.updateOne).not.toHaveBeenCalled();
    });
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

describe('BlockVersionsService.appendVersion refusals', () => {
  it('refuses empty text with a 400 before touching the database', async () => {
    const { service, versionModel, blockModel } = setup([]);

    const refusal = service.appendVersion({ ...input, text: '' });

    await expect(refusal).rejects.toBeInstanceOf(BadRequestException);
    await expect(refusal).rejects.toThrow(EMPTY_BLOCK_TEXT_REFUSAL);
    expect(blockModel.exists).not.toHaveBeenCalled();
    expect(versionModel.create).not.toHaveBeenCalled();
  });

  it('writes no version for a block that does not exist', async () => {
    const { service, versionModel, blockModel } = setup([null]);
    blockModel.exists.mockImplementationOnce(() =>
      Promise.resolve(null as never),
    );

    await expect(service.appendVersion(input)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(versionModel.create).not.toHaveBeenCalled();
  });

  it('still succeeds when a newer save already moved the pointer', async () => {
    const { service, versionModel, blockModel } = setup([null]);
    blockModel.updateOne.mockReturnValueOnce({
      exec: jest.fn().mockResolvedValue({ matchedCount: 0 }),
    });

    await expect(service.appendVersion(input)).resolves.toBeDefined();
    expect(versionModel.create).toHaveBeenCalledTimes(1);
  });
});

describe('BlockVersionsService.verifyBlock', () => {
  function stored(count: number) {
    let prevHash = GENESIS_HASH;
    return Array.from({ length: count }, (_, index) => {
      const fields = {
        blockId: 'blk-1',
        seq: index + 1,
        text: 't',
        authorUserId: 'user_a',
        createdAt: new Date('2026-10-11T05:00:00.000Z'),
        prevHash,
      };
      const version = { ...fields, hash: computeVersionHash(fields) };
      prevHash = version.hash;
      return version;
    });
  }

  function verify(
    versions: ReturnType<typeof stored>,
    block: { currentVersionSeq: number } | null,
  ) {
    const { service, versionModel, blockModel } = setup([]);
    versionModel.find.mockReturnValueOnce(query(versions));
    blockModel.findOne.mockReturnValueOnce(query(block));
    return { result: service.verifyBlock('blk-1'), versionModel, blockModel };
  }

  it('verifies the stored chain when the head matches the block', async () => {
    const versions = stored(2);
    const { result, versionModel, blockModel } = verify(versions, {
      currentVersionSeq: 2,
    });
    await expect(result).resolves.toEqual({
      valid: true,
      length: 2,
      headHash: versions[1].hash,
    });
    expect(versionModel.find).toHaveBeenCalledWith({ blockId: 'blk-1' });
    expect(blockModel.findOne).toHaveBeenCalledWith({ blockId: 'blk-1' });
  });

  it('reads the block before the versions', async () => {
    const { result, versionModel, blockModel } = verify(stored(1), {
      currentVersionSeq: 1,
    });
    await result;
    expect(blockModel.findOne.mock.invocationCallOrder[0]).toBeLessThan(
      versionModel.find.mock.invocationCallOrder[0],
    );
  });

  it('catches a removed newest version', async () => {
    await expect(
      verify(stored(2), { currentVersionSeq: 3 }).result,
    ).resolves.toEqual({ valid: false, seq: 3, reason: 'truncated' });
  });

  it('fails a block with no versions', async () => {
    await expect(verify([], { currentVersionSeq: 3 }).result).resolves.toEqual({
      valid: false,
      seq: 0,
      reason: 'no-versions',
    });
  });

  it('names versions whose block row is gone', async () => {
    await expect(verify(stored(1), null).result).resolves.toEqual({
      valid: false,
      seq: 1,
      reason: 'missing-block',
    });
  });

  it('names a pointer that lags behind the chain', async () => {
    await expect(
      verify(stored(2), { currentVersionSeq: 1 }).result,
    ).resolves.toEqual({ valid: false, seq: 2, reason: 'pointer-behind' });
  });

  it('returns the chain failure first', async () => {
    const versions = stored(2);
    versions[0] = { ...versions[0], text: 'edited' };
    await expect(
      verify(versions, { currentVersionSeq: 2 }).result,
    ).resolves.toEqual({ valid: false, seq: 1, reason: 'hash-mismatch' });
  });
});

describe('a lone surrogate in the text', () => {
  const LONE = 'before \ud83d after';

  it('still verifies after a real BSON round trip', async () => {
    const { service, versionModel } = setup([null]);
    await service.appendVersion({ ...input, text: LONE });
    const written = versionModel.create.mock.calls[0][0];

    const { BSON } = mongoose.mongo;
    const stored = BSON.deserialize(BSON.serialize(written)) as StoredVersion;

    expect(stored.text).toBe('before � after');
    expect(verifyChain('blk-1', [stored])).toMatchObject({ valid: true });
  });

  it('leaves the hash of well-formed text, emoji included, untouched', async () => {
    const { service, versionModel } = setup([null]);
    const text = 'One God 😀 and é';
    await service.appendVersion({ ...input, text });
    const written = versionModel.create.mock.calls[0][0];

    expect(written.text).toBe(text);
    expect(written.hash).toBe(
      computeVersionHash(
        written as unknown as Parameters<typeof computeVersionHash>[0],
      ),
    );
  });
});
