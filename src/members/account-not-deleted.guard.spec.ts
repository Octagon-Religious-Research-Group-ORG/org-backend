import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import {
  ACCOUNT_DELETED_WRITE,
  AccountNotDeletedGuard,
} from './account-not-deleted.guard';
import { CommentWritesController } from './comments/comments.controller';
import { MyClaimWritesController } from './claims/claims.controller';
import { VoteWritesController } from './votes/votes.controller';
import { OrgPageReactionWritesController } from './org-pages/org-pages.controller';
import { MyReportWritesController } from './moderation/moderation.controller';
import { MyMemberPageController } from './members.controller';
import { MyEamRequestWritesController } from './admin/admin.controller';
import {
  MyNotificationSettingsController,
  UnsubscribeController,
} from '../member-notifications/notifications.controller';
import {
  MyDataController,
  MyDataWritesController,
} from '../member-data/member-data.controller';
import { MyMembershipController } from '../membership/membership.controller';
import { MembershipModule } from '../membership/membership.module';
import { AccountDeletion } from '../member-data/schemas/account-deletion.schema';

// Chunk 17 review round 5, LOW-1: nothing is written after the deletion
// list is frozen.
const context = (sub?: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => (sub ? { auth: { payload: { sub } } } : {}),
    }),
  }) as never;

describe('AccountNotDeletedGuard', () => {
  const guard = new AccountNotDeletedGuard(
    fakeModel([{ userId: 'user_gone' }]) as never,
  );

  it('refuses a deleted account with a 403', async () => {
    await expect(guard.canActivate(context('user_gone'))).rejects.toEqual(
      new ForbiddenException(ACCOUNT_DELETED_WRITE),
    );
  });

  it('refuses a request with no subject', async () => {
    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('lets a live account through', async () => {
    await expect(guard.canActivate(context('user_live'))).resolves.toBe(true);
  });

  it('guards the comment, suggestion, vote and claim writes', () => {
    for (const controller of [
      CommentWritesController,
      VoteWritesController,
      MyClaimWritesController,
    ]) {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[],
      ).toContain(AccountNotDeletedGuard);
    }
  });
});

describe('AccountNotDeletedGuard: every me/* write (round 6, 5)', () => {
  const guarded = (target: object) =>
    (
      (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[]) ?? []
    ).includes(AccountNotDeletedGuard);

  it('guards org-page reactions, reports, page edits and the EaM request', () => {
    for (const controller of [
      OrgPageReactionWritesController,
      MyReportWritesController,
      MyMemberPageController,
      MyEamRequestWritesController,
    ]) {
      expect([controller.name, guarded(controller)]).toEqual([
        controller.name,
        true,
      ]);
    }
  });

  it('guards the notification-settings write, not the unsubscribe link', () => {
    const proto =
      MyNotificationSettingsController.prototype as unknown as Record<
        string,
        object
      >;
    const writes = Object.getOwnPropertyNames(proto).filter((name) =>
      guarded(proto[name]),
    );
    expect(writes).toHaveLength(1);
    expect(guarded(UnsubscribeController)).toBe(false);
  });

  it('guards joining the membership, not reading its status (round 7, 5)', () => {
    const proto = MyMembershipController.prototype as unknown as Record<
      string,
      object
    >;
    expect(guarded(proto.join)).toBe(true);
    expect(guarded(proto.summary)).toBe(false);
    expect(guarded(MyMembershipController)).toBe(false);
    // The guard's model is registered where the guard runs.
    const imports = (Reflect.getMetadata('imports', MembershipModule) ??
      []) as Array<{ providers?: Array<{ provide?: unknown }> }>;
    const tokens = imports.flatMap((entry) =>
      (entry.providers ?? []).map((provider) => provider.provide),
    );
    expect(tokens).toContain(`${AccountDeletion.name}Model`);
  });

  it('leaves the export and the undo open', () => {
    expect(guarded(MyDataController)).toBe(false);
    expect(guarded(MyDataWritesController)).toBe(false);
  });
});
