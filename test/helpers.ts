import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { DevSmsSender, type SmsSender } from '../src/integrations/sms.js';
import type { OdooBranch, OdooClient, OdooVendor } from '../src/integrations/odoo.js';

export const prisma = new PrismaClient();

/** In-memory stand-in for Odoo: tokens map to vendors, partners map to branches. */
export class FakeOdoo implements OdooClient {
  vendors = new Map<string, OdooVendor>();
  branches = new Map<number, OdooBranch[]>();
  failBranches = false;

  async getVendorByToken(token: string) {
    return this.vendors.get(token) ?? null;
  }

  async getBranches(_token: string, partnerId: number) {
    if (this.failBranches) throw new Error('odoo down');
    return this.branches.get(partnerId) ?? [];
  }
}

export async function buildTestApp(odoo = new FakeOdoo(), sms: SmsSender = new DevSmsSender()) {
  const app = await buildApp({ prisma, odoo, sms });
  await app.ready();
  return { app, odoo };
}

export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) {
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);
  }
}
