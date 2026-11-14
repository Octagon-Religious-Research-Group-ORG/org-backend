/* eslint-disable @typescript-eslint/no-unsafe-member-access -- in-memory fake rows */
import { strFromU8, unzipSync } from 'fflate';
import { buildReceipt } from '../../anchoring/receipt';
import {
  OrgPageReceiptsController,
  RECEIPT_THROTTLE,
  ReceiptsController,
  receiptFileName,
} from './receipts.controller';

const receipt = buildReceipt(
  { type: 'comment', page: 'p', commentId: 'c' },
  [],
  { isAdmin: false },
  new Date('2026-11-14T00:00:00Z'),
);
const version = {
  seq: 3,
  text: 'Synthetic text.',
  hashInput: {
    included: false,
    withheld: ['authorUserId'],
    reason: 'held back',
  },
  anchor: { state: 'pending', message: 'Not anchored yet.' },
};
const withVersion = { ...receipt, versions: [version] } as never;
const viewer = { kind: 'guest', isAdmin: false };

function response() {
  const headers: Record<string, string> = {};
  return {
    headers,
    body: undefined as Buffer | undefined,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    send(body: Buffer) {
      this.body = body;
    },
  };
}

describe('receipt routes', () => {
  const members = { resolveViewer: jest.fn().mockResolvedValue(viewer) };
  const receipts = {
    belief: jest.fn().mockResolvedValue(withVersion),
    comment: jest.fn().mockResolvedValue(withVersion),
    orgComment: jest.fn().mockResolvedValue(withVersion),
  };
  const req = {} as never;

  it('are rationed per visitor', () => {
    expect(RECEIPT_THROTTLE.limit).toBe(20);
  });

  it('a belief receipt: as JSON, and as a zip download', async () => {
    const controller = new ReceiptsController(
      members as never,
      receipts as never,
    );
    expect(
      await controller.beliefReceipt(req, 'open-page', 'tab_a', {
        field: 'title',
        seq: 2,
      }),
    ).toBe(withVersion);
    expect(receipts.belief).toHaveBeenCalledWith(
      'open-page',
      'tab_a',
      viewer,
      'title',
      2,
    );
    const res = response();
    await controller.beliefReceiptZip(
      req,
      res as never,
      'open-page',
      'tab_a',
      {},
    );
    expect(res.headers).toEqual({
      'Content-Type': 'application/zip',
      'Content-Disposition':
        'attachment; filename="receipt-open-page-tab_a-text-3.zip"',
    });
    expect(
      strFromU8(unzipSync(new Uint8Array(res.body as Buffer))['README.txt']),
    ).toContain('ORG timestamp receipt');
  });

  it('a comment receipt, on a member page and on an ORG page', async () => {
    const controller = new ReceiptsController(
      members as never,
      receipts as never,
    );
    expect(
      await controller.commentReceipt(req, 'open-page', 'cmt_1', { seq: 1 }),
    ).toBe(withVersion);
    expect(receipts.comment).toHaveBeenCalledWith(
      'open-page',
      'cmt_1',
      viewer,
      1,
    );
    const res = response();
    await controller.commentReceiptZip(
      req,
      res as never,
      'open-page',
      'cmt_1',
      {},
    );
    expect(res.headers['Content-Disposition']).toBe(
      'attachment; filename="receipt-open-page-cmt_1-3.zip"',
    );

    const org = new OrgPageReceiptsController(
      members as never,
      receipts as never,
    );
    expect(await org.commentReceipt(req, 'about', 'cmt_2', {})).toBe(
      withVersion,
    );
    expect(receipts.orgComment).toHaveBeenCalledWith(
      'about',
      'cmt_2',
      viewer,
      undefined,
    );
    const orgRes = response();
    await org.commentReceiptZip(req, orgRes as never, 'about', 'cmt_2', {
      seq: 3,
    });
    expect(orgRes.headers['Content-Disposition']).toBe(
      'attachment; filename="receipt-about-cmt_2-3.zip"',
    );
  });

  it('a file name carries nothing a header or a file system could misread', () => {
    expect(receiptFileName('a"b', 'c/d\\e', 'f\r\ng', 1)).toBe(
      'receipt-a-b-c-d-e-f--g-1.zip',
    );
  });
});
