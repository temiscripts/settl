'use strict';

require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const { resolveTransaction } = require('../src/services/reconciliation');

const prisma = new PrismaClient();

let account;

before(async () => {
  account = await prisma.account.create({
    data: {
      nombaVirtualAccountId: 'va-test-resolve-01',
      customerName: 'Resolve Test',
      accountRef: 'ref-test-resolve-01',
      status: 'active',
    },
  });
});

after(async () => {
  await prisma.auditLog.deleteMany({
    where: {
      payload: { path: ['merchantTxRef'], string_starts_with: 'resolve-' },
    },
  });
  await prisma.transaction.deleteMany({ where: { merchantTxRef: { startsWith: 'resolve-' } } });
  await prisma.account.deleteMany({ where: { accountRef: { startsWith: 'ref-test-resolve-' } } });
  await prisma.$disconnect();
});

async function createPendingTx(merchantTxRef) {
  return prisma.transaction.create({
    data: {
      accountId: account.id,
      merchantTxRef,
      amount: 10000,
      direction: 'credit',
      state: 'pending',
      lastCheckedAt: new Date(),
      requeueCount: 1,
    },
  });
}

test('nombaStatus=settled moves transaction to settled and returns "settled"', async () => {
  const tx = await createPendingTx('resolve-settled-001');
  const result = await resolveTransaction(tx, 'settled');
  assert.equal(result, 'settled');
  const updated = await prisma.transaction.findUnique({ where: { id: tx.id } });
  assert.equal(updated.state, 'settled');
});

test('nombaStatus=pending returns "pending" with no state change', async () => {
  const tx = await createPendingTx('resolve-pending-001');
  const result = await resolveTransaction(tx, 'pending');
  assert.equal(result, 'pending');
  const updated = await prisma.transaction.findUnique({ where: { id: tx.id } });
  assert.equal(updated.state, 'pending');
});

test('nombaStatus=anything-else returns "pending" with no state change', async () => {
  const tx = await createPendingTx('resolve-unknown-001');
  const result = await resolveTransaction(tx, 'processing');
  assert.equal(result, 'pending');
  const updated = await prisma.transaction.findUnique({ where: { id: tx.id } });
  assert.equal(updated.state, 'pending');
});

test('nombaStatus=failed sets state to failed then initiates reversal', async () => {
  const tx = await createPendingTx('resolve-failed-001');
  // initiateAutoReversal calls Nomba's API which will fail in test — that's expected.
  // The reversal error is caught internally; the function still returns 'reversed'.
  const result = await resolveTransaction(tx, 'failed');
  assert.equal(result, 'reversed');
  const updated = await prisma.transaction.findUnique({ where: { id: tx.id } });
  // Nomba call fails in test env so state lands on 'reversing', not 'reversed'
  assert.ok(
    updated.state === 'reversing' || updated.state === 'reversed',
    `expected reversing or reversed, got ${updated.state}`
  );
});
