'use strict';

const { Router } = require('express');
const { PrismaClient } = require('@prisma/client');
const { getWebhookQueue, connection: redis } = require('../queues/webhookQueue'); // 🛡️ Import shared Redis connection
const { webhookRateLimiter } = require('../middleware/rateLimiter');
const verifyNombaSignature = require('../middleware/nombaAuth'); // 🛡️ Import our signature verifier
const logger = require('../lib/logger');

const router = Router();
const prisma = new PrismaClient();

// 10-minute replay window with 30s tolerance for clock skew
const REPLAY_WINDOW_MS = (10 * 60 + 30) * 1000;

router.post(
  '/webhooks/nomba',
  webhookRateLimiter,
  verifyNombaSignature, // 🛡️ Enforce HMAC check (attaches req.parsedWebhookBody)
  async (req, res) => {
    const timestamp = req.headers['nomba-timestamp'];

    const ts = parseInt(timestamp, 10);
    if (!ts || isNaN(ts) || Date.now() - ts > REPLAY_WINDOW_MS) {
      logger.warn({ requestId: req.requestId, timestamp }, 'webhook rejected — missing or stale timestamp');
      return res.status(400).json({ error: 'Invalid or expired webhook timestamp' });
    }

    const payload = req.parsedWebhookBody; // 🛡️ Use parsed body from middleware
    const eventType = payload?.event_type;
    const tx = payload?.data?.transaction ?? {};
    const merchant = payload?.data?.merchant ?? {};

    const transactionId = tx.transactionId;
    const amount = tx.amount;
    const accountRef = tx.accountRef ?? tx.destinationAccountRef ?? merchant.walletId;

    if (!transactionId || !accountRef || amount == null) {
      logger.warn({ requestId: req.requestId, eventType, payload }, 'webhook missing required fields');
      return res.status(400).json({ error: 'Missing required webhook fields' });
    }

    // 1. Redis-based idempotency check using Nomba's unique requestId (10-hour window)
    const webhookEventId = payload?.requestId || transactionId;
    if (webhookEventId) {
      const redisKey = `webhook:processed:${webhookEventId}`;
      try {
        const acquired = await redis.set(redisKey, '1', 'NX', 'EX', 36000); // 10 hours
        if (!acquired) {
          logger.info({ requestId: req.requestId, webhookEventId }, 'duplicate webhook detected via Redis — ignoring');
          return res.status(200).json({ received: true });
        }
      } catch (err) {
        logger.error({ requestId: req.requestId, err }, 'Redis idempotency check failed — falling back to DB');
      }
    }

    // 2. Database fallback check
    const existing = await prisma.transaction.findUnique({ where: { merchantTxRef: transactionId } });
    if (existing) {
      logger.info({ requestId: req.requestId, transactionId }, 'duplicate webhook — ignoring');
      return res.status(200).json({ received: true });
    }

    const account = await prisma.account.findFirst({
      where: {
        OR: [
          { accountRef },
          { nombaVirtualAccountId: accountRef },
        ],
      },
    });
    if (!account) {
      logger.error({ requestId: req.requestId, accountRef, payload }, 'no account matched webhook');
      return res.status(404).json({ error: 'Account not found' });
    }

    // Extract sender details if Nomba includes them (field names vary across event types)
    const senderAccountName   = tx.senderName ?? tx.customerName ?? tx.sourceAccountName ?? null;
    const senderAccountNumber = tx.senderAccountNumber ?? tx.customerAccountNumber ?? tx.sourceAccountNumber ?? null;
    const senderBankCode      = tx.senderBankCode ?? tx.sourceBankCode ?? tx.bankCode ?? null;

    const queue = getWebhookQueue();
    await queue.add(
      'process-webhook',
      {
        merchantTxRef: transactionId,
        sessionId: transactionId,
        amount,
        accountId: account.id,
        eventType,
        senderAccountName,
        senderAccountNumber,
        senderBankCode,
      },
      { jobId: transactionId }
    );

    logger.info({ requestId: req.requestId, transactionId, accountId: account.id, eventType }, 'webhook queued');
    return res.status(200).json({ received: true });
  }
);

module.exports = router;
