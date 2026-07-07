'use strict';

const crypto = require('crypto');
const { Worker } = require('bullmq');
const { PrismaClient } = require('@prisma/client');
const { getRedisConnection, connection: redis } = require('../queues/webhookQueue');
const { processWebhookJob, resolveTransaction } = require('../services/reconciliation');
const { requeryTransaction } = require('../services/nomba');
const logger = require('../lib/logger');

const prisma = new PrismaClient();

const BATCH_SIZE = parseInt(process.env.RECONCILIATION_BATCH_SIZE, 10) || 50;
const WORKER_INTERVAL_MS = parseInt(process.env.RECONCILIATION_INTERVAL_MS, 10) || 60 * 1000;

// Maximum minutes to wait before re-querying, regardless of requeueCount.
const MAX_BACKOFF_MINUTES = 60;

const LOCK_KEY = 'locks:reconciliation';
// TTL is slightly shorter than the cycle interval so the lock always
// expires before the next cycle starts, even if this instance crashes
// mid-cycle and never releases it.
const LOCK_TTL_MS = WORKER_INTERVAL_MS - 5000;

async function acquireLock() {
  const lockId = crypto.randomUUID();
  const result = await redis.set(LOCK_KEY, lockId, 'NX', 'PX', LOCK_TTL_MS);
  if (result !== 'OK') return null;
  return {
    async release() {
      // Lua script ensures we only delete the key if we still own it.
      // Prevents releasing a lock that expired and was acquired by another instance.
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      await redis.eval(script, 1, LOCK_KEY, lockId);
    },
  };
}

function shouldRequery(transaction) {
  const { requeueCount, lastCheckedAt } = transaction;
  if (!lastCheckedAt) return true;
  const backoffMinutes = Math.min(Math.pow(2, requeueCount), MAX_BACKOFF_MINUTES);
  const msSinceLastCheck = Date.now() - new Date(lastCheckedAt).getTime();
  return msSinceLastCheck >= backoffMinutes * 60 * 1000;
}

async function runReconciliationCycle() {
  const lock = await acquireLock();
  if (!lock) {
    logger.info('reconciliation cycle skipped — lock held by another instance');
    return;
  }

  let processed = 0;
  let resolved = 0;
  let errors = 0;

  try {
    const pending = await prisma.transaction.findMany({
      where: { state: 'pending' },
      take: BATCH_SIZE,
      orderBy: { lastCheckedAt: 'asc' },
    });

    for (const tx of pending) {
      if (!shouldRequery(tx)) continue;

      try {
        await prisma.transaction.update({
          where: { id: tx.id },
          data: { lastCheckedAt: new Date(), requeueCount: { increment: 1 } },
        });

        processed++;

        if (!tx.sessionId) {
          logger.warn({ merchantTxRef: tx.merchantTxRef }, 'no sessionId — cannot requery, skipping');
          continue;
        }

        const nombaResult = await requeryTransaction(tx.sessionId);
        const nombaStatus = nombaResult?.data?.status?.toLowerCase();

        const outcome = await resolveTransaction(tx, nombaStatus);
        if (outcome !== 'pending') resolved++;
      } catch (err) {
        if (err.response?.status === 404) {
          // Nomba has no record of this sessionId — expected for synthetic test
          // transactions. Not a service failure; backoff will keep retries sparse.
          logger.warn({ merchantTxRef: tx.merchantTxRef }, 'nomba requery 404 — transaction unknown to nomba, skipping this cycle');
        } else {
          errors++;
          logger.error({ err, merchantTxRef: tx.merchantTxRef }, 'reconciliation cycle error on transaction');
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'reconciliation cycle failed to fetch pending transactions');
  } finally {
    await lock.release();
  }

  logger.info({ processed, resolved, errors }, 'reconciliation cycle complete');
}

function startReconciliationWorker() {
  // BullMQ worker: processes webhook jobs from the queue
  const webhookWorker = new Worker(
    'webhook-processing',
    async (job) => {
      logger.info({ jobId: job.id, merchantTxRef: job.data.merchantTxRef }, 'processing webhook job');
      await processWebhookJob(job);
    },
    {
      connection: getRedisConnection(),
      concurrency: 5,
    }
  );

  webhookWorker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'webhook job completed');
  });

  webhookWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'webhook job failed');
  });

  webhookWorker.on('error', (err) => {
    logger.error({ err }, 'webhook worker error');
  });

  // Requery loop: finds pending transactions and asks Nomba for their status
  const interval = setInterval(runReconciliationCycle, WORKER_INTERVAL_MS);

  // Run one cycle immediately on startup to catch anything left over from a restart
  runReconciliationCycle();

  logger.info('reconciliation worker started');

  return { webhookWorker, interval };
}

module.exports = { startReconciliationWorker };
