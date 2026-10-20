import { Prisma, type Member, type PrismaClient } from '@prisma/client';
import { ensureBaseTier } from '../program/defaults.js';
import { SignJWT, jwtVerify } from 'jose';
import { hashToken, newOpaqueToken } from '../../lib/tokens.js';
import { unauthorized } from '../../lib/errors.js';

export const MEMBER_TOKEN_TTL_DAYS = 180;
const SIGNUP_TOKEN_TTL_SECONDS = 30 * 60;
const ISSUER = 'golalita-loyalty';
const SIGNUP_AUDIENCE = 'member-signup';

/** A verified phone that is not a member yet: allowed only to create its membership. */
export interface SignupClaims {
  merchantId: string;
  branchId: string;
  phone: string;
}

export class MemberTokens {
  private readonly key: Uint8Array;

  constructor(
    private readonly prisma: PrismaClient,
    secret: string,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  /** Long-lived card token. Issuing one revokes the member's older tokens. */
  async issue(memberId: string) {
    const token = newOpaqueToken('mt');
    const expiresAt = new Date(Date.now() + MEMBER_TOKEN_TTL_DAYS * 86_400_000);
    await this.prisma.$transaction([
      this.prisma.memberToken.updateMany({ where: { memberId, revokedAt: null }, data: { revokedAt: new Date() } }),
      this.prisma.memberToken.create({ data: { memberId, tokenHash: hashToken(token), expiresAt } }),
    ]);
    return { memberToken: token, memberTokenExpiresAt: expiresAt.toISOString() };
  }

  async issueSignup(claims: SignupClaims) {
    const expiresAt = new Date(Date.now() + SIGNUP_TOKEN_TTL_SECONDS * 1000);
    const token = await new SignJWT({ bid: claims.branchId, ph: claims.phone })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.merchantId)
      .setIssuer(ISSUER)
      .setAudience(SIGNUP_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.key);
    return { memberToken: token, memberTokenExpiresAt: expiresAt.toISOString() };
  }

  /** Resolves a bearer token to either an existing member or a pending sign-up. */
  async resolve(token: string): Promise<{ member: Member } | { signup: SignupClaims }> {
    if (token.startsWith('mt_')) {
      const row = await this.prisma.memberToken.findUnique({ where: { tokenHash: hashToken(token) }, include: { member: true } });
      if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now()) throw unauthorized('member_token_invalid', 'Please verify your phone again');
      if (row.member.status !== 'active') throw unauthorized('member_blocked', 'This card is not active');
      return { member: row.member };
    }
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: ISSUER, audience: SIGNUP_AUDIENCE });
      if (typeof payload.sub !== 'string' || typeof payload.bid !== 'string' || typeof payload.ph !== 'string') throw new Error('bad claims');
      return { signup: { merchantId: payload.sub, branchId: payload.bid, phone: payload.ph } };
    } catch {
      throw unauthorized('member_token_invalid', 'Please verify your phone again');
    }
  }
}

export interface ProfileInput {
  firstName: string;
  lastName?: string;
  email?: string;
  birthDate?: string;
  marketingOptIn?: boolean;
}

/**
 * Creates the membership for a verified phone. If the phone already joined (retry, two tabs),
 * returns the existing member untouched: stamps and points are never reset.
 * New members start with 0 stamps and 0 points; there is no welcome stamp.
 */
export async function enroll(prisma: PrismaClient, signup: SignupClaims, profile: ProfileInput) {
  const existing = await prisma.member.findUnique({ where: { merchantId_phone: { merchantId: signup.merchantId, phone: signup.phone } } });
  if (existing) return { member: existing, created: false };

  try {
    const member = await prisma.$transaction(async (tx) => {
      const tier = await ensureBaseTier(tx, signup.merchantId);
      const program = await tx.program.findUnique({ where: { merchantId: signup.merchantId } });
      const branch = await tx.branch.findFirst({ where: { id: signup.branchId, merchantId: signup.merchantId } });
      const now = new Date();
      const created = await tx.member.create({
        data: {
          merchantId: signup.merchantId,
          phone: signup.phone,
          firstName: profile.firstName.trim(),
          lastName: profile.lastName?.trim() || null,
          email: profile.email || null,
          birthDate: profile.birthDate ? new Date(profile.birthDate) : null,
          source: 'branch_qr',
          joinedBranchId: branch?.id ?? null,
          tierId: tier.id,
          consentVersion: program?.termsVersion ?? 1,
          consentAt: now,
          marketingOptIn: profile.marketingOptIn ?? false,
        },
      });
      await tx.event.create({
        data: {
          merchantId: signup.merchantId,
          type: 'member.enrolled',
          actorType: 'member',
          actorId: created.id,
          subjectId: created.id,
          payload: { branchId: created.joinedBranchId, source: 'branch_qr', tierId: tier.id },
        },
      });
      return created;
    });
    return { member, created: true };
  } catch (err) {
    // Two requests raced on the same phone: the other one won, use its member.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const member = await prisma.member.findUniqueOrThrow({ where: { merchantId_phone: { merchantId: signup.merchantId, phone: signup.phone } } });
      return { member, created: false };
    }
    throw err;
  }
}

const money = (d: Prisma.Decimal | number) => Number(d).toFixed(2);

function windowEnd(start: Date, window: 'monthly' | 'quarterly' | 'lifetime') {
  if (window === 'lifetime') return null;
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + (window === 'monthly' ? 1 : 3));
  return end.toISOString();
}

export function displayMerchantName(name: string) {
  // Odoo names sometimes carry trailing dashes/spaces ("Al Falah Optics-").
  return name.replace(/[\s\-–—_.]+$/u, '') || name;
}

/** The member's card, built only from stored data. */
export async function memberCard(prisma: PrismaClient, memberId: string) {
  const member = await prisma.member.findUniqueOrThrow({
    where: { id: memberId },
    include: { tier: true, merchant: { include: { program: true, cardDesign: true } } },
  });
  const { merchant, tier } = member;
  const design = merchant.cardDesign;
  const [higher, assets] = await Promise.all([
    prisma.tier.findFirst({ where: { merchantId: merchant.id, deletedAt: null, rank: { gt: tier.rank } }, orderBy: { rank: 'asc' } }),
    prisma.asset.findMany({
      where: { merchantId: merchant.id, id: { in: [design?.logoAssetId, design?.bannerAssetId].filter((x): x is string => !!x) } },
    }),
  ]);
  const assetUrl = (id?: string | null) => assets.find((a) => a.id === id)?.url ?? null;
  const stampsRequired = tier.punchEnabled ? tier.stampsRequired : 0;

  return {
    merchantName: displayMerchantName(merchant.name),
    firstName: member.firstName,
    pointsName: merchant.program?.pointsNameEn ?? 'Points',
    points: member.points,
    stamps: member.stamps,
    stampsRequired,
    punchEnabled: tier.punchEnabled,
    rewardAvailable: tier.punchEnabled && member.stamps >= tier.stampsRequired,
    rewardDescEn: tier.rewardDescEn,
    rewardDescAr: tier.rewardDescAr,
    rewardMaxValue: tier.rewardMaxValue ? money(tier.rewardMaxValue) : null,
    tier: { nameEn: tier.nameEn, nameAr: tier.nameAr, color: tier.color, discountPercent: Number(tier.discountPercent) },
    nextTier: higher
      ? {
          nameEn: higher.nameEn,
          nameAr: higher.nameAr,
          spendRemaining: money(Math.max(0, Number(higher.spendThreshold) - Number(member.windowSpend))),
        }
      : null,
    windowEndsAt: windowEnd(member.windowStartedAt, merchant.program?.tierWindow ?? 'monthly'),
    joinedAt: member.joinedAt.toISOString(),
    design: {
      logoUrl: assetUrl(design?.logoAssetId),
      bannerUrl: assetUrl(design?.bannerAssetId),
      backgroundColor: design?.backgroundColor && design.backgroundColor !== '#FFFFFF' ? design.backgroundColor : '#8A1538',
    },
  };
}
