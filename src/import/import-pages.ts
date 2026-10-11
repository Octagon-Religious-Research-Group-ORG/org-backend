/**
 * Imports Apple Pages member profiles (plan §7, Chunk 5).
 *
 *   npm run build
 *   npm run import:pages -- --dir <folder> --propose           # write missing <slug>.proposal.json
 *   npm run import:pages -- --dir <folder> --dry-run           # check everything, write nothing
 *   npm run import:pages -- --dir <folder> --confirm <database>
 *
 * <folder>/manifest.json lists the profiles:
 *   [{ "slug", "displayName", "pagesUrl", "visibility", "docx", "pages" }]
 * with the .docx and .pages files next to it. Member documents must never be
 * committed: keep the folder outside every repository.
 *
 * The import refuses unless EVERY profile checks ok (all or nothing), the
 * database name contains "test" (production import is a separate, later
 * decision), and the managed indexes exist. After writing, it reads every
 * profile back and re-verifies every block's hash chain.
 *
 * Exit codes: 0 ok · 1 mismatch · 2 refused · 3 cannot measure.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import mongoose from 'mongoose';
import { reconcileIndexes } from '../db/index-setup';
import { MANAGED_SCHEMAS } from '../db/managed-schemas';
import { PROFILE_VISIBILITIES } from '../social/schemas/social-profile.schema';
import type { ImportSourceFile } from '../social/schemas/import-record.schema';
import { readDocx, type DocxDocument } from './pages/docx-reader';
import { executeImport } from './pages/execute-import';
import { processImage } from './pages/image';
import {
  buildImportPlan,
  pagesKey,
  type ImportPlan,
} from './pages/import-plan';
import { MongoImportStore } from './pages/mongo-store';
import {
  type CheckStatus,
  crossCheck,
  readPages,
  type PagesPackage,
} from './pages/pages-reader';
import {
  checkProposal,
  type ProfileProposal,
  proposeStructure,
} from './pages/proposal';
import {
  buildProfileReport,
  overallStatus,
  type ProfileReport,
} from './pages/report';

/** Exit codes; every check status has one (an unmapped status must never exit 0). */
const EXIT: Record<CheckStatus, number> = {
  ok: 0,
  mismatch: 1,
  'cannot-measure': 3,
};

interface ManifestEntry {
  slug: string;
  displayName: string;
  pagesUrl: string;
  visibility: ProfileProposal['visibility'];
  docx: string;
  pages?: string;
}

interface Loaded {
  entry: ManifestEntry;
  docx: DocxDocument;
  pages?: PagesPackage;
  sources: ImportSourceFile[];
  files: Map<string, Uint8Array>;
}

function sha256(data: Uint8Array) {
  return createHash('sha256').update(data).digest('hex');
}

function load(dir: string, entry: ManifestEntry): Loaded {
  const docxBytes = new Uint8Array(readFileSync(join(dir, entry.docx)));
  const sources: ImportSourceFile[] = [
    {
      kind: 'docx',
      fileName: entry.docx,
      bytes: docxBytes.length,
      sha256: sha256(docxBytes),
    },
  ];
  const docx = readDocx(docxBytes);
  const files = new Map<string, Uint8Array>(docx.media);
  let pages: PagesPackage | undefined;
  if (entry.pages) {
    const pagesBytes = new Uint8Array(readFileSync(join(dir, entry.pages)));
    sources.push({
      kind: 'pages',
      fileName: entry.pages,
      bytes: pagesBytes.length,
      sha256: sha256(pagesBytes),
    });
    pages = readPages(pagesBytes);
    for (const file of pages.dataFiles) files.set(file.path, file.data);
  }
  return { entry, docx, pages, sources, files };
}

function readManifest(dir: string): ManifestEntry[] {
  const manifest = JSON.parse(
    readFileSync(join(dir, 'manifest.json'), 'utf8'),
  ) as ManifestEntry[];
  const slugs = new Set<string>();
  for (const entry of manifest) {
    if (slugs.has(entry.slug)) throw new Error(`Duplicate slug ${entry.slug}.`);
    slugs.add(entry.slug);
    if (!PROFILE_VISIBILITIES.includes(entry.visibility)) {
      throw new Error(
        `${entry.slug}: unknown visibility "${entry.visibility}".`,
      );
    }
    if (!pagesKey(entry.pagesUrl)) {
      throw new Error(`${entry.slug}: pagesUrl is not an iCloud Pages link.`);
    }
  }
  return manifest;
}

function proposalPath(dir: string, slug: string) {
  return join(dir, `${slug}.proposal.json`);
}

/** Text kept in the import record: everything except the dropped Legal section. */
function extractedText(docx: DocxDocument, proposal: ProfileProposal) {
  const legal = new Set(
    proposal.dropped
      .filter((drop) => /^Legal/.test(drop.reason))
      .flatMap((drop) => drop.paragraphs),
  );
  return docx.paragraphs
    .filter((paragraph) => !legal.has(paragraph.index))
    .map((paragraph) => paragraph.text)
    .join('\n');
}

function writeReports(dir: string, reports: ProfileReport[], extra: object) {
  const status = overallStatus(reports);
  writeFileSync(
    join(dir, 'import-report.json'),
    JSON.stringify({ status, ...extra, profiles: reports }, null, 2),
  );
  const lines = [
    `# Pages import report: ${status.toUpperCase()}`,
    '',
    '| Profile | Status | Tabs | Blocks | Comments (replies) | On tabs | Unplaced | Images | Pages links left | Review flags | Reasons |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...reports.map(
      (r) =>
        `| ${r.slug} | ${r.status} | ${r.counts.tabs} | ${r.counts.blocks} | ${r.counts.comments} (${r.counts.replies}) | ${r.counts.commentsOnTabs} | ${r.unplacedComments.length} | ${r.counts.profileImages} | ${r.unmappedPagesLinks.length} | ${r.reviewFlags.length}${r.reviewed ? ' (reviewed)' : ''} | ${r.reasons.join('; ') || '—'} |`,
    ),
  ];
  writeFileSync(join(dir, 'import-report.md'), `${lines.join('\n')}\n`);
  return status;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const dir = value('--dir');
  if (!dir) {
    console.error('Pass --dir <folder>.');
    return 2;
  }
  const manifest = readManifest(dir);

  if (args.includes('--propose')) {
    for (const entry of manifest) {
      const path = proposalPath(dir, entry.slug);
      if (existsSync(path)) {
        console.warn(`${entry.slug}: proposal exists, left as is.`);
        continue;
      }
      const loaded = load(dir, entry);
      const proposal = proposeStructure(
        {
          slug: entry.slug,
          displayName: entry.displayName,
          pagesUrl: entry.pagesUrl,
          visibility: entry.visibility,
        },
        loaded.docx,
        loaded.pages,
      );
      writeFileSync(path, JSON.stringify(proposal, null, 2));
      console.warn(
        `${entry.slug}: proposal written (${proposal.tabs.length} tabs).`,
      );
    }
    return 0;
  }

  const slugByPagesKey = new Map(
    manifest.map((entry) => [pagesKey(entry.pagesUrl)!, entry.slug]),
  );
  const prepared: {
    loaded: Loaded;
    proposal: ProfileProposal;
    plan?: ImportPlan;
    report: ProfileReport;
  }[] = [];
  for (const entry of manifest) {
    const loaded = load(dir, entry);
    const path = proposalPath(dir, entry.slug);
    if (!existsSync(path)) {
      console.error(
        `${entry.slug}: no proposal; run --propose and review it first.`,
      );
      return 2;
    }
    const proposal = JSON.parse(readFileSync(path, 'utf8')) as ProfileProposal;
    const check = checkProposal(proposal, loaded.docx, loaded.pages);
    const plan =
      check.errors.length === 0
        ? buildImportPlan(
            proposal,
            loaded.docx,
            check.placements,
            slugByPagesKey,
          )
        : undefined;
    const report = buildProfileReport(
      entry.slug,
      loaded.docx,
      check,
      plan,
      loaded.pages ? crossCheck(loaded.docx, loaded.pages) : undefined,
      proposal.reviewed !== undefined,
    );
    prepared.push({ loaded, proposal, plan, report });
  }

  const reports = prepared.map((item) => item.report);
  const status = writeReports(dir, reports, { mode: 'check' });
  console.warn(`Checks: ${status}. Report: ${join(dir, 'import-report.md')}`);
  if (args.includes('--dry-run') || status !== 'ok') {
    return EXIT[status];
  }

  const confirmed = value('--confirm');
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set.');
    return EXIT['cannot-measure'];
  }
  const connection = await mongoose.createConnection(uri).asPromise();
  try {
    const database = connection.db?.databaseName ?? '(unknown)';
    console.warn(`Database: ${database} on ${connection.host}`);
    if (confirmed !== database || !/test/i.test(database)) {
      console.error(
        `Refused: pass --confirm ${database}; only a test database is allowed.`,
      );
      return 2;
    }
    const store = new MongoImportStore(connection);
    const indexes = await reconcileIndexes(
      MANAGED_SCHEMAS.map(({ name }) => store.model(name)),
      { dryRun: true },
    );
    if (indexes.status !== 'ok') {
      console.error(
        'Refused: managed indexes are missing; run db:indexes first.',
      );
      return 2;
    }

    const results: Record<string, unknown>[] = [];
    for (const item of prepared) {
      const result = await executeImport(
        item.plan!,
        {
          files: item.loaded.files,
          sources: item.loaded.sources,
          extractedText: extractedText(item.loaded.docx, item.proposal),
          report: item.report as unknown as Record<string, unknown>,
        },
        store,
        processImage,
      );

      // Read back what was written (Rule 26.1) and re-verify every chain.
      const profileId = new mongoose.Types.ObjectId(result.profileId);
      const counts = {
        tabs: await store.model('BeliefTab').countDocuments({ profileId }),
        blocks: await store.model('ProfileBlock').countDocuments({ profileId }),
        comments: await store.model('Comment').countDocuments({ profileId }),
      };
      const brokenChains: string[] = [];
      for (const block of item.plan!.blocks) {
        const verdict = await store.verifyBlock(block.blockId);
        if (!verdict.valid || verdict.length !== 1) {
          brokenChains.push(block.blockId);
        }
      }
      const matches =
        counts.tabs === result.tabs &&
        counts.blocks === result.blocks &&
        counts.comments === result.comments &&
        brokenChains.length === 0;
      results.push({
        slug: item.plan!.slug,
        ...result,
        readBack: counts,
        brokenChains,
        matches,
      });
      console.warn(
        `${item.plan!.slug}: ${matches ? 'imported and verified' : 'READ-BACK MISMATCH'} ` +
          `(${counts.tabs} tabs, ${counts.blocks} blocks, ${counts.comments} comments, ${result.imageIds.length} images)`,
      );
    }

    const allMatch = results.every((result) => result.matches === true);
    writeReports(dir, reports, { mode: 'import', database, results });
    return allMatch ? 0 : 1;
  } finally {
    await connection.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(EXIT['cannot-measure']);
  },
);
