'use strict';

const { Queue } = require('bullmq');
const logger = require('../lib/logger');

let webhookQueue = null;

function getRedisConnection() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port, 10) || 6379,
    password: parsed.password || undefined,
  };
}

function getWebhookQueue() {
  if (!webhookQueue) {
    webhookQueue = new Queue('webhook-processing', {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 100 },
        removeOnFail: false,
      },
    });

    webhookQueue.on('error', (err) =>
      logger.error({ err }, 'webhook queue error'));
  }
  return webhookQueue;
}

async function logDlqCount() {
  const queue = getWebhookQueue();
  const failed = await queue.getFailed();
  logger.info({ dlqCount: failed.length }, 'webhook dead letter queue count on startup');
}

module.exports = { getWebhookQueue, getRedisConnection, logDlqCount };
