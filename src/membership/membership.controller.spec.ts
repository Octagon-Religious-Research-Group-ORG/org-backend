import type { Request } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.types';
import {
  MembershipController,
  MyMembershipController,
  originOf,
} from './membership.controller';
import type { JoinMembershipDto } from './membership.dto';
import { RESERVED_SLUGS, slugProblem } from './reserved-slugs';

function request(fields: Record<string, unknown>) {
  return { headers: {}, ...fields } as unknown as Request;
}

describe('originOf', () => {
  it('takes the client IP and never the browser type (not disclosed)', () => {
    expect(
      originOf(request({ ip: '1.2.3.4', headers: { 'user-agent': 'ua' } })),
    ).toEqual({ ip: '1.2.3.4' });
    expect(originOf(request({}))).toEqual({});
  });
});

describe('MembershipController', () => {
  const service = {
    terms: jest.fn(() => ({ version: 'v' })),
    slugAvailability: jest.fn(() => Promise.resolve({ available: true })),
    recordGuestEntry: jest.fn(() => Promise.resolve()),
    summary: jest.fn(() => Promise.resolve({ status: 'none' })),
    join: jest.fn(() => Promise.resolve({ status: 'pending' })),
  };
  const controller = new MembershipController(service as never);
  const mine = new MyMembershipController(service as never);

  it('serves the terms', () => {
    expect(controller.terms()).toEqual({ version: 'v' });
  });

  it('checks an address, treating a missing one as empty', async () => {
    const req = request({
      auth: { payload: { sub: 'user_a' } },
    }) as AuthenticatedRequest;
    await controller.slugAvailability(req, 'some-member');
    await controller.slugAvailability(req, ['a', 'b']);
    expect(service.slugAvailability).toHaveBeenNthCalledWith(
      1,
      'some-member',
      'user_a',
    );
    expect(service.slugAvailability).toHaveBeenNthCalledWith(2, '', 'user_a');
  });

  it('records a guest entry with the request origin', async () => {
    await controller.guestEntry(request({ ip: '9.9.9.9' }));
    expect(service.recordGuestEntry).toHaveBeenCalledWith({ ip: '9.9.9.9' });
  });

  it('reads and joins as the signed-in member only', async () => {
    const req = request({
      ip: '5.5.5.5',
      auth: { payload: { sub: 'user_a' } },
    }) as AuthenticatedRequest;
    const body = { slug: 'x' } as JoinMembershipDto;
    await mine.summary(req);
    await mine.join(req, body);
    expect(service.summary).toHaveBeenCalledWith('user_a');
    expect(service.join).toHaveBeenCalledWith('user_a', body, {
      ip: '5.5.5.5',
    });
  });
});

describe('slugProblem', () => {
  it('flags format and reserved site pages', () => {
    expect(slugProblem('a')).toBe('format');
    expect(slugProblem('x'.repeat(81))).toBe('format');
    expect(slugProblem('Some-Member')).toBe('format');
    expect(slugProblem('membership')).toBe('reserved');
    expect(slugProblem('some-member')).toBeUndefined();
  });

  it('reserves staff names and addresses that imply authority', () => {
    for (const address of [
      'tripp',
      'renan',
      'administrator',
      'moderator',
      'official',
      'cart',
      'checkout',
      'directory',
      'eam',
    ]) {
      expect(slugProblem(address)).toBe('reserved');
    }
  });

  it('reserves every page of the current website', () => {
    for (const page of [
      'about',
      'community',
      'beliefs',
      'infrastructure',
      'research',
      'legal',
      'future-ideas',
      'gifts-contributions',
      'offerings',
      'join',
      'profile',
      'admin',
      'membership',
    ]) {
      expect(RESERVED_SLUGS.has(page)).toBe(true);
    }
  });
});
