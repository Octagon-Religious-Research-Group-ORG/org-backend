import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';
import type { AuthenticatedRequest } from '../auth/auth.types';

export const SIGNED_IN_CACHE_CONTROL = 'private, no-store';
export const GUEST_JSON_CACHE_CONTROL = 'no-store';

/**
 * Whatever a signed-in member receives may be for their eyes only, so it is
 * stored nowhere. A handler can still set its own header afterwards, as the
 * picture route does for a public picture.
 */
@Injectable()
export class NoStoreWhenSignedInInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    if (http.getRequest<AuthenticatedRequest>().auth) {
      http
        .getResponse<Response>()
        .setHeader('Cache-Control', SIGNED_IN_CACHE_CONTROL);
    }
    return next.handle();
  }
}

/**
 * For the JSON a guest can read. An answer depends on who asks, so a shared
 * cache must neither reuse it nor hand it to someone else. Signed-in responses
 * keep the stricter header above. Not for the picture route, which sets its
 * own caching.
 */
@Injectable()
export class MemberJsonCacheInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const response = http.getResponse<Response>();
    // `vary` adds to the header: CORS has already put Origin there.
    response.vary('Authorization');
    if (!http.getRequest<AuthenticatedRequest>().auth) {
      response.setHeader('Cache-Control', GUEST_JSON_CACHE_CONTROL);
    }
    return next.handle();
  }
}
