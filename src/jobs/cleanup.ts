import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes unused pass codes that expired over 24 h ago and idempotency keys older than 24 h.
 * Used pass codes are kept: ledger rows reference them.
 */
export async function runCleanup(prisma: PrismaClient, now = new Date()) {
  const cutoff = new Date(now.getTime() - DAY_MS);
  const [passCodes, idempotencyKeys] = await Promise.all([
    prisma.passCode.deleteMany({ where: { usedAt: null, expiresAt: { lt: cutoff } } }),
    prisma.idempotencyKey.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  ]);
  return { passCodes: passCodes.count, idempotencyKeys: idempotencyKeys.count };
}

/** Runs the cleanup a minute after start, then once a day. Safe to run on several instances at once. */
export function scheduleDailyCleanup(app: FastifyInstance) {
  const run = async () => {
    try {
      app.log.info({ deleted: await runCleanup(app.prisma) }, 'daily cleanup done');
    } catch (err) {
      app.log.error({ err }, 'daily cleanup failed');
    }
  };
  const first = setTimeout(run, 60_000);
  const daily = setInterval(run, DAY_MS);
  first.unref();
  daily.unref();
  app.addHook('onClose', async () => {
    clearTimeout(first);
    clearInterval(daily);
  });
}
