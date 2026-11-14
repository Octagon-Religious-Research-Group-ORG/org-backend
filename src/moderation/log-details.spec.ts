import {
  checkLogDetails,
  OTHER_DETAIL_KEYS,
  PERSON_DETAIL_KEYS,
  UnregisteredLogDetailError,
} from './log-details';
import { ModerationLogService } from './moderation-log.service';

// Chunk 17 round 3, M-1: a writer that adds a details key fails its tests
// until the key is registered, saying whether it can hold a person's id.
describe('moderation-log details registry', () => {
  it('refuses an unregistered key under test', () => {
    expect(() => checkLogDetails({ newPersonId: 'user_x' })).toThrow(
      UnregisteredLogDetailError,
    );
    expect(checkLogDetails({ slug: 'a', userId: 'user_x' })).toEqual([]);
    expect(checkLogDetails(undefined)).toEqual([]);
  });

  it('only reports it in production, so an admin action still works', () => {
    expect(checkLogDetails({ newPersonId: 'user_x' }, false)).toEqual([
      'newPersonId',
    ]);
  });

  it('keeps the two lists apart', () => {
    for (const key of PERSON_DETAIL_KEYS) {
      expect(OTHER_DETAIL_KEYS as readonly string[]).not.toContain(key);
    }
  });

  it('refuses the write itself under test, and warns in production', async () => {
    const create = jest.fn(() => Promise.resolve({}));
    const service = new ModerationLogService({ create } as never);
    const entry = {
      actorUserId: 'user_a',
      action: 'x',
      targetType: 'y',
      targetId: 'z',
      reason: 'r',
      details: { newPersonId: 'user_x' },
    };
    await expect(service.record(entry)).rejects.toThrow(
      UnregisteredLogDetailError,
    );
    expect(create).not.toHaveBeenCalled();
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const warn = jest
      .spyOn(service['logger'], 'warn')
      .mockImplementation(() => undefined);
    try {
      await service.record(entry);
    } finally {
      process.env.NODE_ENV = env;
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('newPersonId'));
    expect(create).toHaveBeenCalled();
  });
});
