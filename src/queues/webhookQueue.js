'use strict';

const { Queue } = require('bullmq');
const Redis = require('ioredis');
const logger = require('../lib/logger');

let webhookQueue = null;

function getRedisConnection() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const parsed = new URL(url);
  const isTls = parsed.protocol === 'rediss:';
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port, 10) || (isTls ? 6380 : 6379),
    password: parsed.password || undefined,
    username: parsed.username || undefined,
    ...(isTls && { tls: {} }),
    // BullMQ requires maxRetriesPerRequest: null. Do NOT change this
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (times) => Math.min(times * 50, 2000),
    reconnectOnError: () => true,
  };
}


const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: (times) => Math.min(times * 50, 2000),
  reconnectOnError: () => true,
});
connection.on('error', (err) => logger.error({ err }, 'redis connection error'));

function getWebhookQueue() {
  if (!webhookQueue) {
    webhookQueue = new Queue('webhook-processing', {
      connection,
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

module.exports = { getWebhookQueue, getRedisConnection, connection };
