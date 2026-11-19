import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminRoleGuard } from '../auth/admin-role.guard';
import { ClerkAuthGuard } from '../auth/auth.guard';
import { AccountNotDeletedGuard } from '../members/account-not-deleted.guard';
import { MemberWriteThrottleGuard } from '../members/member-write-throttle.guard';
import {
  AdminConnectionTermsController,
  ConnectionTermsController,
  MyConnectionsController,
  MyConnectionWritesController,
} from './connections.controller';

const request = { auth: { payload: { sub: 'user_me' } } } as never;
const ID = '0123456789abcdef01234567';

function guardsOf(target: object) {
  return (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[]) ?? [];
}

function service() {
  const ok = () => jest.fn(() => Promise.resolve({ ok: true }));
  return {
    overview: ok(),
    relation: ok(),
    send: ok(),
    accept: ok(),
    decline: ok(),
    withdraw: ok(),
    disconnect: ok(),
    block: ok(),
    unblock: ok(),
    updateSettings: ok(),
  };
}

describe('connection controllers (Chunk 18)', () => {
  it('needs no sign-in for the feature’s name', async () => {
    const terms = { terms: jest.fn(() => Promise.resolve({ singular: 'x' })) };
    await new ConnectionTermsController(terms as never).get();
    expect(terms.terms).toHaveBeenCalled();
    expect(guardsOf(ConnectionTermsController)).toEqual([]);
  });

  it('serves only the signed-in account’s own lists', async () => {
    const s = service();
    const controller = new MyConnectionsController(s as never);
    await controller.overview(request);
    await controller.relation(request, 'member-b');
    expect(s.overview).toHaveBeenCalledWith('user_me');
    expect(s.relation).toHaveBeenCalledWith('user_me', 'member-b');
    expect(guardsOf(MyConnectionsController)).toEqual([ClerkAuthGuard]);
  });

  it('passes each write through for the signed-in account only', async () => {
    const s = service();
    const controller = new MyConnectionWritesController(s as never);
    await controller.send(request, { slug: 'member-b', note: 'hi' });
    await controller.accept(request, ID);
    await controller.decline(request, ID);
    await controller.withdraw(request, ID);
    await controller.disconnect(request, ID);
    await controller.block(request, { slug: 'member-b' });
    await controller.block(request, { connectionId: ID });
    await controller.unblock(request, ID);
    await controller.settings(request, { openTo: 'nobody' });
    await controller.settings(request, {
      contacts: [{ method: 'email', value: 'a@example.org' }],
    });
    expect(s.send).toHaveBeenCalledWith('user_me', 'member-b', 'hi');
    for (const action of [s.accept, s.decline, s.withdraw, s.disconnect]) {
      expect(action).toHaveBeenCalledWith('user_me', ID);
    }
    expect(s.block).toHaveBeenNthCalledWith(1, 'user_me', {
      slug: 'member-b',
    });
    expect(s.block).toHaveBeenNthCalledWith(2, 'user_me', {
      connectionId: ID,
    });
    expect(s.unblock).toHaveBeenCalledWith('user_me', ID);
    expect(s.updateSettings).toHaveBeenNthCalledWith(1, 'user_me', {
      openTo: 'nobody',
    });
    expect(s.updateSettings).toHaveBeenNthCalledWith(2, 'user_me', {
      contacts: [{ method: 'email', value: 'a@example.org' }],
    });
    expect(guardsOf(MyConnectionWritesController)).toEqual([
      ClerkAuthGuard,
      AccountNotDeletedGuard,
      MemberWriteThrottleGuard,
    ]);
  });

  it('lets only an admin rename the feature', async () => {
    const terms = {
      setTerms: jest.fn(() => Promise.resolve({})),
    };
    await new AdminConnectionTermsController(terms as never).rename(request, {
      singular: 'introduction',
      plural: 'introductions',
    });
    expect(terms.setTerms).toHaveBeenCalledWith(
      'introduction',
      'introductions',
      'user_me',
    );
    expect(guardsOf(AdminConnectionTermsController)).toEqual([
      ClerkAuthGuard,
      AdminRoleGuard,
      MemberWriteThrottleGuard,
    ]);
  });
});
