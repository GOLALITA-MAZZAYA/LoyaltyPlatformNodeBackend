import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { buildTestApp, FakeOdoo, prisma, resetDb } from './helpers.js';
import { maskPhone, normaliseInvoice } from '../src/modules/counter/routes.js';
import { findLedgerMismatches } from '../src/lib/ledger.js';
import { runCleanup } from '../src/jobs/cleanup.js';

let app: FastifyInstance;
let odoo: FakeOdoo;
const fields = ['id', 'main_member', 'name', 'tracking_partner_id'];

beforeEach(async () => {
  await resetDb();
  await app?.close();
  ({ app, odoo } = await buildTestApp());
  odoo.vendors.set('owner-a', { odooUserId: 1, partnerId: 100, name: 'Cup & Go', isMainMember: true, fields });
  odoo.branches.set(100, [
    { odooBranchId: 11, name: 'Lusail', nameAr: null },
    { odooBranchId: 12, name: 'Pearl', nameAr: null },
  ]);
  odoo.vendors.set('cashier-a', { odooUserId: 2, partnerId: 100, name: 'Cashier', isMainMember: false, fields });
  odoo.vendors.set('owner-b', { odooUserId: 3, partnerId: 200, name: 'Other Shop', isMainMember: true, fields });
  odoo.branches.set(200, [{ odooBranchId: 21, name: 'Wakra', nameAr: null }]);
});

async function staffLogin(odooToken: string) {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/exchange', payload: { odooToken } });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  await prisma.merchant.update({ where: { id: body.merchant.id }, data: { loyaltyEnabled: true } });
  return { authorization: `Bearer ${body.accessToken}` };
}

// Spec "Reconciliation": balances must equal the ledger after every scenario.
afterEach(async () => {
  expect(await findLedgerMismatches(prisma)).toEqual([]);
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

type Ctx = Awaited<ReturnType<typeof setup>>;

async function setup(opts: { stamps?: number; programStatus?: 'active' | 'draft' | 'paused' } = {}) {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/exchange', payload: { odooToken: 'owner-a' } });
  const body = res.json();
  const merchantId = body.merchant.id as string;
  await prisma.merchant.update({ where: { id: merchantId }, data: { loyaltyEnabled: true } });
  await prisma.program.upsert({
    where: { merchantId },
    create: { merchantId, status: opts.programStatus ?? 'active' },
    update: { status: opts.programStatus ?? 'active' },
  });
  const branches = await prisma.branch.findMany({ where: { merchantId }, orderBy: { name: 'asc' } });
  const tier = await prisma.tier.create({
    data: {
      merchantId, rank: 0, isBase: true, nameEn: 'Member', nameAr: 'عضو', color: '#8A1538',
      spendThreshold: 0, discountPercent: 0, punchEnabled: true, stampsRequired: 10,
    },
  });
  const member = await prisma.member.create({
    data: {
      merchantId, phone: '+97455001122', firstName: 'Abishek', tierId: tier.id,
      stamps: opts.stamps ?? 0, consentVersion: 1, consentAt: new Date(),
    },
  });
  if (opts.stamps) {
    // Starting stamps come from a ledger row so balances still reconcile.
    await prisma.transaction.create({
      data: {
        merchantId, memberId: member.id, branchId: branches[0]!.id, staffId: 'seed',
        type: 'adjust', stampsDelta: opts.stamps, reason: 'test seed',
      },
    });
  }
  return {
    headers: { authorization: `Bearer ${body.accessToken}` },
    merchantId,
    lusail: branches.find((b) => b.name === 'Lusail')!.id,
    pearl: branches.find((b) => b.name === 'Pearl')!.id,
    member,
  };
}

/** What the customer's web card would show. */
async function passCode(ctx: Ctx, expiresInMs = 90_000) {
  const code = 'glp1.' + crypto.randomBytes(32).toString('base64url');
  await prisma.passCode.create({
    data: {
      codeHash: crypto.createHash('sha256').update(code).digest('hex'),
      merchantId: ctx.merchantId,
      memberId: ctx.member.id,
      expiresAt: new Date(Date.now() + expiresInMs),
    },
  });
  return code;
}

const lookup = (ctx: Ctx, code: string, branchId = ctx.lusail) =>
  app.inject({ method: 'POST', url: '/v1/scan/lookup', headers: ctx.headers, payload: { code, branchId } });

async function scan(ctx: Ctx, branchId = ctx.lusail) {
  const res = await lookup(ctx, await passCode(ctx), branchId);
  expect(res.statusCode).toBe(200);
  return res.json().lookupToken as string;
}

const award = (ctx: Ctx, payload: Record<string, unknown>, key: string | null = crypto.randomUUID()) =>
  app.inject({
    method: 'POST',
    url: '/v1/transactions',
    headers: key ? { ...ctx.headers, 'idempotency-key': key } : ctx.headers,
    payload: { branchId: ctx.lusail, billAmount: '42.00', stampItems: 1, invoiceRef: `R-${crypto.randomUUID().slice(0, 8)}`, ...payload },
  });

const stamps = async (ctx: Ctx) => (await prisma.member.findUniqueOrThrow({ where: { id: ctx.member.id } })).stamps;

describe('POST /scan/lookup', () => {
  it('previews the member without changing anything', async () => {
    const ctx = await setup({ stamps: 3 });
    const res = await lookup(ctx, await passCode(ctx));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.member.displayName).toBe('Abishek');
    expect(body.stamps).toBe(3);
    expect(body.stampsRequired).toBe(10);
    expect(body.lookupToken).toMatch(/^lk_/);
    expect(await prisma.passCode.count({ where: { usedAt: { not: null } } })).toBe(0);
    expect(await stamps(ctx)).toBe(3);
  });

  it('includes the reward description and optional max value for the cashier', async () => {
    const ctx = await setup({ stamps: 9 });
    expect((await lookup(ctx, await passCode(ctx))).json()).toMatchObject({ rewardDescriptionEn: null, rewardMaxValue: null });
    await prisma.tier.updateMany({ where: { id: ctx.member.tierId }, data: { rewardDescEn: 'Free item', rewardMaxValue: '300' } });
    const body = (await lookup(ctx, await passCode(ctx))).json();
    expect(body).toMatchObject({ rewardDescriptionEn: 'Free item', rewardMaxValue: '300.00' });
  });

  it('rejects unknown, expired and wrong-format codes', async () => {
    const ctx = await setup();
    expect((await lookup(ctx, 'glp1.made-up')).json().code).toBe('code_not_found');
    expect((await lookup(ctx, 'https://example.com')).json().code).toBe('code_not_found');
    expect((await lookup(ctx, await passCode(ctx, -1000))).json().code).toBe('code_expired');
  });

  it('needs an active program', async () => {
    const ctx = await setup({ programStatus: 'paused' });
    const res = await lookup(ctx, await passCode(ctx));
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('program_not_active');
  });
});

describe('POST /transactions', () => {
  it('awards stamps once and records the ledger row', async () => {
    const ctx = await setup();
    const res = await award(ctx, { lookupToken: await scan(ctx), stampItems: 2, invoiceRef: 'INV-1001', billAmount: '50.00' });
    expect(res.statusCode).toBe(201);
    expect(res.json().member.stamps).toBe(2);
    expect(res.json().transaction).toMatchObject({ type: 'earn', stampsDelta: 2, invoiceRef: 'INV-1001', billAmount: '50.00' });
    expect(await stamps(ctx)).toBe(2);
    const row = await prisma.transaction.findFirstOrThrow();
    expect(row.passCodeId).not.toBeNull();
    expect(row.lookupTokenId).not.toBeNull();
  });

  describe('required fields', () => {
    it('needs an Idempotency-Key UUID', async () => {
      const ctx = await setup();
      const token = await scan(ctx);
      expect((await award(ctx, { lookupToken: token }, null)).statusCode).toBe(422);
      expect((await award(ctx, { lookupToken: token }, 'not-a-uuid')).statusCode).toBe(422);
      expect(await prisma.transaction.count()).toBe(0);
    });

    it('needs billAmount and stampItems, never defaulting them', async () => {
      const ctx = await setup();
      const token = await scan(ctx);
      const base = { lookupToken: token, branchId: ctx.lusail, invoiceRef: 'A1' };
      for (const payload of [
        { ...base, stampItems: 1 },
        { ...base, billAmount: '10.00' },
        { ...base, stampItems: 1, billAmount: '-1' },
        { ...base, stampItems: 1, billAmount: '1.234' },
      ]) {
        const res = await app.inject({
          method: 'POST', url: '/v1/transactions', payload,
          headers: { ...ctx.headers, 'idempotency-key': crypto.randomUUID() },
        });
        expect(res.statusCode).toBe(422);
      }
      expect(await prisma.transaction.count()).toBe(0);
    });

    it('rejects stamps over the cap, 0 stamps without redeem, and a missing receipt', async () => {
      const ctx = await setup();
      const token = await scan(ctx);
      expect((await award(ctx, { lookupToken: token, stampItems: 6 })).json().code).toBe('stamps_over_limit');
      expect((await award(ctx, { lookupToken: token, stampItems: 0 })).json().code).toBe('nothing_to_record');
      expect((await award(ctx, { lookupToken: token, invoiceRef: null })).json().code).toBe('invoice_required');
      expect((await award(ctx, { lookupToken: token, invoiceRef: '   ' })).json().code).toBe('invoice_required');
      expect((await award(ctx, { lookupToken: token, invoiceRef: 'X'.repeat(41) })).json().code).toBe('invoice_invalid');
      // Nothing was used up by the rejected attempts.
      expect((await award(ctx, { lookupToken: token })).statusCode).toBe(201);
    });
  });

  describe('idempotency', () => {
    it('replays the stored result for a retry with the same key and body', async () => {
      const ctx = await setup();
      const payload = { lookupToken: await scan(ctx), invoiceRef: 'A1' };
      const key = crypto.randomUUID();
      const first = await award(ctx, payload, key);
      const retry = await award(ctx, payload, key);
      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual(first.json());
      expect(await prisma.transaction.count()).toBe(1);
      expect(await stamps(ctx)).toBe(1);
    });

    it('rejects the same key with a different body', async () => {
      const ctx = await setup();
      const key = crypto.randomUUID();
      const token = await scan(ctx);
      await award(ctx, { lookupToken: token, invoiceRef: 'A1' }, key);
      const res = await award(ctx, { lookupToken: token, invoiceRef: 'A1', stampItems: 2 }, key);
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('idempotency_mismatch');
      expect(await stamps(ctx)).toBe(1);
    });

    it('applies parallel retries of one bill once', async () => {
      const ctx = await setup();
      const payload = { lookupToken: await scan(ctx), invoiceRef: 'A1' };
      const key = crypto.randomUUID();
      const results = await Promise.all([1, 2, 3].map(() => award(ctx, payload, key)));
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 201]);
      expect(await prisma.transaction.count()).toBe(1);
      expect(await stamps(ctx)).toBe(1);
    });

    it('stores nothing for a failed attempt, so the retry is evaluated again', async () => {
      const ctx = await setup({ stamps: 2 });
      const token = await scan(ctx);
      const key = crypto.randomUUID();
      const payload = { lookupToken: token, redeemStampReward: true, stampItems: 0, invoiceRef: null };
      expect((await award(ctx, payload, key)).json().code).toBe('reward_not_eligible');
      expect(await prisma.idempotencyKey.count()).toBe(0);
      expect(await prisma.lookupToken.count({ where: { usedAt: { not: null } } })).toBe(0);
      expect(await prisma.passCode.count({ where: { usedAt: { not: null } } })).toBe(0);
      expect(await stamps(ctx)).toBe(2);
    });
  });

  describe('one customer QR, one award', () => {
    it('refuses a second award from the same QR', async () => {
      const ctx = await setup();
      const code = await passCode(ctx);
      const first = (await lookup(ctx, code)).json().lookupToken;
      const second = (await lookup(ctx, code)).json().lookupToken; // preview twice is fine
      expect((await award(ctx, { lookupToken: first })).statusCode).toBe(201);
      const res = await award(ctx, { lookupToken: second });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('code_used');
      expect((await lookup(ctx, code)).json().code).toBe('code_used');
      expect(await stamps(ctx)).toBe(1);
    });

    it('lets only one of two tills award the same QR at once', async () => {
      const ctx = await setup();
      const code = await passCode(ctx);
      const a = (await lookup(ctx, code)).json().lookupToken;
      const b = (await lookup(ctx, code)).json().lookupToken;
      const results = await Promise.all([award(ctx, { lookupToken: a }), award(ctx, { lookupToken: b })]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.statusCode === 409)!.json().code).toBe('code_used');
      expect(await prisma.transaction.count()).toBe(1);
      expect(await stamps(ctx)).toBe(1);
    });

    it('refuses a reused, expired or other-branch lookup token', async () => {
      const ctx = await setup();
      const token = await scan(ctx);
      expect((await award(ctx, { lookupToken: token, branchId: ctx.pearl })).json().code).toBe('lookup_branch_mismatch');
      expect((await award(ctx, { lookupToken: token })).statusCode).toBe(201);
      expect((await award(ctx, { lookupToken: token })).json().code).toBe('lookup_used');

      const old = await scan(ctx);
      await prisma.lookupToken.updateMany({ where: { usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await award(ctx, { lookupToken: old })).json().code).toBe('lookup_expired');
      expect((await award(ctx, { lookupToken: 'lk_made_up' })).json().code).toBe('lookup_expired');
    });

    it('keeps every stamp when two awards for one member run at once', async () => {
      const ctx = await setup();
      const tokens = await Promise.all([1, 2, 3, 4].map(() => scan(ctx)));
      const results = await Promise.all(tokens.map((t) => award(ctx, { lookupToken: t, stampItems: 1 })));
      expect(results.every((r) => r.statusCode === 201)).toBe(true);
      expect(await stamps(ctx)).toBe(4);
    });
  });

  describe('receipts', () => {
    it('normalises receipt numbers before checking duplicates', async () => {
      expect(normaliseInvoice(' pos-000 123 ')).toBe('POS-000123');
      expect(normaliseInvoice('pos-٠٠٠١٢٣')).toBe('POS-000123');
      expect(normaliseInvoice('pos-۰۰۰۱۲۳')).toBe('POS-000123');

      const ctx = await setup();
      expect((await award(ctx, { lookupToken: await scan(ctx), invoiceRef: ' pos-000 123 ' })).json().transaction.invoiceRef).toBe('POS-000123');
      const dup = await award(ctx, { lookupToken: await scan(ctx), invoiceRef: 'POS-٠٠٠١٢٣' });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().code).toBe('duplicate_invoice');
      expect(await stamps(ctx)).toBe(1);
    });

    it('scopes receipt numbers per branch', async () => {
      const ctx = await setup();
      expect((await award(ctx, { lookupToken: await scan(ctx), invoiceRef: '000123' })).statusCode).toBe(201);
      const other = await award(ctx, { lookupToken: await scan(ctx, ctx.pearl), branchId: ctx.pearl, invoiceRef: '000123' });
      expect(other.statusCode).toBe(201);
    });

    it('lets only one of two parallel bills claim a receipt', async () => {
      const ctx = await setup();
      const [a, b] = [await scan(ctx), await scan(ctx)];
      const results = await Promise.all([award(ctx, { lookupToken: a, invoiceRef: 'R9' }), award(ctx, { lookupToken: b, invoiceRef: 'R9' })]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      expect(await stamps(ctx)).toBe(1);
      // The losing bill released its QR and lookup, so the cashier can correct the receipt and retry.
      const loser = results.find((r) => r.statusCode === 409)!;
      expect(loser.json().code).toBe('duplicate_invoice');
    });
  });

  describe('redemption', () => {
    it('redeems without new stamps when the customer already has enough', async () => {
      const ctx = await setup({ stamps: 12 });
      const res = await award(ctx, { lookupToken: await scan(ctx), stampItems: 0, redeemStampReward: true, invoiceRef: null });
      expect(res.statusCode).toBe(201);
      expect(res.json().transaction).toMatchObject({ type: 'redeem', stampsDelta: -10, rewardRedeemed: true });
      expect(res.json().member).toMatchObject({ stamps: 2, rewardsRedeemed: 1 });
    });

    it('earns first, then redeems on the same bill', async () => {
      const ctx = await setup({ stamps: 8 });
      const res = await award(ctx, { lookupToken: await scan(ctx), stampItems: 3, redeemStampReward: true });
      expect(res.json().transaction).toMatchObject({ type: 'earn_and_redeem', stampsDelta: -7 });
      expect(res.json().member.stamps).toBe(1);
    });

    it('refuses redemption without enough stamps', async () => {
      const ctx = await setup({ stamps: 8 });
      const res = await award(ctx, { lookupToken: await scan(ctx), stampItems: 1, redeemStampReward: true });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('reward_not_eligible');
      expect(await stamps(ctx)).toBe(8);
    });
  });

  it('refuses blocked members and inactive programs at award time', async () => {
    const ctx = await setup();
    const token = await scan(ctx);
    await prisma.member.update({ where: { id: ctx.member.id }, data: { status: 'blocked' } });
    expect((await award(ctx, { lookupToken: token })).json().code).toBe('member_blocked');

    await prisma.member.update({ where: { id: ctx.member.id }, data: { status: 'active' } });
    await prisma.program.update({ where: { merchantId: ctx.merchantId }, data: { status: 'paused' } });
    expect((await award(ctx, { lookupToken: token })).json().code).toBe('program_not_active');
    expect(await prisma.transaction.count()).toBe(0);
  });
});

it('masks phone numbers for cashiers', () => {
  expect(maskPhone('+97455123456')).toBe('+974 •••• 3456');
});

describe('roles', () => {
  it('lets a cashier scan and award, with the phone masked in the preview and history', async () => {
    const ctx = await setup();
    const cashier = { ...ctx, headers: await staffLogin('cashier-a') };
    const preview = await lookup(cashier, await passCode(ctx));
    expect(preview.statusCode).toBe(200);
    expect(preview.json().member.phoneMasked).toBe('+974 •••• 1122');

    const res = await award(cashier, { lookupToken: preview.json().lookupToken });
    expect(res.statusCode).toBe(201);
    const row = await prisma.transaction.findFirstOrThrow();
    expect(row.staffId).toBe((await prisma.lookupToken.findFirstOrThrow()).staffId);

    const history = await app.inject({ method: 'GET', url: '/v1/transactions', headers: cashier.headers });
    expect(history.json().items[0].member.phoneMasked).toBe('+974 •••• 1122');
    const ownerHistory = await app.inject({ method: 'GET', url: '/v1/transactions', headers: ctx.headers });
    expect(ownerHistory.json().items[0].member.phoneMasked).toBe('+97455001122');
  });

  it("refuses one staff member's scan when another submits it", async () => {
    const ctx = await setup();
    const cashier = { ...ctx, headers: await staffLogin('cashier-a') };
    const token = (await lookup(cashier, await passCode(ctx))).json().lookupToken;
    const res = await award(ctx, { lookupToken: token });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('lookup_staff_mismatch');
    expect((await award(cashier, { lookupToken: token })).statusCode).toBe(201);
  });

  it("keeps another merchant away from this merchant's codes, scans and branches", async () => {
    const ctx = await setup();
    const other = await staffLogin('owner-b');
    await prisma.program.create({ data: { merchantId: (await prisma.merchant.findFirstOrThrow({ where: { id: { not: ctx.merchantId } } })).id, status: 'active' } });
    const otherBranch = await prisma.branch.findFirstOrThrow({ where: { merchantId: { not: ctx.merchantId } } });

    const code = await passCode(ctx);
    const theirs = await app.inject({ method: 'POST', url: '/v1/scan/lookup', headers: other, payload: { code, branchId: otherBranch.id } });
    expect(theirs.json().code).toBe('wrong_merchant');
    const ourBranch = await app.inject({ method: 'POST', url: '/v1/scan/lookup', headers: other, payload: { code, branchId: ctx.lusail } });
    expect(ourBranch.json().code).toBe('branch_invalid');

    const token = await scan(ctx);
    const res = await app.inject({
      method: 'POST', url: '/v1/transactions',
      headers: { ...other, 'idempotency-key': crypto.randomUUID() },
      payload: { lookupToken: token, branchId: ctx.lusail, billAmount: '1.00', stampItems: 1, invoiceRef: 'X1' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('lookup_expired');
    expect((await app.inject({ method: 'GET', url: '/v1/transactions', headers: other })).json().items).toHaveLength(0);
    expect(await stamps(ctx)).toBe(0);
  });

  it("refuses a customer's card token on merchant endpoints", async () => {
    const ctx = await setup();
    const branch = await prisma.branch.findUniqueOrThrow({ where: { id: ctx.lusail } });
    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { id: ctx.merchantId } });
    const sent = await app.inject({
      method: 'POST', url: '/v1/public/otp/send',
      payload: { merchantCode: merchant.merchantCode, branchCode: branch.branchCode, phone: '+97455777666' },
    });
    const verified = await app.inject({
      method: 'POST', url: '/v1/public/otp/verify',
      payload: { otpRequestId: sent.json().otpRequestId, code: sent.json().devCode },
    });
    const card = await app.inject({
      method: 'PUT', url: '/v1/public/me',
      headers: { authorization: `Bearer ${verified.json().memberToken}` },
      payload: { firstName: 'Sara', consentAccepted: true },
    });
    const customer = { authorization: `Bearer ${card.json().memberToken}` };
    expect(card.json().memberToken).toMatch(/^mt_/);

    const token = await scan(ctx);
    for (const req of [
      { method: 'POST' as const, url: '/v1/scan/lookup', payload: { code: await passCode(ctx), branchId: ctx.lusail } },
      { method: 'POST' as const, url: '/v1/transactions', payload: { lookupToken: token, branchId: ctx.lusail, billAmount: '1.00', stampItems: 1, invoiceRef: 'X1' } },
      { method: 'GET' as const, url: '/v1/transactions' },
    ]) {
      const res = await app.inject({ ...req, headers: { ...customer, 'idempotency-key': crypto.randomUUID() } });
      expect(res.statusCode).toBe(401);
    }
    expect(await prisma.transaction.count()).toBe(0);
  });
});

describe('POST /transactions/:id/void', () => {
  const voidTx = (ctx: Ctx, id: string, reason: unknown = 'Wrong customer', headers = ctx.headers) =>
    app.inject({ method: 'POST', url: `/v1/transactions/${id}/void`, headers, payload: { reason } });

  async function earned(ctx: Ctx, payload: Record<string, unknown> = {}) {
    const res = await award(ctx, { lookupToken: await scan(ctx), ...payload });
    expect(res.statusCode).toBe(201);
    return res.json().transaction.id as string;
  }

  it('reverses an award with a reason, logs it, and releases the receipt for a corrected entry', async () => {
    const ctx = await setup();
    const id = await earned(ctx, { stampItems: 3, invoiceRef: 'POS-77', billAmount: '30.00' });
    const res = await voidTx(ctx, id);
    expect(res.statusCode).toBe(200);
    expect(res.json().transaction).toMatchObject({ type: 'void', stampsDelta: -3, voidsTransactionId: id, reason: 'Wrong customer', billAmount: '-30.00' });
    expect(res.json().member.stamps).toBe(0);
    expect(await prisma.invoiceClaim.count()).toBe(0);
    const event = await prisma.event.findFirstOrThrow({ where: { type: 'transaction.voided' } });
    expect(event.payload).toMatchObject({ voidsTransactionId: id, reason: 'Wrong customer' });

    // The corrected entry reuses the receipt.
    expect((await award(ctx, { lookupToken: await scan(ctx), invoiceRef: 'pos-77' })).statusCode).toBe(201);
  });

  it('restores stamps and the reward counter when a redemption is reversed', async () => {
    const ctx = await setup({ stamps: 10 });
    const id = await earned(ctx, { stampItems: 0, redeemStampReward: true, invoiceRef: null });
    expect(await stamps(ctx)).toBe(0);
    const res = await voidTx(ctx, id);
    expect(res.json().transaction).toMatchObject({ stampsDelta: 10, rewardRedeemed: true });
    expect(res.json().member).toMatchObject({ stamps: 10, rewardsRedeemed: 0 });
  });

  it('is owner only and needs a 3–200 character reason', async () => {
    const ctx = await setup();
    const id = await earned(ctx);
    const cashier = await staffLogin('cashier-a');
    const asCashier = await voidTx(ctx, id, 'Wrong customer', cashier);
    expect(asCashier.statusCode).toBe(403);
    expect(asCashier.json().code).toBe('forbidden_role');
    const missing = await app.inject({ method: 'POST', url: `/v1/transactions/${id}/void`, headers: ctx.headers, payload: {} });
    expect(missing.statusCode).toBe(422);
    for (const reason of ['', '  a ', 'x'.repeat(201)]) expect((await voidTx(ctx, id, reason)).statusCode).toBe(422);
    expect(await prisma.transaction.count({ where: { type: 'void' } })).toBe(0);
  });

  it('refuses a second void, even in parallel, and a void of a void', async () => {
    const ctx = await setup();
    const id = await earned(ctx, { stampItems: 2 });
    const results = await Promise.all([voidTx(ctx, id), voidTx(ctx, id), voidTx(ctx, id)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    expect(results.filter((r) => r.statusCode === 409).every((r) => r.json().code === 'already_voided')).toBe(true);
    expect(await stamps(ctx)).toBe(0);

    const reversalId = results.find((r) => r.statusCode === 200)!.json().transaction.id;
    expect((await voidTx(ctx, reversalId)).json().code).toBe('cannot_void_reversal');
  });

  it('refuses a void that would make stamps negative', async () => {
    const ctx = await setup({ stamps: 8 });
    const earn = await earned(ctx, { stampItems: 2 }); // 10
    await earned(ctx, { stampItems: 0, redeemStampReward: true, invoiceRef: null }); // 0
    const res = await voidTx(ctx, earn);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('void_would_go_negative');
    expect(await stamps(ctx)).toBe(0);
  });

  it("is 404 for another merchant's or an unknown transaction", async () => {
    const ctx = await setup();
    const id = await earned(ctx);
    const other = await staffLogin('owner-b');
    expect((await voidTx(ctx, id, 'Wrong customer', other)).statusCode).toBe(404);
    expect((await voidTx(ctx, 'nope')).statusCode).toBe(404);
  });
});

describe('audit and database safeguards', () => {
  it('writes a transaction.created event without codes, tokens or phone numbers', async () => {
    const ctx = await setup();
    const code = await passCode(ctx);
    const token = (await lookup(ctx, code)).json().lookupToken;
    await award(ctx, { lookupToken: token });
    const events = await prisma.event.findMany({ where: { type: 'transaction.created' } });
    expect(events).toHaveLength(1);
    const text = JSON.stringify(events[0]);
    for (const secret of [code, token, ctx.member.phone, '55001122']) expect(text).not.toContain(secret);
  });

  it('blocks editing or deleting ledger rows at the database', async () => {
    const ctx = await setup();
    await award(ctx, { lookupToken: await scan(ctx) });
    await expect(prisma.$executeRaw`UPDATE "Transaction" SET "stampsDelta" = 99`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM "Transaction"`).rejects.toThrow(/append-only/);
    expect(await prisma.transaction.count()).toBe(1);
  });

  it('rejects inconsistent ledger rows and negative balances at the database', async () => {
    const ctx = await setup();
    const base = { merchantId: ctx.merchantId, memberId: ctx.member.id, branchId: ctx.lusail, staffId: 's' };
    await expect(prisma.transaction.create({ data: { ...base, type: 'earn', stampsDelta: 0 } })).rejects.toThrow();
    await expect(prisma.transaction.create({ data: { ...base, type: 'earn', stampsDelta: 2, rewardRedeemed: true } })).rejects.toThrow();
    await expect(prisma.transaction.create({ data: { ...base, type: 'redeem', stampsDelta: -10, rewardRedeemed: false } })).rejects.toThrow();
    await expect(prisma.transaction.create({ data: { ...base, type: 'earn_and_redeem', stampsDelta: 1 } })).rejects.toThrow();
    await expect(prisma.transaction.create({ data: { ...base, type: 'void', stampsDelta: -1 } })).rejects.toThrow();
    await expect(prisma.member.update({ where: { id: ctx.member.id }, data: { stamps: -1 } })).rejects.toThrow();
    expect(await prisma.transaction.count()).toBe(0);
  });
});

describe('daily cleanup', () => {
  it('removes only unused codes expired over 24 h and idempotency keys over 24 h', async () => {
    const ctx = await setup();
    // Used code (referenced by the ledger) and its idempotency key.
    const key = crypto.randomUUID();
    await award(ctx, { lookupToken: await scan(ctx) }, key);
    const hourMs = 60 * 60 * 1000;
    await passCode(ctx, -25 * hourMs); // unused, expired 25 h ago → deleted
    await passCode(ctx, -23 * hourMs); // unused, expired 23 h ago → kept
    await prisma.passCode.updateMany({ where: { usedAt: { not: null } }, data: { expiresAt: new Date(Date.now() - 48 * hourMs) } });
    const oldKey = crypto.randomUUID();
    await prisma.idempotencyKey.create({
      data: { merchantId: ctx.merchantId, key: oldKey, requestHash: 'x', responseCode: 201, responseBody: {}, createdAt: new Date(Date.now() - 25 * hourMs) },
    });

    expect(await runCleanup(prisma)).toEqual({ passCodes: 1, idempotencyKeys: 1 });
    expect(await prisma.passCode.count()).toBe(2);
    expect(await prisma.passCode.count({ where: { usedAt: { not: null } } })).toBe(1);
    expect(await prisma.idempotencyKey.findMany({ select: { key: true } })).toEqual([{ key }]);
  });
});
