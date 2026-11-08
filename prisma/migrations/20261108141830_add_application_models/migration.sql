-- CreateTable
CREATE TABLE "caregiver_profile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "caregiver_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "senior_profile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "forwardingActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "senior_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_profile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "care_link" (
    "id" TEXT NOT NULL,
    "caregiverId" TEXT NOT NULL,
    "seniorId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "care_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "protection_number" (
    "id" TEXT NOT NULL,
    "seniorId" TEXT NOT NULL,
    "e164Number" TEXT NOT NULL,
    "personalNumber" TEXT NOT NULL,
    "signalwireId" TEXT,
    "provisioningState" TEXT NOT NULL DEFAULT 'none',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "protection_number_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "known_contact" (
    "id" TEXT NOT NULL,
    "seniorId" TEXT NOT NULL,
    "e164Number" TEXT NOT NULL,
    "displayName" VARCHAR(100),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "known_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_record" (
    "id" TEXT NOT NULL,
    "seniorId" TEXT NOT NULL,
    "protectionNumber" TEXT NOT NULL,
    "consentedAt" TIMESTAMP(3) NOT NULL,
    "withdrawn" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_record" (
    "id" TEXT NOT NULL,
    "seniorId" TEXT NOT NULL,
    "callerNumber" TEXT NOT NULL,
    "rawCallerNumber" TEXT,
    "normalizationFailed" BOOLEAN NOT NULL DEFAULT false,
    "knownContactName" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "screeningOutcome" TEXT NOT NULL,
    "riskCategory" TEXT,
    "riskScore" INTEGER,
    "disposition" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_report" (
    "id" TEXT NOT NULL,
    "callRecordId" TEXT NOT NULL,
    "statedPurpose" TEXT NOT NULL DEFAULT 'undetermined',
    "riskCategory" TEXT NOT NULL,
    "reasonText" TEXT NOT NULL,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_account" (
    "id" TEXT NOT NULL,
    "caregiverId" TEXT,
    "partnerId" TEXT,
    "stripeCustomerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription" (
    "id" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "seniorId" TEXT,
    "partnerId" TEXT,
    "state" TEXT NOT NULL,
    "monthlyPriceCents" INTEGER,
    "quantity" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_membership" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "seniorId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_webhook_event" (
    "id" TEXT NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "matched" BOOLEAN NOT NULL DEFAULT true,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_config" (
    "id" TEXT NOT NULL,
    "retentionDays" INTEGER NOT NULL DEFAULT 365,

    CONSTRAINT "retention_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "caregiver_profile_userId_key" ON "caregiver_profile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "senior_profile_userId_key" ON "senior_profile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "partner_profile_userId_key" ON "partner_profile"("userId");

-- CreateIndex
CREATE INDEX "care_link_caregiverId_active_idx" ON "care_link"("caregiverId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "care_link_caregiverId_seniorId_key" ON "care_link"("caregiverId", "seniorId");

-- CreateIndex
CREATE UNIQUE INDEX "protection_number_seniorId_key" ON "protection_number"("seniorId");

-- CreateIndex
CREATE UNIQUE INDEX "protection_number_e164Number_key" ON "protection_number"("e164Number");

-- CreateIndex
CREATE UNIQUE INDEX "known_contact_seniorId_e164Number_key" ON "known_contact"("seniorId", "e164Number");

-- CreateIndex
CREATE UNIQUE INDEX "consent_record_seniorId_key" ON "consent_record"("seniorId");

-- CreateIndex
CREATE INDEX "call_record_seniorId_startedAt_idx" ON "call_record"("seniorId", "startedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "call_report_callRecordId_key" ON "call_report"("callRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_account_caregiverId_key" ON "billing_account"("caregiverId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_account_partnerId_key" ON "billing_account"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_account_stripeCustomerId_key" ON "billing_account"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_stripeSubscriptionId_key" ON "subscription"("stripeSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_seniorId_key" ON "subscription"("seniorId");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_partnerId_key" ON "subscription"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "partner_membership_seniorId_key" ON "partner_membership"("seniorId");

-- CreateIndex
CREATE INDEX "partner_membership_partnerId_active_idx" ON "partner_membership"("partnerId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "processed_webhook_event_stripeEventId_key" ON "processed_webhook_event"("stripeEventId");

-- AddForeignKey
ALTER TABLE "caregiver_profile" ADD CONSTRAINT "caregiver_profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "senior_profile" ADD CONSTRAINT "senior_profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_profile" ADD CONSTRAINT "partner_profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "care_link" ADD CONSTRAINT "care_link_caregiverId_fkey" FOREIGN KEY ("caregiverId") REFERENCES "caregiver_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "care_link" ADD CONSTRAINT "care_link_seniorId_fkey" FOREIGN KEY ("seniorId") REFERENCES "senior_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protection_number" ADD CONSTRAINT "protection_number_seniorId_fkey" FOREIGN KEY ("seniorId") REFERENCES "senior_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "known_contact" ADD CONSTRAINT "known_contact_seniorId_fkey" FOREIGN KEY ("seniorId") REFERENCES "senior_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_seniorId_fkey" FOREIGN KEY ("seniorId") REFERENCES "senior_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_record" ADD CONSTRAINT "call_record_seniorId_fkey" FOREIGN KEY ("seniorId") REFERENCES "senior_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_report" ADD CONSTRAINT "call_report_callRecordId_fkey" FOREIGN KEY ("callRecordId") REFERENCES "call_record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_account" ADD CONSTRAINT "billing_account_caregiverId_fkey" FOREIGN KEY ("caregiverId") REFERENCES "caregiver_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_account" ADD CONSTRAINT "billing_account_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partner_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_seniorId_fkey" FOREIGN KEY ("seniorId") REFERENCES "senior_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partner_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_membership" ADD CONSTRAINT "partner_membership_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partner_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_membership" ADD CONSTRAINT "partner_membership_seniorId_fkey" FOREIGN KEY ("seniorId") REFERENCES "senior_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
