'use strict';

const { Router } = require('express');
const { PrismaClient } = require('@prisma/client');
const { getWebhookQueue, getRedisConnection } = require('../queues/webhookQueue');
const { getCircuitBreakerStates } = require('../services/nomba');
const logger = require('../lib/logger');

const router = Router();
const prisma = new PrismaClient();

router.get('/health', async (req, res) => {
  const checks = {};
  let allHealthy = true;

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { status: 'ok' };
  } catch (err) {
    checks.database = { status: 'error', message: err.message };
    allHealthy = false;
  }

  try {
    const Redis = require('ioredis');
    const conn = getRedisConnection();
    const redis = new Redis({ ...conn, lazyConnect: true, connectTimeout: 3000 });
    await redis.connect();
    await redis.ping();
    await redis.quit();
    checks.redis = { status: 'ok' };
  } catch (err) {
    checks.redis = { status: 'error', message: err.message };
    allHealthy = false;
  }

  try {
    const queue = getWebhookQueue();
    const [waiting, active, failed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getFailedCount(),
    ]);
    checks.queue = { status: 'ok', waiting, active, dlqCount: failed };
  } catch (err) {
    checks.queue = { status: 'error', message: err.message };
  }

  const circuitBreakers = getCircuitBreakerStates();
  checks.nomba = { circuitBreakers };

  const httpStatus = allHealthy ? 200 : 503;
  logger.info({ requestId: req.requestId, checks, allHealthy }, 'health check');
  res.status(httpStatus).json({ status: allHealthy ? 'ok' : 'degraded', checks });
});

module.exports = router;
