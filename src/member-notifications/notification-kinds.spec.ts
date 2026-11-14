import {
  ADMIN_CATEGORIES,
  CATEGORIES,
  CATEGORY_OF,
  DEFAULT_PREFS,
  deliveryFor,
  isAdminCategory,
  isCategory,
  isUnsubscribeScope,
  LINE_OF,
  MEMBER_CATEGORIES,
  NOTIFICATION_KINDS,
  type NotificationPrefs,
} from './notification-kinds';

const prefs = (change: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
  ...DEFAULT_PREFS,
  off: [],
  ...change,
});

describe('notification kinds (Chunk 14)', () => {
  it('puts every kind in a category and gives it two lines with no member text', () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(CATEGORIES).toContain(CATEGORY_OF[kind]);
      const [one, many] = LINE_OF[kind];
      expect(one.length).toBeGreaterThan(0);
      expect(many(3)).toContain('3');
    }
  });

  it('knows its categories and scopes', () => {
    expect(isCategory('comments')).toBe(true);
    expect(isCategory('nonsense')).toBe(false);
    for (const category of ADMIN_CATEGORIES) {
      expect(isAdminCategory(category)).toBe(true);
    }
    for (const category of MEMBER_CATEGORIES) {
      expect(isAdminCategory(category)).toBe(false);
    }
    expect(isUnsubscribeScope('digest')).toBe(true);
    expect(isUnsubscribeScope('adminImmediate')).toBe(true);
    expect(isUnsubscribeScope('replies')).toBe(true);
    expect(isUnsubscribeScope('everything')).toBe(false);
  });

  describe('deliveryFor', () => {
    it('sends claims and moderation at once by default, the rest in the digest', () => {
      expect(deliveryFor('claims', prefs())).toBe('immediate');
      expect(deliveryFor('moderation', prefs())).toBe('immediate');
      expect(deliveryFor('adminClaims', prefs())).toBe('immediate');
      expect(deliveryFor('adminReports', prefs())).toBe('immediate');
      expect(deliveryFor('comments', prefs())).toBe('digest');
      expect(deliveryFor('adminPages', prefs())).toBe('digest');
      expect(deliveryFor('adminEam', prefs())).toBe('digest');
    });

    it('falls back to the digest when immediate emails are off', () => {
      expect(deliveryFor('claims', prefs({ immediate: false }))).toBe('digest');
      expect(
        deliveryFor('adminReports', prefs({ adminImmediate: false })),
      ).toBe('digest');
      // The member switch does not touch the admin one, and back.
      expect(deliveryFor('adminReports', prefs({ immediate: false }))).toBe(
        'immediate',
      );
      expect(deliveryFor('claims', prefs({ adminImmediate: false }))).toBe(
        'immediate',
      );
    });

    it('sends nothing for a category turned off, or with every channel off', () => {
      expect(deliveryFor('claims', prefs({ off: ['claims'] }))).toBeUndefined();
      expect(deliveryFor('replies', prefs({ digest: false }))).toBeUndefined();
      expect(
        deliveryFor('moderation', prefs({ digest: false, immediate: false })),
      ).toBeUndefined();
    });
  });
});
