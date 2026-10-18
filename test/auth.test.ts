import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, FakeOdoo, prisma, resetDb } from './helpers.js';

let app: FastifyInstance;
let odoo: FakeOdoo;

beforeEach(async () => {
  await resetDb();
  await app?.close();
  ({ app, odoo } = await buildTestApp());
  const fields = ['id', 'main_member', 'name', 'tracking_partner_id'];
  odoo.vendors.set('owner-token', { odooUserId: 101, partnerId: 4812, name: 'Cup & Go', isMainMember: true, fields });
  odoo.vendors.set('cashier-token', { odooUserId: 102, partnerId: 4812, name: 'Cashier Ali', isMainMember: false, fields });
  odoo.vendors.set('no-partner-token', { odooUserId: 103, partnerId: null, name: 'Nobody', isMainMember: true, fields });
  odoo.branches.set(4812, [
    { odooBranchId: 1, name: 'Lusail', nameAr: 'لوسيل' },
    { odooBranchId: 2, name: 'Aspire', nameAr: null },
  ]);
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

const exchange = (odooToken: string) => app.inject({ method: 'POST', url: '/v1/auth/exchange', payload: { odooToken } });
const refresh = (refreshToken: string) => app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken } });

describe('POST /v1/auth/exchange', () => {
  it('creates merchant, owner and branches on first login', async () => {
    const res = await exchange('owner-token');
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toMatch(/^rt_/);
    expect(body.merchant).toMatchObject({ odooMerchantId: 4812, role: 'owner', loyaltyEnabled: false, merchantCode: 'cup-go' });

    const branches = await prisma.branch.findMany({ orderBy: { odooBranchId: 'asc' } });
    expect(branches.map((b) => b.name)).toEqual(['Lusail', 'Aspire']);
    expect(branches[0]!.branchCode).toMatch(/^[a-z2-9]{5}$/);
  });

  it('gives a sub-user the cashier role under the same merchant', async () => {
    await exchange('owner-token');
    const res = await exchange('cashier-token');
    expect(res.json().merchant.role).toBe('cashier');
    expect(await prisma.merchant.count()).toBe(1);
  });

  it('rejects a token Odoo does not recognise', async () => {
    const res = await exchange('garbage');
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ code: 'odoo_token_invalid', status: 401 });
  });

  it('rejects an Odoo user that is not linked to a merchant', async () => {
    const res = await exchange('no-partner-token');
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('not_a_merchant');
  });

  it('still logs in when the branch sync fails', async () => {
    odoo.failBranches = true;
    const res = await exchange('owner-token');
    expect(res.statusCode).toBe(200);
    expect(await prisma.branch.count()).toBe(0);
  });

  it('returns 422 with field errors for an invalid body', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/exchange', payload: {} });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('validation_failed');
    expect(res.json().errors.length).toBeGreaterThan(0);
  });
});

describe('POST /v1/auth/refresh', () => {
  it('rotates the refresh token', async () => {
    const first = (await exchange('owner-token')).json();
    const res = await refresh(first.refreshToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().refreshToken).not.toBe(first.refreshToken);
  });

  it('revokes the whole login when an old refresh token is reused', async () => {
    const first = (await exchange('owner-token')).json();
    const second = (await refresh(first.refreshToken)).json();

    const reuse = await refresh(first.refreshToken);
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().code).toBe('refresh_reused');

    // The newer token from the same login is now dead too.
    const after = await refresh(second.refreshToken);
    expect(after.statusCode).toBe(401);
  });

  it('only lets one of two parallel refreshes win', async () => {
    const first = (await exchange('owner-token')).json();
    const results = await Promise.all([refresh(first.refreshToken), refresh(first.refreshToken)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
  });
});

describe('GET /v1/merchant/me and logout', () => {
  it('returns the merchant for a valid token and 401 without one', async () => {
    const { accessToken } = (await exchange('cashier-token')).json();

    const me = await app.inject({ method: 'GET', url: '/v1/merchant/me', headers: { authorization: `Bearer ${accessToken}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ role: 'cashier', odooMerchantId: 4812 });

    const anon = await app.inject({ method: 'GET', url: '/v1/merchant/me' });
    expect(anon.statusCode).toBe(401);
  });

  it('logout revokes the refresh token', async () => {
    const { accessToken, refreshToken } = (await exchange('owner-token')).json();
    const out = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${accessToken}` } });
    expect(out.statusCode).toBe(204);
    expect((await refresh(refreshToken)).statusCode).toBe(401);
  });
});
