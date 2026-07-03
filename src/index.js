'use strict';

require('dotenv').config();

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const requestId = require('./middleware/requestId');
const errorHandler = require('./middleware/errorHandler');
const healthRouter = require('./routes/health');
const webhooksRouter = require('./routes/webhooks');
const { getWebhookQueue } = require('./queues/webhookQueue');
const { startReconciliationWorker } = require('./workers/reconciliationWorker');
const logger = require('./lib/logger');

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

// requestId must be first as every subsequent middleware needs req.requestId
app.use(requestId);

app.use(express.json({ limit: '10kb' }));

app.use('/v1', healthRouter);
app.use('/v1', webhooksRouter);

app.use(errorHandler);

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception — shutting down');
  process.exit(1);
});

async function start() {
  const { webhookWorker, interval } = startReconciliationWorker();

  const server = app.listen(PORT, () => {
    logger.info({ port: PORT, env: process.env.NODE_ENV }, 'settl server started');
  });

  async function shutdown(signal) {
    logger.info({ signal }, 'shutdown signal received — draining');
    clearInterval(interval);
    server.close(async () => {
      await webhookWorker.close();
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
