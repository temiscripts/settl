'use strict';

/**
 * Reversal integration test.
 *
 * Finds the most recent pending transaction in the database, moves it to
 * 'failed', and triggers the auto-reversal code path against the live
 * Nomba production API. Prints every state transition and the final outcome.
 *
 * Usage:
 *   node scripts/testReversal.js
 *
 * Requirements:
 *   - .env must be populated with real Nomba credentials
 *   - DATABASE_URL must point to the live database
 *   - At least one transaction must be in 'pending' state
 *     (send a webhook first if the DB is empty)
 */

require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const { initiateAutoReversal } = require('../src/services/reconciliation');
const logger = require('../src/lib/logger');

const prisma = new PrismaClient();

async function main() {
  console.log('\nSettl Reversal Integration Test');
  console.log('================================\n');

  // Find the most recent pending transaction
  const tx = await prisma.transaction.findFirst({
    where: { state: 'pending' },
    orderBy: { createdAt: 'desc' },
  });

  if (!tx) {
    console.log('No pending transactions found.');
    console.log('Send a real webhook first, then run this script again.');
    process.exit(0);
  }

  console.log(`Found transaction:`);
  console.log(`  ID:            ${tx.id}`);
  console.log(`  merchantTxRef: ${tx.merchantTxRef}`);
  console.log(`  amount:        ${tx.amount} kobo (${tx.amount / 100} naira)`);
  console.log(`  state:         ${tx.state}`);
  console.log(`  accountId:     ${tx.accountId}`);
  console.log('');

  // Step 1: move to failed (simulates what resolveTransaction does when
  // Nomba's requery returns 'failed')
  console.log('Step 1: Moving transaction to failed...');
  await prisma.transaction.update({
    where: { id: tx.id },
    data: { state: 'failed', lastCheckedAt: new Date() },
  });
  console.log('  state -> failed\n');

  // Step 2: trigger the reversal engine
  console.log('Step 2: Triggering initiateAutoReversal against live Nomba API...');
  console.log(`  Idempotency key: ${tx.merchantTxRef}:reversal\n`);

  const failedTx = await prisma.transaction.findUnique({ where: { id: tx.id } });

  try {
    await initiateAutoReversal(failedTx);
  } catch (err) {
    // initiateAutoReversal handles its own errors internally and leaves
    // state as 'reversing' on failure — this catch is a safety net only
    console.log(`  Outer catch (unexpected): ${err.message}`);
  }

  // Step 3: check final state
  const finalTx = await prisma.transaction.findUnique({ where: { id: tx.id } });

  console.log(`\nResult`);
  console.log(`------`);
  console.log(`Final state: ${finalTx.state}`);

  if (finalTx.state === 'reversed') {
    console.log('PASS: Reversal completed successfully. Nomba accepted the call.');
  } else if (finalTx.state === 'reversing') {
    console.log('PARTIAL: Reversal initiated but Nomba did not confirm.');
    console.log('This is expected if the merchantTxRef has no matching real');
    console.log('transaction in Nomba\'s system (i.e. this was a synthetic test).');
    console.log('The reconciliation worker will retry on its next cycle.');
  } else {
    console.log(`UNEXPECTED: state is ${finalTx.state} — check the logs.`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('\nFatal error:', err.message);
  await prisma.$disconnect();
  process.exit(1);
});
