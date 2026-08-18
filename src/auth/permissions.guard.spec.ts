import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { PermissionsGuard } from './permissions.guard';

function context(permissions: string[]): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({
      getRequest: () => ({
        auth: { payload: { sub: 'user_member', permissions } },
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  const reflector = {
    getAllAndOverride: jest.fn(),
  };
  const adminAccess = {
    hasAdminAccess: jest.fn(),
  };
  const guard = new PermissionsGuard(reflector as never, adminAccess as never);

  beforeEach(() => {
    reflector.getAllAndOverride.mockReset();
    adminAccess.hasAdminAccess.mockReset();
  });

  it('allows a token with every route permission', async () => {
    reflector.getAllAndOverride.mockReturnValue([
      'read:content',
      'update:content',
    ]);

    await expect(
      guard.canActivate(context(['read:content', 'update:content'])),
    ).resolves.toBe(true);
    expect(adminAccess.hasAdminAccess).not.toHaveBeenCalled();
  });

  it.each([undefined, []])(
    'allows routes without permission metadata',
    async (required) => {
      reflector.getAllAndOverride.mockReturnValue(required);

      await expect(guard.canActivate(context([]))).resolves.toBe(true);
    },
  );

  it('treats malformed token permissions as empty', async () => {
    reflector.getAllAndOverride.mockReturnValue(['read:content']);
    const malformed = {
      ...context([]),
      switchToHttp: () => ({
        getRequest: () => ({
          auth: {
            payload: { sub: 'user_member', permissions: 'read:content' },
          },
        }),
      }),
    } as ExecutionContext;

    adminAccess.hasAdminAccess.mockResolvedValue(false);
    await expect(guard.canActivate(malformed)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects a token that is missing a route permission', async () => {
    reflector.getAllAndOverride.mockReturnValue(['publish:content']);
    adminAccess.hasAdminAccess.mockResolvedValue(false);

    await expect(
      guard.canActivate(context(['read:content'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('grants every route permission to an allowlisted administrator', async () => {
    reflector.getAllAndOverride.mockReturnValue([
      'read:content',
      'update:content',
      'publish:content',
    ]);
    adminAccess.hasAdminAccess.mockResolvedValue(true);

    await expect(guard.canActivate(context([]))).resolves.toBe(true);
    expect(adminAccess.hasAdminAccess).toHaveBeenCalled();
  });
});
