import crypto from 'node:crypto';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { Prisma } from '@prisma/client';
import { AppError, notFound } from '../../lib/errors.js';

type AwardResponse = {
  transaction: {
    id: string;
    type: string;
    stampsDelta: number;
    rewardRedeemed: boolean;
    invoiceRef: string | null;
    billAmount: string;
    createdAt: string;
  };
  member: {
    id: string;
    displayName: string;
    stamps: number;
    stampsRequired: number;
    rewardAvailable: boolean;
    rewardsRedeemed: number;
  };
};

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

/** NFKC, Arabic-Indic digits to 0–9, no spaces, uppercase: " pos-000 123 " → "POS-000123". */
export function normaliseInvoice(raw: string) {
  return raw
    .normalize('NFKC')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\s+/g, '')
    .toUpperCase();
}

/** +97455123456 → +974 •••• 3456 */
export const maskPhone = (phone: string) => phone.replace(/^(\+\d{3})\d+(\d{4})$/, '$1 •••• $2');

const codeUsed = () =>
  new AppError(409, 'code_used', 'This customer QR was already used. Ask the customer to refresh.', {
    messageAr: 'تم استخدام هذا الرمز من قبل، يرجى طلب تحديث الرمز من العميل',
  });

const programNotActive = () =>
  new AppError(409, 'program_not_active', 'The loyalty program is not active', {
    messageAr: 'برنامج الولاء غير مفعل',
  });

export const counterRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.requireLoyalty);

  // POST /scan/lookup
  app.post(
    '/scan/lookup',
    {
      schema: {
        body: z.object({
          code: z.string().min(1),
          branchId: z.string().min(1),
        }),
      },
    },
    async (req) => {
      const { code, branchId } = req.body;
      const merchantId = req.auth.mid;

      // 1. Verify branch belongs to caller's merchant and is active
      const branch = await app.prisma.branch.findFirst({
        where: { id: branchId, merchantId, active: true },
      });
      if (!branch) {
        throw new AppError(422, 'branch_invalid', 'Branch is invalid or not active for your business', {
          messageAr: 'الفرع غير صالح أو غير مفعل لمنشأتك',
        });
      }

      // 2. Code must start with glp1.
      if (!code.startsWith('glp1.')) {
        throw new AppError(404, 'code_not_found', 'Invalid loyalty pass code', {
          messageAr: 'رمز بطاقة الولاء غير صالح',
        });
      }

      // 3. Find pass code by SHA-256 hash
      const codeHash = crypto.createHash('sha256').update(code).digest('hex');
      const passCode = await app.prisma.passCode.findUnique({
        where: { codeHash },
      });

      if (!passCode) {
        throw new AppError(404, 'code_not_found', 'Pass code not found or expired', {
          messageAr: 'رمز البطاقة غير موجود أو منتهي الصلاحية',
        });
      }

      if (passCode.merchantId !== merchantId) {
        throw new AppError(409, 'wrong_merchant', 'This card belongs to another business', {
          messageAr: 'هذه البطاقة تابعة لمنشأة أخرى',
        });
      }

      if (passCode.usedAt) {
        throw new AppError(409, 'code_used', 'This single-use code has already been scanned', {
          messageAr: 'تم استخدام هذا الرمز من قبل',
        });
      }

      if (passCode.expiresAt < new Date()) {
        throw new AppError(410, 'code_expired', 'This pass code has expired. Ask customer to refresh.', {
          messageAr: 'انتهت صلاحية الرمز، يرجى طلب تحديث الشاشة من العميل',
        });
      }

      // 4. Find member
      const member = await app.prisma.member.findUnique({
        where: { id: passCode.memberId },
        include: { tier: true },
      });

      if (!member) {
        throw new AppError(404, 'member_not_found', 'Member record not found', {
          messageAr: 'بيانات العضو غير موجودة',
        });
      }

      if (member.status !== 'active') {
        throw new AppError(409, 'member_blocked', 'This member card is blocked or inactive', {
          messageAr: 'بطاقة العميل موقوفة أو غير مفعلة',
        });
      }

      // 5. Get merchant program rules
      const program = await app.prisma.program.findUnique({
        where: { merchantId },
      });
      if (program?.status !== 'active') throw programNotActive();

      // 6. Issue single-use lookup token (valid 5 minutes)
      const rawLookupToken = 'lk_' + crypto.randomBytes(24).toString('base64url');
      const lookupTokenHash = crypto.createHash('sha256').update(rawLookupToken).digest('hex');
      const lookupTokenExpiresAt = new Date(Date.now() + 5 * 60 * 1000);

      await app.prisma.lookupToken.create({
        data: {
          tokenHash: lookupTokenHash,
          merchantId,
          memberId: member.id,
          branchId,
          staffId: req.auth.sub,
          passCodeId: passCode.id,
          canRedeem: true,
          expiresAt: lookupTokenExpiresAt,
        },
      });

      const stampsRequired = member.tier.punchEnabled ? member.tier.stampsRequired : 10;
      const isOwner = req.auth.role === 'owner';

      return {
        lookupToken: rawLookupToken,
        lookupTokenExpiresAt: lookupTokenExpiresAt.toISOString(),
        canRedeem: true,
        member: {
          id: member.id,
          displayName: `${member.firstName}${member.lastName ? ' ' + member.lastName : ''}`,
          phoneMasked: isOwner ? member.phone : maskPhone(member.phone),
        },
        tier: {
          id: member.tier.id,
          nameEn: member.tier.nameEn,
          nameAr: member.tier.nameAr,
          color: member.tier.color,
          discountPercent: Number(member.tier.discountPercent),
        },
        stamps: member.stamps,
        stampsRequired,
        rewardAvailable: member.tier.punchEnabled && member.stamps >= stampsRequired,
        rewardDescriptionEn: member.tier.rewardDescEn,
        rewardDescriptionAr: member.tier.rewardDescAr,
        rewardMaxValue: member.tier.rewardMaxValue ? Number(member.tier.rewardMaxValue).toFixed(2) : null,
        rules: {
          maxStampsPerTransaction: program?.maxStampsPerTransaction ?? 5,
          invoiceRefRequired: program?.invoiceRefRequired ?? true,
        },
      };
    },
  );

  // POST /transactions — one database transaction per bill (docs/loyalty-scanner-spec.md, "Award transaction").
  app.post(
    '/transactions',
    {
      schema: {
        headers: z.object({ 'idempotency-key': z.string().uuid() }).passthrough(),
        body: z.object({
          lookupToken: z.string().min(1).max(200),
          branchId: z.string().min(1),
          invoiceRef: z.string().max(100).optional().nullable(),
          billAmount: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/),
          stampItems: z.number().int().min(0).max(100),
          redeemStampReward: z.boolean().default(false),
          note: z.string().max(255).optional().nullable(),
        }),
      },
    },
    async (req, reply) => {
      const merchantId = req.auth.mid;
      const staffId = req.auth.sub;
      const key = req.headers['idempotency-key'] as string;
      const body = req.body;
      const requestHash = sha256(JSON.stringify({ staffId, body }));

      // Step 1: validate everything that needs no database.
      // A blank receipt counts as no receipt.
      const invoiceRef = (body.invoiceRef ? normaliseInvoice(body.invoiceRef) : '') || null;
      if (invoiceRef !== null && invoiceRef.length > 40) {
        throw new AppError(422, 'invoice_invalid', 'Receipt number must be 1–40 characters', {
          messageAr: 'رقم الفاتورة يجب أن يكون من 1 إلى 40 حرفاً',
        });
      }
      if (body.stampItems === 0 && !body.redeemStampReward) {
        throw new AppError(422, 'nothing_to_record', 'Award at least 1 stamp or redeem a reward', {
          messageAr: 'يرجى تحديد ختم واحد على الأقل أو استلام مكافأة',
        });
      }

      let outcome: { replay: true; body: unknown } | { replay: false; body: AwardResponse };
      try {
        outcome = await app.prisma.$transaction(async (tx) => {
          // Step 3: claim the idempotency key. A parallel request with the same key waits here.
          const inserted = await tx.$executeRaw`
            INSERT INTO "IdempotencyKey" ("merchantId", "key", "requestHash", "responseCode", "responseBody")
            VALUES (${merchantId}, ${key}, ${requestHash}, 0, '{}'::jsonb)
            ON CONFLICT DO NOTHING`;
          if (inserted === 0) {
            const existing = await tx.idempotencyKey.findUniqueOrThrow({ where: { merchantId_key: { merchantId, key } } });
            if (existing.requestHash !== requestHash) {
              throw new AppError(422, 'idempotency_mismatch', 'This request key was already used for a different sale', {
                messageAr: 'تم استخدام مفتاح الطلب لعملية مختلفة',
              });
            }
            return { replay: true as const, body: existing.responseBody };
          }

          // Step 4: consume the lookup token (conditional update, so only one request can win).
          const lookupTokenHash = sha256(body.lookupToken);
          const now = new Date();
          const consumed = await tx.lookupToken.updateMany({
            where: { tokenHash: lookupTokenHash, merchantId, usedAt: null, expiresAt: { gt: now } },
            data: { usedAt: now },
          });
          const lookup = await tx.lookupToken.findUnique({ where: { tokenHash: lookupTokenHash } });
          if (consumed.count === 0 || !lookup || lookup.merchantId !== merchantId) {
            if (lookup && lookup.merchantId === merchantId && lookup.usedAt) {
              throw new AppError(409, 'lookup_used', 'This scan was already used. Please scan again.', {
                messageAr: 'تم استخدام هذا المسح، يرجى إعادة المسح',
              });
            }
            throw new AppError(409, 'lookup_expired', 'Scan session expired. Please scan again.', {
              messageAr: 'انتهت جلسة المسح، يرجى إعادة المسح',
            });
          }
          if (lookup.branchId !== body.branchId) {
            throw new AppError(409, 'lookup_branch_mismatch', 'Branch does not match the scan session', {
              messageAr: 'الفرع غير متطابق مع جلسة المسح',
            });
          }
          if (lookup.staffId !== staffId) {
            throw new AppError(409, 'lookup_staff_mismatch', 'This scan was made by another user. Please scan again.', {
              messageAr: 'تم هذا المسح بواسطة مستخدم آخر، يرجى إعادة المسح',
            });
          }

          // Step 5: the branch must still be active.
          const branch = await tx.branch.findFirst({ where: { id: body.branchId, merchantId, active: true } });
          if (!branch) {
            throw new AppError(422, 'branch_invalid', 'Branch is invalid or not active for your business', {
              messageAr: 'الفرع غير صالح أو غير مفعل لمنشأتك',
            });
          }

          // Step 6: use the customer's QR once. A second till waits on the row, then gets code_used.
          if (!lookup.passCodeId) throw new AppError(409, 'lookup_expired', 'Scan session expired. Please scan again.');
          const codeUse = await tx.passCode.updateMany({
            where: { id: lookup.passCodeId, merchantId, usedAt: null },
            data: { usedAt: now },
          });
          if (codeUse.count === 0) throw codeUsed();

          // Step 7: lock the member so awards for one member run one after another.
          await tx.$queryRaw`SELECT id FROM "Member" WHERE id = ${lookup.memberId} AND "merchantId" = ${merchantId} FOR UPDATE`;
          const member = await tx.member.findFirst({ where: { id: lookup.memberId, merchantId }, include: { tier: true } });
          if (!member || member.status !== 'active') {
            throw new AppError(409, 'member_blocked', 'Member is inactive or blocked', {
              messageAr: 'حساب العميل موقوف أو غير نشط',
            });
          }
          const program = await tx.program.findUnique({ where: { merchantId } });
          if (program?.status !== 'active') throw programNotActive();

          // Step 9: rules and the result, computed on the server only.
          if (program.invoiceRefRequired && !invoiceRef && body.stampItems > 0) {
            throw new AppError(422, 'invoice_required', 'Receipt number is required', { messageAr: 'رقم الفاتورة مطلوب' });
          }
          if (body.stampItems > program.maxStampsPerTransaction) {
            throw new AppError(422, 'stamps_over_limit', `At most ${program.maxStampsPerTransaction} stamps per sale`, {
              messageAr: `الحد الأقصى للأختام في المعاملة الواحدة هو ${program.maxStampsPerTransaction}`,
            });
          }
          const tier = member.tier;
          const R = tier.stampsRequired;
          const n = body.stampItems;
          if (!tier.punchEnabled) {
            throw new AppError(409, 'punch_not_enabled', 'Stamp card is not enabled for this tier', {
              messageAr: 'بطاقة الأختام غير مفعلة لهذه الفئة',
            });
          }
          if (body.redeemStampReward && member.stamps + n < R) {
            throw new AppError(409, 'reward_not_eligible', 'Not enough stamps to redeem the reward', {
              messageAr: 'العميل لا يمتلك أختاماً كافية لاستلام المكافأة',
            });
          }
          const redeem = body.redeemStampReward;
          const stampsDelta = redeem ? n - R : n;
          const type = redeem ? (n > 0 ? 'earn_and_redeem' : 'redeem') : 'earn';
          const newStamps = member.stamps + stampsDelta;
          const newRewardsRedeemed = member.rewardsRedeemed + (redeem ? 1 : 0);

          // Step 11: the ledger row (single QR and lookup use are also enforced by unique indexes).
          const transaction = await tx.transaction.create({
            data: {
              merchantId,
              memberId: member.id,
              branchId: body.branchId,
              staffId,
              type,
              invoiceRef,
              billAmount: new Prisma.Decimal(body.billAmount),
              tierId: member.tierId,
              tierDiscountPercent: tier.discountPercent,
              discountAmount: new Prisma.Decimal('0.00'),
              pointsDelta: 0,
              stampsDelta,
              rewardRedeemed: redeem,
              lookupTokenId: lookup.id,
              passCodeId: lookup.passCodeId,
              note: body.note ?? null,
            },
          });

          // Step 10: claim the receipt (primary key conflict → duplicate_invoice).
          if (invoiceRef) {
            await tx.invoiceClaim.create({
              data: { merchantId, scopeBranchId: body.branchId, invoiceRef, transactionId: transaction.id },
            });
          }

          // Step 12: the member's cached totals.
          await tx.member.update({
            where: { id: member.id },
            data: { stamps: newStamps, rewardsRedeemed: newRewardsRedeemed, lastVisitAt: now },
          });

          // Step 13: audit event (no codes, tokens or phone numbers).
          await tx.event.create({
            data: {
              merchantId,
              type: 'transaction.created',
              actorType: 'staff',
              actorId: staffId,
              subjectId: transaction.id,
              payload: { memberId: member.id, branchId: body.branchId, type, stampsDelta, rewardRedeemed: redeem },
            },
          });

          const response: AwardResponse = {
            transaction: {
              id: transaction.id,
              type: transaction.type,
              stampsDelta: transaction.stampsDelta,
              rewardRedeemed: transaction.rewardRedeemed,
              invoiceRef: transaction.invoiceRef,
              billAmount: Number(transaction.billAmount).toFixed(2),
              createdAt: transaction.createdAt.toISOString(),
            },
            member: {
              id: member.id,
              displayName: `${member.firstName}${member.lastName ? ' ' + member.lastName : ''}`,
              stamps: newStamps,
              stampsRequired: R,
              rewardAvailable: newStamps >= R,
              rewardsRedeemed: newRewardsRedeemed,
            },
          };

          // Step 14: store the result under the key; it commits together with everything above.
          await tx.idempotencyKey.update({
            where: { merchantId_key: { merchantId, key } },
            data: { responseCode: 201, responseBody: response as unknown as Prisma.InputJsonValue },
          });
          return { replay: false as const, body: response };
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const target = JSON.stringify(err.meta?.target ?? '');
          if (target.includes('invoiceRef')) {
            throw new AppError(409, 'duplicate_invoice', 'This receipt is already recorded at this branch', {
              messageAr: 'تم تسجيل رقم الفاتورة هذا مسبقاً',
            });
          }
          if (target.includes('passCodeId')) throw codeUsed();
          if (target.includes('lookupTokenId')) throw new AppError(409, 'lookup_used', 'This scan was already used.');
        }
        throw err;
      }

      return reply.code(outcome.replay ? 200 : 201).send(outcome.body);
    },
  );

  // POST /transactions/:id/void — owner only; an append-only reversal row (docs/loyalty-scanner-spec.md, "Reversals").
  app.post(
    '/transactions/:id/void',
    {
      preHandler: app.requireRole('owner'),
      schema: {
        params: z.object({ id: z.string().min(1).max(64) }),
        body: z.object({ reason: z.string().trim().min(3).max(200) }),
      },
    },
    async (req) => {
      const merchantId = req.auth.mid;
      const staffId = req.auth.sub;
      const { reason } = req.body;
      const alreadyVoided = () =>
        new AppError(409, 'already_voided', 'This transaction was already reversed', {
          messageAr: 'تم عكس هذه المعاملة مسبقاً',
        });

      try {
        return await app.prisma.$transaction(async (tx) => {
          const original = await tx.transaction.findFirst({ where: { id: req.params.id, merchantId } });
          if (!original) throw notFound('transaction_not_found', 'Transaction not found');
          if (original.type === 'void') {
            throw new AppError(409, 'cannot_void_reversal', 'A reversal cannot be reversed. Record a new transaction instead.', {
              messageAr: 'لا يمكن عكس عملية العكس، يرجى تسجيل معاملة جديدة',
            });
          }

          // Lock the member, like an award, so balances change one at a time.
          await tx.$queryRaw`SELECT id FROM "Member" WHERE id = ${original.memberId} AND "merchantId" = ${merchantId} FOR UPDATE`;
          if (await tx.transaction.findUnique({ where: { voidsTransactionId: original.id } })) throw alreadyVoided();
          const member = await tx.member.findUniqueOrThrow({ where: { id: original.memberId }, include: { tier: true } });

          const stampsDelta = -original.stampsDelta;
          const newStamps = member.stamps + stampsDelta;
          const newRewardsRedeemed = member.rewardsRedeemed - (original.rewardRedeemed ? 1 : 0);
          if (newStamps < 0 || newRewardsRedeemed < 0) {
            throw new AppError(409, 'void_would_go_negative', 'These stamps were already used for a later reward. Reverse that redemption first.', {
              messageAr: 'تم استخدام هذه الأختام في مكافأة لاحقة، يرجى عكس عملية الاستلام أولاً',
            });
          }

          const reversal = await tx.transaction.create({
            data: {
              merchantId,
              memberId: original.memberId,
              branchId: original.branchId,
              staffId,
              type: 'void',
              invoiceRef: original.invoiceRef,
              billAmount: original.billAmount.negated(),
              tierId: original.tierId,
              tierDiscountPercent: original.tierDiscountPercent,
              discountAmount: original.discountAmount.negated(),
              pointsDelta: -original.pointsDelta,
              stampsDelta,
              // Mirrors the original so the reward counter can be reversed.
              rewardRedeemed: original.rewardRedeemed,
              voidsTransactionId: original.id,
              reason,
            },
          });

          // Release the receipt so a corrected entry can use it. Pass code and lookup stay used.
          await tx.invoiceClaim.deleteMany({ where: { transactionId: original.id } });

          await tx.member.update({
            where: { id: member.id },
            data: { stamps: newStamps, rewardsRedeemed: newRewardsRedeemed },
          });

          await tx.event.create({
            data: {
              merchantId,
              type: 'transaction.voided',
              actorType: 'staff',
              actorId: staffId,
              subjectId: reversal.id,
              payload: { voidsTransactionId: original.id, memberId: member.id, stampsDelta, reason },
            },
          });

          const R = member.tier.stampsRequired;
          return {
            transaction: {
              id: reversal.id,
              type: reversal.type,
              stampsDelta: reversal.stampsDelta,
              rewardRedeemed: reversal.rewardRedeemed,
              invoiceRef: reversal.invoiceRef,
              billAmount: Number(reversal.billAmount).toFixed(2),
              voidsTransactionId: original.id,
              reason,
              createdAt: reversal.createdAt.toISOString(),
            },
            member: {
              id: member.id,
              displayName: `${member.firstName}${member.lastName ? ' ' + member.lastName : ''}`,
              stamps: newStamps,
              stampsRequired: R,
              rewardAvailable: member.tier.punchEnabled && newStamps >= R,
              rewardsRedeemed: newRewardsRedeemed,
            },
          };
        });
      } catch (err) {
        // Two voids raced: the unique voidsTransactionId stops the second.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw alreadyVoided();
        throw err;
      }
    },
  );

  // GET /transactions (Recent ledger history)
  app.get(
    '/transactions',
    {
      schema: {
        querystring: z.object({
          memberId: z.string().optional(),
          branchId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
    },
    async (req) => {
      const merchantId = req.auth.mid;
      const { memberId, branchId, limit } = req.query;

      const items = await app.prisma.transaction.findMany({
        where: {
          merchantId,
          ...(memberId && { memberId }),
          ...(branchId && { branchId }),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: {
          member: {
            select: { id: true, firstName: true, lastName: true, phone: true },
          },
        },
      });

      const isOwner = req.auth.role === 'owner';
      return {
        items: items.map((t) => ({
          id: t.id,
          type: t.type,
          stampsDelta: t.stampsDelta,
          rewardRedeemed: t.rewardRedeemed,
          invoiceRef: t.invoiceRef,
          billAmount: Number(t.billAmount).toFixed(2),
          voidsTransactionId: t.voidsTransactionId,
          reason: t.reason,
          createdAt: t.createdAt.toISOString(),
          member: {
            id: t.member.id,
            displayName: `${t.member.firstName}${t.member.lastName ? ' ' + t.member.lastName : ''}`,
            phoneMasked: isOwner ? t.member.phone : maskPhone(t.member.phone),
          },
        })),
      };
    },
  );
};
