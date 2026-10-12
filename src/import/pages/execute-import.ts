import { Types } from 'mongoose';
import type { ImportSourceFile } from '../../social/schemas/import-record.schema';
import { MAX_ANCHOR_TEXT_LENGTH } from '../../social/schemas/comment.schema';
import { IMPORT_AUTHOR, type ImportPlan } from './import-plan';
import type { ProcessedImage } from './image';

/** Bumped whenever the importer's output for the same input would change. */
export const IMPORTER_VERSION = 'pages-import-1';

/** The writes an import needs; implemented over Mongo by `MongoImportStore`. */
export interface ImportStore {
  profileExists(slug: string): Promise<boolean>;
  createTab(row: Record<string, unknown>): Promise<void>;
  createBlock(row: Record<string, unknown>): Promise<void>;
  /** Appends a hash-chained version and makes it current (BlockVersionsService). */
  appendVersion(input: {
    blockId: string;
    text: string;
    authorUserId: string;
  }): Promise<void>;
  createComment(row: Record<string, unknown>): Promise<void>;
  storeImage(
    image: ProcessedImage,
    metadata: Record<string, unknown>,
  ): Promise<string>;
  createImportRecord(row: Record<string, unknown>): Promise<void>;
  createProfile(row: Record<string, unknown>): Promise<void>;
}

export interface ImportInputs {
  /** Every file the plan refers to, by package path. */
  files: ReadonlyMap<string, Uint8Array>;
  sources: ImportSourceFile[];
  extractedText: string;
  report: Record<string, unknown>;
  now?: Date;
}

export interface ImportResult {
  profileId: string;
  tabs: number;
  blocks: number;
  comments: number;
  imageIds: string[];
  truncatedAnchors: number;
}

/**
 * Writes one planned profile.
 *
 * Order matters: tabs, blocks (each with its first hash-chained version),
 * comments, images and the import record are written first, and the profile
 * row LAST. Until that row exists nothing references the new rows, so an
 * import that fails half-way leaves no visible half-profile; re-running for
 * the same slug is then allowed, because the slug is still free.
 *
 * @throws Error when the slug is taken, a file is missing, or any write fails
 */
export async function executeImport(
  plan: ImportPlan,
  inputs: ImportInputs,
  store: ImportStore,
  processImage: (bytes: Uint8Array) => Promise<ProcessedImage>,
): Promise<ImportResult> {
  if (await store.profileExists(plan.slug)) {
    throw new Error(
      `A profile with the address "${plan.slug}" already exists.`,
    );
  }
  for (const image of plan.images) {
    if (!inputs.files.has(image.path)) {
      throw new Error(`Image ${image.path} is not among the source files.`);
    }
  }
  for (const block of plan.blocks) {
    if (block.kind === 'image' && !inputs.files.has(block.text)) {
      throw new Error(`Image ${block.text} is not among the source files.`);
    }
  }

  // Convert every picture BEFORE writing anything: a file the converter
  // cannot read (a HEIC photo did) must fail the profile with zero writes.
  const processed = new Map<string, ProcessedImage>();
  const imagePaths = [
    ...plan.blocks
      .filter((block) => block.kind === 'image')
      .map((block) => block.text),
    ...plan.images.map((image) => image.path),
  ];
  for (const path of imagePaths) {
    if (processed.has(path)) continue;
    try {
      processed.set(path, await processImage(inputs.files.get(path)!));
    } catch (error) {
      throw new Error(
        `Image ${path} could not be converted: ${(error as Error).message}`,
      );
    }
  }

  const profileId = new Types.ObjectId();
  const now = inputs.now ?? new Date();

  for (const tab of plan.tabs) {
    await store.createTab({
      profileId,
      tabId: tab.tabId,
      title: tab.title,
      ...(tab.group ? { group: tab.group } : {}),
      order: tab.order,
      reviewStatus: 'imported-review',
    });
  }

  const inlineImageIds = new Map<string, string>();
  for (const block of plan.blocks) {
    let text = block.text;
    if (block.kind === 'image') {
      if (!inlineImageIds.has(block.text)) {
        inlineImageIds.set(
          block.text,
          await store.storeImage(processed.get(block.text)!, {
            profileSlug: plan.slug,
            source: block.text,
            role: 'inline',
          }),
        );
      }
      text = `image:${inlineImageIds.get(block.text)}`;
    }
    await store.createBlock({
      profileId,
      blockId: block.blockId,
      section: block.section,
      kind: block.kind,
      label: block.label,
      order: block.order,
      ...(block.tabId ? { tabId: block.tabId } : {}),
    });
    await store.appendVersion({
      blockId: block.blockId,
      text,
      authorUserId: IMPORT_AUTHOR,
    });
  }

  let truncatedAnchors = 0;
  for (const comment of plan.comments) {
    let anchorText = comment.anchorText;
    if (anchorText && anchorText.length > MAX_ANCHOR_TEXT_LENGTH) {
      anchorText = `${anchorText.slice(0, MAX_ANCHOR_TEXT_LENGTH - 1)}…`;
      truncatedAnchors += 1;
    }
    await store.createComment({
      commentId: comment.commentId,
      profileId,
      ...(comment.parentCommentId
        ? { parentCommentId: comment.parentCommentId }
        : {}),
      ...(comment.tabId ? { tabId: comment.tabId } : {}),
      ...(comment.anchorBlockId
        ? { anchorBlockId: comment.anchorBlockId }
        : {}),
      ...(anchorText ? { anchorText } : {}),
      legacyAuthorName: comment.legacyAuthorName,
      ...(comment.legacyCreatedAt
        ? { legacyCreatedAt: comment.legacyCreatedAt }
        : {}),
      body: comment.body,
      source: 'migrated',
    });
  }

  const imageIds: string[] = [];
  for (const image of plan.images) {
    imageIds.push(
      await store.storeImage(processed.get(image.path)!, {
        profileSlug: plan.slug,
        source: image.path,
        role: image.role,
      }),
    );
  }

  await store.createImportRecord({
    profileId,
    slug: plan.slug,
    pagesUrl: plan.pagesUrl,
    sources: inputs.sources,
    extractedText: inputs.extractedText,
    report: { ...inputs.report, truncatedAnchors },
    importerVersion: IMPORTER_VERSION,
    importedAt: now,
  });

  await store.createProfile({
    _id: profileId,
    slug: plan.slug,
    displayName: plan.displayName,
    imageIds,
    visibility: plan.visibility,
    anonymous: plan.anonymous,
    source: 'migrated',
    legacy: { pagesUrl: plan.pagesUrl, importedAt: now },
  });

  return {
    profileId: profileId.toHexString(),
    tabs: plan.tabs.length,
    blocks: plan.blocks.length,
    comments: plan.comments.length,
    imageIds,
    truncatedAnchors,
  };
}
