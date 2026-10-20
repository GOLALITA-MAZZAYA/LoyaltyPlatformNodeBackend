import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, FakeOdoo, prisma, resetDb } from './helpers.js';

let app: FastifyInstance;
let odoo: FakeOdoo;
const fields = ['id', 'main_member', 'name', 'tracking_partner_id'];

beforeEach(async () => {
  await resetDb();
  await app?.close();
  ({ app, odoo } = await buildTestApp());
  odoo.vendors.set('owner-a', { odooUserId: 1, partnerId: 100, name: 'Cup & Go', isMainMember: true, fields });
  odoo.vendors.set('cashier-a', { odooUserId: 2, partnerId: 100, name: 'Cashier', isMainMember: false, fields });
  odoo.vendors.set('owner-b', { odooUserId: 3, partnerId: 200, name: 'Other Shop', isMainMember: true, fields });
  odoo.branches.set(100, [
    { odooBranchId: 11, name: 'Lusail', nameAr: null },
    { odooBranchId: 12, name: 'Aspire', nameAr: null },
  ]);
  odoo.branches.set(200, [{ odooBranchId: 21, name: 'Pearl', nameAr: null }]);
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

async function login(odooToken: string, enableLoyalty = true) {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/exchange', payload: { odooToken } });
  const body = res.json();
  if (enableLoyalty) await prisma.merchant.update({ where: { id: body.merchant.id }, data: { loyaltyEnabled: true } });
  return { headers: { authorization: `Bearer ${body.accessToken}` }, merchantId: body.merchant.id as string };
}

async function tier(merchantId: string, rank = 0, nameEn = 'Member') {
  return prisma.tier.create({
    data: { merchantId, rank, isBase: rank === 0, nameEn, nameAr: nameEn, color: '#111111', spendThreshold: rank * 100, discountPercent: rank * 5, stampsRequired: 8 },
  });
}

let seq = 0;
async function member(merchantId: string, tierId: string, data: { firstName: string; phone?: string; branchOdooId?: number; joinedAt?: Date; stamps?: number }) {
  const branch = data.branchOdooId ? await prisma.branch.findUniqueOrThrow({ where: { odooBranchId: data.branchOdooId } }) : null;
  seq += 1;
  return prisma.member.create({
    data: {
      merchantId,
      tierId,
      firstName: data.firstName,
      phone: data.phone ?? `+9745500${String(seq).padStart(4, '0')}`,
      joinedBranchId: branch?.id ?? null,
      joinedAt: data.joinedAt ?? new Date(Date.now() - seq * 1000),
      stamps: data.stamps ?? 0,
      consentVersion: 1,
      consentAt: new Date(),
    },
  });
}

const list = (headers: Record<string, string>, query = '') => app.inject({ method: 'GET', url: `/v1/members${query}`, headers });

describe('GET /v1/members', () => {
  it('lists only the authenticated merchant’s members, newest first', async () => {
    const a = await login('owner-a');
    const b = await login('owner-b');
    const ta = await tier(a.merchantId);
    const tb = await tier(b.merchantId);
    await member(a.merchantId, ta.id, { firstName: 'Older', joinedAt: new Date('2026-01-01'), branchOdooId: 11, stamps: 3 });
    await member(a.merchantId, ta.id, { firstName: 'Newer', joinedAt: new Date('2026-02-01') });
    await member(b.merchantId, tb.id, { firstName: 'Other merchant' });

    const res = await list(a.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((m: { displayName: string }) => m.displayName)).toEqual(['Newer', 'Older']);
    expect(body.items[1]).toMatchObject({ joinedBranchName: 'Lusail', stamps: 3, stampsRequired: 8, tierNameEn: 'Member', status: 'active' });
    expect(body.totals).toEqual({ members: 2, matching: 2, byTier: { [ta.id]: 2 } });
  });

  it('cannot reach another merchant’s members through filters', async () => {
    const a = await login('owner-a');
    const b = await login('owner-b');
    const tb = await tier(b.merchantId);
    await member(b.merchantId, tb.id, { firstName: 'Hidden', branchOdooId: 21 });
    const pearl = await prisma.branch.findUniqueOrThrow({ where: { odooBranchId: 21 } });

    for (const q of [`?tierId=${tb.id}`, `?joinedBranchId=${pearl.id}`, '?q=Hidden']) {
      const res = await list(a.headers, q);
      expect(res.json().items).toEqual([]);
    }
  });

  it('shows full phone numbers to owners and masked ones to cashiers', async () => {
    const owner = await login('owner-a');
    const cashier = await login('cashier-a');
    const t = await tier(owner.merchantId);
    await member(owner.merchantId, t.id, { firstName: 'Sara', phone: '+97455123456' });

    const asOwner = (await list(owner.headers)).json().items[0];
    expect(asOwner).toMatchObject({ phone: '+97455123456', phoneMasked: '+974 •••• 3456' });

    const asCashier = (await list(cashier.headers)).json().items[0];
    expect(asCashier.phoneMasked).toBe('+974 •••• 3456');
    expect(asCashier.phone).toBeUndefined();
    expect(JSON.stringify(asCashier)).not.toContain('55123456');
  });

  it('searches by name or by 4+ phone digits, and filters by tier and branch', async () => {
    const a = await login('owner-a');
    const base = await tier(a.merchantId);
    const gold = await tier(a.merchantId, 1, 'Gold');
    await member(a.merchantId, base.id, { firstName: 'Sara', phone: '+97455123456', branchOdooId: 11 });
    await member(a.merchantId, gold.id, { firstName: 'Ahmed', phone: '+97466789012', branchOdooId: 12 });
    const aspire = await prisma.branch.findUniqueOrThrow({ where: { odooBranchId: 12 } });

    const names = async (q: string) => (await list(a.headers, q)).json().items.map((m: { displayName: string }) => m.displayName);
    expect(await names('?q=sar')).toEqual(['Sara']);
    expect(await names('?q=9012')).toEqual(['Ahmed']);
    expect(await names(`?tierId=${gold.id}`)).toEqual(['Ahmed']);
    expect(await names(`?joinedBranchId=${aspire.id}`)).toEqual(['Ahmed']);

    const short = await list(a.headers, '?q=123');
    expect(short.statusCode).toBe(422);

    const filtered = (await list(a.headers, `?tierId=${gold.id}`)).json();
    expect(filtered.totals).toMatchObject({ members: 2, matching: 1 });
  });

  it('pages with a cursor without skipping or repeating members', async () => {
    const a = await login('owner-a');
    const t = await tier(a.merchantId);
    // Same joinedAt for several members, to exercise the id tiebreak.
    const same = new Date('2026-03-01T10:00:00Z');
    for (let i = 0; i < 5; i++) await member(a.merchantId, t.id, { firstName: `M${i}`, joinedAt: i < 3 ? same : new Date(same.getTime() - i * 1000) });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await list(a.headers, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      const body = res.json();
      seen.push(...body.items.map((m: { id: string }) => m.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);

    expect((await list(a.headers, '?cursor=garbage')).statusCode).toBe(422);
  });

  it('requires login and loyalty to be enabled', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/members' })).statusCode).toBe(401);
    const a = await login('owner-a', false);
    const res = await list(a.headers);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('loyalty_not_enabled');
  });
});

describe('GET /v1/members/:id', () => {
  it('returns the member’s details, and 404 for another merchant’s member', async () => {
    const a = await login('owner-a');
    const b = await login('owner-b');
    const ta = await tier(a.merchantId);
    const tb = await tier(b.merchantId);
    const mine = await member(a.merchantId, ta.id, { firstName: 'Sara', branchOdooId: 11 });
    const theirs = await member(b.merchantId, tb.id, { firstName: 'Other' });

    const res = await app.inject({ method: 'GET', url: `/v1/members/${mine.id}`, headers: a.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      firstName: 'Sara',
      source: 'branch_qr',
      lifetimeSpend: '0.00',
      transactionCount: 0,
      joinedBranchName: 'Lusail',
      walletPass: { apple: false, google: false, syncStatus: 'none' },
    });

    const other = await app.inject({ method: 'GET', url: `/v1/members/${theirs.id}`, headers: a.headers });
    expect(other.statusCode).toBe(404);
  });
});

describe('PATCH /v1/members/:id', () => {
  it('lets owners block a member, which also signs out their web card', async () => {
    const a = await login('owner-a');
    const t = await tier(a.merchantId);
    const m = await member(a.merchantId, t.id, { firstName: 'Sara' });
    await prisma.memberToken.create({ data: { memberId: m.id, tokenHash: 'x'.repeat(64), expiresAt: new Date(Date.now() + 86_400_000) } });

    const res = await app.inject({ method: 'PATCH', url: `/v1/members/${m.id}`, headers: a.headers, payload: { status: 'blocked', reason: 'abuse' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('blocked');
    expect(await prisma.memberToken.count({ where: { memberId: m.id, revokedAt: null } })).toBe(0);
    expect(await prisma.event.count({ where: { type: 'member.blocked', subjectId: m.id } })).toBe(1);

    const back = await app.inject({ method: 'PATCH', url: `/v1/members/${m.id}`, headers: a.headers, payload: { status: 'active' } });
    expect(back.json().status).toBe('active');
  });

  it('is owner-only and merchant-scoped', async () => {
    const a = await login('owner-a');
    const cashier = await login('cashier-a');
    const b = await login('owner-b');
    const t = await tier(a.merchantId);
    const m = await member(a.merchantId, t.id, { firstName: 'Sara' });

    const asCashier = await app.inject({ method: 'PATCH', url: `/v1/members/${m.id}`, headers: cashier.headers, payload: { status: 'blocked' } });
    expect(asCashier.statusCode).toBe(403);
    const asOther = await app.inject({ method: 'PATCH', url: `/v1/members/${m.id}`, headers: b.headers, payload: { status: 'blocked' } });
    expect(asOther.statusCode).toBe(404);
    expect((await prisma.member.findUniqueOrThrow({ where: { id: m.id } })).status).toBe('active');
  });
});
