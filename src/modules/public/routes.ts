import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { AppError, notFound, unauthorized } from '../../lib/errors.js';
import type { OtpService } from './otp.js';
import { displayMerchantName, enroll, memberCard, type MemberTokens } from './members.js';

// Qatar mobile numbers only, as in the spec. Spaces and dashes typed by the customer are ignored.
const phoneSchema = z
  .string()
  .max(20)
  .transform((v) => v.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\+974[3-7]\d{7}$/, 'Enter a Qatar mobile number'));

const codeParam = z.string().regex(/^[a-z0-9-]{3,32}$/);

const joinPageSchema = z.object({
  merchantName: z.string(),
  branchName: z.string(),
  branchNameAr: z.string().nullable(),
  programActive: z.boolean(),
  termsEn: z.string().nullable(),
  termsAr: z.string().nullable(),
  design: z.object({ logoUrl: z.string().nullable(), primaryColor: z.string() }),
  tiers: z.array(
    z.object({
      nameEn: z.string(),
      nameAr: z.string(),
      discountPercent: z.number(),
      spendThreshold: z.string(),
      punchRule: z.object({
        enabled: z.boolean(),
        stampsRequired: z.number(),
        rewardDescriptionEn: z.string().nullable(),
        rewardDescriptionAr: z.string().nullable(),
        rewardMaxValue: z.string().nullable(),
      }),
    }),
  ),
});

const tokenSchema = z.object({ memberToken: z.string(), memberTokenExpiresAt: z.string() });

const cardSchema = z.object({
  merchantName: z.string(),
  firstName: z.string(),
  pointsName: z.string(),
  points: z.number(),
  stamps: z.number(),
  stampsRequired: z.number(),
  punchEnabled: z.boolean(),
  rewardAvailable: z.boolean(),
  rewardDescEn: z.string().nullable(),
  rewardDescAr: z.string().nullable(),
  rewardMaxValue: z.string().nullable(),
  tier: z.object({ nameEn: z.string(), nameAr: z.string(), color: z.string(), discountPercent: z.number() }),
  nextTier: z.object({ nameEn: z.string(), nameAr: z.string(), spendRemaining: z.string() }).nullable(),
  windowEndsAt: z.string().nullable(),
  joinedAt: z.string(),
  design: z.object({ logoUrl: z.string().nullable(), bannerUrl: z.string().nullable(), backgroundColor: z.string() }),
});

export interface PublicRouteOptions {
  otp: OtpService;
  memberTokens: MemberTokens;
}

export const publicRoutes: FastifyPluginAsyncZod<PublicRouteOptions> = async (app, { otp, memberTokens }) => {
  async function findBranch(merchantCode: string, branchCode: string) {
    const branch = await app.prisma.branch.findFirst({
      where: { branchCode, active: true, merchant: { merchantCode, loyaltyEnabled: true } },
      include: { merchant: { include: { program: true, cardDesign: true } } },
    });
    if (!branch) throw notFound('join_link_not_found', 'This sign-up link is not valid');
    return branch;
  }

  function bearer(req: FastifyRequest) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    return memberTokens.resolve(header.slice(7));
  }

  app.get(
    '/public/join/:merchantCode/:branchCode',
    { schema: { params: z.object({ merchantCode: codeParam, branchCode: codeParam }), response: { 200: joinPageSchema } } },
    async (req) => {
      const branch = await findBranch(req.params.merchantCode, req.params.branchCode);
      const { merchant } = branch;
      const design = merchant.cardDesign;
      const [logo, tiers] = await Promise.all([
        design?.logoAssetId ? app.prisma.asset.findFirst({ where: { id: design.logoAssetId, merchantId: merchant.id } }) : null,
        app.prisma.tier.findMany({ where: { merchantId: merchant.id, deletedAt: null }, orderBy: { rank: 'asc' } }),
      ]);
      return {
        merchantName: displayMerchantName(merchant.name),
        branchName: branch.name,
        branchNameAr: branch.nameAr,
        programActive: merchant.program?.status === 'active',
        termsEn: merchant.program?.termsEn ?? null,
        termsAr: merchant.program?.termsAr ?? null,
        design: {
          logoUrl: logo?.url ?? null,
          primaryColor: design?.backgroundColor && design.backgroundColor !== '#FFFFFF' ? design.backgroundColor : '#8A1538',
        },
        tiers: tiers.map((t) => ({
          nameEn: t.nameEn,
          nameAr: t.nameAr,
          discountPercent: Number(t.discountPercent),
          spendThreshold: Number(t.spendThreshold).toFixed(2),
          punchRule: {
            enabled: t.punchEnabled,
            stampsRequired: t.stampsRequired,
            rewardDescriptionEn: t.rewardDescEn,
            rewardDescriptionAr: t.rewardDescAr,
            rewardMaxValue: t.rewardMaxValue ? Number(t.rewardMaxValue).toFixed(2) : null,
          },
        })),
      };
    },
  );

  app.post(
    '/public/otp/send',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        body: z.object({
          merchantCode: codeParam,
          branchCode: codeParam,
          phone: phoneSchema,
          locale: z.enum(['en', 'ar']).default('en'),
        }),
        response: {
          202: z.object({
            otpRequestId: z.string(),
            resendAfterSeconds: z.number(),
            expiresInSeconds: z.number(),
            devCode: z.string().optional(),
          }),
        },
      },
    },
    async (req, reply) => {
      const branch = await findBranch(req.body.merchantCode, req.body.branchCode);
      // Same response whether or not the phone is already a member.
      const result = await otp.send({
        merchantId: branch.merchantId,
        branchId: branch.id,
        phone: req.body.phone,
        ip: req.ip,
        locale: req.body.locale,
      });
      return reply.status(202).send(result);
    },
  );

  app.post(
    '/public/otp/verify',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        body: z.object({ otpRequestId: z.string().min(1).max(64), code: z.string().regex(/^\d{4,6}$/) }),
        response: { 200: tokenSchema.extend({ profileRequired: z.boolean() }) },
      },
    },
    async (req) => {
      const verified = await otp.verify(req.body.otpRequestId, req.body.code);
      const member = await app.prisma.member.findUnique({
        where: { merchantId_phone: { merchantId: verified.merchantId, phone: verified.phone } },
      });
      if (member) {
        if (member.status !== 'active') {
          throw new AppError(403, 'member_blocked', 'This card is not active', { messageAr: 'هذه البطاقة غير مفعلة' });
        }
        return { ...(await memberTokens.issue(member.id)), profileRequired: false };
      }
      return { ...(await memberTokens.issueSignup(verified)), profileRequired: true };
    },
  );

  app.get('/public/me', { schema: { response: { 200: cardSchema } } }, async (req) => {
    const who = await bearer(req);
    if (!('member' in who)) {
      throw new AppError(409, 'profile_required', 'Complete your details to create your card', {
        messageAr: 'أكمل بياناتك لإنشاء بطاقتك',
      });
    }
    return memberCard(app.prisma, who.member.id);
  });

  app.put(
    '/public/me',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        body: z.object({
          firstName: z.string().trim().min(1).max(60),
          lastName: z.string().trim().max(60).optional(),
          email: z.string().email().max(120).optional(),
          birthDate: z.string().date().optional(),
          consentAccepted: z.literal(true),
          marketingOptIn: z.boolean().default(false),
        }),
        response: { 200: cardSchema.extend({ memberToken: z.string().optional(), memberTokenExpiresAt: z.string().optional() }) },
      },
    },
    async (req) => {
      const who = await bearer(req);
      // Already a member: nothing to create, and nothing (stamps, points, name) is changed.
      if ('member' in who) return memberCard(app.prisma, who.member.id);

      const { member } = await enroll(app.prisma, who.signup, req.body);
      if (member.status !== 'active') {
        throw new AppError(403, 'member_blocked', 'This card is not active', { messageAr: 'هذه البطاقة غير مفعلة' });
      }
      const token = await memberTokens.issue(member.id);
      return { ...(await memberCard(app.prisma, member.id)), ...token };
    },
  );

  const passCodeResponseSchema = z.object({
    code: z.string(),
    expiresAt: z.string(),
    qrDataUrl: z.string(),
  });

  const PASS_CODE_TTL_MS = 90 * 1000;
  // Per member (one active card token per member, since signing in again revokes the old one).
  const PASS_CODE_LIMITS = [
    { windowMs: 60 * 1000, max: 10 },
    { windowMs: 60 * 60 * 1000, max: 120 },
  ];

  // POST only: each call inserts a row, so it must never be triggered by prefetching or cached.
  app.post(
    '/public/me/qr',
    {
      // Coarse per-IP guard; the real limit is per card below.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { response: { 200: passCodeResponseSchema } },
    },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const who = await bearer(req); // blocked members get 401 here
      if (!('member' in who)) {
        throw new AppError(409, 'profile_required', 'Complete your details to create your card', {
          messageAr: 'أكمل بياناتك لإنشاء بطاقتك',
        });
      }

      const code = 'glp1.' + crypto.randomBytes(32).toString('base64url');
      const codeHash = crypto.createHash('sha256').update(code).digest('hex');
      const expiresAt = new Date(Date.now() + PASS_CODE_TTL_MS);

      await app.prisma.$transaction(async (tx) => {
        // Lock the member row so parallel requests are counted one after another.
        const [member] = await tx.$queryRaw<{ id: string; merchantId: string; status: string }[]>`
          SELECT id, "merchantId", status::text AS status FROM "Member" WHERE id = ${who.member.id} FOR UPDATE`;
        if (!member || member.status !== 'active') {
          throw unauthorized('member_blocked', 'This card is not active');
        }
        for (const limit of PASS_CODE_LIMITS) {
          const count = await tx.passCode.count({
            where: { memberId: member.id, createdAt: { gt: new Date(Date.now() - limit.windowMs) } },
          });
          if (count >= limit.max) {
            throw new AppError(429, 'rate_limited', 'Too many QR requests, try again later', {
              messageAr: 'طلبات كثيرة، حاول لاحقاً',
            });
          }
        }
        await tx.passCode.create({ data: { codeHash, merchantId: member.merchantId, memberId: member.id, expiresAt } });
      });

      const qrDataUrl = await QRCode.toDataURL(code, {
        width: 280,
        margin: 2,
        color: { dark: '#111827', light: '#FFFFFF' },
      });
      return { code, expiresAt: expiresAt.toISOString(), qrDataUrl };
    },
  );
};
