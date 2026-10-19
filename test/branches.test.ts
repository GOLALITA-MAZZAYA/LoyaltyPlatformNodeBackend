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
    { odooBranchId: 11, name: 'Lusail', nameAr: 'لوسيل' },
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
  return { authorization: `Bearer ${body.accessToken}` };
}

describe('branches', () => {
  it('lists only the merchant’s own branches', async () => {
    const headers = await login('owner-a');
    await login('owner-b');
    const res = await app.inject({ method: 'GET', url: '/v1/branches', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((b: { name: string }) => b.name)).toEqual(['Aspire', 'Lusail']);
    expect(res.json().items[0].memberCount).toBe(0);
  });

  it('returns 403 loyalty_not_enabled when the merchant is not enabled', async () => {
    const headers = await login('owner-a', false);
    const res = await app.inject({ method: 'GET', url: '/v1/branches', headers });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('loyalty_not_enabled');
  });

  it('returns a join URL and a QR image for a branch', async () => {
    const headers = await login('owner-a');
    const branch = await prisma.branch.findFirstOrThrow({ where: { odooBranchId: 11 } });
    const res = await app.inject({ method: 'GET', url: `/v1/branches/${branch.id}/qr`, headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.joinUrl).toBe(`https://join.test/j/cup-go/${branch.branchCode}`);
    expect(body.qrSvg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
    expect(body.poster).toMatchObject({ merchantName: 'Cup & Go', primaryColor: '#8A1538', tiers: [] });
  });

  it('does not reveal another merchant’s branch QR', async () => {
    await login('owner-a');
    const headersB = await login('owner-b');
    const branchA = await prisma.branch.findFirstOrThrow({ where: { odooBranchId: 11 } });
    const res = await app.inject({ method: 'GET', url: `/v1/branches/${branchA.id}/qr`, headers: headersB });
    expect(res.statusCode).toBe(404);
  });

  it('lets cashiers view QR codes but only owners re-sync', async () => {
    await login('owner-a');
    const cashier = await login('cashier-a');
    const list = await app.inject({ method: 'GET', url: '/v1/branches', headers: cashier });
    expect(list.statusCode).toBe(200);
    const sync = await app.inject({ method: 'POST', url: '/v1/branches/sync', headers: cashier, payload: { odooToken: 'cashier-a' } });
    expect(sync.statusCode).toBe(403);
    expect(sync.json().code).toBe('forbidden_role');
  });

  it('sync adds new branches and deactivates removed ones, keeping codes stable', async () => {
    const headers = await login('owner-a');
    const before = await prisma.branch.findFirstOrThrow({ where: { odooBranchId: 11 } });
    odoo.branches.set(100, [
      { odooBranchId: 11, name: 'Lusail Marina', nameAr: 'لوسيل' },
      { odooBranchId: 13, name: 'Villaggio', nameAr: null },
    ]);
    const res = await app.inject({ method: 'POST', url: '/v1/branches/sync', headers, payload: { odooToken: 'owner-a' } });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { odooBranchId: number; name: string; active: boolean; branchCode: string }[];
    const lusail = items.find((b) => b.odooBranchId === 11)!;
    expect(lusail.name).toBe('Lusail Marina');
    expect(lusail.branchCode).toBe(before.branchCode); // printed posters keep working
    expect(items.find((b) => b.odooBranchId === 12)!.active).toBe(false);
    expect(items.find((b) => b.odooBranchId === 13)!.active).toBe(true);
  });
});
