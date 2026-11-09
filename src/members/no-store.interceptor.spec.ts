import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import {
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
