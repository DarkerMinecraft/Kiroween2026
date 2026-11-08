"use server";

/**
 * Consent server actions (Req 3).
 *
 * A valid, non-withdrawn Consent_Record is one of the two conditions of the
 * forwarding gate (`isForwardingActive`). These actions capture and withdraw
 * consent, then recompute and materialize `SeniorProfile.forwardingActive`
 * through the single shared gate so the invariant holds in one place.
 *
 * Mutations are Server Actions per the design (each action re-derives its own
 * state server-side). Validation failures return a typed
 * `{ ok: false, field, message }` result with no partial writes (Req 3.4).
 */

import { prisma } from "@/lib/prisma";
import {
  isForwardingActive,
  type SubscriptionStateInput,
} from "@/lib/screening";
import { SUBSCRIPTION_STATES } from "@/lib/constants";

/** Input to {@link submitConsent}. */
export interface SubmitConsentInput {
  /** The consenting Senior's `SeniorProfile.id`. */
  seniorId: string;
  /** The Protection_Number the Senior is consenting to forward through. */
  protectionNumber: string;
  /**
   * Optional caller-supplied consent instant. When omitted, the current time
   * is used. Either way it is captured in UTC at second-level precision.
   */
  consentedAt?: Date;
}

/** Input to {@link withdrawConsent}. */
export interface WithdrawConsentInput {
  /** The Senior's `SeniorProfile.id` whose consent is being withdrawn. */
  seniorId: string;
}

/** A field-level validation / failure result shared by the consent actions. */
export interface ActionFailure {
  ok: false;
  /** The offending field, or a general scope for non-field failures. */
  field: string;
  /** A human-readable explanation suitable for surfacing in the UI. */
  message: string;
}

/** Successful result of {@link submitConsent}. */
export interface SubmitConsentSuccess {
  ok: true;
  /** The upserted Consent_Record id. */
  consentId: string;
  /** The UTC, second-precision timestamp that was captured. */
  consentedAt: Date;
  /** The materialized forwarding gate result for the Senior. */
  forwardingActive: boolean;
}

/** Successful result of {@link withdrawConsent}. */
export interface WithdrawConsentSuccess {
  ok: true;
  /** Always `false`: withdrawing consent deactivates the forwarding gate. */
  forwardingActive: false;
  /** Confirmation phrasing indicating forwarding is now inactive (Req 3.5). */
  message: string;
}

/** Discriminated result of {@link submitConsent}. */
export type SubmitConsentResult = SubmitConsentSuccess | ActionFailure;
/** Discriminated result of {@link withdrawConsent}. */
export type WithdrawConsentResult = WithdrawConsentSuccess | ActionFailure;

/**
 * Truncates an instant to whole seconds in UTC, discarding milliseconds, so the
 * stored consent timestamp has second-level precision (Req 3.2). Returns a new
 * `Date`; the input is not mutated.
 */
const toUtcSecondPrecision = (instant: Date): Date =>
  new Date(Math.floor(instant.getTime() / 1000) * 1000);

/**
 * Narrows a stored Subscription `state` string to the gate's accepted input,
 * treating any absent or unrecognized value as "no active subscription".
 */
const toSubscriptionStateInput = (
  state: string | null | undefined,
): SubscriptionStateInput => {
  const known = Object.values(SUBSCRIPTION_STATES) as readonly string[];
  return state && known.includes(state)
    ? (state as SubscriptionStateInput)
    : null;
};

/**
 * Recomputes the forwarding gate for a Senior from its current Consent_Record
 * and Subscription, materializes the result onto `SeniorProfile.forwardingActive`,
 * and returns it. Forwarding stays inactive without an active Subscription even
 * when consent is valid (Req 3.3, 12.5, 12.6).
 */
const recomputeForwardingActive = async (seniorId: string): Promise<boolean> => {
  const senior = await prisma.seniorProfile.findUnique({
    where: { id: seniorId },
    include: { consent: true, subscription: true },
  });

  if (!senior) return false;

  const hasValidConsent = Boolean(
    senior.consent && !senior.consent.withdrawn,
  );

  const forwardingActive = isForwardingActive({
    hasValidConsent,
    subscriptionState: toSubscriptionStateInput(senior.subscription?.state),
  });

  await prisma.seniorProfile.update({
    where: { id: seniorId },
    data: { forwardingActive },
  });

  return forwardingActive;
};

/**
 * Captures a Senior's consent to call forwarding (Req 3.1, 3.2, 3.3, 3.4).
 *
 * Rejects with a typed field error when the Senior id or Protection_Number is
 * absent, performing no writes. On success it upserts the Senior's
 * Consent_Record (withdrawn: false) with a UTC second-precision timestamp, then
 * recomputes and materializes the forwarding gate. Forwarding only becomes
 * active when an active Subscription also exists.
 */
export const submitConsent = async (
  input: SubmitConsentInput,
): Promise<SubmitConsentResult> => {
  const seniorId = input.seniorId?.trim();
  if (!seniorId) {
    return {
      ok: false,
      field: "seniorId",
      message: "A Senior identifier is required to record consent.",
    };
  }

  const protectionNumber = input.protectionNumber?.trim();
  if (!protectionNumber) {
    return {
      ok: false,
      field: "protectionNumber",
      message: "A Protection_Number is required to record consent.",
    };
  }

  const senior = await prisma.seniorProfile.findUnique({
    where: { id: seniorId },
    select: { id: true },
  });
  if (!senior) {
    return {
      ok: false,
      field: "seniorId",
      message: "No Senior exists for the provided identifier.",
    };
  }

  const consentedAt = toUtcSecondPrecision(input.consentedAt ?? new Date());

  const consent = await prisma.consentRecord.upsert({
    where: { seniorId },
    create: { seniorId, protectionNumber, consentedAt, withdrawn: false },
    update: { protectionNumber, consentedAt, withdrawn: false },
  });

  const forwardingActive = await recomputeForwardingActive(seniorId);

  return {
    ok: true,
    consentId: consent.id,
    consentedAt,
    forwardingActive,
  };
};

/**
 * Withdraws a Senior's consent and deactivates forwarding (Req 3.5).
 *
 * Marks the Senior's Consent_Record withdrawn, then recomputes the forwarding
 * gate — which, with consent now invalid, evaluates to inactive — and
 * materializes `SeniorProfile.forwardingActive = false`. Returns confirmation
 * that forwarding is inactive.
 */
export const withdrawConsent = async (
  input: WithdrawConsentInput,
): Promise<WithdrawConsentResult> => {
  const seniorId = input.seniorId?.trim();
  if (!seniorId) {
    return {
      ok: false,
      field: "seniorId",
      message: "A Senior identifier is required to withdraw consent.",
    };
  }

  const consent = await prisma.consentRecord.findUnique({
    where: { seniorId },
    select: { id: true },
  });
  if (!consent) {
    return {
      ok: false,
      field: "seniorId",
      message: "No consent record exists for the provided Senior.",
    };
  }

  await prisma.consentRecord.update({
    where: { seniorId },
    data: { withdrawn: true },
  });

  await recomputeForwardingActive(seniorId);

  return {
    ok: true,
    forwardingActive: false,
    message: "Consent withdrawn. Call forwarding is now inactive.",
  };
};
