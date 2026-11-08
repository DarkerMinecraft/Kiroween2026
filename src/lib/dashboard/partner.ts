/**
 * Partner dashboard server-side loader (`src/lib/dashboard/partner.ts`).
 *
 * Loads the data the Partner view renders (task 15.3): the Partner's own
 * per-member Subscription state and billed quantity, plus the list of the
 * Partner's own ACTIVE enrolled members. Everything is scoped to the single
 * Partner identified by `partnerUserId` — the per-member billing summary is
 * derived from that Partner's own Subscription and active-membership count, and
 * every returned member is re-checked through {@link assertPartnerMembership}
 * so a row that is not actively managed by this Partner can never surface
 * (Req 13.5, 13.6).
 *
 * This is a plain async server module (no `use server`, no React) consumed by
 * the RSC page. All exports are arrow-function consts with named exports and
 * interfaces over type aliases, per the workspace Next.js rules.
 */

import { assertPartnerMembership } from "@/lib/authz";
import { clampQuantity } from "@/lib/stripe";
import { type SubscriptionState } from "@/lib/constants";
import { prisma } from "@/lib/prisma";

/** A single ACTIVE member enrolled under the Partner. */
export interface PartnerMemberSummary {
  /** The member's `SeniorProfile.id`. */
  readonly seniorId: string;
  /** The member's display name from the backing User account. */
  readonly name: string;
  /** The member's email from the backing User account. */
  readonly email: string;
  /** Whether call forwarding is currently active for this member. */
  readonly forwardingActive: boolean;
}

/** The Partner's own per-member Subscription summary. */
export interface PartnerBillingSummary {
  /** The Stripe subscription id, or `null` when no Subscription exists yet. */
  readonly stripeSubscriptionId: string | null;
  /** Current Subscription state, or `null` when no Subscription exists yet. */
  readonly state: SubscriptionState | null;
  /** The billed quantity: the count of active enrolled members (clamped >= 0). */
  readonly quantity: number;
}

/** The full data payload the Partner view renders. */
export interface PartnerDashboardData {
  /** The per-member Subscription state and billed quantity. */
  readonly billing: PartnerBillingSummary;
  /** The Partner's own ACTIVE enrolled members. */
  readonly members: readonly PartnerMemberSummary[];
}

/** A failure that prevented the dashboard from loading. */
export type PartnerDashboardError = "not_partner";

/**
 * The typed result of {@link loadPartnerDashboard}. A failure carries a stable
 * `error` code so the page can render the right state without ever falling back
 * to another account's data.
 */
export type PartnerDashboardResult =
  | { readonly ok: true; readonly data: PartnerDashboardData }
  | { readonly ok: false; readonly error: PartnerDashboardError };

/**
 * Loads the Partner dashboard for the account identified by `partnerUserId`.
 *
 * Resolves the Partner's own profile (failing closed with `not_partner` when
 * the account owns no PartnerProfile), reads its per-member Subscription and
 * active-membership count for the billing summary, and lists the Partner's own
 * ACTIVE members. Each listed member is re-verified through
 * {@link assertPartnerMembership}; any member that does not pass the active
 * membership check for this Partner is dropped rather than rendered, so the
 * view only ever shows members actually managed by this Partner (Req 13.5,
 * 13.6).
 */
export const loadPartnerDashboard = async (
  partnerUserId: string,
): Promise<PartnerDashboardResult> => {
  const partner = await prisma.partnerProfile.findUnique({
    where: { userId: partnerUserId },
    select: {
      id: true,
      subscription: {
        select: { stripeSubscriptionId: true, state: true, quantity: true },
      },
      memberships: {
        where: { active: true },
        select: {
          seniorId: true,
          senior: {
            select: {
              forwardingActive: true,
              user: { select: { name: true, email: true } },
            },
          },
        },
      },
    },
  });

  if (!partner) {
    return { ok: false, error: "not_partner" };
  }

  // The billed quantity is the count of active enrolled members, which the
  // stored Subscription quantity mirrors; fall back to the live count when no
  // Subscription exists yet (Req 13.5, mirrors getPartnerBilling).
  const activeCount = clampQuantity(partner.memberships.length);
  const subscription = partner.subscription;

  const billing: PartnerBillingSummary = {
    stripeSubscriptionId: subscription?.stripeSubscriptionId ?? null,
    state: (subscription?.state ?? null) as SubscriptionState | null,
    quantity: subscription?.quantity ?? activeCount,
  };

  // Re-assert membership for each listed member so the view is confined to
  // members actively managed by this Partner; drop any that fail (Req 13.6).
  const checks = await Promise.all(
    partner.memberships.map(async (membership) => {
      try {
        await assertPartnerMembership(partnerUserId, membership.seniorId);
      } catch {
        return null;
      }

      return {
        seniorId: membership.seniorId,
        name: membership.senior.user.name,
        email: membership.senior.user.email,
        forwardingActive: membership.senior.forwardingActive,
      } satisfies PartnerMemberSummary;
    }),
  );

  const members = checks.filter(
    (member): member is PartnerMemberSummary => member !== null,
  );

  return { ok: true, data: { billing, members } };
};
