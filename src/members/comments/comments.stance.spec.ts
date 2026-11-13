import { BadRequestException, ConflictException } from '@nestjs/common';
import { harness, U } from './comments-harness.mocks-spec';
import {
  STANCE_EARLIER_WORDING,
  STANCE_NEEDS_VOTE,
  STANCE_ONLY_ON_BELIEF,
  stanceOtherVote,
} from './comments.service';

/** "Agree and comment" / "Disagree and comment" (Chunk 10). Synthetic data. */
describe('comment stance badges', () => {
  it('stores and shows the stance the writer’s vote says', async () => {
    const h = harness();
    await h.votesService.cast(await h.viewer(U.named), {
      slug: 'open-page',
      tabId: 'tab_a',
      value: 'disagree',
      baseSeq: 1,
    });
    const writer = await h.writer(U.named);
    const made = await h.commentsService.create(writer, {
      slug: 'open-page',
      tabId: 'tab_a',
      body: 'Why I disagree, synthetically.',
      stance: 'disagree',
    });
    expect(
      h.comments.docs.find((c) => c.commentId === made.commentId),
    ).toMatchObject({ stance: 'disagree' });
    const page = await h.thread('open-page', await h.viewer(), 'tab_a');
    expect(page.comments[0]).toMatchObject({ stance: 'disagree' });
    // A comment without a vote has no badge.
    await h.commentsService.create(writer, {
      slug: 'open-page',
      tabId: 'tab_a',
      body: 'Just a comment.',
    });
    const again = await h.thread('open-page', await h.viewer(), 'tab_a');
    expect(again.comments[1]).not.toHaveProperty('stance');
  });

  it('refuses a stance the vote does not say', async () => {
    const h = harness();
    const writer = await h.writer(U.named);
    const refused = h.commentsService.create(writer, {
      slug: 'open-page',
      tabId: 'tab_a',
      body: 'Claims to agree.',
      stance: 'agree',
    });
    await expect(refused).rejects.toBeInstanceOf(ConflictException);
    await expect(refused).rejects.toThrow(STANCE_NEEDS_VOTE);
    expect(h.comments.docs.filter((c) => c.source === 'native')).toHaveLength(
      0,
    );
  });

  it('says what the saved vote is when it differs, and refuses a badge for an earlier wording (fix round 1, LOW 5)', async () => {
    const h = harness();
    await h.votesService.cast(await h.viewer(U.named), {
      slug: 'open-page',
      tabId: 'tab_a',
      value: 'disagree',
      baseSeq: 1,
    });
    const writer = await h.writer(U.named);
    const other = h.commentsService.create(writer, {
      slug: 'open-page',
      tabId: 'tab_a',
      body: 'Claims to agree.',
      stance: 'agree',
    });
    await expect(other).rejects.toBeInstanceOf(ConflictException);
    await expect(other).rejects.toThrow(stanceOtherVote('disagree'));
    expect(stanceOtherVote('disagree')).toContain('"disagree"');

    // The belief is reworded: the vote is now on an earlier wording.
    await h.editor.editTabText(U.owner, 'tab_a', 'Reworded synthetically.', 1);
    const earlier = h.commentsService.create(writer, {
      slug: 'open-page',
      tabId: 'tab_a',
      body: 'Still disagree.',
      stance: 'disagree',
    });
    await expect(earlier).rejects.toThrow(STANCE_EARLIER_WORDING);
    expect(h.comments.docs.filter((c) => c.source === 'native')).toHaveLength(
      0,
    );
  });

  it('refuses a stance on a reply or on the page thread', async () => {
    const h = harness();
    await h.votesService.cast(await h.viewer(U.named), {
      slug: 'open-page',
      tabId: 'tab_a',
      value: 'agree',
      baseSeq: 1,
    });
    const writer = await h.writer(U.named);
    const root = await h.commentsService.create(writer, {
      slug: 'open-page',
      tabId: 'tab_a',
      body: 'A root.',
    });
    for (const input of [
      { slug: 'open-page', body: 'Page thread.', stance: 'agree' as const },
      {
        slug: 'open-page',
        body: 'A reply.',
        parentCommentId: root.commentId,
        stance: 'agree' as const,
      },
    ]) {
      const refused = h.commentsService.create(writer, input);
      await expect(refused).rejects.toBeInstanceOf(BadRequestException);
      await expect(refused).rejects.toThrow(STANCE_ONLY_ON_BELIEF);
    }
  });
});
