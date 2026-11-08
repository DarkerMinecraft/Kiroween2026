"use server";

/**
 * Family_Plan subscription Server Actions (`src/app/actions/family-billing.ts`).
 *
 * A Caregiver subscribes, cancels, and lists the per-Senior Family_Plan
 * Subscriptions for the Seniors to whom they hold an active Care_Link. Every
 * action re-derives the Caregiver → Senior scope server-side through
 * {@link assertCareLink} (Req 12.3, 12.10) before any read or write.
 *
 * Billing goes through the Stripe wrapper in `src/lib/stripe.ts`
 * ({@link ensureBillingAccount}, {@link createFamilySubscription},
 * {@link cancelSubscription}); any {@link BillingError} is caught and surfaced
 * as a typed failure result, leaving prior Subscription state unchanged (Req
 * 12.11). Forwarding is re-gated through the single
 * {@link isForwardingActive} predicate and materialized onto
 * `SeniorProfile.forwardingActive` after every state change (Req 12.5, 12.6,
 * 12.9).
 *
 * All exports are arrow-function consts with named exports (workspace Next.js
 * rules); interfaces are preferred over type aliases.
 */

import { assertCareLink, AuthorizationError } from "@/lib/authz";
import { SUBSCRIPTION_STATES, type SubscriptionState } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { isForwardingActive } from "@/lib/screening";
import {
  BillingError,
  cancelSubscription,
  createFamilySubscription,
  ensureBillingAccount,
} from "@/lib/stripe";

/** Input for {@link subscribeFamilyPlan} and {@link cancelFamilyPlan}. */
export interface FamilyPlanInput {
  /** The authenticated Caregiver's `User.id`. */
  readonly caregiverUserId: string;
  /** The target `SeniorProfile.id`. */
  readonly seniorId: string;
}

/** Input for {@link listSubscriptions}. */
export interface ListSubscriptionsInput {
  /** The authenticated Caregiver's `User.id`. */
  readonly caregiverUserId: string;
}

/** A single linked Senior's Subscription in the {@link listSubscriptions} payload. */
export interface SubscriptionSummary {
  /** The `SeniorProfile.id` this Subscription belongs to. */
  readonly seniorId: string;
  /** The Stripe subscription id, or `null` when no Subscription exists. */
  readonly stripeSubscriptionId: string | null;
  /** Current Subscription state, or `null` when no Subscription exists. */
  readonly state: SubscriptionState | null;
  /** Monthly price snapshot in cents, or `null` when unknown. */
  readonly monthlyPriceCents: number | null;
}

/**
 * The typed result returned by the mutating actions. A success carries no
 * payload; a failure carries a stable `code` the UI maps to a message and an
 * optional human-readable `message`.
 */
export type ActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ActionErrorCode; readonly message: string };

/** The typed result returned by {@link listSubscriptions}. */
export type ListSubscriptionsResult =
  | { readonly ok: true; readonly data: readonly SubscriptionSummary[] }
  | { readonly ok: false; readonly code: ActionErrorCode; readonly message: string };

/** Stable failure codes callers can switch on without string matching. */
export type ActionErrorCode =
  | "not_authorized"
  | "subscription_exists"
  | "no_subscription"
  | "billing_failed";

/**
 * Reads the optional configured Family_Plan monthly price (in cents) used as a
 * best-effort snapshot on the Subscription row. Stripe remains the system of
 * record for state (Req 12.12); this is a display convenience only. Returns
 * `null` when unset or malformed.
 */
const resolveFamilyPriceCents = (): number | null => {
  const raw = process.env.STRIPE_FAMILY_PRICE_CENTS;
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

/**
 * Re-derives forwarding for a Senior through the single forwarding gate and
 * materializes the result onto `SeniorProfile.forwardingActive` (Req 12.5,
 * 12.6, 12.9).
 *
 * Reads the Senior's current consent validity and Subscription state, applies
 * {@link isForwardingActive}, and writes the boolean. Called after every
 * subscription state change so the materialized flag never drifts from the
 * gate.
 */
const regateForwarding = async (seniorId: string): Promise<void> => {
  const senior = await prisma.seniorProfile.findUnique({
    where: { id: seniorId },
    select: {
      consent: { select: { withdrawn: true } },
      subscription: { select: { state: true } },
    },
  });

  if (!senior) return;

  const hasValidConsent = senior.consent !== null && !senior.consent.withdrawn;
  const subscriptionState = (senior.subscription?.state ?? null) as
    | SubscriptionState
    | null;

  const active = isForwardingActive({
    hasValidConsent,
    subscriptionState,
  });

  await prisma.seniorProfile.update({
    where: { id: seniorId },
    data: { forwardingActive: active },
  });
};

/**
 * Resolves the CaregiverProfile (with the backing User's email/name) for a
 * Caregiver account, for Stripe customer creation. Returns `null` when no
 * CaregiverProfile exists.
 */
const resolveCaregiver = async (caregiverUserId: string) =>
  prisma.caregiverProfile.findUnique({
    where: { userId: caregiverUserId },
    select: {
      id: true,
      user: { select: { email: true, name: true } },
    },
  });

/**
 * Subscribes a linked Senior to the Family_Plan (Req 12.1, 12.2).
 *
 * Enforces {@link assertCareLink}, then creates the Caregiver's Billing_Account
 * when absent, rejects a second active Subscription for the Senior (Req 12.4),
 * creates the Stripe subscription, persists the Subscription row, and re-gates
 * forwarding. On a {@link BillingError} no Subscription row is written and the
 * failure is reported, retaining prior state (Req 12.11).
 */
export const subscribeFamilyPlan = async (
  input: FamilyPlanInput,
): Promise<ActionResult> => {
  const { caregiverUserId, seniorId } = input;

  try {
    await assertCareLink(caregiverUserId, seniorId);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return {
        ok: false,
        code: "not_authorized",
        message: "You are not linked to this senior.",
      };
    }
    throw error;
  }

  const caregiver = await resolveCaregiver(caregiverUserId);
  if (!caregiver) {
    return {
      ok: false,
      code: "not_authorized",
      message: "You are not linked to this senior.",
    };
  }

  // Reject a second active Subscription before any Stripe call so no Stripe
  // resource is created for a Senior that already has an active Subscription
  // (Req 12.4). A Subscription is one-per-Senior (`seniorId` unique).
  const existing = await prisma.subscription.findUnique({
    where: { seniorId },
    select: { state: true },
  });
  if (existing && existing.state === SUBSCRIPTION_STATES.active) {
    return {
      ok: false,
      code: "subscription_exists",
      message: "An active subscription already exists for this senior.",
    };
  }

  try {
    const account = await ensureBillingAccount({
      caregiverId: caregiver.id,
      email: caregiver.user.email,
      name: caregiver.user.name,
    });

    const subscription = await createFamilySubscription(
      account.stripeCustomerId,
      seniorId,
    );

    // Persist the Subscription row only after Stripe succeeds, so a billing
    // failure leaves no partial local state. `upsert` replaces a prior
    // non-active (e.g. canceled) row for the same Senior.
    await prisma.subscription.upsert({
      where: { seniorId },
      create: {
        seniorId,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        state: subscription.state,
        monthlyPriceCents: resolveFamilyPriceCents(),
      },
      update: {
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        state: subscription.state,
        monthlyPriceCents: resolveFamilyPriceCents(),
      },
    });

    await regateForwarding(seniorId);

    return { ok: true };
  } catch (error) {
    if (error instanceof BillingError) {
      return {
        ok: false,
        code: "billing_failed",
        message: "Billing failed. Your subscription was not changed.",
      };
    }
    throw error;
  }
};

/**
 * Cancels a linked Senior's Family_Plan Subscription (Req 12.9).
 *
 * Enforces {@link assertCareLink}, requests cancellation through Stripe, writes
 * the mapped state onto the Subscription row, and re-gates forwarding (now
 * inactive). On a {@link BillingError} the Subscription row is left unchanged
 * and the failure is reported (Req 12.11).
 */
export const cancelFamilyPlan = async (
  input: FamilyPlanInput,
): Promise<ActionResult> => {
  const { caregiverUserId, seniorId } = input;

  try {
    await assertCareLink(caregiverUserId, seniorId);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return {
        ok: false,
        code: "not_authorized",
        message: "You are not linked to this senior.",
      };
    }
    throw error;
  }

  const existing = await prisma.subscription.findUnique({
    where: { seniorId },
    select: { stripeSubscriptionId: true },
  });
  if (!existing) {
    return {
      ok: false,
      code: "no_subscription",
      message: "No subscription exists for this senior.",
    };
  }

  try {
    const canceled = await cancelSubscription(existing.stripeSubscriptionId);

    await prisma.subscription.update({
      where: { seniorId },
      data: { state: canceled.state },
    });

    await regateForwarding(seniorId);

    return { ok: true };
  } catch (error) {
    if (error instanceof BillingError) {
      return {
        ok: false,
        code: "billing_failed",
        message: "Billing failed. Your subscription was not changed.",
      };
    }
    throw error;
  }
};

/**
 * Lists each linked Senior's Subscription with its current state and monthly
 * price, scoped to the Caregiver's active Care_Links (Req 12.8).
 *
 * Returns one {@link SubscriptionSummary} per actively linked Senior, including
 * Seniors with no Subscription (state/price `null`), so the dashboard can offer
 * subscribe controls for unsubscribed Seniors.
 */
export const listSubscriptions = async (
  input: ListSubscriptionsInput,
): Promise<ListSubscriptionsResult> => {
  const { caregiverUserId } = input;

  const caregiver = await prisma.caregiverProfile.findUnique({
    where: { userId: caregiverUserId },
    select: { id: true },
  });
  if (!caregiver) {
    return {
      ok: false,
      code: "not_authorized",
      message: "Account is not a caregiver.",
    };
  }

  const links = await prisma.careLink.findMany({
    where: { caregiverId: caregiver.id, active: true },
    select: {
      seniorId: true,
      senior: {
        select: {
          subscription: {
            select: {
              stripeSubscriptionId: true,
              state: true,
              monthlyPriceCents: true,
            },
          },
        },
      },
    },
  });

  const data: SubscriptionSummary[] = links.map((link) => {
    const subscription = link.senior.subscription;
    return {
      seniorId: link.seniorId,
      stripeSubscriptionId: subscription?.stripeSubscriptionId ?? null,
      state: (subscription?.state ?? null) as SubscriptionState | null,
      monthlyPriceCents: subscription?.monthlyPriceCents ?? null,
    };
  });

  return { ok: true, data };
};
