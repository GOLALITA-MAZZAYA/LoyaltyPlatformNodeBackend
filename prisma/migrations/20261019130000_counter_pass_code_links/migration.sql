-- DropIndex
DROP INDEX "Transaction_merchantId_invoiceRef_key";

-- AlterTable
ALTER TABLE "LookupToken" ADD COLUMN     "passCodeId" TEXT;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "lookupTokenId" TEXT,
ADD COLUMN     "passCodeId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_lookupTokenId_key" ON "Transaction"("lookupTokenId");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_passCodeId_key" ON "Transaction"("passCodeId");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_merchantId_branchId_invoiceRef_key" ON "Transaction"("merchantId", "branchId", "invoiceRef");

