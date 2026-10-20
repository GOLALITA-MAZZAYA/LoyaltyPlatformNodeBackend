import type { Prisma, Program, Tier } from '@prisma/client';

/**
 * The one default policy for a merchant that hasn't configured anything yet.
 * Used by customer sign-up and by the merchant's Program & Tiers screen, so both always agree.
 *
 * - Program: schema defaults, status `draft` until the owner activates it.
 * - Base tier: "Member", no discount, 10-stamp punch card, no reward text. We never invent a
 *   reward ("free coffee") the merchant hasn't offered; the owner writes it in settings.
 */
export const DEFAULT_BASE_TIER = {
  rank: 0,
  isBase: true,
  nameEn: 'Member',
  nameAr: 'عضو',
  color: '#8A1538',
  spendThreshold: 0,
  discountPercent: 0,
  punchEnabled: true,
  stampsRequired: 10,
  rewardDescEn: null,
  rewardDescAr: null,
} as const;

/** Serialises setup and tier changes per merchant for the rest of the transaction. */
export async function lockMerchant(tx: Prisma.TransactionClient, merchantId: string) {
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${merchantId}))`;
}

export async function ensureBaseTier(tx: Prisma.TransactionClient, merchantId: string): Promise<Tier> {
  await lockMerchant(tx, merchantId);
  const existing = await tx.tier.findFirst({ where: { merchantId, isBase: true, deletedAt: null }, orderBy: { rank: 'asc' } });
  if (existing) return existing;
  return tx.tier.create({ data: { merchantId, ...DEFAULT_BASE_TIER } });
}

/** Creates the program row and base tier if missing. Safe to call concurrently. */
export async function ensureProgramDefaults(tx: Prisma.TransactionClient, merchantId: string): Promise<Program> {
  await lockMerchant(tx, merchantId);
  const program =
    (await tx.program.findUnique({ where: { merchantId } })) ?? (await tx.program.create({ data: { merchantId } }));
  await ensureBaseTier(tx, merchantId);
  return program;
}
