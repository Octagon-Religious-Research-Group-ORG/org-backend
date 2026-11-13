/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
// Claims on a STANDALONE MongoDB (review round 2): decisions need
// transactions, so they must answer a plain 503, and the startup check must
// say so, without stopping the server. Needs MONGO_STANDALONE_URI (a
// throwaway database on a server started WITHOUT --replSet; it is dropped).
// Without it the suite is reported as SKIPPED, never as passed.
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import mongoose, { type Model, Types } from 'mongoose';
import { MANAGED_SCHEMAS } from '../src/db/managed-schemas';
import {
  ReplicaSetCheckService,
  STANDALONE_WARNING,
} from '../src/db/replica-set-check.service';
import {
  ClaimsService,
  CLAIMS_NEED_REPLICA_SET,
} from '../src/members/claims/claims.service';
import { NEEDS_REPLICA_SET } from '../src/db/transactions';
import { AdminMembersService } from '../src/members/admin/admin-members.service';
import { ModerationLogService } from '../src/moderation/moderation-log.service';

const uri = process.env.MONGO_STANDALONE_URI;
const describeStandalone = uri ? describe : describe.skip;

describeStandalone('claims on a standalone MongoDB', () => {
  let conn: mongoose.Connection;
  const m = {} as Record<string, Model<any>>;
  let claims: ClaimsService;

  beforeAll(async () => {
    conn = await mongoose.createConnection(String(uri)).asPromise();
    await conn.dropDatabase();
    for (const { name, schema } of MANAGED_SCHEMAS) {
      m[name] = conn.model(name, schema);
      await m[name].createCollection();
    }
    claims = new ClaimsService(
      m.Claim,
      m.SocialProfile,
      {} as never,
      { emailVerified: () => Promise.resolve(true) } as never,
      {} as never,
      new ModerationLogService(m.ModerationLogEntry),
    );
  });

  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  it('the startup check warns once and does not throw', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    await expect(new ReplicaSetCheckService(conn).check()).resolves.toBe(
      'standalone',
    );
    expect(warn).toHaveBeenCalledWith(STANDALONE_WARNING);
    warn.mockRestore();
  });

  it('approve, reject and withdraw answer 503 with a plain message, changing nothing', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const profileId = new Types.ObjectId();
    await m.SocialProfile.collection.insertOne({
      _id: profileId,
      slug: 'standalone-page',
      displayName: 'Synthetic',
      visibility: 'public',
      reviewStatus: 'approved',
      source: 'migrated',
    });
    const claimId = new Types.ObjectId();
    await m.Claim.collection.insertOne({
      _id: claimId,
      profileId,
      userId: 'user_standalone',
      message: 'Synthetic',
      status: 'pending',
      createdAt: new Date(),
    });
    for (const decide of [
      () => claims.approve('user_admin', String(claimId)),
      () => claims.reject('user_admin', String(claimId)),
      () => claims.withdraw('user_standalone', String(claimId)),
    ]) {
      await expect(decide()).rejects.toThrow(
        new ServiceUnavailableException(CLAIMS_NEED_REPLICA_SET),
      );
    }
    expect((await m.Claim.findOne({ _id: claimId }).lean()).status).toBe(
      'pending',
    );
    expect(
      (await m.SocialProfile.findOne({ _id: profileId }).lean()).ownerUserId,
    ).toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('admin page decisions (Chunk 12) answer 503 the same way, changing nothing', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const profileId = new Types.ObjectId();
    await m.SocialProfile.collection.insertOne({
      _id: profileId,
      slug: 'standalone-waiting',
      displayName: 'Synthetic',
      visibility: 'public',
      reviewStatus: 'pending',
      source: 'native',
      ownerUserId: 'user_waiting',
    });
    const admin = new AdminMembersService(
      m.SocialProfile,
      conn,
      new ModerationLogService(m.ModerationLogEntry),
      { closePageNotice: () => Promise.resolve() } as never,
    );
    await expect(
      admin.approve('user_admin', 'standalone-waiting'),
    ).rejects.toThrow(new ServiceUnavailableException(NEEDS_REPLICA_SET));
    expect(
      (await m.SocialProfile.findOne({ _id: profileId }).lean()).reviewStatus,
    ).toBe('pending');
    error.mockRestore();
  });
});
