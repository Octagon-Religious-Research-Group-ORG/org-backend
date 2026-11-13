import mongoose from 'mongoose';
import { AppendOnlyViolationError } from '../social/append-only';
import { ModerationLogService } from './moderation-log.service';
import { ModerationLogEntrySchema } from './schemas/moderation-log.schema';

describe('ModerationLogService', () => {
  it('stamps each entry with server time', async () => {
    const model = { create: jest.fn((doc: object) => Promise.resolve(doc)) };
    const service = new ModerationLogService(model as never);
    const before = Date.now();

    await service.record({
      actorUserId: 'user_admin',
      action: 'role.change.applied',
      targetType: 'user',
      targetId: 'user_member',
      reason: 'test',
    });

    const written = model.create.mock.calls[0][0] as { at: Date };
    expect(written.at.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('writes inside a transaction when given its session', async () => {
    const model = {
      create: jest.fn((docs: object[]) => Promise.resolve(docs)),
    };
    const service = new ModerationLogService(model as never);
    const session = { id: 'synthetic-session' };

    const written = await service.record(
      {
        actorUserId: 'user_admin',
        action: 'claim.approved',
        targetType: 'claim',
        targetId: 'c1',
        reason: 'test',
      },
      session as never,
    );

    expect(model.create).toHaveBeenCalledWith([expect.any(Object)], {
      session,
    });
    expect(written).toMatchObject({ action: 'claim.approved' });
  });
});

describe('moderationlog schema', () => {
  const connection = mongoose.createConnection();
  const Log = connection.model(
    'ModerationLogAppendOnlyTest',
    ModerationLogEntrySchema,
  );

  afterAll(async () => {
    await connection.close();
  });

  it('is append-only', async () => {
    await expect(
      Log.updateOne(
        { targetId: 'user_member' },
        { reason: 'rewritten' },
      ).exec(),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);
    await expect(Log.deleteMany({}).exec()).rejects.toBeInstanceOf(
      AppendOnlyViolationError,
    );
  });
});
