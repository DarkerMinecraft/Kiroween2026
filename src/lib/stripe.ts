/**
 * Stripe client wrapper and subscription-state mappers (`src/lib/stripe.ts`).
 *
 * Wraps the Stripe SDK for the two billing shapes Mabel sells:
 *
 * - Family_Plan — one per-Senior subscription owned by a Caregiver's
 *   Billing_Account (Req 12.1, 12.2, 12.9).
 * - Partner per-member plan — a single quantity-based subscription owned by a
 *   Partner's Billing_Account whose `quantity` tracks the count of actively
 *   enrolled Seniors and never drops below zero (Req 13.1, 13.2, 13.3, 13.4).
 *
 * The secret key and the configured price ids are read from the environment at
 * call time (`STRIPE_SECRET_KEY`, `STRIPE_FAMILY_PRICE_ID`,
 * `STRIPE_PARTNER_PRICE_ID`) and are never hardcoded. The monthly amount
 * constraint ($14.99–$19.99) is enforced by the configured Stripe Price, not in
 * application code.
 *
 * Every failure — missing configuration, a Stripe API error, or an unexpected
 * response — surfaces as a typed {@link BillingError} so the subscribe/cancel
 * actions can report the failure and leave prior Subscription state unchanged
 * (Req 12.11, 13.8). The webhook reconciler is the only writer of
 * `Subscription.state`; {@link subscriptionStateFromStripe} maps a Stripe
 * subscription status to a {@link SubscriptionState}.
 */

import Stripe from "stripe";

import { prisma } from "@/lib/prisma";
import { SUBSCRIPTION_STATES, type SubscriptionState } from "@/lib/constants";

/**
 * Error thrown by every Stripe wrapper function on failure.
 *
 * Carries the originating `operation` and, when the failure came back from
 * Stripe, the Stripe error `code`. The underlying cause is preserved on
 * `cause` so callers can inspect the original Stripe error if needed.
 */
export class BillingError extends Error {
  /** The wrapper operation that failed (e.g. `"createFamilySubscription"`). */
  readonly operation: string;
  /** Stripe error code when the failure originated from the Stripe API. */
  readonly code?: string;

  constructor(
    operation: string,
    message: string,
    options?: { code?: string; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "BillingError";
    this.operation = operation;
    this.code = options?.code;
    // Restore the prototype chain when targeting ES5 transpilation.
    Object.setPrototypeOf(this, BillingError.prototype);
  }
}

/**
 * Identifies the owner of a Billing_Account. Exactly one of `caregiverId` or
 * `partnerId` is set — a Billing_Account belongs to either a Caregiver
 * (Family_Plan) or a Partner (per-member plan), never both.
 */
export interface BillingAccountOwner {
  /** CaregiverProfile id when the owner is a Caregiver. */
  readonly caregiverId?: string;
  /** PartnerProfile id when the owner is a Partner. */
  readonly partnerId?: string;
  /** Email used when creating the Stripe customer. */
  readonly email?: string;
  /** Display name used when creating the Stripe customer. */
  readonly name?: string;
}

/** The persisted Billing_Account returned by {@link ensureBillingAccount}. */
export interface BillingAccountRef {
  /** BillingAccount row id. */
  readonly id: string;
  /** The Stripe customer id backing this account. */
  readonly stripeCustomerId: string;
}

/** A created or updated subscription returned by the subscription helpers. */
export interface SubscriptionRef {
  /** The Stripe subscription id. */
  readonly stripeSubscriptionId: string;
  /** The Stripe subscription status mapped to a local state. */
  readonly state: SubscriptionState;
  /** The billed quantity, present for Partner per-member subscriptions. */
  readonly quantity?: number;
}

/**
 * Lazily constructs a Stripe client from `STRIPE_SECRET_KEY`.
 *
 * Reads the secret at call time so the key is never captured at module load.
 * Throws a {@link BillingError} when the key is absent so no request is
 * attempted with incomplete configuration. The SDK's pinned API version is
 * used; it is not overridden here.
 */
const resolveClient = (operation: string): Stripe => {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new BillingError(operation, "Missing Stripe configuration: STRIPE_SECRET_KEY");
  }
  return new Stripe(secretKey);
};

/**
 * Reads a required price id from the environment at call time.
 *
 * `explicit` takes precedence when provided (callers pass the price id through
 * from a server action); otherwise the configured env var is used. Throws a
 * {@link BillingError} when neither is available.
 */
const resolvePriceId = (
  operation: string,
  envVar: "STRIPE_FAMILY_PRICE_ID" | "STRIPE_PARTNER_PRICE_ID",
  explicit?: string,
): string => {
  const priceId = explicit ?? process.env[envVar];
  if (!priceId) {
    throw new BillingError(operation, `Missing Stripe configuration: ${envVar}`);
  }
  return priceId;
};

/**
 * Clamps a requested billed quantity to a non-negative integer.
 *
 * Partner per-member billing tracks the count of actively enrolled Seniors,
 * which can never be negative; a value below zero (or a non-finite input) is
 * clamped to zero and any fractional part is truncated (Req 13.3, 13.4).
 */
export const clampQuantity = (quantity: number): number => {
  if (!Number.isFinite(quantity)) return 0;
  return Math.max(0, Math.trunc(quantity));
};

/**
 * Wraps a Stripe SDK call, translating any thrown error into a typed
 * {@link BillingError} tagged with the calling `operation`.
 */
const callStripe = async <T>(operation: string, fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (cause) {
    if (cause instanceof Stripe.errors.StripeError) {
      throw new BillingError(operation, `Stripe error: ${cause.message}`, {
        code: cause.code,
        cause,
      });
    }
    throw new BillingError(
      operation,
      `Stripe request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
};

/**
 * Maps a raw Stripe subscription status to a local {@link SubscriptionState}.
 *
 * Stripe exposes a wider set of statuses than Mabel distinguishes; they fold
 * onto the four {@link SUBSCRIPTION_STATES} values:
 *
 * - `active` / `trialing` → `active` (service is usable)
 * - `past_due` / `unpaid` → `past_due` (payment attention needed)
 * - `canceled` → `canceled`
 * - `incomplete` / `incomplete_expired` / `paused` → `incomplete`
 *
 * Any unrecognized status folds to `incomplete` so an unknown state never
 * reads as service-active for the forwarding gate (Req 12.7, 12.12, 13.7).
 */
export const subscriptionStateFromStripe = (
  status: Stripe.Subscription.Status | string,
): SubscriptionState => {
  switch (status) {
    case "active":
    case "trialing":
      return SUBSCRIPTION_STATES.active;
    case "past_due":
    case "unpaid":
      return SUBSCRIPTION_STATES.pastDue;
    case "canceled":
      return SUBSCRIPTION_STATES.canceled;
    case "incomplete":
    case "incomplete_expired":
    case "paused":
      return SUBSCRIPTION_STATES.incomplete;
    default:
      return SUBSCRIPTION_STATES.incomplete;
  }
};

/**
 * Reads the billed quantity off a Stripe subscription's first line item.
 *
 * Partner per-member subscriptions carry a single quantity-based item; returns
 * its clamped quantity, or `undefined` when no quantity is present.
 */
const quantityFromSubscription = (subscription: Stripe.Subscription): number | undefined => {
  const quantity = subscription.items.data[0]?.quantity;
  return quantity === undefined ? undefined : clampQuantity(quantity);
};

/**
 * Finds or creates the Stripe customer for an owner and persists the
 * Billing_Account row (Req 12.1, 13.1).
 *
 * When a Billing_Account already exists for the owner, its existing Stripe
 * customer is reused and returned unchanged. Otherwise a Stripe customer is
 * created and a new Billing_Account row is written referencing it. Throws a
 * {@link BillingError} when the owner is not exactly one of Caregiver/Partner
 * or when Stripe/persistence fails.
 */
export const ensureBillingAccount = async (
  owner: BillingAccountOwner,
): Promise<BillingAccountRef> => {
  const operation = "ensureBillingAccount";

  const { caregiverId, partnerId } = owner;
  if ((caregiverId && partnerId) || (!caregiverId && !partnerId)) {
    throw new BillingError(
      operation,
      "Billing account owner must be exactly one of caregiverId or partnerId",
    );
  }

  const existing = await prisma.billingAccount.findFirst({
    where: caregiverId ? { caregiverId } : { partnerId },
    select: { id: true, stripeCustomerId: true },
  });
  if (existing) {
    return { id: existing.id, stripeCustomerId: existing.stripeCustomerId };
  }

  const stripe = resolveClient(operation);
  const customer = await callStripe(operation, () =>
    stripe.customers.create({
      email: owner.email,
      name: owner.name,
      metadata: caregiverId ? { caregiverId } : { partnerId: partnerId as string },
    }),
  );

  const account = await prisma.billingAccount.create({
    data: {
      caregiverId: caregiverId ?? null,
      partnerId: partnerId ?? null,
      stripeCustomerId: customer.id,
    },
    select: { id: true, stripeCustomerId: true },
  });

  return { id: account.id, stripeCustomerId: account.stripeCustomerId };
};

/**
 * Creates a per-Senior Family_Plan subscription for a billing customer
 * (Req 12.2).
 *
 * `priceId` defaults to the configured `STRIPE_FAMILY_PRICE_ID` when omitted;
 * the `seniorId` is stamped into subscription metadata so the webhook
 * reconciler can resolve the affected Senior. Throws a {@link BillingError} on
 * failure.
 */
export const createFamilySubscription = async (
  stripeCustomerId: string,
  seniorId: string,
  priceId?: string,
): Promise<SubscriptionRef> => {
  const operation = "createFamilySubscription";
  const stripe = resolveClient(operation);
  const price = resolvePriceId(operation, "STRIPE_FAMILY_PRICE_ID", priceId);

  const subscription = await callStripe(operation, () =>
    stripe.subscriptions.create({
      customer: stripeCustomerId,
      items: [{ price }],
      metadata: { seniorId },
    }),
  );

  return {
    stripeSubscriptionId: subscription.id,
    state: subscriptionStateFromStripe(subscription.status),
  };
};

/**
 * Requests cancellation of a subscription through Stripe (Req 12.9).
 *
 * Returns the resulting mapped state so the caller can re-gate forwarding.
 * Throws a {@link BillingError} on failure, leaving prior state for the caller
 * to retain.
 */
export const cancelSubscription = async (
  subscriptionId: string,
): Promise<SubscriptionRef> => {
  const operation = "cancelSubscription";
  const stripe = resolveClient(operation);

  const subscription = await callStripe(operation, () =>
    stripe.subscriptions.cancel(subscriptionId),
  );

  return {
    stripeSubscriptionId: subscription.id,
    state: subscriptionStateFromStripe(subscription.status),
    quantity: quantityFromSubscription(subscription),
  };
};

/**
 * Creates a Partner per-member subscription with an initial billed quantity
 * (Req 13.2, 13.3).
 *
 * `priceId` defaults to the configured `STRIPE_PARTNER_PRICE_ID` when omitted;
 * the `quantity` is clamped to a non-negative integer. The `partnerId` is
 * stamped into subscription metadata. Throws a {@link BillingError} on failure.
 */
export const createPartnerSubscription = async (
  stripeCustomerId: string,
  partnerId: string,
  quantity: number,
  priceId?: string,
): Promise<SubscriptionRef> => {
  const operation = "createPartnerSubscription";
  const stripe = resolveClient(operation);
  const price = resolvePriceId(operation, "STRIPE_PARTNER_PRICE_ID", priceId);
  const clamped = clampQuantity(quantity);

  const subscription = await callStripe(operation, () =>
    stripe.subscriptions.create({
      customer: stripeCustomerId,
      items: [{ price, quantity: clamped }],
      metadata: { partnerId },
    }),
  );

  return {
    stripeSubscriptionId: subscription.id,
    state: subscriptionStateFromStripe(subscription.status),
    quantity: quantityFromSubscription(subscription) ?? clamped,
  };
};

/**
 * Sets the billed quantity on a Partner per-member subscription (Req 13.3,
 * 13.4).
 *
 * The requested `quantity` is clamped to a non-negative integer so the billed
 * quantity never goes negative. Updates the first subscription item in place.
 * Throws a {@link BillingError} on failure, leaving prior quantity for the
 * caller to retain.
 */
export const setPartnerQuantity = async (
  subscriptionId: string,
  quantity: number,
): Promise<SubscriptionRef> => {
  const operation = "setPartnerQuantity";
  const stripe = resolveClient(operation);
  const clamped = clampQuantity(quantity);

  const current = await callStripe(operation, () =>
    stripe.subscriptions.retrieve(subscriptionId),
  );

  const itemId = current.items.data[0]?.id;
  if (!itemId) {
    throw new BillingError(
      operation,
      `Subscription ${subscriptionId} has no line item to update`,
    );
  }

  const updated = await callStripe(operation, () =>
    stripe.subscriptions.update(subscriptionId, {
      items: [{ id: itemId, quantity: clamped }],
    }),
  );

  return {
    stripeSubscriptionId: updated.id,
    state: subscriptionStateFromStripe(updated.status),
    quantity: quantityFromSubscription(updated) ?? clamped,
  };
};
