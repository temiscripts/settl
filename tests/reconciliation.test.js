'use strict';

require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const { processWebhookJob } = require('../src/services/reconciliation');

const prisma = new PrismaClient();

let accountWithExpected;
let accountNoExpected;

before(async () => {
  accountWithExpected = await prisma.account.create({
    data: {
      nombaVirtualAccountId: 'va-test-reconc-01',
      customerName: 'Reconciliation Test',
      accountRef: 'ref-test-reconc-01',
      expectedAmount: 10000,
      status: 'active',
    },
  });

  accountNoExpected = await prisma.account.create({
    data: {
      nombaVirtualAccountId: 'va-test-reconc-02',
      customerName: 'Reconciliation Test NoExp',
      accountRef: 'ref-test-reconc-02',
      expectedAmount: null,
      status: 'active',
    },
  });
});

after(async () => {
  await prisma.auditLog.deleteMany({
    where: {
      payload: { path: ['merchantTxRef'], string_starts_with: 'test-reconc-' },
    },
  });
  await prisma.transaction.deleteMany({
    where: { merchantTxRef: { startsWith: 'test-reconc-' } },
  });
  await prisma.account.deleteMany({
    where: { accountRef: { startsWith: 'ref-test-reconc-' } },
  });
  await prisma.$disconnect();
});

function makeJob(ref, amount, accountId) {
  return { data: { merchantTxRef: ref, sessionId: `sess-${ref}`, amount, accountId } };
}

test('exact payment settles immediately with settlementMatch=exact', async () => {
  await processWebhookJob(makeJob('test-reconc-exact', 10000, accountWithExpected.id));
  const tx = await prisma.transaction.findUnique({ where: { merchantTxRef: 'test-reconc-exact' } });
  assert.equal(tx.state, 'settled');
  assert.equal(tx.settlementMatch, 'exact');
});

test('overpaid payment settles immediately with settlementMatch=overpaid', async () => {
  await processWebhookJob(makeJob('test-reconc-over', 15000, accountWithExpected.id));
  const tx = await prisma.transaction.findUnique({ where: { merchantTxRef: 'test-reconc-over' } });
  assert.equal(tx.state, 'settled');
  assert.equal(tx.settlementMatch, 'overpaid');
});

test('underpaid payment stays pending with settlementMatch=underpaid', async () => {
  await processWebhookJob(makeJob('test-reconc-under', 5000, accountWithExpected.id));
  const tx = await prisma.transaction.findUnique({ where: { merchantTxRef: 'test-reconc-under' } });
  assert.equal(tx.state, 'pending');
  assert.equal(tx.settlementMatch, 'underpaid');
});

test('account with no expectedAmount settles immediately with settlementMatch=null', async () => {
  await processWebhookJob(makeJob('test-reconc-nullexp', 10000, accountNoExpected.id));
  const tx = await prisma.transaction.findUnique({ where: { merchantTxRef: 'test-reconc-nullexp' } });
  assert.equal(tx.state, 'settled');
  assert.equal(tx.settlementMatch, null);
});

test('duplicate merchantTxRef is rejected by DB unique constraint', async () => {
  await assert.rejects(
    () => processWebhookJob(makeJob('test-reconc-exact', 10000, accountWithExpected.id)),
    (err) => {
      return err.message.includes('Unique constraint') || err.code === 'P2002';
    }
  );
});

test('non-existent accountId throws', async () => {
  await assert.rejects(
    () => processWebhookJob(makeJob('test-reconc-badacct', 10000, '00000000-0000-0000-0000-000000000000')),
    /Account not found/
  );
});
