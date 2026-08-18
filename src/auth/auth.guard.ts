import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verifyToken } from '@clerk/backend';
import type { AuthenticatedRequest, ClerkAuthPayload } from './auth.types';

const BEARER_PREFIX = 'Bearer ';

@Injectable()
export class ClerkAuthGuard implements CanActivate {
  private readonly secretKey: string;
  private readonly authorizedParties: string[];

  constructor(config: ConfigService) {
    this.secretKey = config.getOrThrow<string>('CLERK_SECRET_KEY');
    // Same parsing as the CORS origin list in main.ts. Passing these to
    // verifyToken rejects tokens minted for a different frontend.
    this.authorizedParties = config
      .getOrThrow<string>('CLIENT_ORIGIN_URL')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request);

    if (!token) {
      throw new UnauthorizedException('A valid access token is required.');
    }

    let payload: ClerkAuthPayload;
    try {
      payload = await verifyToken(token, {
        secretKey: this.secretKey,
        authorizedParties: this.authorizedParties,
      });
    } catch {
      throw new UnauthorizedException('A valid access token is required.');
    }

    if (!payload.sub) {
      throw new UnauthorizedException('The access token has no subject.');
    }

    request.auth = { payload };
    return true;
  }

  private extractBearerToken(
    request: AuthenticatedRequest,
  ): string | undefined {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith(BEARER_PREFIX)) return undefined;
    return authorization.slice(BEARER_PREFIX.length).trim() || undefined;
  }
}

@Injectable()
export class OptionalClerkAuthGuard implements CanActivate {
  constructor(private readonly clerkAuthGuard: ClerkAuthGuard) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.headers.authorization) return true;
    return this.clerkAuthGuard.canActivate(context);
  }
}
