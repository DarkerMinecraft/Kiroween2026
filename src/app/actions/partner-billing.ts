"use server";

/**
 * Partner per-member billing Server Actions (`src/app/actions/partner-billing.ts`).
 *
 * A Partner enrolls and removes Seniors as members and reads the billing state
 * of its own per-member plan. The billed quantity on the single Partner
 * Subscription tracks the count of ACTIVE `PartnerMembership` rows for that
 * Partner, clamped at zero (Req 13.2, 13.3, 13.4). Read and manage operations
 * for a specific member are scoped server-side through
 * {@link assertPartnerMembership} (Req 13.6).
 *
 * Billing goes through the Stripe wrapper in `src/lib/stripe.ts`
 * ({@link ensureBillingAccount}, {@link createPartnerSubscription},
 * {@link setPartnerQuantity}). Any {@link BillingError} is caught and surfaced
 * as a typed failure, and no local state is changed — the Stripe quantity
 * update is ordered before the local membership/Subscription writes so a
 * billing failure leaves the prior membership state and billed quantity
 * unchanged (Req 13.8).
 *
 * All exports are arrow-function consts with named exports (workspace Next.js
 * rules); interfaces are preferred over type aliases.
 */

import { assertPartnerMembership, AuthorizationError } from "@/lib/authz";
import { type SubscriptionState } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import {
  BillingError,
  clampQuantity,
  createPartnerSubscription,
  ensureBillingAccount,
  setPartnerQuantity,
} from "@/lib/stripe";

/** Input for {@link enrollPartnerMember} and {@link removePartnerMember}. */
export interface PartnerMemberInput {
  /** The authenticated Partner's `User.id`. */
  readonly partnerUserId: string;
  /** The target `SeniorProfile.id` being enrolled or removed. */
  readonly seniorId: string;
}

/** Input for {@link getPartnerBilling}. */
export interface GetPartnerBillingInput {
  /** The authenticated Partner's `User.id`. */
  readonly partnerUserId: string;
}

/** The per-member Subscription summary returned by {@link getPartnerBilling}. */
export interface PartnerBilling {
  /** The Stripe subscription id, or `null` when no Subscription exists yet. */
  readonly stripeSubscriptionId: string | null;
  /** Current Subscription state, or `null` when no Subscription exists yet. */
  readonly state: SubscriptionState | null;
  /** The billed quantity: the count of active enrolled members (clamped >= 0). */
  readonly quantity: number;
}

/** Stable failure codes callers can switch on without string matching. */
export type ActionErrorCode = "not_authorized" | "billing_failed";

/**
 * The typed result returned by the mutating actions. A success carries no
 * payload; a failure carries a stable `code` and a human-readable `message`.
 */
export type ActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ActionErrorCode; readonly message: string };

/** The typed result returned by {@link getPartnerBilling}. */
export type GetPartnerBillingResult =
  | { readonly ok: true; readonly data: PartnerBilling }
  | { readonly ok: false; readonly code: ActionErrorCode; readonly message: string };

/** A shared not-authorized failure result. */
const notAuthorized = (): Extract<ActionResult, { ok: false }> => ({
  ok: false,
  code: "not_authorized",
  message: "You do not manage this member.",
});

/** A shared billing-failure result (prior state and quantity retained). */
const billingFailed = (): Extract<ActionResult, { ok: false }> => ({
  ok: false,
  code: "billing_failed",
  message: "Billing failed. Your members and billed quantity were not changed.",
});

/**
 * Resolves the PartnerProfile (with the backing User's email/name) for a
 * Partner account, for Stripe customer creation. Returns `null` when no
 * PartnerProfile exists.
 */
const resolvePartner = async (partnerUserId: string) =>
  prisma.partnerProfile.findUnique({
    where: { userId: partnerUserId },
    select: {
      id: true,
      user: { select: { email: true, name: true } },
    },
  });

/**
 * Counts the ACTIVE `PartnerMembership` rows for a Partner, clamped to a
 * non-negative integer. This count is the billed quantity of the Partner's
 * per-member Subscription (Req 13.2, 13.3, 13.4).
 */
const activeMemberCount = async (partnerId: string): Promise<number> => {
  const count = await prisma.partnerMembership.count({
    where: { partnerId, active: true },
  });
  return clampQuantity(count);
};

/**
 * Enrolls a Senior as an active member of a Partner and applies the resulting
 * billed quantity to the Partner's per-member Subscription (Req 13.1, 13.2,
 * 13.3).
 *
 * Resolves the PartnerProfile, ensures the Partner's Billing_Account exists
 * (creating the Stripe customer when absent), then recomputes the target billed
 * quantity as the count of active members after this enrollment. The Stripe
 * quantity update runs before any local membership/Subscription write so a
 * {@link BillingError} leaves the prior membership state and billed quantity
 * unchanged (Req 13.8). When no Partner Subscription exists yet it is created
 * with that quantity and persisted; otherwise the existing Subscription's
 * quantity is updated in place.
 */
export const enrollPartnerMember = async (
  input: PartnerMemberInput,
): Promise<ActionResult> => {
  const { partnerUserId, seniorId } = input;

  const partner = await resolvePartner(partnerUserId);
  if (!partner) return notAuthorized();

  // Determine whether this enrollment adds a newly-active member so we can
  // compute the post-enrollment quantity WITHOUT first writing the membership
  // (keeping Stripe the first mutation, so a billing failure needs no revert).
  const existingMembership = await prisma.partnerMembership.findUnique({
    where: { seniorId },
    select: { partnerId: true, active: true },
  });

  // A membership row is unique per Senior. If one exists under a different
  // Partner, this Senior is not ours to enroll.
  if (existingMembership && existingMembership.partnerId !== partner.id) {
    return notAuthorized();
  }

  const currentActive = await activeMemberCount(partner.id);
  const willActivate = !existingMembership || !existingMembership.active;
  const targetQuantity = clampQuantity(currentActive + (willActivate ? 1 : 0));

  const subscription = await prisma.subscription.findUnique({
    where: { partnerId: partner.id },
    select: { stripeSubscriptionId: true },
  });

  try {
    const account = await ensureBillingAccount({
      partnerId: partner.id,
      email: partner.user.email,
      name: partner.user.name,
    });

    if (!subscription) {
      // No Partner Subscription yet: create it in Stripe at the target
      // quantity, then persist the Subscription row and the membership.
      const created = await createPartnerSubscription(
        account.stripeCustomerId,
        partner.id,
        targetQuantity,
      );

      await prisma.subscription.create({
        data: {
          partnerId: partner.id,
          stripeSubscriptionId: created.stripeSubscriptionId,
          state: created.state,
          quantity: created.quantity ?? targetQuantity,
        },
      });
    } else {
      // Existing Subscription: update the Stripe quantity first, then mirror
      // the mapped state and quantity onto the local row.
      const updated = await setPartnerQuantity(
        subscription.stripeSubscriptionId,
        targetQuantity,
      );

      await prisma.subscription.update({
        where: { partnerId: partner.id },
        data: {
          state: updated.state,
          quantity: updated.quantity ?? targetQuantity,
        },
      });
    }

    // Stripe (the system of record for the billed quantity) has accepted the
    // new quantity, so it is now safe to materialize the membership.
    await prisma.partnerMembership.upsert({
      where: { seniorId },
      create: { partnerId: partner.id, seniorId, active: true },
      update: { partnerId: partner.id, active: true },
    });

    return { ok: true };
  } catch (error) {
    if (error instanceof BillingError) return billingFailed();
    throw error;
  }
};

/**
 * Removes a Senior from a Partner's membership and applies the resulting billed
 * quantity to the Partner's per-member Subscription (Req 13.4, 13.6).
 *
 * Enforces {@link assertPartnerMembership} so only the managing Partner can
 * remove the member. Recomputes the target billed quantity as the count of
 * active members after this removal (clamped >= 0) and updates the Stripe
 * quantity before marking the local membership inactive, so a
 * {@link BillingError} leaves the prior membership state and billed quantity
 * unchanged (Req 13.8).
 */
export const removePartnerMember = async (
  input: PartnerMemberInput,
): Promise<ActionResult> => {
  const { partnerUserId, seniorId } = input;

  try {
    await assertPartnerMembership(partnerUserId, seniorId);
  } catch (error) {
    if (error instanceof AuthorizationError) return notAuthorized();
    throw error;
  }

  const partner = await resolvePartner(partnerUserId);
  if (!partner) return notAuthorized();

  // The membership is active (assertPartnerMembership passed), so removing it
  // drops the active count by one; clamp guards the zero floor (Req 13.4).
  const currentActive = await activeMemberCount(partner.id);
  const targetQuantity = clampQuantity(currentActive - 1);

  const subscription = await prisma.subscription.findUnique({
    where: { partnerId: partner.id },
    select: { stripeSubscriptionId: true },
  });

  try {
    // Update Stripe first (when a Subscription exists) so a billing failure
    // leaves the membership active and the quantity unchanged.
    if (subscription) {
      const updated = await setPartnerQuantity(
        subscription.stripeSubscriptionId,
        targetQuantity,
      );

      await prisma.subscription.update({
        where: { partnerId: partner.id },
        data: {
          state: updated.state,
          quantity: updated.quantity ?? targetQuantity,
        },
      });
    }

    await prisma.partnerMembership.update({
      where: { seniorId },
      data: { active: false },
    });

    return { ok: true };
  } catch (error) {
    if (error instanceof BillingError) return billingFailed();
    throw error;
  }
};

/**
 * Returns the Partner's per-member Subscription state and billed quantity for
 * its own members (Req 13.5).
 *
 * The billed quantity is reported as the count of active enrolled members
 * (clamped >= 0), which the stored Subscription quantity mirrors. When no
 * Partner Subscription exists yet the state is `null` and the quantity is the
 * current active member count (typically zero).
 */
export const getPartnerBilling = async (
  input: GetPartnerBillingInput,
): Promise<GetPartnerBillingResult> => {
  const { partnerUserId } = input;

  const partner = await prisma.partnerProfile.findUnique({
    where: { userId: partnerUserId },
    select: {
      id: true,
      subscription: {
        select: { stripeSubscriptionId: true, state: true, quantity: true },
      },
    },
  });

  if (!partner) {
    return {
      ok: false,
      code: "not_authorized",
      message: "Account is not a partner.",
    };
  }

  const activeCount = await activeMemberCount(partner.id);
  const subscription = partner.subscription;

  return {
    ok: true,
    data: {
      stripeSubscriptionId: subscription?.stripeSubscriptionId ?? null,
      state: (subscription?.state ?? null) as SubscriptionState | null,
      quantity: subscription?.quantity ?? activeCount,
    },
  };
};
