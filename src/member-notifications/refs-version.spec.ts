// Review round 5: the "no longer visible" drop of a row re-pointed before.
import { harness, NOW } from './notifications-harness.mocks-spec';
import { sameRefs } from './digest-sender';

describe('refsVersion', () => {
  it('drops a row re-pointed earlier, once what it now says is gone too', async () => {
    const h = harness();
    h.queued({
      userId: 'user_a',
      kind: 'comment-on-page',
      category: 'comments',
      delivery: 'digest',
      refs: { commentId: 'hidden' },
      refsVersion: 2,
    });
    await h.digests.run(NOW);
    expect(h.queue.docs[0]).toMatchObject({
      status: 'skipped',
      outcome: 'no longer visible',
    });
    expect(sameRefs(2)).toEqual({ refsVersion: 2 });
  });
});
