import { ConflictException } from '@nestjs/common';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import {
  VOTE_BUSY,
  voteEventText,
  VoteHistoryService,
  voteKey,
} from './vote-history.service';
import {
  computeVersionHash,
  GENESIS_HASH,
  VOTE_HASH_SCHEME,
} from './version-chain';

function setup(beforeWrite?: () => void) {
  const model = fakeModel([], { unique: [['voteKey', 'seq']], beforeWrite });
  return { model, service: new VoteHistoryService(model as never) };
}

const base = {
  tabId: 'tab_x',
  voterUserId: 'user_v',
  voterTier: 'member' as const,
};

describe('VoteHistoryService', () => {
  it('appends a hash-chained entry per change, and verifies the chain', async () => {
    const { model, service } = setup();
    await expect(
      service.append({
        ...base,
        action: 'cast',
        value: 'agree',
        textSeq: 1,
        expectedSeq: 0,
      }),
    ).resolves.toMatchObject({ seq: 1 });
    await service.append({
      ...base,
      action: 'withdraw',
      textSeq: 1,
      expectedSeq: 1,
    });
    const [first, second] = model.docs;
    expect(first).toMatchObject({
      voteKey: 'tab_x:user_v',
      seq: 1,
      action: 'cast',
      value: 'agree',
      prevHash: GENESIS_HASH,
    });
    expect(first.hash).toBe(
      computeVersionHash(
        {
          blockId: 'tab_x:user_v',
          seq: 1,
          text: '["cast","agree",1,"member"]',
          authorUserId: 'user_v',
          createdAt: first.createdAt as Date,
          prevHash: GENESIS_HASH,
        },
        VOTE_HASH_SCHEME,
      ),
    );
    expect(second).toMatchObject({ seq: 2, prevHash: first.hash });
    expect(second).not.toHaveProperty('value');
    await expect(service.verify('tab_x', 'user_v')).resolves.toMatchObject({
      valid: true,
      length: 2,
    });
    await expect(service.head('tab_x', 'user_v')).resolves.toMatchObject({
      seq: 2,
      action: 'withdraw',
    });
    await expect(service.head('tab_x', 'nobody')).resolves.toBeNull();

    // A changed entry no longer verifies.
    first.value = 'disagree';
    await expect(service.verify('tab_x', 'user_v')).resolves.toMatchObject({
      valid: false,
      seq: 1,
      reason: 'hash-mismatch',
    });
  });

  it('lands only on top of the newest entry', async () => {
    const { service } = setup();
    const stale = service.append({
      ...base,
      action: 'cast',
      value: 'agree',
      textSeq: 1,
      expectedSeq: 3,
    });
    await expect(stale).rejects.toBeInstanceOf(ConflictException);
    await expect(stale).rejects.toThrow(VOTE_BUSY);
  });

  it('turns a lost race for the next seq into 409, and rethrows anything else', async () => {
    let error: Error = Object.assign(new Error('dup'), { code: 11000 });
    const { service } = setup(() => {
      throw error;
    });
    const input = {
      ...base,
      action: 'cast' as const,
      value: 'agree' as const,
      textSeq: 1,
      expectedSeq: 0,
    };
    await expect(service.append(input)).rejects.toThrow(VOTE_BUSY);
    error = new Error('down');
    await expect(service.append(input)).rejects.toThrow('down');
  });

  it('encodes the event by position, null for a withdrawal', () => {
    expect(voteKey('t', 'u')).toBe('t:u');
    expect(
      voteEventText({ action: 'withdraw', textSeq: 2, voterTier: 'anonymous' }),
    ).toBe('["withdraw",null,2,"anonymous"]');
  });
});
