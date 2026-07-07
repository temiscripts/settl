'use strict';

const crypto = require('crypto');


const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000000';


async function appendAuditEntry(eventType, payload, prismaClient) {
  
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
      payload,
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
    const payloadString = JSON.stringify(entry.payload);
    const message = `${entry.sequenceNumber}${entry.eventType}${payloadString}${entry.previousHash}`;
    
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
