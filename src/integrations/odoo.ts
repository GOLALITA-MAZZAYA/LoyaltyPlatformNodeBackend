import { z } from 'zod';
import { upstream } from '../lib/errors.js';

export interface OdooVendor {
  odooUserId: number;
  /** Odoo tracking_partner_id: the merchant this user belongs to */
  partnerId: number | null;
  name: string;
  /** main_member: the merchant's main account (owner) vs a sub-user */
  isMainMember: boolean;
  /** Field names in Odoo's reply (no values), for checking the mapping */
  fields: string[];
}

export interface OdooBranch {
  odooBranchId: number;
  name: string;
  nameAr: string | null;
}

export interface OdooClient {
  /** Returns null when Odoo rejects the token. Throws `odoo_unavailable` when Odoo can't be reached. */
  getVendorByToken(token: string): Promise<OdooVendor | null>;
  getBranches(token: string, partnerId: number): Promise<OdooBranch[]>;
}

// Odoo returns `false` for empty fields, so accept it wherever a value may be missing.
const vendorSchema = z.object({
  id: z.number(),
  name: z.union([z.string(), z.literal(false)]).optional(),
  tracking_partner_id: z.union([z.number(), z.string(), z.literal(false), z.null()]).optional(),
  main_member: z.boolean().optional(),
});

const branchSchema = z.object({
  id: z.number(),
  name: z.string(),
  x_name_arabic: z.union([z.string(), z.literal(false), z.null()]).optional(),
});

export class HttpOdooClient implements OdooClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  private async call(path: string, params: Record<string, unknown>): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw upstream('odoo_unavailable', 'Could not reach Golalita');
    }
    if (!res.ok) throw upstream('odoo_unavailable', `Golalita returned HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: unknown } | null;
    if (!body) throw upstream('odoo_unavailable', 'Golalita returned an invalid response');
    return body.result;
  }

  async getVendorByToken(token: string): Promise<OdooVendor | null> {
    const result = await this.call('/user/vendor/get_token_duplicate', { token });
    if (!result || typeof result !== 'object' || 'error' in result) return null;

    const parsed = vendorSchema.safeParse(result);
    if (!parsed.success) throw upstream('odoo_unavailable', 'Unexpected user data from Golalita');

    const v = parsed.data;
    const partnerId = v.tracking_partner_id ? Number(v.tracking_partner_id) : null;
    return {
      odooUserId: v.id,
      partnerId: partnerId && Number.isInteger(partnerId) ? partnerId : null,
      name: v.name || `User ${v.id}`,
      isMainMember: v.main_member === true,
      fields: Object.keys(result).sort(),
    };
  }

  async getBranches(token: string, partnerId: number): Promise<OdooBranch[]> {
    const result = await this.call('/merchant.branch/search', {
      token,
      domain: `[['partner_id', '=', ${Math.trunc(partnerId)}]]`,
      fields: "['name', 'id', 'x_name_arabic']",
    });
    if (!Array.isArray(result)) return [];
    return result.flatMap((row) => {
      const b = branchSchema.safeParse(row);
      return b.success ? [{ odooBranchId: b.data.id, name: b.data.name, nameAr: b.data.x_name_arabic || null }] : [];
    });
  }
}
