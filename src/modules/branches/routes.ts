import { z } from 'zod';
import QRCode from 'qrcode';
import type { Branch } from '@prisma/client';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { OdooClient } from '../../integrations/odoo.js';
import { notFound } from '../../lib/errors.js';
import { syncBranches } from '../merchant/branches.js';

// Golalita brand colour, used until the merchant sets a card design.
const DEFAULT_PRIMARY = '#8A1538';

const branchSchema = z.object({
  id: z.string(),
  odooBranchId: z.number(),
  name: z.string(),
  nameAr: z.string().nullable(),
  branchCode: z.string(),
  active: z.boolean(),
  memberCount: z.number(),
});

const branchListSchema = z.object({ items: z.array(branchSchema) });

const branchQrSchema = z.object({
  branchId: z.string(),
  branchName: z.string(),
  branchNameAr: z.string().nullable(),
  joinUrl: z.string().url(),
  qrSvg: z.string(),
  poster: z.object({
    merchantName: z.string(),
    headlineEn: z.string(),
    headlineAr: z.string(),
    stepsEn: z.array(z.string()),
    stepsAr: z.array(z.string()),
    logoUrl: z.string().nullable(),
    primaryColor: z.string(),
    tiers: z.array(z.object({ nameEn: z.string(), nameAr: z.string(), color: z.string(), discountPercent: z.number() })),
  }),
});

export interface BranchRouteOptions {
  odoo: OdooClient;
  joinBaseUrl: string;
}

export function joinUrlFor(joinBaseUrl: string, merchantCode: string, branchCode: string) {
  return `${joinBaseUrl.replace(/\/+$/, '')}/j/${merchantCode}/${branchCode}`;
}

export const branchRoutes: FastifyPluginAsyncZod<BranchRouteOptions> = async (app, { odoo, joinBaseUrl }) => {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.requireLoyalty);

  async function withCounts(merchantId: string, branches: Branch[]) {
    const counts = await app.prisma.member.groupBy({
      by: ['joinedBranchId'],
      where: { merchantId },
      _count: { _all: true },
    });
    const byBranch = new Map(counts.map((c) => [c.joinedBranchId, c._count._all]));
    return branches.map((b) => ({
      id: b.id,
      odooBranchId: b.odooBranchId,
      name: b.name,
      nameAr: b.nameAr,
      branchCode: b.branchCode,
      active: b.active,
      memberCount: byBranch.get(b.id) ?? 0,
    }));
  }

  app.get('/branches', { schema: { response: { 200: branchListSchema } } }, async (req) => {
    const branches = await app.prisma.branch.findMany({ where: { merchantId: req.auth.mid }, orderBy: { name: 'asc' } });
    return { items: await withCounts(req.auth.mid, branches) };
  });

  app.post(
    '/branches/sync',
    {
      preHandler: app.requireRole('owner'),
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { body: z.object({ odooToken: z.string().min(1).max(4096) }), response: { 200: branchListSchema } },
    },
    async (req) => {
      const merchant = await app.prisma.merchant.findUniqueOrThrow({ where: { id: req.auth.mid } });
      const branches = await syncBranches(app.prisma, odoo, merchant.id, merchant.odooPartnerId, req.body.odooToken);
      return { items: await withCounts(merchant.id, branches) };
    },
  );

  app.get(
    '/branches/:branchId/qr',
    {
      schema: {
        params: z.object({ branchId: z.string().min(1).max(64) }),
        response: { 200: branchQrSchema },
      },
    },
    async (req) => {
      // Scoped by merchant: another merchant's branch id is simply "not found".
      const branch = await app.prisma.branch.findFirst({
        where: { id: req.params.branchId, merchantId: req.auth.mid, active: true },
        include: { merchant: { include: { cardDesign: true } } },
      });
      if (!branch) throw notFound('branch_not_found', 'Branch not found');

      const { merchant } = branch;
      const design = merchant.cardDesign;
      const [logo, tiers] = await Promise.all([
        design?.logoAssetId ? app.prisma.asset.findFirst({ where: { id: design.logoAssetId, merchantId: merchant.id } }) : null,
        app.prisma.tier.findMany({ where: { merchantId: merchant.id, deletedAt: null }, orderBy: { rank: 'asc' } }),
      ]);

      const joinUrl = joinUrlFor(joinBaseUrl, merchant.merchantCode, branch.branchCode);
      // Level M survives some damage/glare on a printed poster and keeps the code readable from a distance.
      const qrSvg = await QRCode.toString(joinUrl, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });

      return {
        branchId: branch.id,
        branchName: branch.name,
        branchNameAr: branch.nameAr,
        joinUrl,
        qrSvg,
        poster: {
          merchantName: merchant.name,
          headlineEn: `Join ${merchant.name} Rewards`,
          headlineAr: `انضم إلى برنامج مكافآت ${merchant.name}`,
          stepsEn: ['Scan the QR code with your phone camera', 'Enter your mobile number', 'Add your card to Apple or Google Wallet'],
          stepsAr: ['امسح الرمز بكاميرا هاتفك', 'أدخل رقم جوالك', 'أضف بطاقتك إلى محفظة Apple أو Google'],
          logoUrl: logo?.url ?? null,
          primaryColor: design?.backgroundColor && design.backgroundColor !== '#FFFFFF' ? design.backgroundColor : DEFAULT_PRIMARY,
          tiers: tiers.map((t) => ({ nameEn: t.nameEn, nameAr: t.nameAr, color: t.color, discountPercent: Number(t.discountPercent) })),
        },
      };
    },
  );
};
