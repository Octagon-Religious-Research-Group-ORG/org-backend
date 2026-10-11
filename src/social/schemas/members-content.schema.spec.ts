import mongoose, { Types } from 'mongoose';
import { AppendOnlyViolationError } from '../append-only';
import { BeliefTabSchema } from './belief-tab.schema';
import { CommentSchema } from './comment.schema';
import { ImportRecordSchema } from './import-record.schema';
import { ProfileBlockSchema } from './profile-block.schema';

// A connection that never opens: validation and append-only hooks run before
// any command would be sent.
const connection = mongoose.createConnection();
const Tabs = connection.model('BeliefTabTest', BeliefTabSchema);
const Comments = connection.model('CommentTest', CommentSchema);
const Blocks = connection.model('ProfileBlockTest', ProfileBlockSchema);
const Imports = connection.model('ImportRecordTest', ImportRecordSchema);

const profileId = new Types.ObjectId();

function comment(overrides: Record<string, unknown> = {}) {
  return new Comments({
    commentId: 'cmt-1',
    profileId,
    body: 'I agree',
    source: 'migrated',
    legacyAuthorName: 'Tripp ORG',
    ...overrides,
  });
}

describe('members-area content schemas', () => {
  afterAll(async () => {
    await connection.close();
  });

  describe('belieftabs', () => {
    it('defaults a tab to confirmed', async () => {
      const tab = new Tabs({
        profileId,
        tabId: 'tab-1',
        title: 'God',
        order: 0,
      });
      await expect(tab.validate()).resolves.toBeUndefined();
      expect(tab.reviewStatus).toBe('confirmed');
    });

    it('rejects an unknown review status', async () => {
      const tab = new Tabs({
        profileId,
        tabId: 'tab-1',
        title: 'God',
        order: 0,
        reviewStatus: 'maybe',
      });
      await expect(tab.validate()).rejects.toThrow(/reviewStatus/);
    });
  });

  describe('comments', () => {
    it('accepts a migrated comment with a legacy author', async () => {
      await expect(comment().validate()).resolves.toBeUndefined();
    });

    it('accepts a native comment with an account author', async () => {
      await expect(
        comment({
          source: 'native',
          legacyAuthorName: undefined,
          authorUserId: 'user_a',
        }).validate(),
      ).resolves.toBeUndefined();
    });

    it.each([
      ['no author', { legacyAuthorName: undefined }],
      ['two authors', { authorUserId: 'user_a' }],
      ['an empty legacy name', { legacyAuthorName: '' }],
    ])('rejects %s', async (_name, overrides) => {
      await expect(comment(overrides).validate()).rejects.toThrow(
        /exactly one author/,
      );
    });

    it('rejects a legacy author on a native comment', async () => {
      await expect(comment({ source: 'native' }).validate()).rejects.toThrow(
        /Only migrated comments/,
      );
    });
  });

  describe('profileblocks', () => {
    const block = (overrides: Record<string, unknown>) =>
      new Blocks({
        profileId,
        blockId: 'blk-1',
        section: 'beliefs',
        kind: 'paragraph',
        order: 0,
        ...overrides,
      });

    it('lets a beliefs block belong to a tab', async () => {
      await expect(
        block({ tabId: 'tab-1' }).validate(),
      ).resolves.toBeUndefined();
    });

    it('rejects a tab on a block outside the beliefs section', async () => {
      await expect(
        block({ section: 'bio', tabId: 'tab-1' }).validate(),
      ).rejects.toThrow(/Only blocks in the beliefs section/);
    });
  });

  describe('importrecords', () => {
    it('is append-only', async () => {
      const record = Imports.hydrate({ _id: new Types.ObjectId(), profileId });
      await expect(record.deleteOne()).rejects.toBeInstanceOf(
        AppendOnlyViolationError,
      );
      await expect(
        Imports.updateOne({ profileId }, { slug: 'x' }).exec(),
      ).rejects.toBeInstanceOf(AppendOnlyViolationError);
    });

    it('rejects a source file without a valid SHA-256', async () => {
      const record = new Imports({
        profileId,
        slug: 'renan',
        pagesUrl: 'https://www.icloud.com/pages/x',
        sources: [
          { kind: 'docx', fileName: 'a.docx', bytes: 1, sha256: 'nope' },
        ],
        extractedText: 'text',
        report: {},
        importerVersion: '1',
        importedAt: new Date(),
      });
      await expect(record.validate()).rejects.toThrow(/sha256/);
    });
  });
});
