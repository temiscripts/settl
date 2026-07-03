'use strict';

const { Worker } = require('bullmq');
const { PrismaClient } = require('@prisma/client');
const { getRedisConnection } = require('../queues/webhookQueue');
const { processWebhookJob, resolveTransaction } = require('../services/reconciliation');
const { requeryTransaction } = require('../services/nomba');
const logger = require('../lib/logger');

const prisma = new PrismaClient();

const BATCH_SIZE = 50;
const WORKER_INTERVAL_MS = 60 * 1000;

// Maximum minutes to wait before re-querying, regardless of requeueCount.
const MAX_BACKOFF_MINUTES = 60;

function shouldRequery(transaction) {
  const { requeueCount, lastCheckedAt } = transaction;
  if (!lastCheckedAt) return true;
  const backoffMinutes = Math.min(Math.pow(2, requeueCount), MAX_BACKOFF_MINUTES);
  const msSinceLastCheck = Date.now() - new Date(lastCheckedAt).getTime();
  return msSinceLastCheck >= backoffMinutes * 60 * 1000;
}

async function runReconciliationCycle() {
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
        errors++;
        logger.error({ err, merchantTxRef: tx.merchantTxRef }, 'reconciliation cycle error on transaction');
      }
    }
  } catch (err) {
    logger.error({ err }, 'reconciliation cycle failed to fetch pending transactions');
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
