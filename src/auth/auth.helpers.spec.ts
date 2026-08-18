import {
  getCapabilities,
  getPermissions,
  getUserSub,
  hasPermissions,
} from './auth.helpers';
import type { AuthenticatedRequest } from './auth.types';

function requestWith(permissions: unknown): AuthenticatedRequest {
  return {
    auth: {
      payload: {
        sub: 'user_member',
        permissions,
      },
    },
  } as AuthenticatedRequest;
}

describe('auth permission helpers', () => {
  it('returns the authenticated subject', () => {
    expect(getUserSub(requestWith([]))).toBe('user_member');
  });

  it('rejects a request without an authenticated subject', () => {
    expect(() => getUserSub({ headers: {} } as AuthenticatedRequest)).toThrow(
      'A valid member identity is required.',
    );
  });

  it('maps independent shop and website capabilities', () => {
    const request = requestWith([
      'read:content',
      'update:content',
      'publish:content',
    ]);

    expect(getCapabilities(request)).toEqual({
      canManageOrders: false,
      canEditWebsite: true,
      canPublishWebsite: true,
    });
    expect(getCapabilities(request, true)).toEqual({
      canManageOrders: true,
      canEditWebsite: true,
      canPublishWebsite: true,
    });
  });

  it('ignores malformed permissions and requires every requested permission', () => {
    const request = requestWith(['read:orders', 7, null]);

    expect(getPermissions(request)).toEqual(['read:orders']);
    expect(hasPermissions(request, 'read:orders', 'update:orders')).toBe(false);
    expect(getPermissions(requestWith('read:orders'))).toEqual([]);
  });
});
