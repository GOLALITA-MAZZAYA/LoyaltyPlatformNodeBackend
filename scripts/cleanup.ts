// Runs the daily cleanup once (the server also runs it every 24 h).
import { PrismaClient } from '@prisma/client';
import { runCleanup } from '../src/jobs/cleanup.js';

const prisma = new PrismaClient();
try {
  console.log('Deleted:', await runCleanup(prisma));
} finally {
  await prisma.$disconnect();
}
