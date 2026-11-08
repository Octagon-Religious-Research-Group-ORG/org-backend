import { PublicContentController } from './content.controller';
import type {
  PublishedWebsitePage,
  WebsitePageContent,
  WebsitePageId,
} from './content.types';
import { INITIAL_WEBSITE_PAGES } from './initial-content';
import {
  TEST_SITE_PAYMENT_PLACEHOLDER,
  withoutRealPayments,
} from './test-site-content';

const REAL_HANDLES = ['$trippaardema', '@trippaardema', '@the_org'];

function published(content: WebsitePageContent): PublishedWebsitePage {
  return {
    pageId: content.id,
    revision: 1,
    content,
    publishedAt: '2026-11-08T00:00:00.000Z',
  };
}

function seededPage(id: WebsitePageId) {
  return published(INITIAL_WEBSITE_PAGES.find((page) => page.id === id)!);
}

function page(id: WebsitePageId, text: string) {
  return published({
    kind: 'reference',
    id,
    title: 'Title',
    subtitle: 'Subtitle',
    blocks: [{ id: 'b1', kind: 'paragraph', text }],
  } as WebsitePageContent);
}

function textOf(result: PublishedWebsitePage) {
  return (result.content as { blocks: { text: string }[] }).blocks[0].text;
}

describe('withoutRealPayments', () => {
  it('removes every real handle from the seeded donations page', () => {
    const seeded = JSON.stringify(seededPage('donations'));
    for (const handle of REAL_HANDLES) expect(seeded).toContain(handle);

    const shown = JSON.stringify(withoutRealPayments(seededPage('donations')));

    for (const handle of REAL_HANDLES) expect(shown).not.toContain(handle);
    expect(shown).toContain(TEST_SITE_PAYMENT_PLACEHOLDER);
  });

  it('catches a handle added later in the CMS, keeping the words around it', () => {
    expect(
      textOf(withoutRealPayments(page('donations', 'Send to @someone please'))),
    ).toBe(`Send to ${TEST_SITE_PAYMENT_PLACEHOLDER} please`);
  });

  it('leaves email addresses alone on the donations page', () => {
    const text = 'Write to org@orgspirituality.org';
    expect(textOf(withoutRealPayments(page('donations', text)))).toBe(text);
  });

  it('keeps handles on other pages', () => {
    const text = 'Contact @Tripp_ORG on Telegram';
    expect(textOf(withoutRealPayments(page('community', text)))).toBe(text);
  });

  it.each([
    'https://paypal.me/someone',
    'www.venmo.com/u/someone',
    'cash.app/$someone',
    'https://www.paypal.com/donate?id=1',
  ])('removes the payment link %s on any page', (link) => {
    expect(textOf(withoutRealPayments(page('community', `Pay ${link}`)))).toBe(
      `Pay ${TEST_SITE_PAYMENT_PLACEHOLDER}`,
    );
  });

  it.each(['$60/g', 'requested $2,149,496.30', 'a $5 gift'])(
    'leaves the price in %s alone',
    (text) => {
      expect(textOf(withoutRealPayments(page('donations', text)))).toBe(text);
    },
  );

  it('changes only the three handle lines of the seeded donations page', () => {
    const strings = (value: unknown): string[] =>
      typeof value === 'string'
        ? [value]
        : value !== null && typeof value === 'object'
          ? Object.values(value).flatMap(strings)
          : [];
    const before = strings(seededPage('donations').content);
    const after = strings(withoutRealPayments(seededPage('donations')).content);

    const changed = before.filter((text, index) => text !== after[index]);

    expect(changed.sort()).toEqual([...REAL_HANDLES].sort());
  });

  it.each([
    '(@someone)',
    'Paypal:@someone',
    'Venmo/@someone',
    '"@someone"',
    '**@someone**',
    '[@someone](https://example.com)',
    '＠someone',
    'a\u200B@someone',
  ])('removes the handle in %s on the donations page', (text) => {
    const shown = textOf(withoutRealPayments(page('donations', text)));
    expect(shown).not.toContain('someone');
    expect(shown).toContain(TEST_SITE_PAYMENT_PLACEHOLDER);
  });

  it('keeps the full stop after a handle', () => {
    expect(textOf(withoutRealPayments(page('donations', 'To @someone.')))).toBe(
      `To ${TEST_SITE_PAYMENT_PLACEHOLDER}.`,
    );
  });

  it.each(['Tip @trippaardema', 'Cashapp $TrippAardema', 'Venmo (@the_org)'])(
    'removes the real account in %s on any page',
    (text) => {
      const shown = textOf(withoutRealPayments(page('community', text)));
      expect(shown).toContain(TEST_SITE_PAYMENT_PLACEHOLDER);
      expect(shown.toLowerCase()).not.toMatch(/trippaardema|the_org/);
    },
  );

  it.each([
    'cash.me/$someone',
    'venmo.me/someone',
    'paypal.com.br/someone',
    'https://donate.paypal.com/x',
  ])('removes the whole payment link %s', (link) => {
    expect(textOf(withoutRealPayments(page('community', link)))).toBe(
      TEST_SITE_PAYMENT_PLACEHOLDER,
    );
  });

  it.each(['paypal.message', 'me@paypal.com'])('leaves %s alone', (text) => {
    expect(textOf(withoutRealPayments(page('community', text)))).toBe(text);
  });

  it('does not change the stored page', () => {
    const stored = page('donations', '@someone');
    withoutRealPayments(stored);
    expect(textOf(stored)).toBe('@someone');
  });

  it('keeps non-text values', () => {
    const stored = page('donations', 'text');
    (stored.content as unknown as { depth: number; none: null }).depth = 2;
    (stored.content as unknown as { depth: number; none: null }).none = null;

    expect(withoutRealPayments(stored).content).toMatchObject({
      depth: 2,
      none: null,
    });
  });
});

describe('PublicContentController on each site', () => {
  const donations = seededPage('donations');
  const content = {
    listPublic: jest.fn().mockResolvedValue([donations]),
    getPublic: jest.fn().mockResolvedValue(donations),
  };
  const controllerFor = (siteEnv: string | undefined) =>
    new PublicContentController(
      content as never,
      { get: () => siteEnv } as never,
    );

  it.each([undefined, 'production'])(
    'serves the stored page untouched when SITE_ENV is %p',
    async (siteEnv) => {
      const controller = controllerFor(siteEnv);

      await expect(controller.findOne('donations')).resolves.toBe(donations);
      await expect(controller.list()).resolves.toEqual([donations]);
      expect((await controller.list())[0]).toBe(donations);
    },
  );

  it('never serves a real handle when SITE_ENV is test', async () => {
    const controller = controllerFor('test');

    const one = JSON.stringify(await controller.findOne('donations'));
    const all = JSON.stringify(await controller.list());

    for (const handle of REAL_HANDLES) {
      expect(one).not.toContain(handle);
      expect(all).not.toContain(handle);
    }
  });
});
