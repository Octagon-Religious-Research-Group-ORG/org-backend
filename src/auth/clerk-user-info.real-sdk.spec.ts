// Reviews rounds 4 and 5: the REAL Clerk SDK with only `fetch` stubbed. The
// SDK reports a failed connection and an unreadable answer after a 200 as a
// ClerkAPIResponseError with NO status (`unexpected_error`); a 5xx keeps its
// status, with no Clerk error body when the body is not JSON. A write is
// unknown unless Clerk definitely refused it. Synthetic data and key only; no request
// leaves the machine (the SDK reads the global `fetch` per call under
// NODE_ENV=test, which Jest sets).
import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CLERK_WRITE_BUSY,
  ClerkOutcomeUnknown,
  ClerkUserInfoService,
  isDefiniteRefusal,
} from './clerk-user-info.service';
import { ClerkAdminDirectoryService } from './clerk-admin-directory.service';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('ClerkAdminDirectoryService with the real SDK (review round 5, PA/PB)', () => {
  const realFetch = globalThis.fetch;
  const fetchMock = jest.fn<Promise<Response>, [string, RequestInit?]>();
  const directory = () =>
    new ClerkAdminDirectoryService({
      getOrThrow: () => 'sk_test_synthetic_key_for_tests',
    } as never);
  const invitationJson = (extra: Record<string, unknown> = {}) => ({
    object: 'invitation',
    id: 'inv_synthetic',
    email_address: 'x@example.org',
    public_metadata: { role: 'admin' },
    status: 'pending',
    updated_at: 1_700_000_000_000,
    ...extra,
  });

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it('PA: a 2xx the SDK cannot read (a charset content type) is unknown, never a failure', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify(invitationJson({ created_at: 1_700_000_000_000 })),
        {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        },
      ),
    );
    await expect(
      directory().invite('x@example.org', 'admin', 'https://x.test', 3),
    ).rejects.toBeInstanceOf(ClerkOutcomeUnknown);
  });

  it('PB: a created invitation without a creation time is a success, not an error', async () => {
    fetchMock.mockResolvedValueOnce(json(200, invitationJson()));
    await expect(
      directory().invite('x@example.org', 'admin', 'https://x.test', 3),
    ).resolves.toEqual({
      invitationId: 'inv_synthetic',
      email: 'x@example.org',
      role: 'admin',
    });
  });

  it('a normal answer is a normal success, with its creation time', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, invitationJson({ created_at: 1_700_000_000_000 })),
    );
    await expect(
      directory().invite('x@example.org', null, 'https://x.test'),
    ).resolves.toMatchObject({
      invitationId: 'inv_synthetic',
      createdAt: new Date(1_700_000_000_000).toISOString(),
    });
  });
});

describe('ClerkUserInfoService with the real SDK (review round 4, P4)', () => {
  const realFetch = globalThis.fetch;
  const fetchMock = jest.fn<Promise<Response>, [string, RequestInit?]>();
  const service = () =>
    new ClerkUserInfoService({
      getOrThrow: () => 'sk_test_synthetic_key_for_tests',
    } as never);

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it('P4: Clerk applied the change but the answer could not be read: unknown', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"id": "user_1", "public_m', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(service().setRole('user_1', null)).rejects.toBeInstanceOf(
      ClerkOutcomeUnknown,
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/users/user_1/metadata');
    expect(init?.method).toBe('PATCH');
  });

  it('a connection that fails, and any 5xx, are unknown too', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(service().setRole('user_1', null)).rejects.toBeInstanceOf(
      ClerkOutcomeUnknown,
    );
    fetchMock.mockResolvedValueOnce(new Response('oops', { status: 500 }));
    await expect(service().setRole('user_1', null)).rejects.toBeInstanceOf(
      ClerkOutcomeUnknown,
    );
    // A 429 without Clerk's own body might come from anything in between.
    fetchMock.mockResolvedValueOnce(new Response('slow down', { status: 429 }));
    await expect(service().setRole('user_1', null)).rejects.toBeInstanceOf(
      ClerkOutcomeUnknown,
    );
  });

  it('a definite Clerk refusal is a plain failure', async () => {
    fetchMock.mockResolvedValueOnce(
      json(422, {
        errors: [{ code: 'form_param_format_invalid', message: 'x' }],
      }),
    );
    await expect(service().setRole('user_1', null)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    fetchMock.mockResolvedValueOnce(
      json(429, { errors: [{ code: 'too_many_requests', message: 'x' }] }),
    );
    const busy = await service()
      .setRole('user_1', null)
      .catch((e: unknown) => e);
    expect(busy).toEqual(new ServiceUnavailableException(CLERK_WRITE_BUSY));
    expect(busy).not.toBeInstanceOf(ClerkOutcomeUnknown);
  });

  it('a READ that fails is a plain 503, never "unknown"', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const read = await service()
      .getIdentity('user_1')
      .catch((e: unknown) => e);
    expect(read).toBeInstanceOf(ServiceUnavailableException);
    expect(read).not.toBeInstanceOf(ClerkOutcomeUnknown);
  });

  it.each([
    [{ status: 400 }, true],
    [{ status: 401 }, true],
    [{ status: 403 }, true],
    [{ status: 404 }, true],
    [{ status: 409 }, true],
    [{ status: 422 }, true],
    [{ status: 429, errors: [{ code: 'x' }] }, true],
    [{ status: 429, errors: [] }, false],
    [{ status: 429 }, false],
    [{ status: 500 }, false],
    [{ status: 503 }, false],
    [{ status: undefined, errors: [{ code: 'unexpected_error' }] }, false],
    [new TypeError('boom'), false],
    [null, false],
    ['text', false],
  ])('isDefiniteRefusal(%o) is %s', (error, expected) => {
    expect(isDefiniteRefusal(error)).toBe(expected);
  });
});
