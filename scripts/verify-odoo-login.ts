// Checks a real merchant login against Odoo without saving or printing the token.
//   ODOO_BASE_URL=https://gcptest.golalita.com/go/api npx tsx scripts/verify-odoo-login.ts
// Paste the merchant app's Odoo token when asked (input is hidden). Touches no database.
import { stdin, stdout } from 'node:process';
import { HttpOdooClient } from '../src/integrations/odoo.js';

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    stdout.write(prompt);
    let value = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          return resolve(value.trim());
        }
        if (ch === '\u0003') process.exit(130);
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const baseUrl = process.env.ODOO_BASE_URL;
if (!baseUrl) {
  console.error('Set ODOO_BASE_URL, e.g. https://gcptest.golalita.com/go/api');
  process.exit(1);
}

const token = await readHidden(`Odoo token for ${baseUrl} (hidden): `);
if (!token) process.exit(1);

// Raw reply: show which fields exist, without values that could identify people.
const raw = await fetch(`${baseUrl}/user/vendor/get_token_duplicate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ params: { token } }),
}).then((r) => r.json() as Promise<{ result?: Record<string, unknown> }>);

const result = raw.result ?? {};
if ('error' in result) {
  console.log(`✗ Odoo rejected the token: ${String(result.error)}`);
  console.log('  Check that ODOO_BASE_URL is the same server the app is logged into.');
  process.exit(1);
}

console.log('\nFields in Odoo reply:');
for (const [k, v] of Object.entries(result).sort()) console.log(`  ${k}: ${v === false ? 'false' : typeof v}`);

const show = (k: string) => (k in result ? JSON.stringify(result[k]) : '(missing)');
console.log('\nFields the loyalty backend relies on:');
console.log(`  id                  = ${show('id')}`);
console.log(`  tracking_partner_id = ${show('tracking_partner_id')}   → merchant`);
console.log(`  main_member         = ${show('main_member')}   → true = owner, else cashier`);

const odoo = new HttpOdooClient(baseUrl, 10_000);
const vendor = await odoo.getVendorByToken(token);
console.log('\nHow the backend reads it:');
console.log(`  odooUserId=${vendor?.odooUserId} partnerId=${vendor?.partnerId} role=${vendor?.isMainMember ? 'owner' : 'cashier'} name=${vendor?.name}`);

if (vendor?.partnerId) {
  const branches = await odoo.getBranches(token, vendor.partnerId);
  console.log(`\nBranches from Odoo (${branches.length}):`);
  for (const b of branches) console.log(`  #${b.odooBranchId} ${b.name}${b.nameAr ? ` / ${b.nameAr}` : ''}`);
} else {
  console.log('\n✗ No tracking_partner_id: login would fail with not_a_merchant.');
}
