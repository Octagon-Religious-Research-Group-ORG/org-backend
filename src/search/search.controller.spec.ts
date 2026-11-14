/* eslint-disable @typescript-eslint/unbound-method */
import { GUEST_VIEWER, type Viewer } from '../members/profile-access';
import { SEARCH_THROTTLE } from '../config/throttle';
import {
  AdminSearchFragmentsController,
  SearchController,
} from './search.controller';

const MEMBER: Viewer = {
  kind: 'named-member',
  userId: 'user_x',
  isAdmin: false,
};

function build(viewer: Viewer = GUEST_VIEWER) {
  const members = { resolveViewer: jest.fn(() => Promise.resolve(viewer)) };
  const response = { total: 4, results: [] };
  const search = {
    search: jest.fn(() => Promise.resolve(response)),
    empty: jest.fn((query: string) => ({ query, total: 0 })),
  };
  const fragments = {
    record: jest.fn(() => Promise.resolve()),
    fragments: jest.fn(() => Promise.resolve(['lamp'])),
    adminView: jest.fn(() => Promise.resolve([])),
    setHidden: jest.fn(() => Promise.resolve({ term: 'lamp', hidden: true })),
  };
  const controller = new SearchController(
    members as never,
    search as never,
    fragments as never,
  );
  return { controller, members, search, fragments, response };
}

const req = (extra: Record<string, unknown> = {}) =>
  ({ ip: '10.0.0.1', headers: {}, ...extra }) as never;

describe('SearchController', () => {
  it('normalises the query and counts a first page by address for a guest', async () => {
    const { controller, search, fragments, response } = build();
    expect(await controller.find(req(), { q: '  LAMP  ' })).toBe(response);
    expect(search.search).toHaveBeenCalledWith('lamp', 'all', 1, GUEST_VIEWER);
    expect(fragments.record).toHaveBeenCalledWith(
      'lamp',
      4,
      GUEST_VIEWER,
      'ip:10.0.0.1',
    );
  });

  it('counts a member by account, and never a later page', async () => {
    const { controller, fragments } = build(MEMBER);
    await controller.find(req(), { q: 'lamp', type: 'beliefs' });
    expect(fragments.record).toHaveBeenCalledWith(
      'lamp',
      4,
      MEMBER,
      'user:user_x',
    );
    fragments.record.mockClear();
    await controller.find(req(), { q: 'lamp', page: 2 });
    expect(fragments.record).not.toHaveBeenCalled();
  });

  it('answers a too-short query without reading anything', async () => {
    const { controller, members, search } = build();
    expect(await controller.find(req(), { q: ' a ' })).toEqual({
      query: 'a',
      total: 0,
    });
    expect(members.resolveViewer).not.toHaveBeenCalled();
    expect(search.search).not.toHaveBeenCalled();
  });

  it('lists the suggested fragments', async () => {
    const { controller } = build();
    expect(await controller.suggested()).toEqual({ fragments: ['lamp'] });
  });

  it('rations searches per visitor', () => {
    expect(
      Reflect.getMetadata(
        'THROTTLER:LIMITdefault',
        SearchController.prototype.find,
      ),
    ).toBe(SEARCH_THROTTLE.limit);
  });
});

describe('AdminSearchFragmentsController', () => {
  it('lists and hides fragments as the signed-in admin', async () => {
    const { fragments } = build();
    const controller = new AdminSearchFragmentsController(fragments as never);
    expect(await controller.list()).toEqual({ fragments: [] });
    await controller.setHidden(
      req({ auth: { payload: { sub: 'user_admin' } } }),
      { term: 'lamp', hidden: true, reason: 'r' },
    );
    expect(fragments.setHidden).toHaveBeenCalledWith(
      'lamp',
      true,
      'user_admin',
      'r',
    );
  });
});
