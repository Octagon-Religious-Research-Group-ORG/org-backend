import type { AuthenticatedRequest } from '../../auth/auth.types';
import type { MembersService } from '../members.service';
import {
  AgreedBeliefsController,
  VoteWritesController,
} from './votes.controller';
import type { VotesService } from './votes.service';

const request = {
  auth: { payload: { sub: 'user_v' } },
  headers: {},
} as unknown as AuthenticatedRequest;

function setup() {
  const viewer = { kind: 'named-member', userId: 'user_v', isAdmin: false };
  const members = {
    resolveViewer: jest.fn(() => Promise.resolve(viewer)),
  } as unknown as MembersService;
  const votes = {
    cast: jest.fn(() => Promise.resolve('cast')),
    withdraw: jest.fn(() => Promise.resolve('withdrawn')),
    agreedPage: jest.fn(() => Promise.resolve('page')),
  };
  return { viewer, members, votes };
}

describe('votes controllers', () => {
  it('pass the resolved viewer and only the validated fields', async () => {
    const { viewer, members, votes } = setup();
    const writes = new VoteWritesController(
      members,
      votes as unknown as VotesService,
    );
    await expect(
      writes.cast(request, {
        slug: 'a-page',
        tabId: 'tab_1',
        value: 'agree',
        baseSeq: 2,
        extra: 'dropped',
      } as never),
    ).resolves.toBe('cast');
    expect(votes.cast).toHaveBeenCalledWith(viewer, {
      slug: 'a-page',
      tabId: 'tab_1',
      value: 'agree',
      baseSeq: 2,
    });
    await expect(
      writes.withdraw(request, { slug: 'a-page', tabId: 'tab_1' }),
    ).resolves.toBe('withdrawn');
    expect(votes.withdraw).toHaveBeenCalledWith(
      { ...viewer, userId: 'user_v' },
      'a-page',
      'tab_1',
    );

    const list = new AgreedBeliefsController(
      members,
      votes as unknown as VotesService,
    );
    await expect(list.list(request, { after: '2.0.tab_1' })).resolves.toBe(
      'page',
    );
    expect(votes.agreedPage).toHaveBeenCalledWith(viewer, '2.0.tab_1');
  });
});
