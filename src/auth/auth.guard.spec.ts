import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { verifyToken } from '@clerk/backend';
import { ClerkAuthGuard, OptionalClerkAuthGuard } from './auth.guard';

jest.mock('@clerk/backend', () => ({
  verifyToken: jest.fn(),
}));

const verifyTokenMock = jest.mocked(verifyToken);

function context(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ statusCode: 200 }),
    }),
  } as unknown as ExecutionContext;
}

describe('ClerkAuthGuard', () => {
  const config = {
    getOrThrow: jest.fn((key: string) =>
      key === 'CLERK_SECRET_KEY'
        ? 'sk_test_secret'
        : 'https://app.example.test, https://www.app.example.test',
    ),
  };

  beforeEach(() => {
    verifyTokenMock.mockReset();
    config.getOrThrow.mockClear();
  });

  it('verifies a bearer token and exposes its claims on the request', async () => {
    verifyTokenMock.mockResolvedValue({ sub: 'user_member' } as never);
    const guard = new ClerkAuthGuard(config as never);
    const request: Record<string, unknown> = {
      headers: { authorization: 'Bearer session-token' },
    };

    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(verifyTokenMock).toHaveBeenCalledWith('session-token', {
      secretKey: 'sk_test_secret',
      authorizedParties: [
        'https://app.example.test',
        'https://www.app.example.test',
      ],
    });
    expect(request.auth).toEqual({ payload: { sub: 'user_member' } });
  });

  it.each([
    ['a missing authorization header', {}],
    ['a non-bearer scheme', { authorization: 'Basic abc123' }],
    ['an empty bearer value', { authorization: 'Bearer   ' }],
  ])('rejects %s without calling Clerk', async (_label, headers) => {
    const guard = new ClerkAuthGuard(config as never);

    await expect(
      guard.canActivate(context({ headers })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(verifyTokenMock).not.toHaveBeenCalled();
  });

  it('converts verification failures to an unauthorized response', async () => {
    verifyTokenMock.mockRejectedValue(new Error('invalid'));
    const guard = new ClerkAuthGuard(config as never);

    await expect(
      guard.canActivate(
        context({ headers: { authorization: 'Bearer bad-token' } }),
      ),
    ).rejects.toThrow('A valid access token is required.');
  });

  it('rejects a verified token without a subject', async () => {
    verifyTokenMock.mockResolvedValue({} as never);
    const guard = new ClerkAuthGuard(config as never);

    await expect(
      guard.canActivate(
        context({ headers: { authorization: 'Bearer subjectless' } }),
      ),
    ).rejects.toThrow('The access token has no subject.');
  });
});

describe('OptionalClerkAuthGuard', () => {
  it('allows requests without authorization and delegates requests with it', async () => {
    const clerkAuthGuard = { canActivate: jest.fn().mockResolvedValue(true) };
    const guard = new OptionalClerkAuthGuard(clerkAuthGuard as never);
    const anonymous = context({ headers: {} });
    const authorized = context({
      headers: { authorization: 'Bearer token' },
    });

    expect(guard.canActivate(anonymous)).toBe(true);
    await expect(guard.canActivate(authorized)).resolves.toBe(true);
    expect(clerkAuthGuard.canActivate).toHaveBeenCalledWith(authorized);
  });
});
