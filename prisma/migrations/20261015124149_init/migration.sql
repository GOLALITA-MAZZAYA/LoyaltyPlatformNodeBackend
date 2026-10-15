-- CreateEnum
CREATE TYPE "Role" AS ENUM ('owner', 'cashier');

-- CreateEnum
CREATE TYPE "ProgramStatus" AS ENUM ('draft', 'active', 'paused');

-- CreateEnum
CREATE TYPE "TierWindow" AS ENUM ('monthly', 'quarterly', 'lifetime');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('logo', 'banner', 'stamp_filled', 'stamp_empty');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('active', 'blocked');

-- CreateEnum
CREATE TYPE "MemberSource" AS ENUM ('branch_qr', 'cashier', 'other');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('earn', 'redeem', 'earn_and_redeem', 'void', 'adjust');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'done', 'failed');

-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "odooPartnerId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "merchantCode" TEXT NOT NULL,
    "loyaltyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Staff" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "odooUserId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "odooBranchId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "branchCode" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Program" (
    "merchantId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "ProgramStatus" NOT NULL DEFAULT 'draft',
    "pointsPerQar" DECIMAL(8,2) NOT NULL DEFAULT 1,
    "minBillForEarning" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "pointsNameEn" TEXT NOT NULL DEFAULT 'Points',
    "pointsNameAr" TEXT NOT NULL DEFAULT 'نقاط',
    "tierWindow" "TierWindow" NOT NULL DEFAULT 'monthly',
    "tierCarryOver" BOOLEAN NOT NULL DEFAULT false,
    "maxStampsPerTransaction" INTEGER NOT NULL DEFAULT 5,
    "invoiceRefRequired" BOOLEAN NOT NULL DEFAULT true,
    "allowPhoneLookup" BOOLEAN NOT NULL DEFAULT false,
    "phoneLookupDailyLimit" INTEGER NOT NULL DEFAULT 20,
    "termsEn" TEXT,
    "termsAr" TEXT,
    "termsVersion" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Program_pkey" PRIMARY KEY ("merchantId")
);

-- CreateTable
CREATE TABLE "Tier" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "isBase" BOOLEAN NOT NULL DEFAULT false,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "spendThreshold" DECIMAL(12,2) NOT NULL,
    "discountPercent" DECIMAL(5,2) NOT NULL,
    "punchEnabled" BOOLEAN NOT NULL DEFAULT true,
    "stampsRequired" INTEGER NOT NULL DEFAULT 10,
    "rewardDescEn" TEXT,
    "rewardDescAr" TEXT,
    "rewardMaxValue" DECIMAL(12,2),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Tier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardDesign" (
    "merchantId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "logoAssetId" TEXT,
    "bannerAssetId" TEXT,
    "stampFilledAssetId" TEXT,
    "stampEmptyAssetId" TEXT,
    "backgroundColor" TEXT NOT NULL DEFAULT '#FFFFFF',
    "foregroundColor" TEXT NOT NULL DEFAULT '#000000',
    "labelColor" TEXT NOT NULL DEFAULT '#666666',
    "cardTitleEn" TEXT,
    "cardTitleAr" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardDesign_pkey" PRIMARY KEY ("merchantId")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "email" TEXT,
    "birthDate" DATE,
    "status" "MemberStatus" NOT NULL DEFAULT 'active',
    "source" "MemberSource" NOT NULL DEFAULT 'branch_qr',
    "joinedBranchId" TEXT,
    "tierId" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "stamps" INTEGER NOT NULL DEFAULT 0,
    "windowSpend" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lifetimeSpend" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "rewardsRedeemed" INTEGER NOT NULL DEFAULT 0,
    "consentVersion" INTEGER NOT NULL,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "marketingOptIn" BOOLEAN NOT NULL DEFAULT false,
    "lastVisitAt" TIMESTAMP(3),
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberToken" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpRequest" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LookupToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "canRedeem" BOOLEAN NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LookupToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "invoiceRef" TEXT,
    "billAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tierId" TEXT,
    "tierDiscountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "pointsDelta" INTEGER NOT NULL DEFAULT 0,
    "stampsDelta" INTEGER NOT NULL DEFAULT 0,
    "rewardRedeemed" BOOLEAN NOT NULL DEFAULT false,
    "voidsTransactionId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "merchantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseCode" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("merchantId","key")
);

-- CreateTable
CREATE TABLE "WalletPass" (
    "memberId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "apple" BOOLEAN NOT NULL DEFAULT false,
    "google" BOOLEAN NOT NULL DEFAULT false,
    "syncStatus" TEXT NOT NULL DEFAULT 'ok',
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "WalletPass_pkey" PRIMARY KEY ("memberId")
);

-- CreateTable
CREATE TABLE "OutboxMessage" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttempt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "subjectId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_odooPartnerId_key" ON "Merchant"("odooPartnerId");

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_merchantCode_key" ON "Merchant"("merchantCode");

-- CreateIndex
CREATE UNIQUE INDEX "Staff_odooUserId_key" ON "Staff"("odooUserId");

-- CreateIndex
CREATE INDEX "Staff_merchantId_idx" ON "Staff"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_odooBranchId_key" ON "Branch"("odooBranchId");

-- CreateIndex
CREATE INDEX "Branch_merchantId_idx" ON "Branch"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_merchantId_branchCode_key" ON "Branch"("merchantId", "branchCode");

-- CreateIndex
CREATE INDEX "Tier_merchantId_rank_idx" ON "Tier"("merchantId", "rank");

-- CreateIndex
CREATE INDEX "Asset_merchantId_kind_idx" ON "Asset"("merchantId", "kind");

-- CreateIndex
CREATE INDEX "Member_merchantId_tierId_idx" ON "Member"("merchantId", "tierId");

-- CreateIndex
CREATE UNIQUE INDEX "Member_merchantId_phone_key" ON "Member"("merchantId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "MemberToken_tokenHash_key" ON "MemberToken"("tokenHash");

-- CreateIndex
CREATE INDEX "MemberToken_memberId_idx" ON "MemberToken"("memberId");

-- CreateIndex
CREATE INDEX "OtpRequest_phone_createdAt_idx" ON "OtpRequest"("phone", "createdAt");

-- CreateIndex
CREATE INDEX "OtpRequest_ip_createdAt_idx" ON "OtpRequest"("ip", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LookupToken_tokenHash_key" ON "LookupToken"("tokenHash");

-- CreateIndex
CREATE INDEX "LookupToken_staffId_createdAt_idx" ON "LookupToken"("staffId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_voidsTransactionId_key" ON "Transaction"("voidsTransactionId");

-- CreateIndex
CREATE INDEX "Transaction_merchantId_createdAt_idx" ON "Transaction"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "Transaction_memberId_createdAt_idx" ON "Transaction"("memberId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_merchantId_invoiceRef_key" ON "Transaction"("merchantId", "invoiceRef");

-- CreateIndex
CREATE INDEX "IdempotencyKey_createdAt_idx" ON "IdempotencyKey"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WalletPass_externalId_key" ON "WalletPass"("externalId");

-- CreateIndex
CREATE INDEX "OutboxMessage_status_nextAttempt_idx" ON "OutboxMessage"("status", "nextAttempt");

-- CreateIndex
CREATE INDEX "Event_merchantId_type_createdAt_idx" ON "Event"("merchantId", "type", "createdAt");

-- AddForeignKey
ALTER TABLE "Staff" ADD CONSTRAINT "Staff_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Program" ADD CONSTRAINT "Program_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tier" ADD CONSTRAINT "Tier_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardDesign" ADD CONSTRAINT "CardDesign_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "Tier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberToken" ADD CONSTRAINT "MemberToken_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletPass" ADD CONSTRAINT "WalletPass_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
