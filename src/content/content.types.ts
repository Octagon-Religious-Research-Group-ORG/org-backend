export const WEBSITE_PAGE_IDS = [
  'about',
  'community',
  'beliefs',
  'infrastructure',
  'research',
  'legal',
  'future',
  'donations',
  'membership',
] as const;

export type WebsitePageId = (typeof WEBSITE_PAGE_IDS)[number];

export type ReferenceBlockKind = 'lead' | 'heading' | 'paragraph' | 'outline';

export interface ReferenceBlock {
  id: string;
  kind: ReferenceBlockKind;
  text: string;
  marker?: string;
  depth?: number;
}

export interface ReferencePageContent {
  kind: 'reference';
  id: Exclude<WebsitePageId, 'about'>;
  title: string;
  subtitle: string;
  blocks: ReferenceBlock[];
}

export interface AboutOutlineNode {
  id: string;
  marker: string;
  text: string;
  children: AboutOutlineNode[];
}

export interface AboutArticle {
  id: string;
  roman: string;
  eyebrow: string;
  lead: string;
  body: AboutOutlineNode[];
}

export interface ContactChannel {
  id: string;
  label: string;
  handle: string;
  href: string | null;
}

export interface AboutPageContent {
  kind: 'about';
  id: 'about';
  title: string;
  statusNote: string;
  articles: AboutArticle[];
  contact: {
    roman: string;
    eyebrow: string;
    intro: string;
    channels: ContactChannel[];
  };
}

export type WebsitePageContent = AboutPageContent | ReferencePageContent;

export interface PublishedWebsitePage {
  pageId: WebsitePageId;
  revision: number;
  content: WebsitePageContent;
  publishedAt: string;
}

export interface WebsitePageSummary {
  pageId: WebsitePageId;
  title: string;
  publishedRevision: number;
  draftRevision: number | null;
  updatedAt: string;
}

export interface ContentRevision {
  revision: number;
  content: WebsitePageContent;
  publishedAt: string;
  publishedBy: string;
}

export interface ContentDraft {
  revision: number;
  basedOnPublishedRevision: number;
  content: WebsitePageContent;
  updatedAt: string;
  updatedBy: string;
}

export interface AdminWebsitePage {
  pageId: WebsitePageId;
  published: ContentRevision;
  draft: ContentDraft | null;
  history: ContentRevision[];
}
