import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mongoose, { type Types } from 'mongoose';
import { reconcileIndexes } from '../db/index-setup';
import { main } from './import-pages';
import { buildDocx, buildPages, p } from './pages/docx-fixture';
import { readDocx } from './pages/docx-reader';
import { MongoImportStore } from './pages/mongo-store';
import { type ProfileProposal, proposeStructure } from './pages/proposal';

jest.mock('./pages/mongo-store');
jest.mock('../db/index-setup');

type Row = Record<string, unknown>;

const same = (left: unknown, right: unknown) => String(left) === String(right);

describe('import:pages database guard (the CLI itself)', () => {
  const originalArgv = process.argv;
  const originalUri = process.env.MONGODB_URI;
  let dir: string;

  function connectTo(databaseName: string) {
    const close = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(mongoose, 'createConnection').mockReturnValue({
      asPromise: () =>
        Promise.resolve({ db: { databaseName }, host: 'fake-host', close }),
    } as never);
    return close;
  }

  function run(...flags: string[]) {
    process.argv = ['node', 'import-pages', '--dir', dir, ...flags];
    return main();
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'import-pages-'));
    writeFileSync(join(dir, 'manifest.json'), '[]');
    process.env.MONGODB_URI = 'mongodb://fake-host/never-contacted';
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (reconcileIndexes as jest.Mock).mockResolvedValue({ status: 'ok' });
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env.MONGODB_URI = originalUri;
    jest.restoreAllMocks();
    jest.clearAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(['test', 'org-latest-production'])(
    'refuses %p (production is named test) and opens no store',
    async (database) => {
      const close = connectTo(database);

      await expect(run('--confirm', database, '--replace')).resolves.toBe(2);

      expect(MongoImportStore).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalled();
    },
  );

  it('refuses the test database without a matching --confirm', async () => {
    connectTo('org-testing');

    await expect(run('--confirm', 'test')).resolves.toBe(2);

    expect(MongoImportStore).not.toHaveBeenCalled();
  });

  it('proceeds on the test database when confirmed', async () => {
    connectTo('org-testing');

    await expect(run('--confirm', 'org-testing')).resolves.toBe(0);

    expect(MongoImportStore).toHaveBeenCalledTimes(1);
  });

  describe('importing real files', () => {
    const STYLES =
      '<w:style w:styleId="Heading2"><w:name w:val="Heading 2"/></w:style>' +
      '<w:style w:styleId="Heading3"><w:name w:val="Heading 3"/></w:style>';
    const H2 = '<w:pStyle w:val="Heading2"/>';
    const H3 = '<w:pStyle w:val="Heading3"/>';
    const BODY = p('Bio', H2) + p('my bio') + p('Beliefs', H2);
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    const image =
      '<w:p><w:r><w:drawing><a:blip r:embed="R1"/></w:drawing></w:r></w:p>';

    interface Member {
      slug: string;
      body: string;
      parts?: Partial<Parameters<typeof buildDocx>[0]>;
      edit?: (proposal: ProfileProposal) => void;
    }

    function member(slug: string, extra = '', parts = {}): Member {
      return { slug, body: BODY + p('I. one') + extra, parts };
    }

    function writeMembers(members: Member[]) {
      const manifest = members.map(({ slug, body, parts, edit }, at) => {
        const pagesUrl = `https://www.icloud.com/pages/id${at}`;
        const docx = buildDocx({ styles: STYLES, ...parts, body });
        writeFileSync(join(dir, `${slug}.docx`), docx);
        writeFileSync(join(dir, `${slug}.pages`), buildPages('', ''));
        const proposal = proposeStructure(
          { slug, displayName: slug, pagesUrl, visibility: 'public' },
          readDocx(docx),
        );
        edit?.(proposal);
        writeFileSync(
          join(dir, `${slug}.proposal.json`),
          JSON.stringify(proposal),
        );
        return {
          slug,
          displayName: slug,
          pagesUrl,
          visibility: 'public',
          docx: `${slug}.docx`,
          pages: `${slug}.pages`,
        };
      });
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    }

    const reportHead = () =>
      readFileSync(join(dir, 'import-report.md'), 'utf8').split('\n')[0];
    const reportJson = () =>
      JSON.parse(readFileSync(join(dir, 'import-report.json'), 'utf8')) as {
        status: string;
        profiles: { slug: string; reasons: string[] }[];
      };
    const sha = (slug: string) =>
      createHash('sha256')
        .update(readFileSync(join(dir, `${slug}.docx`)))
        .digest('hex');

    /** A store that keeps rows in memory; `createConnection` is faked. */
    function memoryStore() {
      const rows = {
        profile: [] as Row[],
        tabs: [] as Row[],
        blocks: [] as Row[],
        versions: [] as Row[],
        comments: [] as Row[],
        records: [] as Row[],
        images: [] as Row[],
      };
      let images = 0;
      const push = (list: Row[]) => (row: Row) => {
        list.push(row);
        return Promise.resolve();
      };
      const store = {
        rows,
        model: () => ({}),
        profileExists: jest.fn(() => Promise.resolve(false)),
        removeImported: jest.fn(() => Promise.resolve({})),
        createTab: push(rows.tabs),
        createBlock: push(rows.blocks),
        appendVersion: push(rows.versions),
        createComment: push(rows.comments),
        createImportRecord: jest.fn(push(rows.records)),
        createProfile: push(rows.profile),
        storeImage: (
          image: { data: Buffer },
          metadata: Record<string, unknown>,
        ) => {
          const id = `img${++images}`;
          rows.images.push({ id, ...metadata, bytes: image.data.length });
          return Promise.resolve(id);
        },
        verifyBlock: () => Promise.resolve({ valid: true, length: 1 }),
        readBack: (profileId: Types.ObjectId) =>
          Promise.resolve({
            profile: rows.profile.find((r) => same(r._id, profileId)) ?? null,
            tabs: rows.tabs.filter((r) => same(r.profileId, profileId)),
            blocks: rows.blocks.filter((r) => same(r.profileId, profileId)),
            versions: rows.versions.filter((r) =>
              rows.blocks.some(
                (b) => b.blockId === r.blockId && same(b.profileId, profileId),
              ),
            ),
            comments: rows.comments.filter((r) => same(r.profileId, profileId)),
            importRecords: rows.records.filter((r) =>
              same(r.profileId, profileId),
            ),
            images: rows.images,
          }),
      };
      (MongoImportStore as jest.Mock).mockImplementation(() => store);
      return store;
    }

    const refusesInDryRun = async (reason: string) => {
      const connect = jest.spyOn(mongoose, 'createConnection');
      await expect(run('--dry-run')).resolves.toBe(1);
      expect(connect).not.toHaveBeenCalled();
      expect(reportHead()).toBe('# Pages import report: MISMATCH');
      expect(
        reportJson().profiles.flatMap((profile) => profile.reasons),
      ).toEqual(expect.arrayContaining([expect.stringContaining(reason)]));
    };

    it('passes a clean profile in a dry run without touching a database', async () => {
      writeMembers([member('alpha')]);
      const connect = jest.spyOn(mongoose, 'createConnection');

      await expect(run('--dry-run')).resolves.toBe(0);

      expect(connect).not.toHaveBeenCalled();
      expect(reportHead()).toBe('# Pages import report: OK');
    });

    it.each<[string, Member]>([
      [
        'a paragraph too long for a version',
        member('beta', p('II. ' + 'y'.repeat(25_000))),
      ],
      [
        'an empty comment body',
        member(
          'beta',
          '<w:p><w:commentRangeStart w:id="1"/><w:r><w:t>II. a</w:t></w:r><w:commentRangeEnd w:id="1"/></w:p>',
          { comments: '<w:comment w:id="1" w:author="A"><w:p/></w:comment>' },
        ),
      ],
      [
        'a picture that cannot be decoded',
        member('beta', image, {
          rels: '<Relationship Id="R1" Target="media/a.png"/>',
          media: { 'word/media/a.png': new Uint8Array([1, 2, 3]) },
        }),
      ],
      [
        'a picture relationship outside the package',
        member('beta', image, {
          rels: '<Relationship Id="R1" Target="../media/up.png"/>',
          media: { 'word/media/up.png': new Uint8Array([1]) },
        }),
      ],
      ['a one-letter address', member('z')],
    ])('fails a dry run over %s, in a later profile', async (_name, bad) => {
      writeMembers([member('alpha'), bad]);
      await refusesInDryRun('row or picture check(s) failed');
    });

    it('accepts a picture in an empty heading', async () => {
      writeMembers([
        member(
          'beta',
          `<w:p><w:pPr>${H3}</w:pPr><w:r><w:drawing><a:blip r:embed="R1"/></w:drawing></w:r></w:p>`,
          {
            rels: '<Relationship Id="R1" Target="media/a.png"/>',
            media: { 'word/media/a.png': PNG },
          },
        ),
      ]);
      await expect(run('--dry-run')).resolves.toBe(0);
    });

    describe('the review gate', () => {
      const flagged = (reviewed: unknown): Member => ({
        ...member('alpha', p('(Fill this in)')),
        edit: (proposal) => {
          proposal.reviewed = reviewed as ProfileProposal['reviewed'];
        },
      });

      it('blocks a flagged profile with no review', async () => {
        writeMembers([member('alpha', p('(Fill this in)'))]);
        await refusesInDryRun('needs review');
      });

      it.each([
        ['null', null],
        ['empty fields', { by: '', at: '' }],
        ['no hash', { by: 'Sam', at: '2026-11-08T10:00:00Z' }],
      ])(
        'blocks a review that is %s, saying how to fix it',
        async (_n, reviewed) => {
          writeMembers([flagged(reviewed)]);
          await refusesInDryRun('Re-review the profile against its .docx');
          expect(reportJson().profiles[0].reasons[0]).toContain(sha('alpha'));
        },
      );

      it('blocks a review of a document that has since changed', async () => {
        writeMembers([
          flagged({
            by: 'Sam',
            at: '2026-11-08T10:00:00Z',
            sourceSha256: 'b'.repeat(64),
          }),
        ]);
        await refusesInDryRun('the .docx has changed since this review');
      });

      it('accepts a review tied to the document as it is', async () => {
        writeMembers([flagged(undefined)]);
        const path = join(dir, 'alpha.proposal.json');
        const proposal = JSON.parse(
          readFileSync(path, 'utf8'),
        ) as ProfileProposal;
        proposal.reviewed = {
          by: 'Sam',
          at: '2026-11-08T10:00:00Z',
          sourceSha256: sha('alpha'),
        };
        writeFileSync(path, JSON.stringify(proposal));

        await expect(run('--dry-run')).resolves.toBe(0);
      });
    });

    it('imports, reads every row back and reports OK', async () => {
      writeMembers([member('alpha'), member('beta')]);
      connectTo('org-testing');
      const store = memoryStore();

      await expect(run('--confirm', 'org-testing')).resolves.toBe(0);

      expect(reportHead()).toBe('# Pages import report: OK');
      expect(store.rows.profile).toHaveLength(2);
    });

    it('keeps a Legal-named category of beliefs in the import record', async () => {
      writeMembers([
        {
          slug: 'alpha',
          body:
            BODY +
            p('Legal Rights and Liberty', H3) +
            p('I. MEMBER_BELIEF_MARKER') +
            p('Legal', H2) +
            p('A LEGAL_SECTION_MARKER'),
          edit: (proposal) => {
            proposal.reviewed = { by: 'S', at: '2026-11-08' };
          },
        },
      ]);
      connectTo('org-testing');
      const store = memoryStore();
      // The review is rewritten once the document's hash is known.
      const path = join(dir, 'alpha.proposal.json');
      const proposal = JSON.parse(
        readFileSync(path, 'utf8'),
      ) as ProfileProposal;
      proposal.reviewed!.sourceSha256 = sha('alpha');
      writeFileSync(path, JSON.stringify(proposal));

      await expect(run('--confirm', 'org-testing')).resolves.toBe(0);

      const record = store.rows.records[0];
      expect(record.extractedText).toContain('MEMBER_BELIEF_MARKER');
      expect(record.extractedText).not.toContain('LEGAL_SECTION_MARKER');
    });

    it('says so when a profile write was swallowed', async () => {
      writeMembers([member('alpha')]);
      connectTo('org-testing');
      const store = memoryStore();
      store.createProfile = () => Promise.resolve();

      await expect(run('--confirm', 'org-testing')).resolves.toBe(1);

      expect(reportHead()).toBe('# Pages import report: READ-BACK MISMATCH');
      expect(console.error).toHaveBeenCalledWith(
        expect.stringMatching(/^profile .*: missing$/),
      );
      expect(console.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('imported and verified'),
      );
    });

    it('reports FAILED, naming the profile and how to clear it, on a write failure', async () => {
      writeMembers([member('alpha'), member('beta')]);
      connectTo('org-testing');
      const store = memoryStore();
      store.createImportRecord
        .mockImplementationOnce(() => Promise.resolve())
        .mockImplementationOnce(() => Promise.reject(new Error('disk full')));

      await expect(run('--confirm', 'org-testing')).resolves.toBe(1);

      const report = readFileSync(join(dir, 'import-report.md'), 'utf8');
      expect(report.split('\n')[0]).toBe('# Pages import report: FAILED');
      expect(report).toContain('The write of profile beta failed: disk full');
      expect(report).toContain('--replace');
      expect(reportJson().status).toBe('failed');
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('--replace'),
      );
    });

    it('reports a failure that is not an Error too', async () => {
      writeMembers([member('alpha')]);
      connectTo('org-testing');
      const store = memoryStore();
      store.createImportRecord.mockImplementationOnce(
        () => Promise.reject('plain string') as never,
      );

      await expect(run('--confirm', 'org-testing')).resolves.toBe(1);

      expect(readFileSync(join(dir, 'import-report.md'), 'utf8')).toContain(
        'failed: plain string',
      );
    });

    it('writes nothing at all when one address is already taken', async () => {
      writeMembers([member('alpha'), member('beta')]);
      connectTo('org-testing');
      const store = memoryStore();
      store.profileExists.mockImplementation((slug?: unknown) =>
        Promise.resolve(slug === 'beta'),
      );

      await expect(run('--confirm', 'org-testing')).resolves.toBe(2);

      expect(store.createImportRecord).not.toHaveBeenCalled();
      expect(store.rows.images).toEqual([]);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('"beta" already exists'),
      );
    });
  });
});
