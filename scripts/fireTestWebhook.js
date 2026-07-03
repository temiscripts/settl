'use strict';

/**
 * End-to-end webhook smoke test.
 *
 * Usage:
 *   node scripts/fireTestWebhook.js                          # hits localhost:3000
 *   node scripts/fireTestWebhook.js https://your-app.onrender.com
 *
 * What it does:
 *   1. Creates a test account in the DB (idempotent — reuses if already exists)
 *   2. Builds a Nomba-shaped payload with a unique transactionId
 *   3. Computes the real HMAC signature (same algorithm as nomba uses)
 *   4. POSTs to /v1/webhooks/nomba
 *   5. Waits for the BullMQ worker to process the job
 *   6. Queries the DB and prints the resulting transaction state
 */

require('dotenv').config();

const crypto = require('crypto');
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const { randomUUID } = require('crypto');

const prisma = new PrismaClient();
const TARGET = process.argv[2] || 'http://localhost:3000';
const WEBHOOK_SECRET = process.env.NOMBA_WEBHOOK_SECRET || 'NombaHackathon2026';

function computeSignature(payload, timestamp) {
  const { event_type, requestId } = payload;
  const { userId, walletId } = payload.data.merchant;
  const { transactionId, type, time, responseCode } = payload.data.transaction;
  const sigString = [
    event_type, requestId, userId, walletId,
    transactionId, type, time, responseCode ?? '',
    timestamp,
  ].join(':');
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(sigString).digest('base64');
}

async function ensureTestAccount(accountRef, nombaVirtualAccountId, expectedAmount) {
  const existing = await prisma.account.findFirst({ where: { accountRef } });
  if (existing) {
    console.log(`  reusing account  id=${existing.id}  accountRef=${accountRef}`);
    return existing;
  }
  const account = await prisma.account.create({
    data: {
      nombaVirtualAccountId,
      customerName: 'Webhook Smoke Test',
      accountRef,
      expectedAmount,
      status: 'active',
    },
  });
  console.log(`  created account  id=${account.id}  accountRef=${accountRef}`);
  return account;
}

async function pollForTransaction(merchantTxRef, maxWaitMs = 15000) {
  const interval = 1000;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const tx = await prisma.transaction.findUnique({ where: { merchantTxRef } });
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, interval));
  }
  return null;
}

async function fireWebhook({ accountRef, nombaVirtualAccountId, expectedAmount, paymentAmount }) {
  const account = await ensureTestAccount(accountRef, nombaVirtualAccountId, expectedAmount);

  const transactionId = `smoke-${Date.now()}`;
  const timestamp = String(Date.now());
  const eventType = 'collection.success';
  const requestId = randomUUID();
  const userId = process.env.NOMBA_PARENT_ACCOUNT_ID || 'test-parent-id';
  const walletId = nombaVirtualAccountId;
  const txTime = new Date().toISOString();
  const responseCode = '00';

  const payload = {
    event_type: eventType,
    requestId,
    data: {
      merchant: { userId, walletId },
      transaction: {
        transactionId,
        accountRef,
        type: 'COLLECTION',
        time: txTime,
        responseCode,
        amount: paymentAmount,
      },
    },
  };

  const signature = computeSignature(payload, timestamp);
  const url = `${TARGET}/v1/webhooks/nomba`;

  console.log(`\n  POST ${url}`);
  console.log(`  transactionId=${transactionId}  amount=${paymentAmount}  expected=${expectedAmount ?? 'none'}`);

  let httpStatus;
  try {
    const res = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'nomba-signature': signature,
        'nomba-timestamp': timestamp,
      },
      timeout: 10000,
    });
    httpStatus = res.status;
    console.log(`  → HTTP ${res.status}  body=${JSON.stringify(res.data)}`);
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.error(`  → HTTP ${status ?? 'no-response'}  error=${JSON.stringify(body ?? err.message)}`);
    return;
  }

  if (httpStatus !== 200) return;

  process.stdout.write('  waiting for worker to process job');
  const tx = await pollForTransaction(transactionId);
  console.log('');

  if (!tx) {
    console.error('  FAIL — transaction not found in DB after 15s (worker may be slow or not running)');
    return;
  }

  const matchLabel = tx.settlementMatch ?? 'null';
  const statusIcon = tx.state === 'settled' ? '✓' : tx.state === 'pending' ? '~' : '✗';
  console.log(`  ${statusIcon} state=${tx.state}  settlementMatch=${matchLabel}  id=${tx.id}`);
}

async function main() {
  console.log(`\nSettl webhook smoke test  →  ${TARGET}\n`);

  console.log('[1] Exact payment (should settle immediately)');
  await fireWebhook({
    accountRef: 'smoke-test-exact',
    nombaVirtualAccountId: 'va-smoke-exact-001',
    expectedAmount: 50000,
    paymentAmount: 50000,
  });

  console.log('\n[2] Underpaid (should stay pending)');
  await fireWebhook({
    accountRef: 'smoke-test-under',
    nombaVirtualAccountId: 'va-smoke-under-001',
    expectedAmount: 50000,
    paymentAmount: 30000,
  });

  console.log('\n[3] No expectedAmount (should settle immediately)');
  await fireWebhook({
    accountRef: 'smoke-test-open',
    nombaVirtualAccountId: 'va-smoke-open-001',
    expectedAmount: null,
    paymentAmount: 75000,
  });

  await prisma.$disconnect();
  console.log('\ndone.\n');
}

main().catch((err) => {
  console.error(err);
  prisma.$disconnect();
  process.exit(1);
});
