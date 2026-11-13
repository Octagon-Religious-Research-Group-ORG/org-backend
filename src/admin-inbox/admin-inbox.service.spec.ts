import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import mongoose, { Types } from 'mongoose';
import { fakeConnection } from '../db/transactions.mocks-spec';
import {
  AdminInboxService,
  EAM_ALREADY_REQUESTED,
  EAM_NOTE_TOO_LONG,
  ENTRY_HANDLED,
  ENTRY_NOT_FOUND,
  INBOX_PAGE_SIZE,
  NOT_EAM_REQUEST,
  OWN_ENTRY,
  parseEntryId,
} from './admin-inbox.service';
import {
  AdminInboxEntrySchema,
  eamKey,
  MAX_INBOX_NOTE_LENGTH,
  pageSubmittedKey,
} from './schemas/admin-inbox.schema';

const ADMIN = 'user_admin';
const MEMBER = 'user_member';
const ENTRY_ID = new Types.ObjectId();
const PROFILE_ID = new Types.ObjectId();
const CREATED = new Date('2026-11-13T10:00:00Z');
const duplicate = Object.assign(new Error('E11000'), { code: 11000 });

function chain(value: unknown) {
  const query = {
    select: () => query,
    sort: () => query,
    skip: () => query,
    limit: () => query,
    session: () => query,
    lean: () => query,
    exec: () => Promise.resolve(value),
  };
  return query;
}

function build(options: { failure?: unknown } = {}) {
  const entryModel = {
    create: jest.fn((row: Record<string, unknown>) =>
      Promise.resolve({ ...row, createdAt: CREATED }),
    ),
    updateOne: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
    findOne: jest.fn(() => chain(null)),
    find: jest.fn(() => chain([])),
  };
  const profileModel = { find: jest.fn(() => chain([])) };
  const log = { record: jest.fn(() => Promise.resolve({})) };
  const { connection, session } = fakeConnection(options.failure);
  const service = new AdminInboxService(
    entryModel as never,
    profileModel as never,
    connection as never,
    log as never,
  );
  return { service, entryModel, profileModel, log, session };
}

const entry = (overrides: Record<string, unknown> = {}) => ({
  _id: ENTRY_ID,
  kind: 'eam-request',
  status: 'open',
  subjectUserId: MEMBER,
  profileId: PROFILE_ID,
  dedupeKey: eamKey(MEMBER),
  createdAt: CREATED,
  ...overrides,
});

describe('AdminInboxService', () => {
  it('writes one "page waiting" notice per page, and ignores a second', async () => {
    const { service, entryModel } = build();
    await service.notifyPageSubmitted(MEMBER, PROFILE_ID);
    expect(entryModel.create).toHaveBeenCalledWith({
      kind: 'page-submitted',
      status: 'open',
      subjectUserId: MEMBER,
      profileId: PROFILE_ID,
      dedupeKey: pageSubmittedKey(PROFILE_ID),
    });
    entryModel.create.mockRejectedValueOnce(duplicate);
    await expect(
      service.notifyPageSubmitted(MEMBER, PROFILE_ID),
    ).resolves.toBeUndefined();
    entryModel.create.mockRejectedValueOnce(new Error('synthetic outage'));
    await expect(
      service.notifyPageSubmitted(MEMBER, PROFILE_ID),
    ).rejects.toThrow('synthetic outage');
  });

  it('closes a page notice inside the caller’s transaction', async () => {
    const { service, entryModel } = build();
    const session = { id: 's' };
    await service.closePageNotice(PROFILE_ID, ADMIN, session as never);
    const [filter, update, options] = entryModel.updateOne.mock
      .calls[0] as unknown as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
      Record<string, unknown>,
    ];
    expect(filter).toEqual({
      dedupeKey: pageSubmittedKey(PROFILE_ID),
      status: 'open',
    });
    expect(update.$set).toMatchObject({ status: 'handled', handledBy: ADMIN });
    expect(options).toEqual({ session });
  });

  it('reopens, or writes, a page notice when the page waits again (LOW-2)', async () => {
    const { service, entryModel } = build();
    const session = { id: 's' };
    await service.reopenPageNotice(PROFILE_ID, MEMBER, session as never);
    expect(entryModel.updateOne).toHaveBeenCalledWith(
      { dedupeKey: pageSubmittedKey(PROFILE_ID) },
      {
        $set: { status: 'open' },
        $unset: { handledAt: 1, handledBy: 1 },
        $setOnInsert: {
          kind: 'page-submitted',
          subjectUserId: MEMBER,
          profileId: PROFILE_ID,
        },
      },
      { session, upsert: true },
    );
  });

  describe('EaM requests (member side)', () => {
    it('reports none, then the request with its date', async () => {
      const { service, entryModel } = build();
      await expect(service.myEamRequest(MEMBER)).resolves.toEqual({
        requested: false,
      });
      entryModel.findOne.mockReturnValueOnce(chain({ createdAt: CREATED }));
      await expect(service.myEamRequest(MEMBER)).resolves.toEqual({
        requested: true,
        requestedAt: CREATED.toISOString(),
      });
      expect(entryModel.findOne).toHaveBeenCalledWith({
        dedupeKey: eamKey(MEMBER),
      });
    });

    it('records a cleaned note, or none when it is blank', async () => {
      const { service, entryModel } = build();
      await expect(
        service.requestEam(MEMBER, PROFILE_ID, '  Ready\u0007 to start.  '),
      ).resolves.toEqual({
        requested: true,
        requestedAt: CREATED.toISOString(),
      });
      expect(entryModel.create).toHaveBeenLastCalledWith({
        kind: 'eam-request',
        status: 'open',
        subjectUserId: MEMBER,
        profileId: PROFILE_ID,
        note: 'Ready to start.',
        dedupeKey: eamKey(MEMBER),
      });
      await service.requestEam(MEMBER, PROFILE_ID, '   ');
      expect(entryModel.create.mock.calls[1][0]).not.toHaveProperty('note');
      await service.requestEam(MEMBER, PROFILE_ID, undefined);
      expect(entryModel.create.mock.calls[2][0]).not.toHaveProperty('note');
    });

    it('refuses a second request, and a note over the limit', async () => {
      const { service, entryModel } = build();
      entryModel.create.mockRejectedValueOnce(duplicate);
      await expect(service.requestEam(MEMBER, PROFILE_ID, '')).rejects.toThrow(
        new ConflictException(EAM_ALREADY_REQUESTED),
      );
      entryModel.create.mockRejectedValueOnce(new Error('synthetic'));
      await expect(service.requestEam(MEMBER, PROFILE_ID, '')).rejects.toThrow(
        'synthetic',
      );
      await expect(
        service.requestEam(
          MEMBER,
          PROFILE_ID,
          'x'.repeat(MAX_INBOX_NOTE_LENGTH + 1),
        ),
      ).rejects.toThrow(new BadRequestException(EAM_NOTE_TOO_LONG));
      await expect(
        service.requestEam(
          MEMBER,
          PROFILE_ID,
          'x'.repeat(MAX_INBOX_NOTE_LENGTH),
        ),
      ).resolves.toMatchObject({ requested: true });
    });
  });

  describe('list', () => {
    it('shows each entry with its page, newest first, a page at a time', async () => {
      const { service, entryModel, profileModel } = build();
      const rows = [
        entry({ note: 'A synthetic note.' }),
        entry({
          _id: new Types.ObjectId(),
          kind: 'page-submitted',
          status: 'handled',
          dedupeKey: pageSubmittedKey(PROFILE_ID),
          handledAt: CREATED,
          handledBy: ADMIN,
        }),
        entry({
          _id: new Types.ObjectId(),
          dedupeKey: undefined,
          profileId: undefined,
        }),
      ];
      const query = chain(rows);
      const skip = jest.spyOn(query, 'skip');
      entryModel.find.mockReturnValueOnce(query);
      profileModel.find.mockReturnValueOnce(
        chain([
          {
            _id: PROFILE_ID,
            slug: 'quiet-fern',
            displayName: 'Quiet Fern',
            reviewStatus: 'pending',
          },
        ]),
      );
      const result = await service.list('open', 2);
      expect(entryModel.find).toHaveBeenCalledWith({ status: 'open' });
      expect(skip).toHaveBeenCalledWith(INBOX_PAGE_SIZE);
      expect(result.hasMore).toBe(false);
      expect(result.entries[0]).toEqual({
        entryId: String(ENTRY_ID),
        kind: 'eam-request',
        status: 'open',
        subjectUserId: MEMBER,
        page: {
          slug: 'quiet-fern',
          displayName: 'Quiet Fern',
          reviewStatus: 'pending',
        },
        note: 'A synthetic note.',
        createdAt: CREATED.toISOString(),
        blocksNewRequest: true,
      });
      expect(result.entries[1]).toMatchObject({
        kind: 'page-submitted',
        handledAt: CREATED.toISOString(),
        handledBy: ADMIN,
      });
      expect(result.entries[1]).not.toHaveProperty('blocksNewRequest');
      expect(result.entries[2]).not.toHaveProperty('page');
      expect(result.entries[2].blocksNewRequest).toBe(false);
    });

    it('shows no page that is gone, half-joined, and reads an old row as approved', async () => {
      const { service, entryModel, profileModel } = build();
      const ids = [1, 2, 3].map(() => new Types.ObjectId());
      entryModel.find.mockReturnValueOnce(
        chain(ids.map((profileId) => entry({ _id: profileId, profileId }))),
      );
      profileModel.find.mockReturnValueOnce(
        chain([
          { _id: ids[0], slug: 'a', displayName: 'A', deletedAt: CREATED },
          {
            _id: ids[1],
            slug: 'b',
            displayName: 'B',
            reviewStatus: 'claiming',
          },
          { _id: ids[2], slug: 'c', displayName: 'C' },
        ]),
      );
      const { entries } = await service.list('open', 1);
      expect(entries[0]).not.toHaveProperty('page');
      expect(entries[1]).not.toHaveProperty('page');
      expect(entries[2].page).toEqual({
        slug: 'c',
        displayName: 'C',
        reviewStatus: 'approved',
      });
    });

    it('says when there are more, and reads no pages for an empty list', async () => {
      const { service, entryModel, profileModel } = build();
      await expect(service.list('handled', 1)).resolves.toEqual({
        entries: [],
        hasMore: false,
      });
      expect(profileModel.find).not.toHaveBeenCalled();
      entryModel.find.mockReturnValueOnce(
        chain(
          Array.from({ length: INBOX_PAGE_SIZE + 1 }, () =>
            entry({ _id: new Types.ObjectId(), profileId: undefined }),
          ),
        ),
      );
      const result = await service.list('open', 1);
      expect(result.entries).toHaveLength(INBOX_PAGE_SIZE);
      expect(result.hasMore).toBe(true);
    });
  });

  describe('markHandled', () => {
    it('marks it and logs it in one transaction', async () => {
      const { service, entryModel, log, session } = build();
      entryModel.findOne.mockReturnValueOnce(chain(entry()));
      await expect(
        service.markHandled(ADMIN, String(ENTRY_ID)),
      ).resolves.toEqual({ handled: true });
      expect(entryModel.updateOne).toHaveBeenCalledWith(
        { _id: ENTRY_ID, status: 'open' },
        {
          $set: expect.objectContaining({
            status: 'handled',
            handledBy: ADMIN,
          }) as unknown,
        },
        { session },
      );
      expect(log.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: ADMIN,
          action: 'inbox.handled',
          targetType: 'admin-inbox',
          targetId: String(ENTRY_ID),
          reason: 'Admin marked the notice handled.',
          details: { kind: 'eam-request', subjectUserId: MEMBER },
        }),
        session,
      );
      expect(session.committed).toBe(1);
    });

    it('refuses an unknown id, a notice about yourself, and one already handled', async () => {
      const { service, entryModel, log } = build();
      await expect(service.markHandled(ADMIN, 'nope')).rejects.toThrow(
        new NotFoundException(ENTRY_NOT_FOUND),
      );
      await expect(
        service.markHandled(ADMIN, String(ENTRY_ID)),
      ).rejects.toThrow(new NotFoundException(ENTRY_NOT_FOUND));
      entryModel.findOne.mockReturnValueOnce(
        chain(entry({ subjectUserId: ADMIN })),
      );
      await expect(
        service.markHandled(ADMIN, String(ENTRY_ID)),
      ).rejects.toThrow(new ForbiddenException(OWN_ENTRY));
      entryModel.findOne.mockReturnValueOnce(
        chain(entry({ status: 'handled' })),
      );
      await expect(
        service.markHandled(ADMIN, String(ENTRY_ID)),
      ).rejects.toThrow(new ConflictException(ENTRY_HANDLED));
      expect(log.record).not.toHaveBeenCalled();
      expect(entryModel.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('resetEam', () => {
    it('lets the member ask again, and marks an open request handled', async () => {
      const { service, entryModel, log, session } = build();
      entryModel.findOne.mockReturnValueOnce(chain(entry()));
      await expect(service.resetEam(ADMIN, String(ENTRY_ID))).resolves.toEqual({
        reset: true,
      });
      const [filter, update] = entryModel.updateOne.mock
        .calls[0] as unknown as [
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      expect(filter).toEqual({ _id: ENTRY_ID, dedupeKey: eamKey(MEMBER) });
      expect(update.$unset).toEqual({ dedupeKey: 1 });
      expect(update.$set).toMatchObject({ status: 'handled' });
      expect(log.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'eam.reset',
          reason: 'Admin let the member ask for EaM again.',
        }),
        session,
      );
    });

    it('keeps the handled date of a request already handled', async () => {
      const { service, entryModel } = build();
      entryModel.findOne.mockReturnValueOnce(
        chain(entry({ status: 'handled' })),
      );
      await service.resetEam(ADMIN, String(ENTRY_ID));
      const [, update] = entryModel.updateOne.mock.calls[0] as unknown as [
        unknown,
        Record<string, unknown>,
      ];
      expect(update).toEqual({ $unset: { dedupeKey: 1 } });
    });

    it('refuses anything but a still-blocking EaM request about someone else', async () => {
      const { service, entryModel, log } = build();
      entryModel.findOne.mockReturnValueOnce(
        chain(entry({ kind: 'page-submitted' })),
      );
      await expect(service.resetEam(ADMIN, String(ENTRY_ID))).rejects.toThrow(
        new BadRequestException(NOT_EAM_REQUEST),
      );
      entryModel.findOne.mockReturnValueOnce(
        chain(entry({ dedupeKey: undefined })),
      );
      await expect(service.resetEam(ADMIN, String(ENTRY_ID))).rejects.toThrow(
        new ConflictException(ENTRY_HANDLED),
      );
      entryModel.findOne.mockReturnValueOnce(
        chain(entry({ subjectUserId: ADMIN })),
      );
      await expect(service.resetEam(ADMIN, String(ENTRY_ID))).rejects.toThrow(
        ForbiddenException,
      );
      expect(log.record).not.toHaveBeenCalled();
    });
  });

  it('parses only a 24-hex id', () => {
    expect(String(parseEntryId(String(ENTRY_ID)))).toBe(String(ENTRY_ID));
    expect(() => parseEntryId('x'.repeat(24))).toThrow(NotFoundException);
  });
});

describe('admininbox schema', () => {
  it('declares the inbox order and the one-per-subject key', () => {
    expect(AdminInboxEntrySchema.indexes()).toEqual([
      [{ status: 1, createdAt: -1 }, expect.any(Object)],
      [
        { dedupeKey: 1 },
        expect.objectContaining({
          unique: true,
          partialFilterExpression: { dedupeKey: { $type: 'string' } },
        }),
      ],
    ]);
  });

  it('keeps notes within the limit', () => {
    const connection = mongoose.createConnection();
    const Entry = connection.model('InboxSchemaTest', AdminInboxEntrySchema);
    const error = new Entry({
      kind: 'eam-request',
      subjectUserId: MEMBER,
      note: 'x'.repeat(MAX_INBOX_NOTE_LENGTH + 1),
    }).validateSync();
    expect(error?.errors.note).toBeDefined();
    void connection.close();
  });
});
