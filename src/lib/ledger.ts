import type { PrismaClient } from '@prisma/client';

export interface LedgerMismatch {
  memberId: string;
  merchantId: string;
  stamps: number;
  ledgerStamps: number;
  rewardsRedeemed: number;
  ledgerRewardsRedeemed: number;
}

/**
 * Members whose cached totals differ from their ledger (docs/loyalty-scanner-spec.md, "Reconciliation").
 * Read-only: never changes balances.
 */
export async function findLedgerMismatches(prisma: PrismaClient): Promise<LedgerMismatch[]> {
  return prisma.$queryRaw<LedgerMismatch[]>`
    SELECT m.id AS "memberId", m."merchantId", m.stamps, m."rewardsRedeemed",
           COALESCE(SUM(t."stampsDelta"), 0)::int AS "ledgerStamps",
           COALESCE(SUM(CASE WHEN t."rewardRedeemed" IS NOT TRUE THEN 0
                             WHEN t.type = 'void' THEN -1 ELSE 1 END), 0)::int AS "ledgerRewardsRedeemed"
    FROM "Member" m
    LEFT JOIN "Transaction" t ON t."memberId" = m.id
    GROUP BY m.id
    HAVING m.stamps <> COALESCE(SUM(t."stampsDelta"), 0)
        OR m."rewardsRedeemed" <> COALESCE(SUM(CASE WHEN t."rewardRedeemed" IS NOT TRUE THEN 0
                                                    WHEN t.type = 'void' THEN -1 ELSE 1 END), 0)`;
}
