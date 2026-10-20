// Read-only: reports members whose stamps or reward counter differ from the ledger. Exit code 1 if any.
import { PrismaClient } from '@prisma/client';
import { findLedgerMismatches } from '../src/lib/ledger.js';

const prisma = new PrismaClient();
try {
  const mismatches = await findLedgerMismatches(prisma);
  if (mismatches.length === 0) {
    console.log('Ledger OK: every member balance matches the ledger.');
  } else {
    console.table(mismatches);
    process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect();
}
