'use strict';

const express = require('express');
const { Router } = require('express');
const { PrismaClient } = require('@prisma/client');
const { getWebhookQueue } = require('../queues/webhookQueue');
const { webhookRateLimiter } = require('../middleware/rateLimiter');
const logger = require('../lib/logger');

const router = Router();
const prisma = new PrismaClient();

// Raw body intentionally preserved here. The HMAC verification requires the exact bytes
// Nomba sent. express.json() would re-serialize and change whitespace, breaking the hash.
router.post(
  '/webhooks/nomba',
  webhookRateLimiter,
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const rawBody = req.body;
    const signature = req.headers['nomba-signature'];

    // TODO(cybersecurity): replace this stub call with real HMAC verification
    // verifyWebhookSignature(rawBody, signature) should throw or return false on invalid sig
    // For now we log and proceed. The HMAC enforcement happens once cybersecurity wires it in
    logger.info({ requestId: req.requestId, signature }, 'webhook received');

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const merchantTxRef = payload?.data?.merchantTxRef || payload?.merchantTxRef;
    if (!merchantTxRef) {
      return res.status(400).json({ error: 'Missing merchantTxRef' });
    }

    const existing = await prisma.transaction.findUnique({
      where: { merchantTxRef },
    });
    if (existing) {
      logger.info({ requestId: req.requestId, merchantTxRef }, 'duplicate webhook — ignoring');
      return res.status(200).json({ received: true });
    }

    const queue = getWebhookQueue();
    await queue.add('process-webhook', { payload, rawBody: rawBody.toString('utf8') }, {
      jobId: merchantTxRef,
    });

    logger.info({ requestId: req.requestId, merchantTxRef }, 'webhook queued for processing');
    return res.status(200).json({ received: true });
  }
);

module.exports = router;
