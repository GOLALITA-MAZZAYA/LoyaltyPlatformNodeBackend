import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { ensureProgramDefaults, lockMerchant } from './defaults.js';

const money = (d: Prisma.Decimal | number | string) => Number(d).toFixed(2);

const punchRuleSchema = z.object({
  enabled: z.boolean(),
  stampsRequired: z.number().int().min(2).max(20),
  rewardDescriptionEn: z.string().max(60).nullable().optional(),
  rewardDescriptionAr: z.string().max(60).nullable().optional(),
  // Optional cap on the free item's price, shown to customers and cashiers. Empty means no cap.
  rewardMaxValue: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z
      .string()
      .regex(/^\d{1,7}(\.\d{1,2})?$/, 'Must be an amount like 300 or 300.00')
      .refine((v) => Number(v) > 0, 'Must be more than 0')
      .nullable()
      .optional(),
  ),
});

const tierInputSchema = z.object({
  id: z.string().optional(),
  nameEn: z.string().min(1).max(20),
  nameAr: z.string().min(1).max(20),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a 6-digit hex color like #8A1538'),
  spendThreshold: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Must be a decimal string like 0.00'),
  discountPercent: z.number().min(0).max(100),
  isBase: z.boolean(),
  punchRule: punchRuleSchema,
});

const tierViewSchema = tierInputSchema.extend({
  id: z.string(),
  rank: z.number().int(),
});

const programInputSchema = z.object({
  status: z.enum(['draft', 'active', 'paused']),
  pointsPerQar: z.number().min(0).max(100),
  minBillForEarning: z.string().regex(/^\d+(\.\d{1,2})?$/).default('0.00'),
  pointsNameEn: z.string().min(1).max(20),
  pointsNameAr: z.string().min(1).max(20),
  tierWindow: z.enum(['monthly', 'quarterly', 'lifetime']),
  tierCarryOver: z.boolean().default(false),
  maxStampsPerTransaction: z.number().int().min(1).max(20).default(5),
  invoiceRefRequired: z.boolean().default(true),
  allowPhoneLookup: z.boolean().default(false),
  phoneLookupDailyLimit: z.number().int().min(0).max(500).default(20),
  termsEn: z.string().max(4000).nullable().optional(),
  termsAr: z.string().max(4000).nullable().optional(),
});

const programViewSchema = programInputSchema.extend({
  version: z.number().int(),
  updatedAt: z.string(),
  currentWindowEndsAt: z.string().nullable(),
});

export const programRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.requireLoyalty);

  // Shared with customer sign-up so both create the same defaults (see defaults.ts).
  // Locked per merchant: the hub loads /program and /program/tiers in parallel on first open.
  const getOrInitProgram = (merchantId: string) =>
    app.prisma.$transaction((tx) => ensureProgramDefaults(tx, merchantId));

  function programView(p: any) {
    return {
      version: p.version,
      status: p.status,
      pointsPerQar: Number(p.pointsPerQar),
      minBillForEarning: money(p.minBillForEarning),
      pointsNameEn: p.pointsNameEn,
      pointsNameAr: p.pointsNameAr,
      tierWindow: p.tierWindow,
      tierCarryOver: p.tierCarryOver,
      maxStampsPerTransaction: p.maxStampsPerTransaction,
      invoiceRefRequired: p.invoiceRefRequired,
      allowPhoneLookup: p.allowPhoneLookup,
      phoneLookupDailyLimit: p.phoneLookupDailyLimit,
      termsEn: p.termsEn,
      termsAr: p.termsAr,
      updatedAt: p.updatedAt.toISOString(),
      currentWindowEndsAt: null,
    };
  }

  function tierView(t: any) {
    return {
      id: t.id,
      rank: t.rank,
      nameEn: t.nameEn,
      nameAr: t.nameAr,
      color: t.color,
      spendThreshold: money(t.spendThreshold),
      discountPercent: Number(t.discountPercent),
      isBase: t.isBase,
      punchRule: {
        enabled: t.punchEnabled,
        stampsRequired: t.stampsRequired,
        rewardDescriptionEn: t.rewardDescEn,
        rewardDescriptionAr: t.rewardDescAr,
        rewardMaxValue: t.rewardMaxValue ? money(t.rewardMaxValue) : null,
      },
    };
  }

  // GET /program
  app.get(
    '/program',
    {
      
      schema: { response: { 200: programViewSchema } },
    },
    async (req) => {
      const p = await getOrInitProgram(req.auth.mid);
      return programView(p);
    },
  );

  // PUT /program (Owner only)
  app.put(
    '/program',
    {
      preHandler: app.requireRole('owner'),
      schema: {
        body: programInputSchema,
        response: { 200: programViewSchema },
      },
    },
    async (req) => {
      await getOrInitProgram(req.auth.mid);

      const updated = await app.prisma.program.update({
        where: { merchantId: req.auth.mid },
        data: {
          version: { increment: 1 },
          status: req.body.status,
          pointsPerQar: new Prisma.Decimal(req.body.pointsPerQar),
          minBillForEarning: new Prisma.Decimal(req.body.minBillForEarning ?? '0.00'),
          pointsNameEn: req.body.pointsNameEn,
          pointsNameAr: req.body.pointsNameAr,
          tierWindow: req.body.tierWindow,
          tierCarryOver: req.body.tierCarryOver,
          maxStampsPerTransaction: req.body.maxStampsPerTransaction,
          invoiceRefRequired: req.body.invoiceRefRequired,
          allowPhoneLookup: req.body.allowPhoneLookup,
          phoneLookupDailyLimit: req.body.phoneLookupDailyLimit,
          termsEn: req.body.termsEn ?? null,
          termsAr: req.body.termsAr ?? null,
        },
      });

      return programView(updated);
    },
  );

  // GET /program/tiers
  app.get(
    '/program/tiers',
    {
      
      schema: {
        response: {
          200: z.object({
            version: z.number().int(),
            items: z.array(tierViewSchema),
          }),
        },
      },
    },
    async (req) => {
      const p = await getOrInitProgram(req.auth.mid);
      const tiers = await app.prisma.tier.findMany({
        where: { merchantId: req.auth.mid, deletedAt: null },
        orderBy: { rank: 'asc' },
      });

      return {
        version: p.version,
        items: tiers.map(tierView),
      };
    },
  );

  // PUT /program/tiers (Owner only)
  app.put(
    '/program/tiers',
    {
      preHandler: app.requireRole('owner'),
      schema: {
        body: z.object({
          items: z.array(tierInputSchema).min(1).max(8),
          reassignToTierId: z.string().optional(),
        }),
        response: {
          200: z.object({
            version: z.number().int(),
            items: z.array(tierViewSchema),
          }),
        },
      },
    },
    async (req) => {
      const items = req.body.items;

      // Exactly one base tier
      const baseTiers = items.filter((i) => i.isBase);
      if (baseTiers.length !== 1) {
        throw new AppError(422, 'invalid_tiers', 'Exactly one tier must be marked as base', {
          messageAr: 'يجب تحديد مستوى أساسي واحد بالضبط',
        });
      }

      if (Number(baseTiers[0]!.spendThreshold) !== 0) {
        throw new AppError(422, 'invalid_tiers', 'Base tier spend threshold must be 0.00', {
          messageAr: 'الحد الأدنى للمستوى الأساسي يجب أن يكون 0.00',
        });
      }

      // Check strictly increasing thresholds
      for (let i = 1; i < items.length; i++) {
        if (Number(items[i]!.spendThreshold) <= Number(items[i - 1]!.spendThreshold)) {
          throw new AppError(422, 'invalid_tiers', 'Spend thresholds must strictly increase with tier rank', {
            messageAr: 'حد الإنفاق يجب أن يتصاعد تدريجياً مع كل مستوى',
          });
        }
      }

      await getOrInitProgram(req.auth.mid);
      const merchantId = req.auth.mid;
      const invalid = (message: string, messageAr: string) => new AppError(422, 'invalid_tiers', message, { messageAr });

      // Perform replace atomically
      const result = await app.prisma.$transaction(async (tx) => {
        // One tier edit per merchant at a time.
        await lockMerchant(tx, merchantId);
        const existingTiers = await tx.tier.findMany({
          where: { merchantId, deletedAt: null },
        });

        // Tenant check: every id the client sends must be one of THIS merchant's live tiers.
        // Anything else (another merchant's tier, a deleted tier, a made-up id) is rejected
        // before any write, so nothing changes for either merchant.
        const ownIds = new Set(existingTiers.map((t) => t.id));
        const suppliedIds = items.map((it) => it.id).filter((id): id is string => !!id);
        if (suppliedIds.some((id) => !ownIds.has(id))) {
          throw invalid('Unknown tier id', 'مستوى غير معروف');
        }
        if (new Set(suppliedIds).size !== suppliedIds.length) {
          throw invalid('The same tier appears twice', 'المستوى مكرر');
        }

        const newIds = new Set(suppliedIds);
        const removedTiers = existingTiers.filter((t) => !newIds.has(t.id));

        // Members of removed tiers may only move to a tier of this merchant that is being kept.
        const target = req.body.reassignToTierId;
        if (target !== undefined && !newIds.has(target)) {
          throw invalid('Members can only be moved to one of your remaining tiers', 'يمكن نقل الأعضاء إلى أحد مستوياتك المتبقية فقط');
        }

        // Check if removed tiers have members
        if (removedTiers.length > 0) {
          const removedIds = removedTiers.map((t) => t.id);
          const membersInRemoved = await tx.member.count({
            where: { merchantId, tierId: { in: removedIds } },
          });

          if (membersInRemoved > 0) {
            if (!req.body.reassignToTierId) {
              throw new AppError(409, 'tier_in_use', 'Cannot delete a tier with active members without specifying reassignToTierId', {
                messageAr: 'لا يمكن حذف مستوى يحتوي على أعضاء دون تحديد مستوى بديل',
              });
            }
            // Reassign members
            await tx.member.updateMany({
              where: { merchantId, tierId: { in: removedIds } },
              data: { tierId: req.body.reassignToTierId },
            });
          }

          // Soft delete removed tiers
          await tx.tier.updateMany({
            where: { merchantId, id: { in: removedIds } },
            data: { deletedAt: new Date() },
          });
        }

        // Upsert / update items
        const savedTiers = [];
        for (const [rank, it] of items.entries()) {
          if (it.id) {
            // Ownership was verified above; merchantId here is a second guard.
            const updated = await tx.tier.update({
              where: { id: it.id, merchantId },
              data: {
                rank,
                isBase: it.isBase,
                nameEn: it.nameEn,
                nameAr: it.nameAr,
                color: it.color,
                spendThreshold: new Prisma.Decimal(it.spendThreshold),
                discountPercent: new Prisma.Decimal(it.discountPercent),
                punchEnabled: it.punchRule.enabled,
                stampsRequired: it.punchRule.stampsRequired,
                rewardDescEn: it.punchRule.rewardDescriptionEn ?? null,
                rewardDescAr: it.punchRule.rewardDescriptionAr ?? null,
                rewardMaxValue: it.punchRule.rewardMaxValue ? new Prisma.Decimal(it.punchRule.rewardMaxValue) : null,
              },
            });
            savedTiers.push(updated);
          } else {
            const created = await tx.tier.create({
              data: {
                merchantId,
                rank,
                isBase: it.isBase,
                nameEn: it.nameEn,
                nameAr: it.nameAr,
                color: it.color,
                spendThreshold: new Prisma.Decimal(it.spendThreshold),
                discountPercent: new Prisma.Decimal(it.discountPercent),
                punchEnabled: it.punchRule.enabled,
                stampsRequired: it.punchRule.stampsRequired,
                rewardDescEn: it.punchRule.rewardDescriptionEn ?? null,
                rewardDescAr: it.punchRule.rewardDescriptionAr ?? null,
                rewardMaxValue: it.punchRule.rewardMaxValue ? new Prisma.Decimal(it.punchRule.rewardMaxValue) : null,
              },
            });
            savedTiers.push(created);
          }
        }

        // Increment version
        const prog = await tx.program.update({
          where: { merchantId },
          data: { version: { increment: 1 } },
        });

        return { version: prog.version, items: savedTiers };
      });

      return {
        version: result.version,
        items: result.items.map(tierView),
      };
    },
  );
};
