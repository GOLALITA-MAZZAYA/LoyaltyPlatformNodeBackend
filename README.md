# Golalita Loyalty Platform

Backend for merchant-owned loyalty programs: points, tiers, punch cards, branch sign-up QR codes and wallet passes.

- **Merchant app** (GolalitaMerchant, "Loyalty Program" section) manages the program and scans members at the counter.
- **Customer sign-up website** (opened from the branch QR) enrols members and hands out wallet passes.
- **wallet-api** (`wallet-api.golalitatwffer.com`) issues and updates the passes. Only this backend calls it.

Loyalty members belong to one merchant and are never linked to Golalita customers.

The API contract is [`openapi/openapi.yaml`](openapi/openapi.yaml). Change the contract first, then the code.

## Stack

Node 22+, TypeScript, Fastify 5, Prisma + PostgreSQL, zod, Vitest.

## Getting started

```bash
cp .env.example .env            # set DATABASE_URL user and a random JWT_SECRET
createdb loyalty_dev
createdb loyalty_test
npm install
npm run db:migrate              # apply migrations to loyalty_dev
npm run dev                     # http://localhost:4000
npm test                        # uses loyalty_test (override with TEST_DATABASE_URL)
```

Generate a secret: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`

## How merchant login works

The merchant app already holds an Odoo token. It calls `POST /v1/auth/exchange { odooToken }`.
This server checks the token with Odoo (`/user/vendor/get_token_duplicate`), takes the merchant from
Odoo's `tracking_partner_id` and the role from `main_member` (`owner` / `cashier`), and returns:

- an access token (JWT, 15 min) for `Authorization: Bearer …`
- a refresh token (30 days, single use; reusing an old one logs that device out)

The app never sends a merchant id; it always comes from Odoo.

## Layout

```
openapi/openapi.yaml        API contract
prisma/schema.prisma        data model (all tables, including ones not used by code yet)
src/
  app.ts                    builds the Fastify app (inject Prisma/Odoo for tests)
  server.ts                 process entry point
  config/env.ts             environment validation
  lib/                      errors (problem+json), tokens, public codes
  plugins/                  prisma, auth (authenticate / requireRole / requireLoyalty)
  integrations/odoo.ts      Odoo client (token check, branches)
  modules/<area>/           routes + service per API area
test/                       Vitest + fake Odoo
```

## Conventions

- Errors are RFC 9457 `application/problem+json` with a stable `code` and an Arabic `messageAr`.
- Every merchant-owned query filters by `merchantId` from the token.
- Money is `Decimal(12,2)` in the database and a two-decimal string in the API.
- The transaction ledger is append-only; corrections are `void` rows.
- Side effects on other systems (wallet pass updates) go through `OutboxMessage`, written in the same DB transaction.

## Status

| Area | Status |
|---|---|
| Auth exchange / refresh / logout, `GET /merchant/me` | Done, tested |
| Branch sync from Odoo (on first login) | Done, tested |
| Program, tiers, card design, assets | Not started (tables exist) |
| Branch QR, public sign-up + OTP | Not started |
| Counter lookup, transactions, void | Not started |
| Members | Not started |
| wallet-api client + outbox worker | Blocked on wallet-api capabilities |

Still to confirm: what Odoo's token check returns for a real merchant login (field names are taken from the merchant app's code), members per merchant vs per branch, and wallet-api capabilities.
