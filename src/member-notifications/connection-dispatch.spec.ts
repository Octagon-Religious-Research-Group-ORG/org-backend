// Review round 5: an immediate email whose `refs` are re-pointed while the
// dispatcher holds it is not dropped as "no longer visible". Connection
// request emails are digest-only (`IMMEDIATE_CATEGORIES`), so this guards the
// dispatcher for any re-pointed row; the test drives it with a stand-in.
import { deliveryFor, DEFAULT_PREFS } from './notification-kinds';
import { harness } from './notifications-harness.mocks-spec';

describe('the dispatcher and a re-pointed row', () => {
  it('connection request emails never go through it', () => {
    const prefs = { ...DEFAULT_PREFS, off: [] };
    expect(deliveryFor('connectionRequests', prefs)).toBe('digest');
    expect(deliveryFor('connectionAccepts', prefs)).toBe('digest');
  });

  it('puts the row back instead of dropping it, and sends it about the new refs', async () => {
    const h = harness();
    const row = h.queued({
      userId: 'user_b',
      kind: 'claim-approved',
      category: 'claims',
      delivery: 'immediate',
      refs: { commentId: 'hidden' },
    });
    // Deterministic interleaving: while the dispatcher describes the old
    // refs, they are re-pointed (as MemberNotifier does) to something shown.
    h.targets.describe.mockImplementationOnce(() => {
      const held = h.queue.docs.find((d) => d._id === row._id)!;
      held.refs = { commentId: 'shown' };
      held.refsVersion = 1;
      return Promise.resolve(undefined);
    });
    // The same pass takes it again and sends it, about the new refs.
    await h.dispatcher.tick();
    expect(h.mail.sendNotice).toHaveBeenCalledTimes(1);
    expect(h.queue.docs[0]).toMatchObject({
      status: 'sent',
      refs: { commentId: 'shown' },
    });
    expect(h.targets.describe).toHaveBeenCalledTimes(2);
  });
});
