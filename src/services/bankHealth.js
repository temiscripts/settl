'use strict';

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const FAILURE_STATES = ['failed', 'reversing', 'reversed'];

// Translated from the data scientist's Python classifyFailure function.
// nombaResponse is the full response object from requeryTransaction; may be null.
function classifyFailure(transaction, nombaResponse) {
  if (transaction.settlementMatch === 'underpaid') return 'partial';
  const status = nombaResponse?.data?.status?.toLowerCase();
  if (status === 'declined') return 'rejected_by_bank';
  if (status === 'timeout_error') return 'timeout';
  return 'silent_failure';
}

function classify(failureRate) {
  if (failureRate >= 0.3) return 'critical';
  if (failureRate >= 0.1) return 'degraded';
  return 'healthy';
}

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

async function getBankByCode(bankCode) {
  const rows = await prisma.transaction.groupBy({
    by: ['state'],
    where: { senderBankCode: bankCode },
    _count: { _all: true },
  });

  if (rows.length === 0) return null;

  let total = 0, settled = 0, pending = 0, failed = 0;
  for (const row of rows) {
    const count = row._count._all;
    total += count;
    if (FAILURE_STATES.includes(row.state)) failed += count;
    else if (row.state === 'settled') settled += count;
    else pending += count;
  }

  const failureRate = total > 0 ? failed / total : 0;
  return {
    bankCode,
    totalTransactions: total,
    settled,
    pending,
    failed,
    failureRate: Number(failureRate.toFixed(4)),
    status: classify(failureRate),
  };
}

module.exports = { classifyFailure, getReport, getBankByCode };
