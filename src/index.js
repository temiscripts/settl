'use strict';

require('dotenv').config();

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const requestId = require('./middleware/requestId');
const errorHandler = require('./middleware/errorHandler');
const healthRouter = require('./routes/health');
const webhooksRouter = require('./routes/webhooks');
const { logDlqCount, getWebhookQueue } = require('./queues/webhookQueue');
const logger = require('./lib/logger');

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

// requestId must be first — every subsequent middleware needs req.requestId
app.use(requestId);

// Raw body for the webhook path BEFORE express.json().
// express.raw sets req._body=true which signals express.json to skip this request.
// If express.json ran first it would consume the stream; HMAC would then compute
// over a re-serialized string, not Nomba's original bytes — and never match.
app.use('/v1/webhooks/nomba', express.raw({ type: 'application/json', limit: '10kb' }));

// Global JSON parser for all other routes
app.use(express.json({ limit: '10kb' }));

// Routes — all under /v1
app.use('/v1', healthRouter);
app.use('/v1', webhooksRouter);

// Error handler must be registered last
app.use(errorHandler);

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception — shutting down');
  process.exit(1);
});

async function start() {
  await logDlqCount().catch((err) =>
    logger.warn({ err }, 'could not check dlq on startup (redis may not be running locally)')
  );

  const server = app.listen(PORT, () => {
    logger.info({ port: PORT, env: process.env.NODE_ENV }, 'settl server started');
  });

  async function shutdown(signal) {
    logger.info({ signal }, 'shutdown signal received — draining');
    server.close(async () => {
      const queue = getWebhookQueue();
      await queue.close();
      await prisma.$disconnect();
      logger.info('shutdown complete');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  logger.fatal({ err }, 'failed to start server');
  process.exit(1);
});
