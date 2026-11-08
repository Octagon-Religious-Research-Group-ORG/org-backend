/**
 * Imports Apple Pages member profiles (plan §7, Chunk 5).
 *
 *   npm run build
 *   npm run import:pages -- --dir <folder> --propose           # write missing <slug>.proposal.json
 *   npm run import:pages -- --dir <folder> --dry-run           # check everything, write nothing
 *   npm run import:pages -- --dir <folder> --confirm <database>
 *   npm run import:pages -- --dir <folder> --confirm <database> --replace
 *     (test databases only: first removes earlier imports of these profiles)
 *
 * <folder>/manifest.json lists the profiles:
 *   [{ "slug", "displayName", "pagesUrl", "visibility", "docx", "pages" }]
 * with the .docx and .pages files next to it. Member documents must never be
 * committed: keep the folder outside every repository.
 *
 * The import refuses unless EVERY profile checks ok (all or nothing), the
 * database is on the exact list in import-guard.ts (production import is a
 * separate, later decision), and the managed indexes exist. The check phase
 * validates every planned row against the real schemas and converts every
 * picture, so a dry run fails for the same reasons a real run would. After
 * writing, it reads every profile back and compares it with what was planned,
 * and re-verifies every block's hash chain.
 *
 * There are no transactions: a write that fails part-way leaves earlier
 * profiles imported. The report then says FAILED and names the profile, and
 * re-running with --replace clears it (test databases only).
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
import { importDatabaseRefusal } from './import-guard';
import { readDocx, type DocxDocument } from './pages/docx-reader';
import { executeImport } from './pages/execute-import';
import { processImage } from './pages/image';
import { preflightImport } from './pages/preflight';
import { compareReadBack } from './pages/read-back';
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
  isLegalDrop,
  type ProfileProposal,
  proposalSha256,
  proposeStructure,
  type ReviewBinding,
  reviewProblems,
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
  anonymous?: boolean;
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
    proposal.dropped.filter(isLegalDrop).flatMap((drop) => drop.paragraphs),
  );
  return docx.paragraphs
    .filter((paragraph) => !legal.has(paragraph.index))
    .map((paragraph) => paragraph.text)
    .join('\n');
}

/**
 * Writes both reports. `outcome` overrides the checks' status once writing has
 * begun: every profile can check ok and the import can still fail afterwards.
 */
function writeReports(
  dir: string,
  reports: ProfileReport[],
  extra: object,
  outcome?: { status: string; detail: string[] },
) {
  const status = overallStatus(reports);
  writeFileSync(
    join(dir, 'import-report.json'),
    JSON.stringify(
      { status: outcome?.status ?? status, ...extra, profiles: reports },
      null,
      2,
    ),
  );
  const lines = [
    `# Pages import report: ${(outcome?.status ?? status).toUpperCase()}`,
    '',
    ...(outcome ? [...outcome.detail, ''] : []),
    '| Profile | Status | Tabs | Blocks | Comments (replies) | On tabs | Unplaced | Images | Pages links left | Legal left out | Review flags | Reasons |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...reports.map(
      (r) =>
        `| ${r.slug} | ${r.status} | ${r.counts.tabs} | ${r.counts.blocks} | ${r.counts.comments} (${r.counts.replies}) | ${r.counts.commentsOnTabs} | ${r.unplacedComments.length} | ${r.counts.profileImages} | ${r.unmappedPagesLinks.length} | ${r.legalDropped.paragraphs} ¶, ${r.legalDropped.characters} chars | ${r.reviewFlags.length}${r.reviewed ? ' (reviewed)' : ''} | ${r.reasons.join('; ') || '—'} |`,
    ),
  ];
  writeFileSync(join(dir, 'import-report.md'), `${lines.join('\n')}\n`);
  return status;
}

export async function main(): Promise<number> {
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
  if (manifest.length === 0) {
    console.error('Refused: manifest.json lists no profiles.');
    return 2;
  }

  if (args.includes('--propose')) {
    // A picture whose exact bytes appear in more than one member's package is
    // template art (The founder's onboarding template ships an example picture).
    const seen = new Map<string, Set<string>>();
    for (const entry of manifest) {
      for (const file of load(dir, entry).pages?.dataFiles ?? []) {
        const owners = seen.get(file.sha256) ?? new Set<string>();
        owners.add(entry.slug);
        seen.set(file.sha256, owners);
      }
    }
    const templateSha256 = new Set(
      [...seen].filter(([, owners]) => owners.size > 1).map(([sha]) => sha),
    );
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
          ...(entry.anonymous ? { anonymous: true } : {}),
        },
        loaded.docx,
        loaded.pages,
        { templateSha256 },
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
    extracted: string;
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
    const binding: ReviewBinding = {
      sourceSha256: loaded.sources[0].sha256,
      pagesSha256: loaded.sources[1]?.sha256 ?? 'none',
      proposalSha256: proposalSha256(proposal),
    };
    const voidReview = reviewProblems(proposal, binding);
    const plan =
      check.errors.length === 0
        ? buildImportPlan(
            proposal,
            loaded.docx,
            check.placements,
            slugByPagesKey,
          )
        : undefined;
    const extracted = extractedText(loaded.docx, proposal);
    const preflightErrors = plan
      ? await preflightImport(
          plan,
          {
            files: loaded.files,
            sources: loaded.sources,
            extractedText: extracted,
          },
          processImage,
        )
      : [];
    const report = buildProfileReport(
      entry.slug,
      loaded.docx,
      check,
      plan,
      loaded.pages ? crossCheck(loaded.docx, loaded.pages) : undefined,
      proposal.reviewed !== undefined && voidReview.length === 0,
      {
        reviewProblems: voidReview,
        preflightErrors,
        binding,
        acceptedWarnings: proposal.reviewed?.acceptedWarnings,
      },
    );
    prepared.push({ loaded, proposal, plan, report, extracted });
  }

  const reports = prepared.map((item) => item.report);
  const status = writeReports(dir, reports, { mode: 'check' });
  console.warn(`Checks: ${status}. Report: ${join(dir, 'import-report.md')}`);
  for (const report of reports) {
    for (const reason of report.reasons) {
      console.error(`${report.slug}: ${reason}`);
    }
  }
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
    const refusal = importDatabaseRefusal(database, confirmed);
    if (refusal) {
      console.error(refusal);
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

    // All or nothing: find an address that is taken before removing or
    // writing anything. --replace only ever clears earlier imports.
    const replace = args.includes('--replace');
    for (const item of prepared) {
      const slug = item.plan!.slug;
      const taken = replace
        ? await store.hasNonImportedProfile(slug)
        : await store.profileExists(slug);
      if (taken) {
        console.error(
          replace
            ? `Refused: the address "${slug}" belongs to a profile that was not imported, which --replace will not remove; nothing was removed or written.`
            : `Refused: a profile with the address "${slug}" already exists; nothing was written. A failed earlier import is cleared with --replace.`,
        );
        return 2;
      }
    }

    if (replace) {
      // Test database only (checked above): removes earlier imports of these
      // profiles and what a failed import of them left behind.
      const removed = await store.removeImported(
        prepared.map((item) => item.plan!.slug),
      );
      console.warn(`Replaced: removed ${JSON.stringify(removed)}`);
    }

    const results: Record<string, unknown>[] = [];
    const reportWith = (status: string, detail: string[]) =>
      writeReports(
        dir,
        reports,
        { mode: 'import', database, results },
        { status, detail },
      );
    for (const item of prepared) {
      const slug = item.plan!.slug;
      let imported: Awaited<ReturnType<typeof executeImport>>;
      try {
        imported = await executeImport(
          item.plan!,
          {
            files: item.loaded.files,
            sources: item.loaded.sources,
            extractedText: item.extracted,
            report: item.report as unknown as Record<string, unknown>,
          },
          store,
          processImage,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const clear =
          'Re-run with --replace to clear what was written (test databases only), then import again.';
        reportWith('failed', [
          `The write of profile ${slug} failed: ${reason}`,
          clear,
        ]);
        console.error(`FAILED while writing ${slug}: ${reason}`);
        console.error(clear);
        return EXIT.mismatch;
      }

      const { written, ...result } = imported;
      try {
        // Read back what was written (Rule 26.1) and re-verify every chain.
        const snapshot = await store.readBack(
          new mongoose.Types.ObjectId(result.profileId),
          item.plan!.blocks.map((block) => block.blockId),
          written.images.map((image) => String(image.id)),
        );
        const differences = compareReadBack(written, snapshot);
        const brokenChains: string[] = [];
        for (const block of item.plan!.blocks) {
          const verdict = await store.verifyBlock(block.blockId);
          if (!verdict.valid || verdict.length !== 1) {
            brokenChains.push(block.blockId);
          }
        }
        const counts = {
          tabs: snapshot.tabs.length,
          blocks: snapshot.blocks.length,
          comments: snapshot.comments.length,
          images: snapshot.images.length,
        };
        const matches = differences.length === 0 && brokenChains.length === 0;
        results.push({
          slug,
          ...result,
          readBack: counts,
          differences,
          brokenChains,
          matches,
        });
        console.warn(
          `${slug}: ${matches ? 'imported and verified' : 'READ-BACK MISMATCH'} ` +
            `(${counts.tabs} tabs, ${counts.blocks} blocks, ${counts.comments} comments, ${counts.images} images)`,
        );
        for (const difference of differences) console.error(difference);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const unverified = `${slug} was written, but reading it back failed: ${reason}. It is NOT verified; check the database, or clear it with --replace (test databases only).`;
        reportWith('cannot-measure', [unverified]);
        console.error(unverified);
        return EXIT['cannot-measure'];
      }
    }

    const allMatch = results.every((result) => result.matches === true);
    writeReports(
      dir,
      reports,
      { mode: 'import', database, results },
      allMatch
        ? undefined
        : {
            status: 'read-back mismatch',
            detail: [
              'What was read back differs from what was written; see import-report.json.',
            ],
          },
    );
    return allMatch ? 0 : EXIT.mismatch;
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  void main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(EXIT['cannot-measure']);
    },
  );
}
