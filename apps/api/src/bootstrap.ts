import type { INestApplication } from '@nestjs/common';
import { raw } from 'express';
import type { CorsOptionsDelegate } from '@nestjs/common/interfaces/external/cors-options.interface.js';
import { CONTENT_SECURITY_POLICY, CORS_HEADERS, CORS_METHODS } from './config/constants.ts';
import { ALLOWED_FILE_TYPES } from './riders/file-storage.ts';
import { APP_CONFIG } from './config/env.ts';
import type { AppConfig } from './config/env.ts';
import type { ApiRequest, ApiResponse } from './common/http.ts';

/** Settings shared by the real server and the tests, so tests exercise the same security setup. */
export function configureApp(app: INestApplication) {
  const config = app.get<AppConfig>(APP_CONFIG);
  const http = app.getHttpAdapter().getInstance();
  http.disable('x-powered-by');
  if (config.http.trustProxy > 0) http.set('trust proxy', config.http.trustProxy); // number of proxies in front

  app.use((_req: ApiRequest, res: ApiResponse, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Strict-Transport-Security', `max-age=${config.http.hstsMaxAgeSeconds}; includeSubDomains`);
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    next();
  });

  // A document upload is the file's own bytes (PDF, JPEG or PNG), not JSON. Only those content types are read, and only up to the size limit;
  // a bigger body is refused with 413 before it is kept in memory.
  app.use('/documents', raw({ type: [...ALLOWED_FILE_TYPES], limit: config.uploads.maxBytes }));

  // Browsers may only call from the sites listed in CORS_ORIGINS. The mobile apps are not browsers and need no entry.
  // Decided per request, so only a listed site is told that cookies are allowed. An unlisted site gets no CORS headers that grant anything.
  const cors: CorsOptionsDelegate<{ headers: { origin?: string } }> = (req, callback) => {
    const listed = req.headers.origin !== undefined && config.http.corsOrigins.includes(req.headers.origin);
    callback(null, { origin: listed, methods: CORS_METHODS, allowedHeaders: CORS_HEADERS, credentials: listed });
  };
  app.enableCors(cors);
}
