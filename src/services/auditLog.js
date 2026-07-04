'use strict';

const crypto = require('crypto');

// A fixed seed string used for the very first (genesis) log entry
const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Appends a tamper-evident entry to the audit log.
 * Must be executed within a Prisma transaction to guarantee strict sequence ordering.
 * 
 * @param {string} eventType - The action category (e.g., 'state_changed', 'reversal_triggered')
 * @param {object} payload - Action-specific metadata
 * @param {object} prismaClient - The Prisma transaction client (tx)
 */
async function appendAuditEntry(eventType, payload, prismaClient) {
  // 1. Fetch the latest entry to link the hash chain
  const latestEntry = await prismaClient.auditLog.findFirst({
    orderBy: { sequenceNumber: 'desc' },
  });

  const nextSequenceNumber = latestEntry ? latestEntry.sequenceNumber + 1 : 1;
  const previousHash = latestEntry ? latestEntry.hash : GENESIS_SEED;

  // 2. Hash Formula: SHA-256(sequenceNumber + eventType + JSON.stringify(payload) + previousHash)
  const payloadString = JSON.stringify(payload);
  const message = `${nextSequenceNumber}${eventType}${payloadString}${previousHash}`;
  
  const hash = crypto
    .createHash('sha256')
    .update(message)
    .digest('hex');

  // 3. Persist the sealed entry
  return await prismaClient.auditLog.create({
    data: {
      sequenceNumber: nextSequenceNumber,
      eventType,
      payload,
      previousHash,
      hash,
    },
  });
}

/**
 * Audit Log Verification Engine.
 * Iterates through the entire chain and validates every link.
 * 
 * @param {object} prismaClient - Database client
 * @returns {Promise<{valid: boolean, reason?: string}>} Verification result
 */
async function verifyAuditChain(prismaClient) {
  const entries = await prismaClient.auditLog.findMany({
    orderBy: { sequenceNumber: 'asc' },
  });

  let expectedPreviousHash = GENESIS_SEED;

  for (const entry of entries) {
    const payloadString = JSON.stringify(entry.payload);
    const message = `${entry.sequenceNumber}${entry.eventType}${payloadString}${entry.previousHash}`;
    
    const calculatedHash = crypto
      .createHash('sha256')
      .update(message)
      .digest('hex');

    // Check if the content inside this block was edited
    if (calculatedHash !== entry.hash) {
      return { 
        valid: false, 
        reason: `Content alteration detected at sequence number ${entry.sequenceNumber}` 
      };
    }

    // Check if a block was deleted, inserted, or reordered
    if (entry.previousHash !== expectedPreviousHash) {
      return { 
        valid: false, 
        reason: `Chain break detected at sequence number ${entry.sequenceNumber}. Expected previous hash: ${expectedPreviousHash}, got: ${entry.previousHash}` 
      };
    }

    expectedPreviousHash = entry.hash;
  }

  return { valid: true };
}

module.exports = { appendAuditEntry, verifyAuditChain };
