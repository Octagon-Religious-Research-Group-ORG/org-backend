import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

export function createCorsOptions(origins: string[]): CorsOptions {
  return {
    origin: origins,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'X-Cart-Token',
    ],
    // A receipt download (Chunk 16) names its file here; the website reads it.
    exposedHeaders: ['Content-Disposition'],
  };
}
