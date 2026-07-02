'use strict';

// TODO(cybersecurity): replace this stub with the real hash-chain implementation.
// Expected signature: appendAuditEntry(eventType, payload, prismaClient) → Promise<void>
// The prismaClient arg MUST be the tx client from prisma.$transaction so writes are atomic.
// Hash formula: SHA-256(sequenceNumber + eventType + JSON.stringify(payload) + previousHash)
// Genesis entry uses a fixed seed string as previousHash.

async function appendAuditEntry(eventType, payload, prismaClient) {
  // no-op stub — cybersecurity teammate will replace this
}

module.exports = { appendAuditEntry };
