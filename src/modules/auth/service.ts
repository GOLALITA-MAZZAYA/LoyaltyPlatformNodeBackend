import { randomUUID } from 'node:crypto';
import { Prisma, type Merchant, type PrismaClient, type Staff } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type { OdooClient } from '../../integrations/odoo.js';
import { AppError, unauthorized } from '../../lib/errors.js';
import { hashToken, newOpaqueToken, type TokenService } from '../../lib/tokens.js';
import { publicCode, slugify } from '../../lib/codes.js';
import { syncBranches } from '../merchant/branches.js';

export interface AuthDeps {
  prisma: PrismaClient;
  odoo: OdooClient;
  tokens: TokenService;
  refreshTtlDays: number;
  log: FastifyBaseLogger;
}

export function merchantView(merchant: Merchant, staff: Staff) {
  return {
    id: merchant.id,
    odooMerchantId: merchant.odooPartnerId,
    name: merchant.name,
    role: staff.role,
    loyaltyEnabled: merchant.loyaltyEnabled,
    merchantCode: merchant.merchantCode,
  };
}

export class AuthService {
  constructor(private readonly d: AuthDeps) {}

  /**
   * Verifies the Odoo token with Odoo, then returns loyalty tokens.
   * Succeeds even when loyalty is not enabled, so the app can read `loyaltyEnabled`;
   * loyalty endpoints themselves return 403 `loyalty_not_enabled`.
   */
  async exchange(odooToken: string) {
    const vendor = await this.d.odoo.getVendorByToken(odooToken);
    if (!vendor) throw unauthorized('odoo_token_invalid', 'Golalita session is not valid');
    this.d.log.info(
      {
        odooFields: vendor.fields,
        odooUserId: vendor.odooUserId,
        partnerId: vendor.partnerId,
        role: vendor.isMainMember ? 'owner' : 'cashier',
        hasMainMemberField: vendor.fields.includes('main_member'),
      },
      'odoo login mapped',
    );
    if (!vendor.partnerId) {
      throw new AppError(403, 'not_a_merchant', 'This Golalita account is not linked to a merchant', {
        messageAr: 'هذا الحساب غير مرتبط بتاجر',
      });
    }

    const merchant = await this.upsertMerchant(vendor.partnerId, vendor.name);

    const existingStaff = await this.d.prisma.staff.findUnique({ where: { odooUserId: vendor.odooUserId } });
    if (existingStaff && existingStaff.merchantId !== merchant.id) {
      throw new AppError(409, 'staff_merchant_mismatch', 'This user is registered to a different merchant');
    }
    if (existingStaff && !existingStaff.active) throw new AppError(403, 'staff_disabled', 'This user has been disabled');

    const staff = await this.d.prisma.staff.upsert({
      where: { odooUserId: vendor.odooUserId },
      create: {
        merchantId: merchant.id,
        odooUserId: vendor.odooUserId,
        name: vendor.name,
        role: vendor.isMainMember ? 'owner' : 'cashier',
      },
      update: { name: vendor.name, role: vendor.isMainMember ? 'owner' : 'cashier', lastSeenAt: new Date() },
    });

    // First login: pull branches so QR codes are ready. A failure here must not block login.
    const branchCount = await this.d.prisma.branch.count({ where: { merchantId: merchant.id } });
    if (branchCount === 0) {
      await syncBranches(this.d.prisma, this.d.odoo, merchant.id, vendor.partnerId, odooToken).catch((err) =>
        this.d.log.warn({ err, merchantId: merchant.id }, 'initial branch sync failed'),
      );
    }

    const pair = await this.issuePair(staff, randomUUID());
    return { ...pair, merchant: merchantView(merchant, staff) };
  }

  /** Single-use refresh. Presenting an already-used token revokes the whole login (likely theft). */
  async refresh(refreshToken: string) {
    const row = await this.d.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
      include: { staff: { include: { merchant: true } } },
    });
    if (!row) throw unauthorized('refresh_invalid', 'Refresh token is not valid');

    if (row.usedAt || row.revokedAt) {
      await this.revokeFamily(row.familyId);
      throw unauthorized('refresh_reused', 'Refresh token was already used; please sign in again');
    }
    if (row.expiresAt < new Date()) throw unauthorized('refresh_expired', 'Refresh token expired');
    if (!row.staff.active) throw new AppError(403, 'staff_disabled', 'This user has been disabled');

    // Mark used only if nobody else did in the meantime (two parallel refreshes).
    const claimed = await this.d.prisma.refreshToken.updateMany({
      where: { id: row.id, usedAt: null, revokedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count === 0) {
      await this.revokeFamily(row.familyId);
      throw unauthorized('refresh_reused', 'Refresh token was already used; please sign in again');
    }

    const pair = await this.issuePair(row.staff, row.familyId);
    return { ...pair, merchant: merchantView(row.staff.merchant, row.staff) };
  }

  async logout(familyId: string) {
    await this.revokeFamily(familyId);
  }

  private async revokeFamily(familyId: string) {
    await this.d.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issuePair(staff: Staff, familyId: string) {
    const refreshToken = newOpaqueToken('rt');
    await this.d.prisma.refreshToken.create({
      data: {
        staffId: staff.id,
        familyId,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + this.d.refreshTtlDays * 86_400_000),
      },
    });
    const accessToken = await this.d.tokens.signAccess({
      sub: staff.id,
      mid: staff.merchantId,
      role: staff.role,
      fid: familyId,
    });
    return { accessToken, accessTokenExpiresIn: this.d.tokens.accessTokenTtl, refreshToken };
  }

  private async upsertMerchant(partnerId: number, name: string) {
    const existing = await this.d.prisma.merchant.findUnique({ where: { odooPartnerId: partnerId } });
    if (existing) return existing;

    const base = slugify(name) || 'merchant';
    for (let attempt = 0; attempt < 5; attempt++) {
      const merchantCode = attempt === 0 ? base : `${base}-${publicCode(3)}`;
      try {
        return await this.d.prisma.merchant.create({ data: { odooPartnerId: partnerId, name, merchantCode } });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
        // Another request may have created this merchant concurrently.
        const raced = await this.d.prisma.merchant.findUnique({ where: { odooPartnerId: partnerId } });
        if (raced) return raced;
      }
    }
    throw new Error('Could not allocate a unique merchant code');
  }
}
