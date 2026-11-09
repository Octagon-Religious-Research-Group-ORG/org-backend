import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { AdminRoleGuard } from './admin-role.guard';

function context(permissions: string[]): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        auth: { payload: { sub: 'user_member', permissions } },
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('AdminRoleGuard', () => {
  const adminAccess = { hasAdminAccess: jest.fn() };
  const guard = new AdminRoleGuard(adminAccess as never);

  beforeEach(() => adminAccess.hasAdminAccess.mockReset());

  it('allows the real admin role', async () => {
    adminAccess.hasAdminAccess.mockResolvedValue(true);
    await expect(guard.canActivate(context([]))).resolves.toBe(true);
  });

  it('refuses a non-admin, even with every permission claim', async () => {
    adminAccess.hasAdminAccess.mockResolvedValue(false);
    await expect(
      guard.canActivate(context(['manage:settings'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(adminAccess.hasAdminAccess).toHaveBeenCalledTimes(1);
  });
});
