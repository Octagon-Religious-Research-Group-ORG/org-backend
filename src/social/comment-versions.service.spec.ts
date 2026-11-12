/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.any() matchers */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import {
  CommentVersionsService,
  STALE_COMMENT_EDIT,
} from './comment-versions.service';
import { MAX_COMMENT_VERSION_TEXT } from './schemas/comment-version.schema';

function setup() {
  const model = fakeModel([], { unique: [['commentId', 'seq']] });
  return { model, service: new CommentVersionsService(model as never) };
}

describe('CommentVersionsService', () => {
  it('chains versions with server time and verifies them', async () => {
    const { model, service } = setup();
    const first = await service.append({
      commentId: 'c1',
      text: 'One \ud83d',
      authorUserId: 'u',
      expectedSeq: 0,
    });
    expect(first.seq).toBe(1);
    await service.append({
      commentId: 'c1',
      text: 'Two',
      authorUserId: 'u',
      expectedSeq: 1,
    });
    expect(model.docs[0]).toMatchObject({ text: 'One \ufffd' });
    await expect(service.verify('c1')).resolves.toMatchObject({
      valid: true,
      length: 2,
    });
    model.docs[0].text = 'Changed';
    await expect(service.verify('c1')).resolves.toMatchObject({
      valid: false,
      seq: 1,
      reason: 'hash-mismatch',
    });
    await expect(service.heads(['c1', 'none'])).resolves.toEqual(
      new Map([['c1', { seq: 2, text: 'Two', createdAt: expect.any(Date) }]]),
    );
    await expect(service.heads([])).resolves.toEqual(new Map());
    await expect(service.page('c1', 1, 5)).resolves.toMatchObject([{ seq: 1 }]);
  });

  it('refuses a stale base and a lost race, and passes other failures on', async () => {
    const { model, service } = setup();
    const input = {
      commentId: 'c1',
      text: 'x',
      authorUserId: 'u',
      expectedSeq: 0,
    };
    await service.append(input);
    await expect(service.append(input)).rejects.toThrow(
      new ConflictException(STALE_COMMENT_EDIT),
    );
    // Lost the race: the head read said 1, the insert found 2 taken.
    const realFindOne = model.findOne;
    jest.spyOn(model, 'findOne').mockImplementationOnce(realFindOne);
    await service.append({ ...input, expectedSeq: 1 });
    jest.spyOn(model, 'findOne').mockImplementationOnce(() => {
      const q = realFindOne({ commentId: 'c1', seq: 1 });
      return { ...q, sort: () => q };
    });
    await expect(service.append({ ...input, expectedSeq: 1 })).rejects.toThrow(
      new ConflictException(STALE_COMMENT_EDIT),
    );
    jest.spyOn(model, 'create').mockRejectedValueOnce(new Error('disk full'));
    await expect(service.append({ ...input, expectedSeq: 2 })).rejects.toThrow(
      'disk full',
    );
  });

  it('refuses empty and over-long text', async () => {
    const { service } = setup();
    for (const text of ['', 'a'.repeat(MAX_COMMENT_VERSION_TEXT + 1)]) {
      await expect(
        service.append({
          commentId: 'c',
          text,
          authorUserId: 'u',
          expectedSeq: 0,
        }),
      ).rejects.toThrow(BadRequestException);
    }
  });
});
