/**
 * The readable half of "Download my data" (Chunk 17): plain text a person
 * can open anywhere, made from the same object as `my-data.json`, so the two
 * can never say different things.
 */

interface PlaceLike {
  type: string;
  page?: string;
  name?: string;
}

interface VersionLike {
  seq: number;
  text: string;
  savedAt: string;
  source?: string;
}

/** The parts of the export the text reads. */
export interface ExportLike {
  generatedAt: string;
  page: null | {
    address: string;
    name: unknown;
    status: unknown;
    tabs: Array<{
      title: unknown;
      removedAt?: string;
      titleHistory: VersionLike[];
    }>;
    blocks: Array<{
      section: string;
      tabId?: string;
      removedAt?: string;
      versions: VersionLike[];
    }>;
    deletion?: { deletedAt?: string; keptUntil?: string };
  };
  myComments: Array<{
    place: PlaceLike;
    kind: unknown;
    text: unknown;
    postedAt?: string;
    versions: VersionLike[];
  }>;
  commentsOnMyPage: unknown[];
  votes: unknown[];
  claims: unknown[];
  reportsFiled: unknown[];
  connections: {
    connected: unknown[];
    requestsSent: unknown[];
    requestsReceived: unknown[];
    blocksMade: unknown[];
  };
  receipts: { included: string[]; notIncluded?: number };
}

export function placeText(place: PlaceLike): string {
  switch (place.type) {
    case 'my-page':
      return 'your page';
    case 'org-page':
      return `ORG's "${place.page}" page`;
    default:
      return place.name
        ? `${place.name}'s page`
        : 'a member page you can no longer see';
  }
}

function versionLines(versions: VersionLike[], indent: string): string[] {
  return versions.flatMap((version) => [
    `${indent}Version ${version.seq}, saved ${version.savedAt}${version.source ? ` (${version.source})` : ''}:`,
    ...version.text.split('\n').map((line) => `${indent}  ${line}`),
  ]);
}

/** `my-data.txt`: the page and the comments, every version, in words. */
export function exportText(data: ExportLike): string {
  const lines: string[] = [`Your ORG data, made ${data.generatedAt}`, ''];
  if (data.page) {
    const page = data.page;
    lines.push(
      `YOUR PAGE: ${String(page.name)} (/${page.address}), ${String(page.status)}`,
    );
    if (page.deletion) {
      lines.push(
        `Deleted ${page.deletion.deletedAt}; ORG keeps a private copy until ${page.deletion.keptUntil}.`,
      );
    }
    for (const tab of page.tabs) {
      lines.push(
        '',
        `Belief tab "${String(tab.title)}"${tab.removedAt ? ` (removed ${tab.removedAt})` : ''}`,
        ...versionLines(tab.titleHistory, '  '),
      );
    }
    for (const block of page.blocks) {
      lines.push(
        '',
        `${block.section}${block.tabId ? ` (tab ${block.tabId})` : ''}${block.removedAt ? `, removed ${block.removedAt}` : ''}`,
        ...versionLines(block.versions, '  '),
      );
    }
  } else {
    lines.push('You have no member page.');
  }
  lines.push('', `YOUR COMMENTS (${data.myComments.length})`);
  for (const comment of data.myComments) {
    lines.push(
      '',
      `On ${placeText(comment.place)}, ${String(comment.kind)}, posted ${comment.postedAt ?? 'at an unknown time'}:`,
      ...(comment.versions.length > 0
        ? versionLines(comment.versions, '  ')
        : String(comment.text)
            .split('\n')
            .map((line) => `  ${line}`)),
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** `READ-ME-FIRST.txt`: what is in the download and what is not. */
export function exportReadme(data: ExportLike): string {
  return [
    'Your ORG data',
    '',
    'my-data.txt   your page and your comments, every version, to read.',
    'my-data.json  everything, for a computer to read.',
    'receipts/     one timestamp receipt for each version that has been anchored.',
    '              Each is the same zip the site gives you, with its own README.',
    '',
    `In this download: ${data.myComments.length} comments, ${data.commentsOnMyPage.length} comments by others on your page, ${data.votes.length} votes, ${data.claims.length} claims, ${data.reportsFiled.length} reports you filed, ${data.receipts.included.length} receipts.`,
    `Connections: ${data.connections.connected.length} connected, ${data.connections.requestsSent.length} requests sent, ${data.connections.requestsReceived.length} received, ${data.connections.blocksMade.length} members you blocked (in my-data.json).`,
    ...(data.receipts.notIncluded
      ? [
          `${data.receipts.notIncluded} more receipts did not fit; each is still in its history on the site.`,
        ]
      : []),
    '',
    'Other people appear only as the site shows them to you. Their account ids,',
    'moderators’ notes, and reports made about you are not included.',
    '',
  ].join('\n');
}
