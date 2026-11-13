import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import type { WebsitePageId } from '../../content/content.types';
import {
  WebsitePage,
  type WebsitePageDocument,
} from '../../content/schemas/website-page.schema';
import {
  isOrgPageId,
  orgPageIdOfThread,
  orgPageThreadId,
} from './org-page-targets';

/** The one answer for a page that is unknown or not published. */
export const ORG_PAGE_NOT_FOUND = 'That page does not exist.';

/** An ORG page as votes and comments see it. */
export interface OrgPage {
  /** The page's database id: the `profileId` of its votes and comments. */
  _id: Types.ObjectId;
  pageId: WebsitePageId;
  /** Its votes' and comments' thread id. */
  tabId: string;
  /** The published revision: what a vote is cast on. */
  revision: number;
  /** When the page was first stored (a tally's tie-break). */
  createdAt: Date;
}

interface StoredPage {
  _id: Types.ObjectId;
  pageId: WebsitePageId;
  published?: { revision: number };
  createdAt?: Date;
}

/**
 * Reads ORG's published CMS pages for votes and comments (Chunk 10b). Only a
 * published page takes votes or comments; anything else is the same quiet
 * "not found" for every reader.
 */
@Injectable()
export class OrgPagesService {
  constructor(
    @InjectModel(WebsitePage.name)
    private readonly pageModel: Model<WebsitePageDocument>,
  ) {}

  /** @throws NotFoundException for a page that is unknown or not published */
  async find(pageId: string): Promise<OrgPage> {
    const page = await this.current(pageId);
    if (!page) throw new NotFoundException(ORG_PAGE_NOT_FOUND);
    return page;
  }

  /** The page now, or undefined when it is unknown or not published. */
  async current(pageId: string): Promise<OrgPage | undefined> {
    if (!isOrgPageId(pageId)) return undefined;
    const row = (await this.pageModel
      .findOne({ pageId })
      .select({ pageId: 1, 'published.revision': 1, createdAt: 1 })
      .lean()
      .exec()) as StoredPage | null;
    if (!row?.published) return undefined;
    return {
      _id: row._id,
      pageId,
      tabId: orgPageThreadId(pageId),
      revision: row.published.revision,
      createdAt: row.createdAt ?? new Date(0),
    };
  }

  /** The page a thread id names, now; undefined for anything else. */
  async forThread(tabId: string): Promise<OrgPage | undefined> {
    const pageId = orgPageIdOfThread(tabId);
    return pageId === undefined ? undefined : this.current(pageId);
  }
}
