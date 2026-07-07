'use strict';

const crypto = require('crypto');


const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000000';


// Arbitrary fixed key for the advisory lock below — must stay constant.
const SEQUENCE_LOCK_KEY = 848200321;

async function appendAuditEntry(eventType, payload, prismaClient) {
  // Every call site passes a transaction client. Without this lock, two
  // concurrent writers (e.g. two BullMQ webhook jobs processing at once —
  // the worker runs with concurrency: 5) can both read the same "latest"
  // sequenceNumber and then both try to insert latest+1, colliding on the
  // unique constraint and aborting the whole enclosing transaction
  // (the transaction/state write and its audit entry are meant to commit
  // together). pg_advisory_xact_lock serializes writers across ALL
  // connections/processes, not just within one Node process, and
  // auto-releases at transaction commit/rollback — no manual unlock, so a
  // crash mid-write can't leave it stuck locked.
  await prismaClient.$executeRaw`SELECT pg_advisory_xact_lock(${SEQUENCE_LOCK_KEY})`;

  const latestEntry = await prismaClient.auditLog.findFirst({
    orderBy: { sequenceNumber: 'desc' },
  });

  const nextSequenceNumber = latestEntry ? latestEntry.sequenceNumber + 1 : 1;
  const previousHash = latestEntry ? latestEntry.hash : GENESIS_SEED;

 
  const payloadString = JSON.stringify(payload);
  const message = `${nextSequenceNumber}${eventType}${payloadString}${previousHash}`;

  const hash = crypto
    .createHash('sha256')
    .update(message)
    .digest('hex');


  return await prismaClient.auditLog.create({
    data: {
      sequenceNumber: nextSequenceNumber,
      eventType,
      payload: payloadString,
      previousHash,
      hash,
    },
  });
}


async function verifyAuditChain(prismaClient) {
  const entries = await prismaClient.auditLog.findMany({
    orderBy: { sequenceNumber: 'asc' },
  });

  let expectedPreviousHash = GENESIS_SEED;

  for (const entry of entries) {
    // entry.payload is already the exact JSON string that was hashed at
    // write time — do not re-serialize it here.
    const message = `${entry.sequenceNumber}${entry.eventType}${entry.payload}${entry.previousHash}`;
    
    const calculatedHash = crypto
      .createHash('sha256')
      .update(message)
      .digest('hex');

    
    if (calculatedHash !== entry.hash) {
      return { 
        valid: false, 
        reason: `Content alteration detected at sequence number ${entry.sequenceNumber}` 
      };
    }

   
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
