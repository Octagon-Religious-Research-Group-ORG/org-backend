import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { AnyBulkWriteOperation, Model, Types } from 'mongoose';
import {
  WebsitePage,
  type WebsitePageDocument,
} from '../content/schemas/website-page.schema';
import type {
  AboutOutlineNode,
  WebsitePageContent,
} from '../content/content.types';
import { visibleFieldBlocks } from '../members/editable-fields';
import {
  BeliefTab,
  type BeliefTabDocument,
} from '../social/schemas/belief-tab.schema';
import {
  BlockVersion,
  type BlockVersionDocument,
} from '../social/schemas/block-version.schema';
import {
  ProfileBlock,
  type ProfileBlockDocument,
} from '../social/schemas/profile-block.schema';
import {
  SocialProfile,
  type SocialProfileDocument,
} from '../social/schemas/social-profile.schema';
import { readHeads } from '../social/version-heads';
import { readSiteEnv, type SiteEnv } from '../config/site-env';
import { withoutRealPayments } from '../content/test-site-content';
import { foldedText } from './search-text';
import {
  SearchEntry,
  type SearchEntryDocument,
} from './schemas/search-entry.schema';

/** A search waits for a refresh at most this often. */
export const REFRESH_EVERY_MS = 15_000;
/** Everything is read again this often, healing anything a refresh missed. */
export const FULL_REBUILD_EVERY_MS = 6 * 60 * 60_000;
/** Each refresh re-reads this far back, for writes whose clock ran behind. */
export const REFRESH_OVERLAP_MS = 2 * 60_000;

type Entry = Omit<SearchEntry, 'createdAt' | 'updatedAt' | 'folded'>;

function upsert(entry: Entry): AnyBulkWriteOperation<SearchEntryDocument> {
  const { _id, ...fields } = entry;
  return {
    updateOne: {
      filter: { _id },
      update: { $set: { ...fields, folded: foldedText(fields.text) } },
      upsert: true,
    },
  };
}

/** Every text of a published CMS page, each with a stable part name. */
export function pageParts(
  content: WebsitePageContent | undefined,
): Array<{ part: string; text: string }> {
  if (!content) return [];
  const parts = [{ part: 'title', text: content.title }];
  if (content.kind === 'reference') {
    parts.push({ part: 'subtitle', text: content.subtitle });
    for (const block of content.blocks ?? []) {
      parts.push({ part: `block:${block.id}`, text: block.text });
    }
  } else {
    const walk = (nodes: readonly AboutOutlineNode[] | undefined) => {
      for (const node of nodes ?? []) {
        parts.push({ part: `node:${node.id}`, text: node.text });
        walk(node.children);
      }
    };
    for (const article of content.articles ?? []) {
      parts.push({ part: `article:${article.id}`, text: article.lead });
      walk(article.body);
    }
  }
  return parts.filter(
    (part) => typeof part.text === 'string' && part.text.trim() !== '',
  );
}

/**
 * Keeps `searchentries` in step with the site (Chunk 15) by reading the
 * source collections, rather than by a hook in every write path: no write
 * can forget it. A copy that falls behind is never shown: every search
 * checks each entry against its live rows (`visibilityStages`), which drops
 * an old name or title, a removed tab or block, an old version, a block the
 * page no longer shows after an edit (the `visibleFieldBlocks` rule), an old
 * CMS revision and the other site's copy of a page. Such a copy is only
 * MISSING from results until the next refresh rewrites it.
 *
 * Each refresh reads what changed since the last one (by `updatedAt`, and
 * `createdAt` for the append-only versions); every six hours everything.
 */
@Injectable()
export class SearchIndexerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SearchIndexerService.name);
  private since = new Date(0);
  private lastRefreshAt = 0;
  private lastFullAt = 0;
  private running?: Promise<void>;
  private writes = 0;
  private readonly site: SiteEnv;

  constructor(
    @InjectModel(SearchEntry.name)
    private readonly entryModel: Model<SearchEntryDocument>,
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
    @InjectModel(BeliefTab.name)
    private readonly tabModel: Model<BeliefTabDocument>,
    @InjectModel(ProfileBlock.name)
    private readonly blockModel: Model<ProfileBlockDocument>,
    @InjectModel(BlockVersion.name)
    private readonly versionModel: Model<BlockVersionDocument>,
    @InjectModel(WebsitePage.name)
    private readonly pageModel: Model<WebsitePageDocument>,
    config: ConfigService,
  ) {
    this.site = readSiteEnv(config);
  }

  /**
   * How many times the index has been written to. A cache of answers drawn
   * from it keys on this (round-2 review L2). Deletions only follow writes
   * of the same refresh, so counting the writes is enough.
   */
  generation(): number {
    return this.writes;
  }

  /** The first full read starts with the server, not with the first search. */
  onApplicationBootstrap() {
    void this.ensureFresh();
  }

  /**
   * Refreshes when the last refresh is older than {@link REFRESH_EVERY_MS}.
   * A failure is logged and search goes on with the entries it has.
   */
  async ensureFresh(now = Date.now()): Promise<void> {
    // A reader never queues behind a refresh already running (review L5).
    if (this.running) return;
    if (now - this.lastRefreshAt < REFRESH_EVERY_MS) return;
    // A failing database is not asked again on every search.
    this.lastRefreshAt = now;
    const full = now - this.lastFullAt >= FULL_REBUILD_EVERY_MS;
    const job = this.refresh({ full }).catch((error: unknown) => {
      this.logger.warn(
        `Search refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    // The full rebuild reads everything: it runs in the background.
    if (!full) await job;
  }

  /** One refresh at a time; a caller during one waits for it. */
  refresh({ full }: { full: boolean }): Promise<void> {
    this.running ??= this.run(full).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(full: boolean) {
    const startedAt = new Date();
    const since = full
      ? new Date(0)
      : new Date(this.since.getTime() - REFRESH_OVERLAP_MS);
    const changed = (field: 'updatedAt' | 'createdAt') =>
      full ? {} : { [field]: { $gte: since } };

    await this.indexNames(changed('updatedAt'));
    await this.indexTitles(changed('updatedAt'));
    await this.indexBeliefTexts(full, changed);
    await this.indexPages(changed('updatedAt'));

    this.since = startedAt;
    if (full) this.lastFullAt = startedAt.getTime();
  }

  private async write(
    operations: AnyBulkWriteOperation<SearchEntryDocument>[],
  ) {
    if (operations.length > 0) {
      await this.entryModel.bulkWrite(operations, { ordered: false });
      this.writes += 1;
    }
  }

  private async indexNames(filter: object) {
    const rows = await this.profileModel
      .find(filter)
      .select({ displayName: 1 })
      .lean()
      .exec();
    await this.write(
      rows.map((row) =>
        upsert({
          _id: `member:${String(row._id)}`,
          kind: 'member',
          profileId: row._id,
          text: row.displayName,
        }),
      ),
    );
  }

  private async indexTitles(filter: object) {
    const rows = await this.tabModel
      .find(filter)
      .select({ tabId: 1, title: 1, profileId: 1 })
      .lean()
      .exec();
    await this.write(
      rows.map((row) =>
        upsert({
          _id: `title:${row.tabId}`,
          kind: 'belief-title',
          profileId: row.profileId,
          tabId: row.tabId,
          text: row.title,
        }),
      ),
    );
  }

  /**
   * Belief text, one tab at a time: the tab's live blocks, the newest version
   * of each, and only the blocks the page shows (`visibleFieldBlocks`, the
   * page's own rule). Entries for the tab's other blocks are deleted.
   */
  private async indexBeliefTexts(
    full: boolean,
    changed: (field: 'updatedAt' | 'createdAt') => object,
  ) {
    let tabIds: string[];
    if (full) {
      tabIds = await this.blockModel.distinct('tabId', { section: 'beliefs' });
    } else {
      const newVersions = await this.versionModel.distinct(
        'blockId',
        changed('createdAt'),
      );
      const [fromVersions, fromBlocks] = await Promise.all([
        newVersions.length === 0
          ? []
          : this.blockModel.distinct('tabId', {
              blockId: { $in: newVersions },
              section: 'beliefs',
            }),
        this.blockModel.distinct('tabId', {
          ...changed('updatedAt'),
          section: 'beliefs',
        }),
      ]);
      tabIds = [...new Set([...fromVersions, ...fromBlocks])];
    }
    for (const tabId of tabIds.filter(
      (id): id is string => typeof id === 'string',
    )) {
      await this.indexTab(tabId);
    }
  }

  private async indexTab(tabId: string) {
    const blocks = (await this.blockModel
      .find({ tabId, section: 'beliefs', removedAt: { $exists: false } })
      .select({ blockId: 1, kind: 1, label: 1, profileId: 1 })
      .sort({ order: 1, _id: 1 })
      .lean()
      .exec()) as unknown as Array<{
      blockId: string;
      kind: string;
      label?: string;
      profileId: Types.ObjectId;
    }>;
    const texts = blocks.filter((block) => block.kind !== 'image');
    const heads = await readHeads(
      this.versionModel,
      texts.map((block) => block.blockId),
    );
    const shown = visibleFieldBlocks(
      texts,
      (blockId) => heads.get(blockId)?.seq ?? 0,
    ).flatMap((block) => {
      const head = heads.get(block.blockId);
      return head ? [{ block, head }] : [];
    });
    await this.write(
      shown.map(({ block, head }) =>
        upsert({
          _id: `text:${block.blockId}`,
          kind: 'belief-text',
          profileId: block.profileId,
          tabId,
          blockId: block.blockId,
          seq: head.seq,
          text: head.text,
        }),
      ),
    );
    await this.entryModel
      .deleteMany({
        kind: 'belief-text',
        tabId,
        blockId: { $nin: shown.map(({ block }) => block.blockId) },
      })
      .exec();
  }

  /** Each changed CMS page: its published texts, and nothing older. */
  private async indexPages(filter: object) {
    const pages = await this.pageModel
      .find(filter)
      .select({ pageId: 1, published: 1 })
      .lean()
      .exec();
    for (const page of pages) {
      const revision = page.published?.revision;
      const parts = pageParts(this.forThisSite(page.pageId, page.published));
      await this.write(
        parts.map(({ part, text }) =>
          upsert({
            // Each site its own copy, even sharing one database (round-2 L3).
            _id: `page:${this.site}:${page.pageId}:${part}`,
            kind: 'page',
            pageId: page.pageId,
            part,
            revision,
            variant: this.site,
            text,
          }),
        ),
      );
      await this.entryModel
        .deleteMany({
          kind: 'page',
          pageId: page.pageId,
          variant: this.site,
          part: { $nin: parts.map(({ part }) => part) },
        })
        .exec();
    }
  }

  /**
   * A page's published content as THIS site serves it: the test site removes
   * real payment accounts (`withoutRealPayments`, the content controller's
   * rule), so its index never holds them (review M2).
   */
  private forThisSite(
    pageId: WebsitePage['pageId'],
    published: WebsitePage['published'] | undefined,
  ): WebsitePageContent | undefined {
    if (!published?.content || this.site !== 'test') return published?.content;
    return withoutRealPayments({
      pageId,
      revision: published.revision,
      content: published.content,
      publishedAt: '',
    }).content;
  }
}
