import express from 'express';
import cors from 'cors';
import pino from 'pino';
import pinoHttp from 'pino-http';

import { verifyFirebaseToken } from './auth.js';
import tenantRouter from './routes/tenant.js';

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
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use('/tenant', verifyFirebaseToken, tenantRouter);

  if (serveStatic && webDir) {
    app.use(express.static(webDir, { extensions: ['html'] }));
  }

  app.use((err, req, res, _next) => {
    req.log?.error({ err: err.message, stack: err.stack }, 'unhandled error');
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
