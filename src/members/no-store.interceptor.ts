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
