import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { UnconfiguredSmsSender } from '../src/integrations/sms.js';
import { loadEnv } from '../src/config/env.js';
import { buildTestApp, FakeOdoo, prisma, resetDb } from './helpers.js';

let app: FastifyInstance;
let odoo: FakeOdoo;
const fields = ['id', 'main_member', 'name', 'tracking_partner_id'];
const PHONE = '+97455123456';

beforeEach(async () => {
  await resetDb();
  await app?.close();
  ({ app, odoo } = await buildTestApp());
  odoo.vendors.set('owner-a', { odooUserId: 1, partnerId: 100, name: 'Cup & Go', isMainMember: true, fields });
  odoo.vendors.set('owner-b', { odooUserId: 3, partnerId: 200, name: 'Other Shop', isMainMember: true, fields });
  odoo.branches.set(100, [{ odooBranchId: 11, name: 'Lusail', nameAr: 'لوسيل' }]);
  odoo.branches.set(200, [{ odooBranchId: 21, name: 'Pearl', nameAr: null }]);
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

/** Creates the merchant (via a real login) and returns its public join codes. */
async function merchant(odooToken: string, enableLoyalty = true) {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/exchange', payload: { odooToken } });
  const m = await prisma.merchant.update({ where: { id: res.json().merchant.id }, data: { loyaltyEnabled: enableLoyalty } });
  const branch = await prisma.branch.findFirstOrThrow({ where: { merchantId: m.id } });
  return { merchantId: m.id, branchId: branch.id, merchantCode: m.merchantCode, branchCode: branch.branchCode };
}

type Codes = { merchantCode: string; branchCode: string };

const send = (c: Codes, phone = PHONE) =>
  app.inject({ method: 'POST', url: '/v1/public/otp/send', payload: { merchantCode: c.merchantCode, branchCode: c.branchCode, phone } });
const verify = (otpRequestId: string, code: string) =>
  app.inject({ method: 'POST', url: '/v1/public/otp/verify', payload: { otpRequestId, code } });
const getMe = (token: string) => app.inject({ method: 'GET', url: '/v1/public/me', headers: { authorization: `Bearer ${token}` } });
const putMe = (token: string, payload: Record<string, unknown> = { firstName: 'Sara', consentAccepted: true }) =>
  app.inject({ method: 'PUT', url: '/v1/public/me', headers: { authorization: `Bearer ${token}` }, payload });

/** Lets the next send through the 60-second resend limit. */
const ageOtps = () => prisma.otpRequest.updateMany({ data: { createdAt: new Date(Date.now() - 16 * 60_000) } });

async function verifyPhone(c: Codes, phone = PHONE) {
  const sent = await send(c, phone);
  expect(sent.statusCode).toBe(202);
  const { otpRequestId, devCode } = sent.json();
  const res = await verify(otpRequestId, devCode);
  expect(res.statusCode).toBe(200);
  return res.json() as { memberToken: string; profileRequired: boolean };
}

async function signUp(c: Codes, phone = PHONE) {
  const v = await verifyPhone(c, phone);
  const res = await putMe(v.memberToken);
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('GET /v1/public/join/:merchantCode/:branchCode', () => {
  it('returns the merchant and branch for a valid link', async () => {
    const c = await merchant('owner-a');
    const res = await app.inject({ method: 'GET', url: `/v1/public/join/${c.merchantCode}/${c.branchCode}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ merchantName: 'Cup & Go', branchName: 'Lusail', branchNameAr: 'لوسيل', programActive: false, tiers: [] });
  });

  it('is 404 for an unknown branch, another merchant’s branch, or a merchant without loyalty', async () => {
    const a = await merchant('owner-a');
    const b = await merchant('owner-b', false);
    const urls = [`${a.merchantCode}/zzzzz`, `${a.merchantCode}/${b.branchCode}`, `${b.merchantCode}/${b.branchCode}`];
    for (const u of urls) {
      const res = await app.inject({ method: 'GET', url: `/v1/public/join/${u}` });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('join_link_not_found');
    }
  });
});

describe('new member sign-up', () => {
  it('creates one member with 0 stamps in the base tier, linked to the joined branch', async () => {
    const c = await merchant('owner-a');
    const v = await verifyPhone(c);
    expect(v.profileRequired).toBe(true);

    // Not a member until the profile is completed.
    const early = await getMe(v.memberToken);
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe('profile_required');
    expect(await prisma.member.count()).toBe(0);

    const res = await putMe(v.memberToken, { firstName: ' Sara ', consentAccepted: true, stamps: 99, points: 500 });
    expect(res.statusCode).toBe(200);
    const card = res.json();
    expect(card).toMatchObject({ merchantName: 'Cup & Go', firstName: 'Sara', stamps: 0, points: 0, stampsRequired: 10, rewardAvailable: false });
    expect(card.tier).toMatchObject({ nameEn: 'Member', discountPercent: 0 });
    expect(card.memberToken).toMatch(/^mt_/);

    const members = await prisma.member.findMany();
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ phone: PHONE, merchantId: c.merchantId, joinedBranchId: c.branchId, stamps: 0, points: 0, source: 'branch_qr' });
    expect(await prisma.event.count({ where: { type: 'member.enrolled' } })).toBe(1);

    // The saved token opens the same card later (page refresh / QR reopened).
    const later = await getMe(card.memberToken);
    expect(later.statusCode).toBe(200);
    expect(later.json().firstName).toBe('Sara');
  });

  it('shows the reward and its optional max value on the card and the join page', async () => {
    const c = await merchant('owner-a');
    const card = await signUp(c);
    expect(card).toMatchObject({ rewardDescEn: null, rewardMaxValue: null });

    await prisma.program.upsert({ where: { merchantId: c.merchantId }, create: { merchantId: c.merchantId, status: 'active' }, update: { status: 'active' } });
    await prisma.tier.updateMany({
      where: { merchantId: c.merchantId, isBase: true },
      data: { rewardDescEn: 'Free item', rewardDescAr: 'هدية مجانية', rewardMaxValue: '300' },
    });
    const me = (await getMe(card.memberToken)).json();
    expect(me).toMatchObject({ rewardDescEn: 'Free item', rewardDescAr: 'هدية مجانية', rewardMaxValue: '300.00' });

    const join = (await app.inject({ method: 'GET', url: `/v1/public/join/${c.merchantCode}/${c.branchCode}` })).json();
    expect(join.tiers[0].punchRule).toMatchObject({ rewardDescriptionEn: 'Free item', rewardMaxValue: '300.00' });
  });

  it('requires consent and a first name', async () => {
    const c = await merchant('owner-a');
    const v = await verifyPhone(c);
    expect((await putMe(v.memberToken, { firstName: 'Sara', consentAccepted: false })).statusCode).toBe(422);
    expect((await putMe(v.memberToken, { firstName: '  ', consentAccepted: true })).statusCode).toBe(422);
    expect(await prisma.member.count()).toBe(0);
  });

  it('creates only one member when the profile is submitted twice at once', async () => {
    const c = await merchant('owner-a');
    const v = await verifyPhone(c);
    const results = await Promise.all([putMe(v.memberToken), putMe(v.memberToken), putMe(v.memberToken)]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(await prisma.member.count()).toBe(1);
    expect(await prisma.tier.count()).toBe(1);
  });

  it('rejects numbers that are not Qatar mobiles', async () => {
    const c = await merchant('owner-a');
    for (const phone of ['+97412345678', '+9715512345', '55123456']) {
      expect((await send(c, phone)).statusCode).toBe(422);
    }
  });
});

describe('returning member', () => {
  it('gets the existing card back with stamps preserved and no duplicate', async () => {
    const c = await merchant('owner-a');
    const first = await signUp(c);
    await prisma.member.updateMany({ data: { stamps: 4, points: 120 } });

    await ageOtps();
    const again = await verifyPhone(c);
    expect(again.profileRequired).toBe(false);
    expect(again.memberToken).toMatch(/^mt_/);

    const card = (await getMe(again.memberToken)).json();
    expect(card).toMatchObject({ firstName: 'Sara', stamps: 4, points: 120 });
    expect(await prisma.member.count()).toBe(1);

    // Verifying again replaces the old card token.
    expect((await getMe(first.memberToken)).statusCode).toBe(401);

    // A profile submission from an existing member changes nothing.
    const put = await putMe(again.memberToken, { firstName: 'Changed', consentAccepted: true });
    expect(put.json()).toMatchObject({ firstName: 'Sara', stamps: 4 });
  });

  it('is a separate member at each merchant', async () => {
    const a = await merchant('owner-a');
    const b = await merchant('owner-b');
    await signUp(a);
    await prisma.member.updateMany({ data: { stamps: 7 } });

    await ageOtps();
    const atB = await verifyPhone(b);
    expect(atB.profileRequired).toBe(true);
    const cardB = (await putMe(atB.memberToken)).json();
    expect(cardB).toMatchObject({ merchantName: 'Other Shop', stamps: 0 });

    const members = await prisma.member.findMany({ orderBy: { joinedAt: 'asc' } });
    expect(members.map((m) => [m.merchantId, m.stamps])).toEqual([
      [a.merchantId, 7],
      [b.merchantId, 0],
    ]);
  });
});

describe('OTP checks', () => {
  it('counts wrong codes and locks after 5 attempts, even for the right code', async () => {
    const c = await merchant('owner-a');
    const { otpRequestId, devCode } = (await send(c)).json();
    const wrong = devCode === '000000' ? '111111' : '000000';

    const first = await verify(otpRequestId, wrong);
    expect(first.statusCode).toBe(401);
    expect(first.json()).toMatchObject({ code: 'otp_invalid', attemptsRemaining: 4 });
    for (let i = 0; i < 4; i++) await verify(otpRequestId, wrong);

    const right = await verify(otpRequestId, devCode);
    expect(right.statusCode).toBe(401);
    expect(right.json().code).toBe('otp_attempts_exceeded');
  });

  it('rejects an expired code', async () => {
    const c = await merchant('owner-a');
    const { otpRequestId, devCode } = (await send(c)).json();
    await prisma.otpRequest.update({ where: { id: otpRequestId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await verify(otpRequestId, devCode);
    expect(res.json().code).toBe('otp_expired');
  });

  it('accepts a code only once', async () => {
    const c = await merchant('owner-a');
    const { otpRequestId, devCode } = (await send(c)).json();
    expect((await verify(otpRequestId, devCode)).statusCode).toBe(200);
    const again = await verify(otpRequestId, devCode);
    expect(again.statusCode).toBe(401);
    expect(again.json().code).toBe('otp_invalid');
  });

  it('stores only a hash of the code', async () => {
    const c = await merchant('owner-a');
    const { otpRequestId, devCode } = (await send(c)).json();
    const row = await prisma.otpRequest.findUniqueOrThrow({ where: { id: otpRequestId } });
    expect(row.codeHash).not.toContain(devCode);
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('limits resends: 60 s apart and 3 per 15 minutes', async () => {
    const c = await merchant('owner-a');
    expect((await send(c)).statusCode).toBe(202);
    const tooSoon = await send(c);
    expect(tooSoon.statusCode).toBe(429);
    expect(tooSoon.json().retryAfterSeconds).toBeGreaterThan(0);

    // Two more, each just over a minute after the previous one.
    for (let i = 0; i < 2; i++) {
      await prisma.otpRequest.updateMany({ data: { createdAt: { set: new Date(Date.now() - (i + 1) * 61_000) } } });
      expect((await send(c)).statusCode).toBe(202);
    }
    await prisma.otpRequest.updateMany({ data: { createdAt: new Date(Date.now() - 2 * 60_000) } });
    expect((await send(c)).statusCode).toBe(429);
  });

  it('does not pretend to send when SMS is not configured', async () => {
    await app.close();
    ({ app, odoo } = await buildTestApp(odoo, new UnconfiguredSmsSender()));
    const c = await merchant('owner-a');
    const res = await send(c);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('sms_not_configured');
    expect(res.json().devCode).toBeUndefined();
    expect(await prisma.otpRequest.count()).toBe(0);
  });

  it('refuses dev OTP delivery in production', () => {
    const base = { ...process.env, NODE_ENV: 'production' };
    expect(() => loadEnv({ ...base, OTP_DELIVERY: 'dev' })).toThrow(/OTP_DELIVERY/);
    expect(loadEnv({ ...base, OTP_DELIVERY: 'sms' }).OTP_DELIVERY).toBe('sms');
  });

  it('rejects garbage member tokens', async () => {
    expect((await getMe('mt_nope')).statusCode).toBe(401);
    expect((await getMe('eyJhbGciOiJIUzI1NiJ9.e30.x')).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/public/me' })).statusCode).toBe(401);
  });
});

describe('POST /v1/public/me/qr', () => {
  const qr = (token: string, method: 'POST' | 'GET' = 'POST') =>
    app.inject({ method, url: '/v1/public/me/qr', headers: { authorization: `Bearer ${token}` } });

  it('issues a 90-second single-row pass code, storing only its hash', async () => {
    const c = await merchant('owner-a');
    const card = await signUp(c);
    const before = Date.now();

    const res = await qr(card.memberToken);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body.code).toMatch(/^glp1\.[A-Za-z0-9_-]{43}$/);
    expect(body.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    const ttl = new Date(body.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(89_000);
    expect(ttl).toBeLessThanOrEqual(91_000);

    const rows = await prisma.passCode.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.codeHash).not.toContain(body.code.slice(5));
    expect(rows[0]!.usedAt).toBeNull();
  });

  it('is not routed for GET and creates no pass code', async () => {
    const c = await merchant('owner-a');
    const card = await signUp(c);
    const res = await qr(card.memberToken, 'GET');
    expect(res.statusCode).toBe(404);
    expect(await prisma.passCode.count()).toBe(0);
  });

  it('gives blocked members 401 and no code', async () => {
    const c = await merchant('owner-a');
    const card = await signUp(c);
    await prisma.member.updateMany({ where: { phone: PHONE }, data: { status: 'blocked' } });
    expect((await qr(card.memberToken)).statusCode).toBe(401);
    expect(await prisma.passCode.count()).toBe(0);
  });

  it('needs a member card token, not a sign-up token or nothing', async () => {
    const c = await merchant('owner-a');
    const v = await verifyPhone(c);
    expect((await qr(v.memberToken)).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/v1/public/me/qr' })).statusCode).toBe(401);
    expect(await prisma.passCode.count()).toBe(0);
  });

  it('allows 10 codes per minute per card, then 429 without creating a row', async () => {
    const c = await merchant('owner-a');
    const card = await signUp(c);
    for (let i = 0; i < 10; i++) expect((await qr(card.memberToken)).statusCode).toBe(200);
    const over = await qr(card.memberToken);
    expect(over.statusCode).toBe(429);
    expect(over.json().code).toBe('rate_limited');
    expect(await prisma.passCode.count()).toBe(10);
  });

  it('counts the limit in parallel requests too', async () => {
    const c = await merchant('owner-a');
    const card = await signUp(c);
    const results = await Promise.all(Array.from({ length: 15 }, () => qr(card.memberToken)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(10);
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(5);
    expect(await prisma.passCode.count()).toBe(10);
  });

  it('allows 120 codes per hour per card', async () => {
    const c = await merchant('owner-a');
    const card = await signUp(c);
    const member = await prisma.member.findFirstOrThrow({ where: { phone: PHONE } });
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    await prisma.passCode.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        codeHash: `seed-${i}`,
        merchantId: member.merchantId,
        memberId: member.id,
        expiresAt: new Date(tenMinutesAgo.getTime() + 90_000),
        createdAt: tenMinutesAgo,
      })),
    });
    expect((await qr(card.memberToken)).statusCode).toBe(429);

    // Codes older than an hour no longer count.
    await prisma.passCode.updateMany({ data: { createdAt: new Date(Date.now() - 61 * 60_000) } });
    expect((await qr(card.memberToken)).statusCode).toBe(200);
  });

  it('keeps the limit when the customer signs in again for a new token', async () => {
    const c = await merchant('owner-a');
    const card = await signUp(c);
    for (let i = 0; i < 10; i++) await qr(card.memberToken);
    await ageOtps();
    const again = await verifyPhone(c);
    expect(again.memberToken).not.toBe(card.memberToken);
    expect((await qr(again.memberToken)).statusCode).toBe(429);
  });

  it('limits each member separately', async () => {
    const c = await merchant('owner-a');
    const sara = await signUp(c);
    const other = await signUp(c, '+97455999888');
    for (let i = 0; i < 10; i++) await qr(sara.memberToken);
    expect((await qr(sara.memberToken)).statusCode).toBe(429);
    expect((await qr(other.memberToken)).statusCode).toBe(200);
  });
});
