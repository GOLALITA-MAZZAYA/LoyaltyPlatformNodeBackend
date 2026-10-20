import { z } from 'zod';
import type { Prisma, Branch, Member, Tier } from '@prisma/client';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { AppError, notFound } from '../../lib/errors.js';

/** "+97455123456" -> "+974 •••• 3456". Cashiers only ever see this form. */
export function maskPhone(phone: string) {
  return `${phone.slice(0, 4)} •••• ${phone.slice(-4)}`;
}

const money = (d: Prisma.Decimal) => Number(d).toFixed(2);

const summarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  phoneMasked: z.string(),
  /** Full number, owners only. */
  phone: z.string().optional(),
  tierId: z.string(),
  tierNameEn: z.string(),
  tierNameAr: z.string(),
  tierColor: z.string(),
  points: z.number(),
  stamps: z.number(),
  stampsRequired: z.number(),
  status: z.enum(['active', 'blocked']),
  joinedAt: z.string(),
  joinedBranchId: z.string().nullable(),
  joinedBranchName: z.string().nullable(),
  lastVisitAt: z.string().nullable(),
});

const detailSchema = summarySchema.extend({
  firstName: z.string(),
  lastName: z.string().nullable(),
  source: z.enum(['branch_qr', 'cashier', 'other']),
  windowSpend: z.string(),
  lifetimeSpend: z.string(),
  rewardsRedeemed: z.number(),
  marketingOptIn: z.boolean(),
  transactionCount: z.number(),
  walletPass: z.object({
    apple: z.boolean(),
    google: z.boolean(),
    lastSyncedAt: z.string().nullable(),
    syncStatus: z.enum(['ok', 'pending', 'failed', 'none']),
  }),
});

type Row = Member & { tier: Tier };

const SYNC_STATUSES = ['ok', 'pending', 'failed'] as const;
const syncStatus = (s?: string): (typeof SYNC_STATUSES)[number] | 'none' =>
  SYNC_STATUSES.find((x) => x === s) ?? 'none';

// Keyset paging over (joinedAt desc, id desc): stable while new members keep joining.
const encodeCursor = (m: Member) => Buffer.from(`${m.joinedAt.toISOString()}|${m.id}`).toString('base64url');
function decodeCursor(cursor: string) {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const date = new Date(at ?? '');
  if (!id || Number.isNaN(date.getTime())) throw new AppError(422, 'invalid_cursor', 'Invalid cursor');
  return { at: date, id };
}

export const memberRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.requireLoyalty);

  function summary(m: Row, branches: Map<string, Branch>, isOwner: boolean) {
    const branch = m.joinedBranchId ? branches.get(m.joinedBranchId) : undefined;
    return {
      id: m.id,
      displayName: [m.firstName, m.lastName].filter(Boolean).join(' '),
      phoneMasked: maskPhone(m.phone),
      ...(isOwner && { phone: m.phone }),
      tierId: m.tierId,
      tierNameEn: m.tier.nameEn,
      tierNameAr: m.tier.nameAr,
      tierColor: m.tier.color,
      points: m.points,
      stamps: m.stamps,
      stampsRequired: m.tier.punchEnabled ? m.tier.stampsRequired : 0,
      status: m.status,
      joinedAt: m.joinedAt.toISOString(),
      joinedBranchId: m.joinedBranchId,
      joinedBranchName: branch?.name ?? null,
      lastVisitAt: m.lastVisitAt?.toISOString() ?? null,
    };
  }

  const branchMap = async (merchantId: string) =>
    new Map((await app.prisma.branch.findMany({ where: { merchantId } })).map((b) => [b.id, b]));

  async function detail(merchantId: string, memberId: string, isOwner: boolean) {
    const m = await app.prisma.member.findFirst({ where: { id: memberId, merchantId }, include: { tier: true, walletPass: true } });
    if (!m) throw notFound('member_not_found', 'Member not found');
    const [branches, transactionCount] = await Promise.all([
      branchMap(merchantId),
      app.prisma.transaction.count({ where: { merchantId, memberId: m.id } }),
    ]);
    return {
      ...summary(m, branches, isOwner),
      firstName: m.firstName,
      lastName: m.lastName,
      source: m.source,
      windowSpend: money(m.windowSpend),
      lifetimeSpend: money(m.lifetimeSpend),
      rewardsRedeemed: m.rewardsRedeemed,
      marketingOptIn: m.marketingOptIn,
      transactionCount,
      walletPass: {
        apple: m.walletPass?.apple ?? false,
        google: m.walletPass?.google ?? false,
        lastSyncedAt: m.walletPass?.lastSyncedAt?.toISOString() ?? null,
        syncStatus: syncStatus(m.walletPass?.syncStatus),
      },
    };
  }

  app.get(
    '/members',
    {
      schema: {
        querystring: z.object({
          cursor: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(20),
          q: z.string().trim().min(2).max(60).optional(),
          tierId: z.string().max(64).optional(),
          joinedBranchId: z.string().max(64).optional(),
        }),
        response: {
          200: z.object({
            items: z.array(summarySchema),
            nextCursor: z.string().nullable(),
            totals: z.object({ members: z.number(), matching: z.number(), byTier: z.record(z.number()) }),
          }),
        },
      },
    },
    async (req) => {
      const { mid, role } = req.auth;
      const { cursor, limit, q, tierId, joinedBranchId } = req.query;

      // Every condition is ANDed with merchantId, so filters can never reach another merchant's members.
      const and: Prisma.MemberWhereInput[] = [{ merchantId: mid }];
      if (tierId) and.push({ tierId });
      if (joinedBranchId) and.push({ joinedBranchId });
      if (q) {
        const digits = q.replace(/[\s+-]/g, '');
        if (/^\d+$/.test(digits)) {
          if (digits.length < 4) {
            throw new AppError(422, 'validation_failed', 'Enter at least 4 digits of the phone number', {
              messageAr: 'أدخل 4 أرقام على الأقل من رقم الجوال',
              errors: [{ field: 'q', code: 'too_short' }],
            });
          }
          and.push({ phone: { contains: digits } });
        } else {
          and.push({
            OR: [{ firstName: { contains: q, mode: 'insensitive' } }, { lastName: { contains: q, mode: 'insensitive' } }],
          });
        }
      }
      const where: Prisma.MemberWhereInput = { AND: and };

      const pageWhere: Prisma.MemberWhereInput = cursor
        ? (() => {
            const c = decodeCursor(cursor);
            return { AND: [where, { OR: [{ joinedAt: { lt: c.at } }, { joinedAt: c.at, id: { lt: c.id } }] }] };
          })()
        : where;

      const [rows, matching, members, byTierRows, branches] = await Promise.all([
        app.prisma.member.findMany({
          where: pageWhere,
          include: { tier: true },
          orderBy: [{ joinedAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
        }),
        app.prisma.member.count({ where }),
        app.prisma.member.count({ where: { merchantId: mid } }),
        app.prisma.member.groupBy({ by: ['tierId'], where: { merchantId: mid }, _count: { _all: true } }),
        branchMap(mid),
      ]);

      const page = rows.slice(0, limit);
      return {
        items: page.map((m) => summary(m, branches, role === 'owner')),
        nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null,
        totals: { members, matching, byTier: Object.fromEntries(byTierRows.map((r) => [r.tierId, r._count._all])) },
      };
    },
  );

  app.get(
    '/members/:memberId',
    { schema: { params: z.object({ memberId: z.string().min(1).max(64) }), response: { 200: detailSchema } } },
    async (req) => detail(req.auth.mid, req.params.memberId, req.auth.role === 'owner'),
  );

  app.patch(
    '/members/:memberId',
    {
      preHandler: app.requireRole('owner'),
      schema: {
        params: z.object({ memberId: z.string().min(1).max(64) }),
        body: z.object({ status: z.enum(['active', 'blocked']), reason: z.string().trim().max(200).optional() }),
        response: { 200: detailSchema },
      },
    },
    async (req) => {
      const { mid, sub } = req.auth;
      const member = await app.prisma.member.findFirst({ where: { id: req.params.memberId, merchantId: mid } });
      if (!member) throw notFound('member_not_found', 'Member not found');

      if (member.status !== req.body.status) {
        await app.prisma.$transaction([
          app.prisma.member.update({ where: { id: member.id }, data: { status: req.body.status } }),
          // A blocked member's saved web card stops working immediately.
          ...(req.body.status === 'blocked'
            ? [app.prisma.memberToken.updateMany({ where: { memberId: member.id, revokedAt: null }, data: { revokedAt: new Date() } })]
            : []),
          app.prisma.event.create({
            data: {
              merchantId: mid,
              type: req.body.status === 'blocked' ? 'member.blocked' : 'member.unblocked',
              actorType: 'staff',
              actorId: sub,
              subjectId: member.id,
              payload: { reason: req.body.reason ?? null },
            },
          }),
        ]);
      }
      return detail(mid, member.id, true);
    },
  );
};
