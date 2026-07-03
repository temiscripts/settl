'use strict';

const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');
const nomba = require('./nomba');
const { appendAuditEntry } = require('./auditLog');
const logger = require('../lib/logger');

const prisma = new PrismaClient();

const createAccountSchema = z.object({
  customerName: z.string().min(1).max(100),
  accountRef: z.string().min(1).max(100),
  expectedAmount: z.number().int().positive().optional(),
  expiryDate: z.string().datetime().optional(),
});

async function createAccount(data) {
  const parsed = createAccountSchema.parse(data);

  const nombaRes = await nomba.createVirtualAccount({
    accountName: parsed.customerName,
    accountRef: parsed.accountRef,
    ...(parsed.expectedAmount !== undefined && { expectedAmount: parsed.expectedAmount }),
    ...(parsed.expiryDate !== undefined && { expiryDate: parsed.expiryDate }),
  });

  const virtualAccountData = nombaRes.data;

  const account = await prisma.$transaction(async (tx) => {
    const created = await tx.account.create({
      data: {
        nombaVirtualAccountId: virtualAccountData.accountId || virtualAccountData.id,
        customerName: parsed.customerName,
        accountRef: parsed.accountRef,
        expectedAmount: parsed.expectedAmount ?? null,
        expiryDate: parsed.expiryDate ? new Date(parsed.expiryDate) : null,
        status: 'active',
      },
    });
    await appendAuditEntry('account.created', { accountId: created.id, accountRef: created.accountRef }, tx);
    return created;
  });

  logger.info({ accountId: account.id, accountRef: account.accountRef }, 'virtual account created');
  return { ...account, nombaVirtualAccount: virtualAccountData };
}

async function getAccount(id) {
  const account = await prisma.account.findUnique({ where: { id } });
  if (!account) {
    const err = new Error('Account not found');
    err.status = 404;
    throw err;
  }
  return account;
}

async function getBalance(accountId) {
  await getAccount(accountId);

  const result = await prisma.transaction.aggregate({
    where: { accountId, state: 'settled' },
    _sum: {
      amount: true,
    },
  });

  const credits = await prisma.transaction.aggregate({
    where: { accountId, state: 'settled', direction: 'credit' },
    _sum: { amount: true },
  });

  const debits = await prisma.transaction.aggregate({
    where: { accountId, state: 'settled', direction: 'debit' },
    _sum: { amount: true },
  });

  const balanceKobo = (credits._sum.amount ?? 0) - (debits._sum.amount ?? 0);
  return { accountId, balanceKobo, balanceNaira: balanceKobo / 100 };
}

async function getTransactions(accountId, { page = 1, limit = 20 } = {}) {
  await getAccount(accountId);
  const skip = (page - 1) * limit;
  const [transactions, total] = await Promise.all([
    prisma.transaction.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.transaction.count({ where: { accountId } }),
  ]);
  return { transactions, total, page, limit, pages: Math.ceil(total / limit) };
}

async function handleExpiredAccounts() {
  const now = new Date();
  const expired = await prisma.account.updateMany({
    where: { status: 'active', expiryDate: { lte: now } },
    data: { status: 'expired' },
  });
  if (expired.count > 0) {
    logger.info({ count: expired.count }, 'accounts marked expired');
  }
  return expired.count;
}

module.exports = { createAccount, getAccount, getBalance, getTransactions, handleExpiredAccounts };
