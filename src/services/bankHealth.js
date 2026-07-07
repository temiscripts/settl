'use strict';

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const FAILURE_STATES = ['failed', 'reversing', 'reversed'];

function classify(failureRate) {
  if (failureRate >= 0.3) return 'critical';
  if (failureRate >= 0.1) return 'degraded';
  return 'healthy';
}

// Failure rate per bank code, derived from senderBankCode captured on inbound
// webhooks. A transaction only carries a bank code once Nomba includes sender
// details in the payload, so banks with no observed transactions are omitted.
async function getReport() {
  const rows = await prisma.transaction.groupBy({
    by: ['senderBankCode', 'state'],
    where: { senderBankCode: { not: null } },
    _count: { _all: true },
  });

  const byBank = new Map();
  for (const row of rows) {
    const code = row.senderBankCode;
    if (!byBank.has(code)) {
      byBank.set(code, { bankCode: code, totalTransactions: 0, settled: 0, pending: 0, failed: 0 });
    }
    const entry = byBank.get(code);
    const count = row._count._all;
    entry.totalTransactions += count;
    if (FAILURE_STATES.includes(row.state)) entry.failed += count;
    else if (row.state === 'settled') entry.settled += count;
    else entry.pending += count;
  }

  const banks = Array.from(byBank.values())
    .map((b) => {
      const failureRate = b.totalTransactions > 0 ? b.failed / b.totalTransactions : 0;
      return { ...b, failureRate: Number(failureRate.toFixed(4)), status: classify(failureRate) };
    })
    .sort((a, b) => b.failureRate - a.failureRate);

  return { generatedAt: new Date().toISOString(), banks };
}

module.exports = { getReport };
