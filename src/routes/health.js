'use strict';

const { Router } = require('express');
const { PrismaClient } = require('@prisma/client');
const { getWebhookQueue, connection: redisConnection } = require('../queues/webhookQueue');
const { getCircuitBreakerStates } = require('../services/nomba');
const logger = require('../lib/logger');

const router = Router();
const prisma = new PrismaClient();

function withTimeout(promise, ms, label) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} check timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

router.get('/health', async (req, res) => {
  const checks = {};
  let allHealthy = true;

  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, 5000, 'database');
    checks.database = { status: 'ok' };
  } catch (err) {
    checks.database = { status: 'error', message: err.message };
    allHealthy = false;
  }

  try {
    await withTimeout(redisConnection.ping(), 4000, 'redis');
    checks.redis = { status: 'ok' };
  } catch (err) {
    checks.redis = { status: 'error', message: err.message };
    allHealthy = false;
  }

  try {
    const queue = getWebhookQueue();
    const [waiting, active, failed] = await withTimeout(
      Promise.all([queue.getWaitingCount(), queue.getActiveCount(), queue.getFailedCount()]),
      4000,
      'queue'
    );
    checks.queue = { status: 'ok', waiting, active, dlqCount: failed };
  } catch (err) {
    checks.queue = { status: 'error', message: err.message };
  }

  checks.nomba = { circuitBreakers: getCircuitBreakerStates() };

  const httpStatus = allHealthy ? 200 : 503;
  logger.info({ requestId: req.requestId, checks, allHealthy }, 'health check');
  res.status(httpStatus).json({ status: allHealthy ? 'ok' : 'degraded', checks });
});

module.exports = router;
