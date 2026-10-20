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

describe('Program & Tiers', () => {
  it('GET /program auto-creates default program and base tier if missing', async () => {
    const owner = await login('owner-a');
    const res = await app.inject({ method: 'GET', url: '/v1/program', headers: owner.headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Shared default policy (src/modules/program/defaults.ts): draft until the owner activates it.
    expect(body.status).toBe('draft');
    expect(body.pointsPerQar).toBe(1);
    expect(body.version).toBe(1);

    // Verify default tier exists
    const tiersRes = await app.inject({ method: 'GET', url: '/v1/program/tiers', headers: owner.headers });
    expect(tiersRes.statusCode).toBe(200);
    const tiersBody = tiersRes.json();
    expect(tiersBody.items.length).toBe(1);
    expect(tiersBody.items[0].isBase).toBe(true);
    expect(tiersBody.items[0].spendThreshold).toBe('0.00');
    expect(tiersBody.items[0].punchRule).toMatchObject({ stampsRequired: 10, rewardDescriptionEn: null, rewardDescriptionAr: null });
  });

  it('PUT /program allows owner to update program settings and bumps version', async () => {
    const owner = await login('owner-a');
    const updateRes = await app.inject({
      method: 'PUT',
      url: '/v1/program',
      headers: owner.headers,
      payload: {
        status: 'active',
        pointsPerQar: 2,
        minBillForEarning: '10.00',
        pointsNameEn: 'G-Points',
        pointsNameAr: 'نقاط جي',
        tierWindow: 'quarterly',
        tierCarryOver: true,
        maxStampsPerTransaction: 8,
        invoiceRefRequired: false,
        allowPhoneLookup: true,
        phoneLookupDailyLimit: 50,
        termsEn: 'Program terms and conditions',
        termsAr: 'الشروط والأحكام',
      },
    });

    expect(updateRes.statusCode).toBe(200);
    const body = updateRes.json();
    expect(body.pointsPerQar).toBe(2);
    expect(body.pointsNameEn).toBe('G-Points');
    expect(body.tierWindow).toBe('quarterly');
    expect(body.version).toBe(2);
  });

  it('PUT /program forbids cashiers with 403', async () => {
    await login('owner-a');
    const cashier = await login('cashier-a');
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/program',
      headers: cashier.headers,
      payload: {
        status: 'active',
        pointsPerQar: 2,
        pointsNameEn: 'G-Points',
        pointsNameAr: 'نقاط',
        tierWindow: 'monthly',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('PUT /program/tiers replaces tiers and updates stamp rules', async () => {
    const owner = await login('owner-a');
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/program/tiers',
      headers: owner.headers,
      payload: {
        items: [
          {
            nameEn: 'Silver',
            nameAr: 'فضي',
            color: '#8A8A8A',
            spendThreshold: '0.00',
            discountPercent: 0,
            isBase: true,
            punchRule: {
              enabled: true,
              stampsRequired: 6,
              rewardDescriptionEn: 'Free Drink',
              rewardDescriptionAr: 'مشروب مجاني',
            },
          },
          {
            nameEn: 'Gold',
            nameAr: 'ذهبي',
            color: '#F59E0B',
            spendThreshold: '100.00',
            discountPercent: 10,
            isBase: false,
            punchRule: {
              enabled: true,
              stampsRequired: 5,
              rewardDescriptionEn: 'Free Premium Item',
              rewardDescriptionAr: 'هدية مميزة مجاناً',
            },
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBe(2);
    expect(body.items[0].nameEn).toBe('Silver');
    expect(body.items[0].punchRule.stampsRequired).toBe(6);
    expect(body.items[1].nameEn).toBe('Gold');
    expect(body.items[1].punchRule.stampsRequired).toBe(5);
  });

  it('PUT /program/tiers saves, clears and validates the optional reward max value', async () => {
    const owner = await login('owner-a');
    const tier = (rewardMaxValue: unknown, id?: string) => ({
      ...(id && { id }),
      nameEn: 'Member',
      nameAr: 'عضو',
      color: '#8A1538',
      spendThreshold: '0.00',
      discountPercent: 0,
      isBase: true,
      punchRule: { enabled: true, stampsRequired: 10, rewardDescriptionEn: 'Free item', rewardDescriptionAr: 'هدية مجانية', rewardMaxValue },
    });
    const put = (item: object) =>
      app.inject({ method: 'PUT', url: '/v1/program/tiers', headers: owner.headers, payload: { items: [item] } });
    const getMax = async () =>
      (await app.inject({ method: 'GET', url: '/v1/program/tiers', headers: owner.headers })).json().items[0].punchRule.rewardMaxValue;

    // Saved and read back with two decimals
    const saved = await put(tier('300'));
    expect(saved.statusCode).toBe(200);
    expect(await getMax()).toBe('300.00');
    const id = saved.json().items[0].id as string;

    // Empty stays empty (no cap), never 0
    expect((await put(tier('', id))).statusCode).toBe(200);
    expect(await getMax()).toBeNull();
    expect((await put(tier('49.5', id))).statusCode).toBe(200);
    expect(await getMax()).toBe('49.50');
    expect((await put(tier(null, id))).statusCode).toBe(200);
    expect(await getMax()).toBeNull();

    // Bad values are refused with 422, not a server error
    for (const bad of ['abc', '-5', '0', '0.00', '10.123', '12345678']) {
      const res = await put(tier(bad, id));
      expect(res.statusCode, bad).toBe(422);
      expect(res.json().code).toBe('validation_failed');
    }
    expect(await getMax()).toBeNull();
  });

  it('PUT /program/tiers enforces exactly one base tier with spendThreshold = 0.00', async () => {
    const owner = await login('owner-a');
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/program/tiers',
      headers: owner.headers,
      payload: {
        items: [
          {
            nameEn: 'Silver',
            nameAr: 'فضي',
            color: '#8A8A8A',
            spendThreshold: '50.00',
            discountPercent: 0,
            isBase: false,
            punchRule: { enabled: true, stampsRequired: 6 },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('enforces merchant isolation for program and tiers', async () => {
    const ownerA = await login('owner-a');
    const ownerB = await login('owner-b');

    // Update owner A tiers
    await app.inject({
      method: 'PUT',
      url: '/v1/program/tiers',
      headers: ownerA.headers,
      payload: {
        items: [
          {
            nameEn: 'Cup & Go VIP',
            nameAr: 'كوب آند جو',
            color: '#8A1538',
            spendThreshold: '0.00',
            discountPercent: 5,
            isBase: true,
            punchRule: { enabled: true, stampsRequired: 4 },
          },
        ],
      },
    });

    // Check owner B tiers
    const resB = await app.inject({ method: 'GET', url: '/v1/program/tiers', headers: ownerB.headers });
    expect(resB.statusCode).toBe(200);
    const bodyB = resB.json();
    expect(bodyB.items[0].nameEn).toBe('Member'); // default, not owner A's 'Cup & Go VIP'
  });
});
