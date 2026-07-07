'use strict';

/**
 * Load test for the webhook endpoint.
 *
 * Simulates concurrent webhook requests with real HMAC signatures.
 * Does not require any external tool — runs with plain Node.js.
 *
 * Usage:
 *   node scripts/loadTest.js [target-url] [concurrent-users] [total-requests]
 *
 * Examples:
 *   node scripts/loadTest.js                                        # 50 VUs, 500 requests, localhost
 *   node scripts/loadTest.js https://settl-878p.onrender.com 100 2000
 *   node scripts/loadTest.js https://settl-878p.onrender.com 500 10000
 */

require('dotenv').config();

const https = require('https');
const http = require('http');
const crypto = require('crypto');

const TARGET_URL   = process.argv[2] || 'http://localhost:3000';
const CONCURRENCY  = parseInt(process.argv[3], 10) || 50;
const TOTAL        = parseInt(process.argv[4], 10) || 500;
const SECRET       = process.env.NOMBA_WEBHOOK_SECRET || 'NombaHackathon2026';

const TEST_ACCOUNT_REF = process.env.LOAD_TEST_ACCOUNT_REF || 'settl-acc-july03b';
const TEST_WALLET_ID   = process.env.NOMBA_SUB_ACCOUNT_ID  || '1dde5fef-fa76-44b9-8b84-541b34b85b3e';

function buildPayload(txId) {
  return {
    event_type: 'payment.success',
    requestId: txId,
    data: {
      transaction: {
        transactionId: txId,
        type: 'vact_transfer',
        amount: 10000,
        time: new Date().toISOString(),
        responseCode: '00',
        accountRef: TEST_ACCOUNT_REF,
      },
      merchant: {
        userId: 'load-test-user',
        walletId: TEST_WALLET_ID,
      },
    },
  };
}

function computeHmac(payload, timestamp) {
  const tx = payload.data.transaction;
  const merchant = payload.data.merchant;
  const fields = [
    payload.event_type || '',
    payload.requestId  || '',
    merchant.userId    || '',
    merchant.walletId  || '',
    tx.transactionId   || '',
    tx.type            || '',
    tx.time            || '',
    tx.responseCode    || '',
  ].join(':');
  return crypto
    .createHmac('sha256', SECRET)
    .update(`${fields}:${timestamp}`)
    .digest('base64');
}

function sendRequest(txId) {
  return new Promise((resolve) => {
    const timestamp = Date.now().toString();
    const payload   = buildPayload(txId);
    const body      = JSON.stringify(payload);
    const signature = computeHmac(payload, timestamp);

    const url      = new URL(`${TARGET_URL}/v1/webhooks/nomba`);
    const lib      = url.protocol === 'https:' ? https : http;
    const start    = Date.now();

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'nomba-signature': signature,
        'nomba-timestamp': timestamp,
      },
    };

    const req = lib.request(options, (res) => {
      res.resume();
      resolve({ status: res.statusCode, duration: Date.now() - start });
    });

    req.on('error', () => resolve({ status: 0, duration: Date.now() - start }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ status: 0, duration: 10000 }); });
    req.write(body);
    req.end();
  });
}

async function runWorker(ids, results) {
  for (const id of ids) {
    const result = await sendRequest(id);
    results.push(result);
  }
}

async function main() {
  console.log(`\nSettl Webhook Load Test`);
  console.log(`Target:      ${TARGET_URL}`);
  console.log(`Concurrency: ${CONCURRENCY} virtual users`);
  console.log(`Total:       ${TOTAL} requests`);
  console.log(`\nStarting...\n`);

  const txIds = Array.from({ length: TOTAL }, (_, i) =>
    `load-test-${Date.now()}-${i}`
  );

  // Split requests across concurrent workers
  const chunks = Array.from({ length: CONCURRENCY }, (_, i) =>
    txIds.filter((_, j) => j % CONCURRENCY === i)
  );

  const results = [];
  const start = Date.now();

  await Promise.all(chunks.map((chunk) => runWorker(chunk, results)));

  const elapsed = Date.now() - start;
  const durations = results.map((r) => r.duration).sort((a, b) => a - b);
  const statuses = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  const p50  = durations[Math.floor(durations.length * 0.50)];
  const p95  = durations[Math.floor(durations.length * 0.95)];
  const p99  = durations[Math.floor(durations.length * 0.99)];
  const mean = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  const rps  = Math.round((TOTAL / elapsed) * 1000);
  const ok   = (statuses[200] || 0) + (statuses[201] || 0);
  const fail = TOTAL - ok;

  console.log(`Results`);
  console.log(`-------`);
  console.log(`Total time:    ${elapsed}ms`);
  console.log(`Throughput:    ${rps} req/s`);
  console.log(`Success (2xx): ${ok} / ${TOTAL}`);
  console.log(`Failures:      ${fail} / ${TOTAL}`);
  console.log(`\nLatency`);
  console.log(`-------`);
  console.log(`Mean:  ${mean}ms`);
  console.log(`p50:   ${p50}ms`);
  console.log(`p95:   ${p95}ms`);
  console.log(`p99:   ${p99}ms`);
  console.log(`\nStatus breakdown:`, statuses);

  if (fail > TOTAL * 0.05) {
    console.log(`\nWARNING: failure rate exceeds 5% (${((fail / TOTAL) * 100).toFixed(1)}%)`);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
