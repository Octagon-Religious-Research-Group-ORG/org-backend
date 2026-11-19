// Review round 6: every write that makes a row live (send, a crossing send,
// accept) re-checks, inside its transaction after both gate rows, that BOTH
// members still count. Here a deletion lands at the gate-row write, after
// every pre-check passed; the real-Mongo e2e forces the same with real
// transactions.
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { pairKeyOf } from './connection-rules';
import { A, D, harness, NOW } from './connections-harness.mocks-spec';

function deletedAtGate(victim: string) {
  const state: { h?: ReturnType<typeof harness> } = {};
  let fired = false;
  state.h = harness({
    beforeSettingsWrite: () => {
      if (fired) return;
      fired = true;
      const page = state.h!.profiles.docs.find(
        (doc) => (doc as { ownerUserId?: string }).ownerUserId === victim,
      ) as Record<string, unknown>;
      page.deletedAt = NOW;
    },
  });
  return state.h;
}

const live = (h: ReturnType<typeof harness>) =>
  h.connections.docs.filter((doc) => (doc as { live?: boolean }).live);

describe('a deletion between the pre-checks and the write (review round 6)', () => {
  it('send: refuses as not eligible when the sender is gone', async () => {
    const h = deletedAtGate(A);
    await expect(
      h.service.send(A, 'member-d', undefined, NOW),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(live(h)).toHaveLength(0);
  });

  it('send: refuses as not open when the recipient is gone', async () => {
    const h = deletedAtGate(D);
    await expect(
      h.service.send(A, 'member-d', undefined, NOW),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(live(h)).toHaveLength(0);
  });

  for (const [victim, error] of [
    [A, ForbiddenException],
    [D, NotFoundException],
  ] as const) {
    it(`accept: refuses when ${victim === A ? 'the acceptor' : 'the requester'} is gone, and the request stays pending`, async () => {
      const h = deletedAtGate(victim);
      h.connections.docs.push({
        _id: '0123456789abcdef01234567',
        fromUserId: D,
        toUserId: A,
        pairKey: pairKeyOf(A, D),
        status: 'pending',
        live: true,
        createdAt: NOW,
      });
      await expect(
        h.service.accept(A, '0123456789abcdef01234567', NOW),
      ).rejects.toBeInstanceOf(error);
      expect((live(h)[0] as { status: string } | undefined)?.status).toBe(
        'pending',
      );
      expect(h.notifier.connectionAccepted).not.toHaveBeenCalled();
    });
  }
});
