'use strict';

const { PrismaClient } = require('@prisma/client');
const { validateStateTransition } = require('../lib/stateTransitions');
const { appendAuditEntry } = require('./auditLog');
const { initiateReversal } = require('./nomba');
const { classifyFailure } = require('./bankHealth');
const logger = require('../lib/logger');

const prisma = new PrismaClient();

const TX_TIMEOUT = 15000;

function computeSettlementMatch(receivedAmount, expectedAmount) {
  if (expectedAmount == null) return null;
  if (receivedAmount === expectedAmount) return 'exact';
  if (receivedAmount < expectedAmount) return 'underpaid';
  return 'overpaid';
}

// Nomba event types that mean the money was NOT actually credited to us.
// A webhook carrying one of these must never be treated as a successful
// payment, regardless of what its amount field happens to match.
const FAILURE_EVENTS = new Set(['payment_failed', 'payout_failed']);

// Called by the BullMQ worker for each dequeued webhook job.
async function processWebhookJob(job) {
  const { merchantTxRef, sessionId, amount, accountId, eventType,
          senderAccountName, senderAccountNumber, senderBankCode } = job.data;

  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) throw new Error(`Account not found: ${accountId}`);

  const isFailure = FAILURE_EVENTS.has(eventType);
  const settlementMatch = isFailure ? null : computeSettlementMatch(amount, account.expectedAmount);

  // underpaid payments stay pending (top-up expected); everything else settles
  const settleImmediately = !isFailure && settlementMatch !== 'underpaid';

  const txRecord = await prisma.$transaction(async (tx) => {
    const created = await tx.transaction.create({
      data: {
        accountId,
        merchantTxRef,
        sessionId: sessionId || null,
        amount,
        direction: 'credit',
        state: 'initiated',
        settlementMatch,
        senderAccountName:   senderAccountName   || null,
        senderAccountNumber: senderAccountNumber || null,
        senderBankCode:      senderBankCode      || null,
      },
    });

    await appendAuditEntry(
      'WEBHOOK_RECEIVED',
      { merchantTxRef, amount, eventType, settlementMatch, accountId },
      tx
    );

    validateStateTransition('initiated', 'pending');
    await tx.transaction.update({
      where: { id: created.id },
      data: { state: 'pending', lastCheckedAt: new Date() },
    });
    await appendAuditEntry(
      'STATE_TRANSITION',
      { merchantTxRef, from: 'initiated', to: 'pending' },
      tx
    );

    if (isFailure) {
      validateStateTransition('pending', 'failed');
      await tx.transaction.update({
        where: { id: created.id },
        data: { state: 'failed', lastCheckedAt: new Date() },
      });
      await appendAuditEntry(
        'STATE_TRANSITION',
        { merchantTxRef, from: 'pending', to: 'failed', source: 'webhook', eventType },
        tx
      );
    } else if (settleImmediately) {
      validateStateTransition('pending', 'settled');
      await tx.transaction.update({
        where: { id: created.id },
        data: { state: 'settled' },
      });
      await appendAuditEntry(
        'STATE_TRANSITION',
        { merchantTxRef, from: 'pending', to: 'settled', settlementMatch },
        tx
      );
    }

    return created;
  }, { timeout: TX_TIMEOUT });

  if (isFailure) {
    logger.info({ merchantTxRef, eventType }, 'webhook reported a failed payment — triggering reversal');
    await initiateAutoReversal({
      id: txRecord.id,
      merchantTxRef,
      amount,
      senderAccountName,
      senderAccountNumber,
      senderBankCode,
    });
  }

  logger.info(
    { merchantTxRef, amount, eventType, settlementMatch, settled: settleImmediately, failed: isFailure },
    'webhook job processed'
  );
}

// Called by the reconciliation worker when Nomba's requery returns a terminal state.
// nombaResult is the full response from requeryTransaction, used to classify failure reason.
async function resolveTransaction(transaction, nombaStatus, nombaResult = null) {
  const { id, merchantTxRef, accountId, state } = transaction;

  if (nombaStatus === 'settled') {
    validateStateTransition(state, 'settled');
    await prisma.$transaction(async (tx) => {
      await tx.transaction.update({
        where: { id },
        data: { state: 'settled', lastCheckedAt: new Date() },
      });
      await appendAuditEntry(
        'STATE_TRANSITION',
        { merchantTxRef, from: state, to: 'settled', source: 'requery' },
        tx
      );
    }, { timeout: TX_TIMEOUT });
    logger.info({ merchantTxRef, accountId }, 'transaction settled via requery');
    return 'settled';
  }

  if (nombaStatus === 'failed') {
    const failureReason = classifyFailure(transaction, nombaResult);
    validateStateTransition(state, 'failed');
    await prisma.$transaction(async (tx) => {
      await tx.transaction.update({
        where: { id },
        data: { state: 'failed', lastCheckedAt: new Date(), failureReason },
      });
      await appendAuditEntry(
        'STATE_TRANSITION',
        { merchantTxRef, from: state, to: 'failed', source: 'requery', failureReason },
        tx
      );
    }, { timeout: TX_TIMEOUT });
    logger.info({ merchantTxRef, accountId }, 'transaction failed — triggering reversal');
    await initiateAutoReversal(transaction);
    return 'reversed';
  }

  return 'pending';
}

// Initiates and (if successful) completes an automatic reversal.
// If Nomba's reversal call fails, leaves the transaction in 'reversing' so
// the reconciliation worker retries on its next cycle.
async function initiateAutoReversal(transaction) {
  const { id, merchantTxRef, amount,
          senderAccountName, senderAccountNumber, senderBankCode } = transaction;

  validateStateTransition('failed', 'reversing');
  await prisma.$transaction(async (tx) => {
    await tx.transaction.update({ where: { id }, data: { state: 'reversing' } });
    await appendAuditEntry(
      'STATE_TRANSITION',
      { merchantTxRef, from: 'failed', to: 'reversing' },
      tx
    );
  }, { timeout: TX_TIMEOUT });

  if (!senderAccountName || !senderAccountNumber || !senderBankCode) {
    logger.warn(
      { merchantTxRef },
      'reversal skipped — sender bank details not captured from webhook; stays reversing for manual review'
    );
    return;
  }

  try {
    // X-Idempotency-Key is set inside initiateReversal as `${merchantTxRef}:reversal`
    await initiateReversal(
      {
        amount,
        merchantTxRef: `${merchantTxRef}:reversal`,
        accountName:   senderAccountName,
        accountNumber: senderAccountNumber,
        bankCode:      senderBankCode,
      },
      merchantTxRef
    );

    validateStateTransition('reversing', 'reversed');
    await prisma.$transaction(async (tx) => {
      await tx.transaction.update({ where: { id }, data: { state: 'reversed' } });
      await appendAuditEntry(
        'STATE_TRANSITION',
        { merchantTxRef, from: 'reversing', to: 'reversed' },
        tx
      );
    }, { timeout: TX_TIMEOUT });
    logger.info({ merchantTxRef }, 'reversal complete');
  } catch (err) {
    logger.error({ err, merchantTxRef }, 'reversal call failed — state stays reversing, will retry');
  }
}

module.exports = { processWebhookJob, resolveTransaction, initiateAutoReversal };
