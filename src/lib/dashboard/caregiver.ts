/**
 * Server-side data loaders for the Caregiver_Dashboard (Req 9).
 *
 * These run inside the authenticated request (React Server Components) and read
 * directly through Prisma — no client-side fetching (workspace rule: favor
 * RSC/SSR). Every per-Senior read is scoped by {@link assertCareLink} so a
 * Caregiver can only see data for a Senior they hold an active Care_Link to
 * (Req 9.4); an unauthorized request throws {@link AuthorizationError} and
 * returns no Senior data.
 *
 * All exports are arrow-function consts with named exports and prefer
 * interfaces over type aliases (workspace Next.js rules).
 */

import { assertCareLink } from "@/lib/authz";
import {
  PROVISIONING_STATES,
  SUBSCRIPTION_STATES,
  type CallDisposition,
  type ProvisioningState,
  type RiskCategory,
  type SubscriptionState,
} from "@/lib/constants";
import { prisma } from "@/lib/prisma";

/** A single linked Senior shown in the dashboard's Senior list (Req 9.1). */
export interface LinkedSenior {
  /** The `SeniorProfile.id`. */
  readonly id: string;
  /** The Senior's display name, or `null` when the account has none. */
  readonly name: string | null;
  /** The Senior's account email. */
  readonly email: string;
}

/** A Call_Record row rendered in the selected Senior's call history (Req 9.3). */
export interface CallRecordView {
  readonly id: string;
  /** Normalized E.164 caller number, or the raw value on normalization failure. */
  readonly callerNumber: string;
  /** Known_Contact display name stamped at call time, when one matched. */
  readonly knownContactName: string | null;
  /** Call start timestamp (UTC). */
  readonly startedAt: Date;
  /** Call end timestamp (UTC), or `null` when the call did not complete. */
  readonly endedAt: Date | null;
  readonly screeningOutcome: string;
  readonly riskCategory: RiskCategory | null;
  readonly riskScore: number | null;
  readonly disposition: CallDisposition;
  /** The AI Call_Report for this call, when one is available (Req 9.3). */
  readonly report: CallReportView | null;
}

/** An AI Call_Report shown alongside its Call_Record (Req 9.3, 8.2). */
export interface CallReportView {
  readonly statedPurpose: string;
  readonly riskCategory: RiskCategory;
  readonly reasonText: string;
  /** False when report generation failed and the report is unavailable (Req 8.6). */
  readonly available: boolean;
}

/** A Known_Contact row with the controls to remove it (Req 9.3, 9.6). */
export interface KnownContactView {
  readonly id: string;
  readonly e164Number: string;
  readonly displayName: string | null;
}

/** The Protection_Number provisioning status presented for the Senior (Req 9.8). */
export interface ProtectionNumberView {
  /** Exactly one of {@link PROVISIONING_STATES} (Req 9.8). */
  readonly provisioningState: ProvisioningState;
  /** The provisioned E.164 Protection_Number, or `null` when none exists. */
  readonly e164Number: string | null;
}

/** The Subscription state shown for the selected Senior (Req 9.3). */
export interface SubscriptionView {
  /** Current Subscription state, or `null` when the Senior has no Subscription. */
  readonly state: SubscriptionState | null;
  /** Monthly price snapshot in cents, or `null` when unknown. */
  readonly monthlyPriceCents: number | null;
}

/** The full detail payload for a selected, linked Senior (Req 9.3). */
export interface SeniorDetail {
  readonly senior: LinkedSenior;
  readonly callRecords: readonly CallRecordView[];
  readonly knownContacts: readonly KnownContactView[];
  readonly protectionNumber: ProtectionNumberView;
  readonly subscription: SubscriptionView;
}

/**
 * Narrows a stored `provisioningState` string to a {@link ProvisioningState},
 * defaulting to `none` for any unexpected value so the dashboard always renders
 * exactly one defined provisioning state (Req 9.8).
 */
const toProvisioningState = (value: string): ProvisioningState => {
  const known = Object.values(PROVISIONING_STATES) as readonly string[];
  return known.includes(value)
    ? (value as ProvisioningState)
    : PROVISIONING_STATES.none;
};

/**
 * Narrows a stored `state` string to a {@link SubscriptionState}, or `null`
 * when it is absent or unrecognized.
 */
const toSubscriptionState = (value: string | null | undefined): SubscriptionState | null => {
  if (!value) return null;
  const known = Object.values(SUBSCRIPTION_STATES) as readonly string[];
  return known.includes(value) ? (value as SubscriptionState) : null;
};

/**
 * Narrows a stored `riskCategory` string to a {@link RiskCategory}, or `null`
 * when it is absent or unrecognized.
 */
const toRiskCategory = (value: string | null | undefined): RiskCategory | null => {
  if (!value) return null;
  const known: readonly string[] = ["Known", "Allowed", "Spam", "Fraud"];
  return known.includes(value) ? (value as RiskCategory) : null;
};

/**
 * Loads the list of Seniors to whom the Caregiver holds an active Care_Link
 * (Req 9.1). Returns an empty array when none are linked, so the dashboard can
 * render the empty state without treating "no seniors" as an error (Req 9.2).
 */
export const loadLinkedSeniors = async (
  caregiverUserId: string,
): Promise<readonly LinkedSenior[]> => {
  const caregiver = await prisma.caregiverProfile.findUnique({
    where: { userId: caregiverUserId },
    select: { id: true },
  });

  // No CaregiverProfile means no links; render the empty state (Req 9.2).
  if (!caregiver) return [];

  const links = await prisma.careLink.findMany({
    where: { caregiverId: caregiver.id, active: true },
    orderBy: { createdAt: "asc" },
    select: {
      senior: {
        select: {
          id: true,
          user: { select: { name: true, email: true } },
        },
      },
    },
  });

  return links.map((link) => ({
    id: link.senior.id,
    name: link.senior.user.name ?? null,
    email: link.senior.user.email,
  }));
};

/**
 * Loads the full dashboard detail for a single Senior the Caregiver has
 * selected, scoped by {@link assertCareLink} (Req 9.3, 9.4).
 *
 * Throws {@link AuthorizationError} when no active Care_Link exists between the
 * Caregiver and the Senior; the caller surfaces that as "not linked" and shows
 * no data for that Senior (Req 9.4). On success returns the Senior's
 * Call_Records (newest first) with their Call_Reports, Known_Contacts,
 * Protection_Number provisioning status (exactly one defined state, Req 9.8),
 * and Subscription state.
 */
export const loadSeniorDetail = async (
  caregiverUserId: string,
  seniorId: string,
): Promise<SeniorDetail> => {
  // Authorization first: a missing/inactive Care_Link throws before any Senior
  // data is read, so an unauthorized request returns no data (Req 9.4).
  await assertCareLink(caregiverUserId, seniorId);

  const senior = await prisma.seniorProfile.findUnique({
    where: { id: seniorId },
    select: {
      id: true,
      user: { select: { name: true, email: true } },
      protectionNumber: {
        select: { provisioningState: true, e164Number: true },
      },
      subscription: {
        select: { state: true, monthlyPriceCents: true },
      },
      knownContacts: {
        orderBy: { createdAt: "asc" },
        select: { id: true, e164Number: true, displayName: true },
      },
      callRecords: {
        orderBy: { startedAt: "desc" },
        select: {
          id: true,
          callerNumber: true,
          knownContactName: true,
          startedAt: true,
          endedAt: true,
          screeningOutcome: true,
          riskCategory: true,
          riskScore: true,
          disposition: true,
          report: {
            select: {
              statedPurpose: true,
              riskCategory: true,
              reasonText: true,
              available: true,
            },
          },
        },
      },
    },
  });

  // The Care_Link assertion passed, so the Senior exists; this guards the type.
  if (!senior) {
    throw new Error(`Senior ${seniorId} not found after care-link assertion`);
  }

  return {
    senior: {
      id: senior.id,
      name: senior.user.name ?? null,
      email: senior.user.email,
    },
    callRecords: senior.callRecords.map((record) => ({
      id: record.id,
      callerNumber: record.callerNumber,
      knownContactName: record.knownContactName ?? null,
      startedAt: record.startedAt,
      endedAt: record.endedAt ?? null,
      screeningOutcome: record.screeningOutcome,
      riskCategory: toRiskCategory(record.riskCategory),
      riskScore: record.riskScore ?? null,
      disposition: record.disposition as CallDisposition,
      report: record.report
        ? {
            statedPurpose: record.report.statedPurpose,
            riskCategory: toRiskCategory(record.report.riskCategory) ?? "Allowed",
            reasonText: record.report.reasonText,
            available: record.report.available,
          }
        : null,
    })),
    knownContacts: senior.knownContacts.map((contact) => ({
      id: contact.id,
      e164Number: contact.e164Number,
      displayName: contact.displayName ?? null,
    })),
    protectionNumber: {
      provisioningState: senior.protectionNumber
        ? toProvisioningState(senior.protectionNumber.provisioningState)
        : PROVISIONING_STATES.none,
      e164Number: senior.protectionNumber?.e164Number ?? null,
    },
    subscription: {
      state: toSubscriptionState(senior.subscription?.state),
      monthlyPriceCents: senior.subscription?.monthlyPriceCents ?? null,
    },
  };
};
