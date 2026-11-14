import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  ADMIN_CATEGORIES,
  type Category,
  CATEGORIES,
  DEFAULT_PREFS,
  MEMBER_CATEGORIES,
  type NotificationPrefs,
  type UnsubscribeScope,
} from './notification-kinds';
import {
  NotificationPrefsRow,
  type NotificationPrefsDocument,
} from './schemas/notification-prefs.schema';

/** What the settings page shows and saves. */
export interface NotificationSettingsView {
  categories: Record<string, boolean>;
  digest: boolean;
  immediate: boolean;
  /** Only for admins: their own section. */
  admin?: {
    categories: Record<string, boolean>;
    adminImmediate: boolean;
  };
}

/** A change from the settings page: only the fields it names. */
export interface NotificationSettingsChange {
  categories?: Partial<Record<Category, boolean>>;
  digest?: boolean;
  immediate?: boolean;
  adminImmediate?: boolean;
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

/** Members' email settings (Chunk 14). Defaults until a member saves. */
@Injectable()
export class NotificationPrefsService {
  constructor(
    @InjectModel(NotificationPrefsRow.name)
    private readonly prefsModel: Model<NotificationPrefsDocument>,
  ) {}

  async get(userId: string): Promise<NotificationPrefs> {
    const row = await this.prefsModel
      .findOne({ userId })
      .select({ off: 1, digest: 1, immediate: 1, adminImmediate: 1 })
      .lean()
      .exec();
    if (!row) return { ...DEFAULT_PREFS, off: [] };
    return {
      off: (row.off ?? []).filter((c) =>
        (CATEGORIES as readonly string[]).includes(c),
      ),
      digest: row.digest !== false,
      immediate: row.immediate !== false,
      adminImmediate: row.adminImmediate !== false,
    };
  }

  /** The settings as the page shows them; the admin part only for admins. */
  async view(
    userId: string,
    isAdmin: boolean,
  ): Promise<NotificationSettingsView> {
    return toView(await this.get(userId), isAdmin);
  }

  /**
   * Saves a change: ONLY the fields it names (review L6), each as one
   * atomic update, so a page loaded before an unsubscribe link was used can
   * never turn that back on by saving something else. Admin settings are
   * ignored for a non-admin (the page never offers them).
   */
  async update(
    userId: string,
    isAdmin: boolean,
    change: NotificationSettingsChange,
  ): Promise<NotificationSettingsView> {
    const turnOn: Category[] = [];
    const turnOff: Category[] = [];
    for (const [key, on] of Object.entries(change.categories ?? {})) {
      if (!isAdmin && (ADMIN_CATEGORIES as readonly string[]).includes(key)) {
        continue;
      }
      (on ? turnOn : turnOff).push(key as Category);
    }
    const set: Partial<NotificationPrefs> = {
      ...(change.digest !== undefined ? { digest: change.digest } : {}),
      ...(change.immediate !== undefined
        ? { immediate: change.immediate }
        : {}),
      ...(isAdmin && change.adminImmediate !== undefined
        ? { adminImmediate: change.adminImmediate }
        : {}),
    };
    if (Object.keys(set).length > 0) await this.write(userId, { $set: set });
    if (turnOff.length > 0) {
      await this.write(userId, { $addToSet: { off: { $each: turnOff } } });
    }
    if (turnOn.length > 0) {
      await this.write(userId, { $pull: { off: { $in: turnOn } } });
    }
    return toView(await this.get(userId), isAdmin);
  }

  /**
   * An unsubscribe link: turns one category, the digest or the immediate
   * emails off. Doing it twice changes nothing.
   */
  async unsubscribe(userId: string, scope: UnsubscribeScope) {
    const flag =
      scope === 'digest' || scope === 'immediate' || scope === 'adminImmediate'
        ? scope
        : undefined;
    await this.write(
      userId,
      flag ? { $set: { [flag]: false } } : { $addToSet: { off: scope } },
    );
  }

  /** One update on the member's row, made with the defaults if missing. */
  private async write(userId: string, update: Record<string, unknown>) {
    const run = () =>
      this.prefsModel
        .updateOne({ userId }, update, {
          upsert: true,
          setDefaultsOnInsert: true,
        })
        .exec();
    try {
      await run();
    } catch (error) {
      // Two first saves at once: one inserted, the other updates it.
      if (!isDuplicateKey(error)) throw error;
      await run();
    }
  }
}

function toView(
  prefs: NotificationPrefs,
  isAdmin: boolean,
): NotificationSettingsView {
  const on = (category: Category) => !prefs.off.includes(category);
  return {
    categories: Object.fromEntries(MEMBER_CATEGORIES.map((c) => [c, on(c)])),
    digest: prefs.digest,
    immediate: prefs.immediate,
    ...(isAdmin
      ? {
          admin: {
            categories: Object.fromEntries(
              ADMIN_CATEGORIES.map((c) => [c, on(c)]),
            ),
            adminImmediate: prefs.adminImmediate,
          },
        }
      : {}),
  };
}
