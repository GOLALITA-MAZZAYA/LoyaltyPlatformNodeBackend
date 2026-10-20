-- CreateTable
CREATE TABLE "PassCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PassCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PassCode_codeHash_key" ON "PassCode"("codeHash");

-- CreateIndex
CREATE INDEX "PassCode_memberId_expiresAt_idx" ON "PassCode"("memberId", "expiresAt");

-- CreateIndex
CREATE INDEX "PassCode_merchantId_createdAt_idx" ON "PassCode"("merchantId", "createdAt");

-- AddForeignKey
ALTER TABLE "PassCode" ADD CONSTRAINT "PassCode_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
