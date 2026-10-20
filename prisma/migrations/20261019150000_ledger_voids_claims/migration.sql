-- Ledger hardening for voids (docs/loyalty-scanner-spec.md, "Constraints the database enforces").

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "reason" TEXT;

-- CreateTable
CREATE TABLE "InvoiceClaim" (
    "merchantId" TEXT NOT NULL,
    "scopeBranchId" TEXT NOT NULL,
    "invoiceRef" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceClaim_pkey" PRIMARY KEY ("merchantId","scopeBranchId","invoiceRef")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceClaim_transactionId_key" ON "InvoiceClaim"("transactionId");

-- Receipts already recorded keep their claim (per-branch scope; no void rows exist yet).
INSERT INTO "InvoiceClaim" ("merchantId", "scopeBranchId", "invoiceRef", "transactionId", "createdAt")
SELECT "merchantId", "branchId", "invoiceRef", "id", "createdAt"
FROM "Transaction"
WHERE "invoiceRef" IS NOT NULL AND "type" <> 'void';

-- Receipt uniqueness now lives in InvoiceClaim.
DROP INDEX "Transaction_merchantId_branchId_invoiceRef_key";

-- No negative balances from any bug.
ALTER TABLE "Member" ADD CONSTRAINT "Member_balances_non_negative"
  CHECK ("stamps" >= 0 AND "points" >= 0 AND "rewardsRedeemed" >= 0);

-- Type and delta must agree.
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_type_delta_check" CHECK (
  ("type" <> 'earn' OR ("stampsDelta" > 0 AND NOT "rewardRedeemed"))
  AND ("type" <> 'redeem' OR ("stampsDelta" < 0 AND "rewardRedeemed"))
  AND ("type" <> 'earn_and_redeem' OR "rewardRedeemed")
  AND ("type" <> 'void' OR ("voidsTransactionId" IS NOT NULL AND "reason" IS NOT NULL))
);

-- The ledger is append-only: history can't be edited or deleted.
CREATE FUNCTION "transaction_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Transaction rows are append-only; record a void instead'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "transaction_no_update_delete"
  BEFORE UPDATE OR DELETE ON "Transaction"
  FOR EACH ROW EXECUTE FUNCTION "transaction_append_only"();
