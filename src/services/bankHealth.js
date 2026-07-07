'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Translated from the data scientist's Python classifyFailure function.
// nombaResponse is the full response object from requeryTransaction; may be null.
function classifyFailure(transaction, nombaResponse) {
  if (transaction.settlementMatch === 'underpaid') return 'partial';
  const status = nombaResponse?.data?.status?.toLowerCase();
  if (status === 'declined') return 'rejected_by_bank';
  if (status === 'timeout_error') return 'timeout';
  return 'silent_failure';
}

async function getBankHealth(bankCode) {
  const recent = await prisma.transaction.findMany({
    where: { senderBankCode: bankCode },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { state: true },
  });

  if (recent.length === 0) {
    return { health_status: 'Unknown', success_rate: null, sample_size: 0 };
  }

  const settled = recent.filter((tx) => tx.state === 'settled').length;
  const successRate = (settled / recent.length) * 100;

  let health_status;
  if (successRate >= 80) health_status = 'Healthy';
  else if (successRate >= 50) health_status = 'Degraded';
  else health_status = 'Downtime';

  return {
    health_status,
    success_rate: Math.round(successRate * 10) / 10,
    sample_size: recent.length,
  };
}

async function getAllBankHealth() {
  const banks = await prisma.transaction.groupBy({
    by: ['senderBankCode'],
    where: { senderBankCode: { not: null } },
  });

  return Promise.all(
    banks.map(async ({ senderBankCode }) => ({
      bankCode: senderBankCode,
      ...(await getBankHealth(senderBankCode)),
    }))
  );
}

module.exports = { classifyFailure, getBankHealth, getAllBankHealth };
