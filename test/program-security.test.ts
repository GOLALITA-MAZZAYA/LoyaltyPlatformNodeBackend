import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, FakeOdoo, prisma, resetDb } from './helpers.js';

// Attacks on Program & Tiers that must fail without changing anyone's data.

let app: FastifyInstance;
let odoo: FakeOdoo;
const fields = ['id', 'main_member', 'name', 'tracking_partner_id'];

beforeEach(async () => {
  await resetDb();
  await app?.close();
  ({ app, odoo } = await buildTestApp());
  odoo.vendors.set('owner-a', { odooUserId: 1, partnerId: 100, name: 'Cup & Go', isMainMember: true, fields });
  odoo.vendors.set('owner-b', { odooUserId: 3, partnerId: 200, name: 'Other Shop', isMainMember: true, fields });
  odoo.branches.set(100, [{ odooBranchId: 11, name: 'Lusail', nameAr: null }]);
  odoo.branches.set(200, [{ odooBranchId: 21, name: 'Pearl', nameAr: null }]);
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

async function login(odooToken: string) {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/exchange', payload: { odooToken } });
  const body = res.json();
  await prisma.merchant.update({ where: { id: body.merchant.id }, data: { loyaltyEnabled: true } });
  return { headers: { authorization: `Bearer ${body.accessToken}` }, merchantId: body.merchant.id as string };
}

const tierInput = (over: Record<string, unknown> = {}) => ({
  nameEn: 'Member',
  nameAr: 'عضو',
  color: '#8A1538',
  spendThreshold: '0.00',
  discountPercent: 0,
  isBase: true,
  punchRule: { enabled: true, stampsRequired: 10 },
  ...over,
});

const getTiers = async (headers: Record<string, string>) =>
  (await app.inject({ method: 'GET', url: '/v1/program/tiers', headers })).json().items as Array<{ id: string; nameEn: string }>;
const putTiers = (headers: Record<string, string>, payload: unknown) =>
  app.inject({ method: 'PUT', url: '/v1/program/tiers', headers, payload: payload as any });

/** Snapshot of every tier and member, to prove a rejected request changed nothing. */
const snapshot = async () => ({
  tiers: await prisma.tier.findMany({ orderBy: { id: 'asc' } }),
  members: await prisma.member.findMany({ orderBy: { id: 'asc' } }),
});

async function addMember(merchantId: string, tierId: string, phone: string) {
  return prisma.member.create({
    data: { merchantId, tierId, phone, firstName: 'M', consentVersion: 1, consentAt: new Date() },
  });
}

describe('tier tenant isolation', () => {
  it('rejects updating another merchant’s tier by id, and changes nothing', async () => {
    const a = await login('owner-a');
    const b = await login('owner-b');
    const [tierB] = await getTiers(b.headers);
    await getTiers(a.headers);
    const before = await snapshot();

    const res = await putTiers(a.headers, { items: [tierInput({ id: tierB!.id, nameEn: 'Hacked' })] });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('invalid_tiers');
    expect(await snapshot()).toEqual(before);
  });

  it('rejects moving members into another merchant’s tier, and changes nothing', async () => {
    const a = await login('owner-a');
    const b = await login('owner-b');
    const [baseA] = await getTiers(a.headers);
    const [tierB] = await getTiers(b.headers);

    // A adds Gold, puts a member in it, then removes Gold while pointing members at B's tier.
    const withGold = await putTiers(a.headers, {
      items: [tierInput({ id: baseA!.id }), tierInput({ nameEn: 'Gold', isBase: false, spendThreshold: '100.00' })],
    });
    const gold = withGold.json().items[1];
    await addMember(a.merchantId, gold.id, '+97455000001');
    const before = await snapshot();

    const res = await putTiers(a.headers, { items: [tierInput({ id: baseA!.id })], reassignToTierId: tierB!.id });
    expect(res.statusCode).toBe(422);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects moving members into a tier that is being removed', async () => {
    const a = await login('owner-a');
    const [baseA] = await getTiers(a.headers);
    const withGold = await putTiers(a.headers, {
      items: [tierInput({ id: baseA!.id }), tierInput({ nameEn: 'Gold', isBase: false, spendThreshold: '100.00' })],
    });
    const gold = withGold.json().items[1];
    await addMember(a.merchantId, gold.id, '+97455000001');
    const before = await snapshot();

    const res = await putTiers(a.headers, { items: [tierInput({ id: baseA!.id })], reassignToTierId: gold.id });
    expect(res.statusCode).toBe(422);
    expect(await snapshot()).toEqual(before);
  });

  it('still lets a merchant remove its own tier and move members to a kept tier', async () => {
    const a = await login('owner-a');
    const [baseA] = await getTiers(a.headers);
    const withGold = await putTiers(a.headers, {
      items: [tierInput({ id: baseA!.id }), tierInput({ nameEn: 'Gold', isBase: false, spendThreshold: '100.00' })],
    });
    const gold = withGold.json().items[1];
    const m = await addMember(a.merchantId, gold.id, '+97455000001');

    const missingTarget = await putTiers(a.headers, { items: [tierInput({ id: baseA!.id })] });
    expect(missingTarget.statusCode).toBe(409);

    const res = await putTiers(a.headers, { items: [tierInput({ id: baseA!.id })], reassignToTierId: baseA!.id });
    expect(res.statusCode).toBe(200);
    expect((await prisma.member.findUniqueOrThrow({ where: { id: m.id } })).tierId).toBe(baseA!.id);
  });

  it('rejects unknown, deleted and duplicate tier ids', async () => {
    const a = await login('owner-a');
    const [baseA] = await getTiers(a.headers);
    const withGold = await putTiers(a.headers, {
      items: [tierInput({ id: baseA!.id }), tierInput({ nameEn: 'Gold', isBase: false, spendThreshold: '100.00' })],
    });
    const gold = withGold.json().items[1];
    await putTiers(a.headers, { items: [tierInput({ id: baseA!.id })] }); // Gold now soft-deleted

    const cases = [
      { items: [tierInput({ id: 'does-not-exist' })] },
      { items: [tierInput({ id: baseA!.id }), tierInput({ id: gold.id, nameEn: 'Gold', isBase: false, spendThreshold: '100.00' })] },
      { items: [tierInput({ id: baseA!.id }), tierInput({ id: baseA!.id, nameEn: 'Dup', isBase: false, spendThreshold: '100.00' })] },
    ];
    for (const payload of cases) {
      const before = await snapshot();
      const res = await putTiers(a.headers, payload);
      expect(res.statusCode).toBe(422);
      expect(await snapshot()).toEqual(before);
    }
  });
});

describe('default program and tier', () => {
  it('creates exactly one program and base tier when the hub loads both at once', async () => {
    const a = await login('owner-a');
    const results = await Promise.all([
      app.inject({ method: 'GET', url: '/v1/program', headers: a.headers }),
      app.inject({ method: 'GET', url: '/v1/program/tiers', headers: a.headers }),
      app.inject({ method: 'GET', url: '/v1/program', headers: a.headers }),
      app.inject({ method: 'GET', url: '/v1/program/tiers', headers: a.headers }),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    expect(await prisma.program.count()).toBe(1);
    expect(await prisma.tier.count()).toBe(1);
  });

  it('gives the same default whether a customer or the merchant comes first', async () => {
    // Merchant opens settings first.
    const a = await login('owner-a');
    const fromSettings = (await getTiers(a.headers))[0];

    // Customer signs up first at another merchant (no settings opened yet).
    const b = await login('owner-b');
    const codes = await prisma.branch.findFirstOrThrow({ where: { merchantId: b.merchantId }, include: { merchant: true } });
    const sent = (
      await app.inject({
        method: 'POST',
        url: '/v1/public/otp/send',
        payload: { merchantCode: codes.merchant.merchantCode, branchCode: codes.branchCode, phone: '+97455000002' },
      })
    ).json();
    const verified = (await app.inject({ method: 'POST', url: '/v1/public/otp/verify', payload: { otpRequestId: sent.otpRequestId, code: sent.devCode } })).json();
    const card = (
      await app.inject({
        method: 'PUT',
        url: '/v1/public/me',
        headers: { authorization: `Bearer ${verified.memberToken}` },
        payload: { firstName: 'Sara', consentAccepted: true },
      })
    ).json();
    const fromSignup = (await getTiers(b.headers))[0];

    const shape = (t: unknown) => {
      const { id: _id, ...rest } = t as Record<string, unknown>;
      return rest;
    };
    expect(shape(fromSignup)).toEqual(shape(fromSettings));
    expect(card).toMatchObject({ stamps: 0, stampsRequired: 10, rewardDescEn: null });
    expect(await prisma.tier.count({ where: { merchantId: b.merchantId } })).toBe(1);
  });
});
