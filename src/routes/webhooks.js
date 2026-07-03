'use strict';

const { Router } = require('express');
const { PrismaClient } = require('@prisma/client');
const { getWebhookQueue } = require('../queues/webhookQueue');
const { webhookRateLimiter } = require('../middleware/rateLimiter');
const logger = require('../lib/logger');

const router = Router();
const prisma = new PrismaClient();

// 10-minute replay window with 30s tolerance for clock skew between
// our server and Nomba's
const REPLAY_WINDOW_MS = (10 * 60 + 30) * 1000;

router.post('/webhooks/nomba', webhookRateLimiter, async (req, res) => {
  const timestamp = req.headers['nomba-timestamp'];

  const ts = parseInt(timestamp, 10);
  if (!ts || isNaN(ts) || Date.now() - ts > REPLAY_WINDOW_MS) {
    logger.warn({ requestId: req.requestId, timestamp }, 'webhook rejected — missing or stale timestamp');
    return res.status(400).json({ error: 'Invalid or expired webhook timestamp' });
  }

  // TODO(cybersecurity): replace this no-op with real HMAC verification.
  // Signature string (colon-joined): event_type:requestId:merchant.userId:merchant.walletId:
  //   transaction.transactionId:transaction.type:transaction.time:transaction.responseCode:nomba-timestamp
  // HMAC-SHA256 with key NombaHackathon2026, base64-encoded, compared against req.headers['nomba-signature'].
  // Expected call: verifyWebhookSignature(req.body, req.headers) → throws on invalid signature

  const payload = req.body;
  const eventType = payload?.event_type;
  const tx = payload?.data?.transaction ?? {};
  const merchant = payload?.data?.merchant ?? {};

  const transactionId = tx.transactionId;
  const amount = tx.amount;
  // accountRef is set on the virtual account at provisioning time and echoed back
  // in the webhook so we can match the payment to the right internal account.
  // Fallback to merchant.walletId if accountRef is absent. Log full payload on
  // first real webhook to confirm which field Nomba actually uses.
  const accountRef = tx.accountRef ?? tx.destinationAccountRef ?? merchant.walletId;

  if (!transactionId || !accountRef || amount == null) {
    logger.warn({ requestId: req.requestId, eventType, payload }, 'webhook missing required fields');
    return res.status(400).json({ error: 'Missing required webhook fields' });
  }

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

  const queue = getWebhookQueue();
  await queue.add(
    'process-webhook',
    {
      merchantTxRef: transactionId,
      sessionId: transactionId,
      amount,
      accountId: account.id,
    },
    { jobId: transactionId }
  );

  logger.info({ requestId: req.requestId, transactionId, accountId: account.id, eventType }, 'webhook queued');
  return res.status(200).json({ received: true });
});

module.exports = router;
