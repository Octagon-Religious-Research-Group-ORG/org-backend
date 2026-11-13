import { ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import type { Viewer } from '../profile-access';
import {
  EAM_NEEDS_APPROVED_PAGE,
  EamRequestsService,
} from './eam-requests.service';

const PAGE_ID = new Types.ObjectId();
const AT = '2026-11-13T10:00:00.000Z';

function build(page: unknown = { _id: PAGE_ID }) {
  const profileModel = {
    findOne: jest.fn(() => ({
      select: () => ({ lean: () => ({ exec: () => Promise.resolve(page) }) }),
    })),
  };
  const inbox = {
    myEamRequest: jest.fn(() => Promise.resolve({ requested: false })),
    requestEam: jest.fn(() =>
      Promise.resolve({ requested: true, requestedAt: AT }),
    ),
  };
  const service = new EamRequestsService(profileModel as never, inbox as never);
  return { service, profileModel, inbox };
}

const viewer = (kind: Viewer['kind']) => ({
  kind,
  userId: 'user_m',
  isAdmin: false,
});

describe('EamRequestsService', () => {
  it('offers the button to approved members only', async () => {
    const { service } = build();
    await expect(service.status(viewer('named-member'))).resolves.toEqual({
      mayRequest: true,
    });
    await expect(service.status(viewer('anonymous-member'))).resolves.toEqual({
      mayRequest: true,
    });
    await expect(service.status(viewer('signed-in'))).resolves.toEqual({
      mayRequest: false,
      block: 'needs-approved-page',
    });
  });

  it('says when the member already asked, whatever their page now', async () => {
    const { service, inbox } = build();
    inbox.myEamRequest.mockResolvedValue({
      requested: true,
      requestedAt: AT,
    } as never);
    await expect(service.status(viewer('signed-in'))).resolves.toEqual({
      mayRequest: false,
      block: 'already-requested',
      requestedAt: AT,
    });
  });

  it('records the request against the member’s own page', async () => {
    const { service, inbox, profileModel } = build();
    await expect(
      service.request(viewer('named-member'), 'A note'),
    ).resolves.toEqual({
      mayRequest: false,
      block: 'already-requested',
      requestedAt: AT,
    });
    expect(profileModel.findOne).toHaveBeenCalledWith({
      ownerUserId: 'user_m',
    });
    expect(inbox.requestEam).toHaveBeenCalledWith('user_m', PAGE_ID, 'A note');
  });

  it('refuses anyone without an approved page', async () => {
    const { service, inbox } = build();
    await expect(
      service.request(viewer('signed-in'), undefined),
    ).rejects.toThrow(new ForbiddenException(EAM_NEEDS_APPROVED_PAGE));
    const gone = build(null);
    await expect(
      gone.service.request(viewer('named-member'), undefined),
    ).rejects.toThrow(ForbiddenException);
    expect(inbox.requestEam).not.toHaveBeenCalled();
  });
});
