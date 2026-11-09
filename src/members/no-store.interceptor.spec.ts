import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import {
  GUEST_JSON_CACHE_CONTROL,
  MemberJsonCacheInterceptor,
  NoStoreWhenSignedInInterceptor,
  SIGNED_IN_CACHE_CONTROL,
} from './no-store.interceptor';

function run(request: object) {
  const setHeader = jest.fn();
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ setHeader }),
    }),
  } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => of('body') };
  const result = new NoStoreWhenSignedInInterceptor().intercept(context, next);
  return { setHeader, result };
}

describe('NoStoreWhenSignedInInterceptor', () => {
  it('keeps a signed-in response out of every cache', async () => {
    const { setHeader, result } = run({ auth: { payload: { sub: 'u1' } } });
    expect(setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      SIGNED_IN_CACHE_CONTROL,
    );
    await expect(lastValueFrom(result)).resolves.toBe('body');
  });

  it('leaves a guest response alone', async () => {
    const { setHeader, result } = run({});
    expect(setHeader).not.toHaveBeenCalled();
    await expect(lastValueFrom(result)).resolves.toBe('body');
  });
});

describe('MemberJsonCacheInterceptor', () => {
  function json(request: object) {
    const setHeader = jest.fn();
    const vary = jest.fn();
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ setHeader, vary }),
      }),
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of('body') };
    const result = new MemberJsonCacheInterceptor().intercept(context, next);
    return { setHeader, vary, result };
  }

  it('keeps a guest answer out of a shared cache', async () => {
    const { setHeader, vary, result } = json({});
    expect(setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      GUEST_JSON_CACHE_CONTROL,
    );
    expect(vary).toHaveBeenCalledWith('Authorization');
    await expect(lastValueFrom(result)).resolves.toBe('body');
  });

  it('varies a signed-in answer, leaving its stricter header alone', () => {
    const { setHeader, vary } = json({ auth: { payload: { sub: 'u1' } } });
    expect(vary).toHaveBeenCalledWith('Authorization');
    expect(setHeader).not.toHaveBeenCalled();
  });
});
