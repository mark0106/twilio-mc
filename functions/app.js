import express from 'express';
import cors from 'cors';
import pino from 'pino';
import pinoHttp from 'pino-http';

import { verifyFirebaseToken } from './auth.js';
import tenantRouter from './routes/tenant.js';
import contactListsRouter from './routes/contactLists.js';

export function buildApp({ serveStatic = false, webDir = null } = {}) {
  const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    redact: {
      paths: [
        'req.body.authToken',
        'req.body.twilioAuthToken',
        'tenant.twilioAuthToken*',
        'twilioAuthToken',
        'req.headers.authorization',
        'req.headers.cookie',
      ],
      censor: '[redacted]',
    },
  });

  const app = express();
  app.disable('x-powered-by');

  app.use(pinoHttp({ logger }));
  app.use(cors());
  // JSON parser scoped to non-multipart routes so the CSV upload endpoint can stream.
  app.use((req, res, next) => {
    const ct = req.headers['content-type'] || '';
    if (ct.startsWith('multipart/form-data')) return next();
    return express.json({ limit: '1mb' })(req, res, next);
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use('/tenant', verifyFirebaseToken, tenantRouter);
  app.use('/contact-lists', verifyFirebaseToken, contactListsRouter);

  if (serveStatic && webDir) {
    app.use(express.static(webDir, { extensions: ['html'] }));
  }

  app.use((err, req, res, _next) => {
    req.log?.error({ err: err.message, stack: err.stack }, 'unhandled error');
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
