import { Prisma, type PrismaClient } from '@prisma/client';
import type { OdooClient } from '../../integrations/odoo.js';
import { publicCode } from '../../lib/codes.js';

/**
 * Mirrors the merchant's Odoo branches. New branches get a random public code;
 * branches that disappeared from Odoo are marked inactive (never deleted, history points at them).
 */
export async function syncBranches(prisma: PrismaClient, odoo: OdooClient, merchantId: string, partnerId: number, odooToken: string) {
  const remote = await odoo.getBranches(odooToken, partnerId);
  const now = new Date();

  for (const b of remote) {
    const existing = await prisma.branch.findUnique({ where: { odooBranchId: b.odooBranchId } });
    if (existing) {
      if (existing.merchantId !== merchantId) continue; // belongs to another merchant; never move it
      await prisma.branch.update({
        where: { id: existing.id },
        data: { name: b.name, nameAr: b.nameAr, active: true, syncedAt: now },
      });
      continue;
    }
    await createWithUniqueCode(prisma, { merchantId, odooBranchId: b.odooBranchId, name: b.name, nameAr: b.nameAr, syncedAt: now });
  }

  await prisma.branch.updateMany({
    where: { merchantId, odooBranchId: { notIn: remote.map((b) => b.odooBranchId) }, active: true },
    data: { active: false, syncedAt: now },
  });

  return prisma.branch.findMany({ where: { merchantId }, orderBy: { name: 'asc' } });
}

async function createWithUniqueCode(prisma: PrismaClient, data: Omit<Prisma.BranchUncheckedCreateInput, 'branchCode'>) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.branch.create({ data: { ...data, branchCode: publicCode(5) } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
      throw err;
    }
  }
  throw new Error('Could not allocate a unique branch code');
}
