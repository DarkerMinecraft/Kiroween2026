import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import { SUBSCRIPTION_STATES } from "@/lib/constants";

// Feature: senior-call-shield, Property 8: Partner billed quantity never goes
// negative. For an arbitrary sequence of enroll/remove operations over a small
// pool of Senior ids under a single Partner, the billed quantity on the
// Partner's per-member Subscription (what Stripe is told to bill) tracks the
// count of ACTIVE PartnerMembership rows after every operation, and never drops
// below zero. Enrolls add/reactivate a membership and raise the quantity to the
// new active count; removes deactivate a membership and lower it, clamped at the
// zero floor so repeated or spurious removals can never produce a negative bill.
//
// Validates: Requirements 13.3, 13.4

// --- Mock wiring -----------------------------------------------------------
//
// An in-memory model stands in for the database and the Stripe wrapper so no
// real DB/Stripe is touched:
//
// - `@/lib/prisma` is replaced with maps for one partnerProfile (+ backing
//   user), one Subscription (keyed by partnerId, carrying the billed
//   `quantity`), and partnerMemberships keyed by seniorId. `partnerMembership`
//   exposes the findUnique/upsert/update/count the actions call, and the
//   subscription exposes findUnique/create/update; the counts and quantity all
//   read from the same maps so the invariant is observed on real writes.
// - `@/lib/stripe` keeps the REAL `clampQuantity` and `BillingError` (so the
//   zero-floor clamp under test is the production one) and replaces only the
//   three wrapper functions the actions call: `ensureBillingAccount`,
//   `createPartnerSubscription`, and `setPartnerQuantity`. The latter two
//   record the quantity passed in onto the in-memory subscription, mirroring
//   Stripe accepting the new billed quantity.
// - `@/lib/authz` replaces `assertPartnerMembership` with an in-memory check
//   against the same membership map (active + same partner), matching prod
//   scoping without a database.

/** The single Partner under test and its backing user. */
const PARTNER_USER_ID = "partner_user_1";
const PARTNER_ID = "partner_profile_1";

/** In-memory PartnerMembership row (unique per Senior). */
interface MembershipRow {
  partnerId: string;
  active: boolean;
}

/** In-memory per-member Subscription row (one per Partner). */
interface SubscriptionRow {
  partnerId: string;
  stripeSubscriptionId: string;
  state: string;
  quantity: number;
}

const { prismaMock, stripeMock, store } = vi.hoisted(() => {
  // seniorId -> membership row.
  const memberships = new Map<string, MembershipRow>();
  // partnerId -> subscription row (at most one for this test's single partner).
  const subscriptions = new Map<string, SubscriptionRow>();

  const activeCount = (partnerId: string): number =>
    [...memberships.values()].filter(
      (m) => m.partnerId === partnerId && m.active,
    ).length;

  const prismaMock = {
    partnerProfile: {
      findUnique: vi.fn(
        async ({ where }: { where: { userId: string } }) => {
          if (where.userId !== PARTNER_USER_ID) return null;
          return {
            id: PARTNER_ID,
            user: { email: "partner@example.test", name: "Partner Org" },
          };
        },
      ),
    },
    partnerMembership: {
      findUnique: vi.fn(
        async ({ where }: { where: { seniorId: string } }) => {
          const row = memberships.get(where.seniorId);
          return row ? { partnerId: row.partnerId, active: row.active } : null;
        },
      ),
      count: vi.fn(
        async ({
          where,
        }: {
          where: { partnerId: string; active: boolean };
        }) =>
          [...memberships.values()].filter(
            (m) => m.partnerId === where.partnerId && m.active === where.active,
          ).length,
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { seniorId: string };
          create: { partnerId: string; seniorId: string; active: boolean };
          update: { partnerId: string; active: boolean };
        }) => {
          const existing = memberships.get(where.seniorId);
          if (existing) {
            existing.partnerId = update.partnerId;
            existing.active = update.active;
            return { ...existing };
          }
          const row: MembershipRow = {
            partnerId: create.partnerId,
            active: create.active,
          };
          memberships.set(where.seniorId, row);
          return { ...row };
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { seniorId: string };
          data: { active: boolean };
        }) => {
          const row = memberships.get(where.seniorId);
          if (row) row.active = data.active;
          return row ? { ...row } : null;
        },
      ),
    },
    subscription: {
      findUnique: vi.fn(
        async ({ where }: { where: { partnerId: string } }) => {
          const row = subscriptions.get(where.partnerId);
          return row ? { stripeSubscriptionId: row.stripeSubscriptionId } : null;
        },
      ),
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            partnerId: string;
            stripeSubscriptionId: string;
            state: string;
            quantity: number;
          };
        }) => {
          const row: SubscriptionRow = { ...data };
          subscriptions.set(data.partnerId, row);
          return { ...row };
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { partnerId: string };
          data: { state?: string; quantity?: number };
        }) => {
          const row = subscriptions.get(where.partnerId);
          if (!row) return null;
          if (data.state !== undefined) row.state = data.state;
          if (data.quantity !== undefined) row.quantity = data.quantity;
          return { ...row };
        },
      ),
    },
  };

  // Record the quantity Stripe is told to bill onto the in-memory subscription,
  // mirroring Stripe accepting the update. The row may not exist yet when
  // createPartnerSubscription runs (the action creates it right after), so the
  // recorded quantity is returned and the action persists it.
  const stripeMock = {
    ensureBillingAccount: vi.fn(async () => ({
      id: "billing_account_1",
      stripeCustomerId: "cus_partner_1",
    })),
    createPartnerSubscription: vi.fn(
      async (_customerId: string, _partnerId: string, quantity: number) => ({
        stripeSubscriptionId: "sub_partner_1",
        state: SUBSCRIPTION_STATES.active,
        quantity,
      }),
    ),
    setPartnerQuantity: vi.fn(
      async (_subscriptionId: string, quantity: number) => {
        const row = subscriptions.get(PARTNER_ID);
        if (row) row.quantity = quantity;
        return {
          stripeSubscriptionId: "sub_partner_1",
          state: SUBSCRIPTION_STATES.active,
          quantity,
        };
      },
    ),
  };

  const store = {
    memberships,
    subscriptions,
    activeCount,
    billedQuantity(): number {
      return subscriptions.get(PARTNER_ID)?.quantity ?? 0;
    },
    reset() {
      memberships.clear();
      subscriptions.clear();
      vi.clearAllMocks();
    },
  };

  return { prismaMock, stripeMock, store };
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

vi.mock("@/lib/stripe", async (importOriginal) => {
  // Keep the real clampQuantity (the zero-floor clamp under test) and the real
  // BillingError; override only the three wrapper functions the actions call.
  const actual = await importOriginal<typeof import("@/lib/stripe")>();
  return {
    ...actual,
    ensureBillingAccount: stripeMock.ensureBillingAccount,
    createPartnerSubscription: stripeMock.createPartnerSubscription,
    setPartnerQuantity: stripeMock.setPartnerQuantity,
  };
});

vi.mock("@/lib/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authz")>();
  return {
    ...actual,
    // In-memory stand-in matching prod scoping: active membership under the
    // same partner, else an AuthorizationError the action maps to not_authorized.
    assertPartnerMembership: vi.fn(
      async (partnerUserId: string, seniorId: string) => {
        if (partnerUserId !== PARTNER_USER_ID) {
          throw new actual.AuthorizationError(
            "not_partner",
            "Account is not a partner",
          );
        }
        const row = store.memberships.get(seniorId);
        if (!row || !row.active || row.partnerId !== PARTNER_ID) {
          throw new actual.AuthorizationError(
            "partner_membership_absent",
            "No active partner membership between partner and senior",
          );
        }
      },
    ),
  };
});

// Imported after the mocks are registered so the actions pick them up.
import {
  enrollPartnerMember,
  getPartnerBilling,
  removePartnerMember,
} from "./partner-billing";

/** A small, fixed pool of Senior ids so enroll/remove operations collide. */
const SENIOR_POOL = ["sen_a", "sen_b", "sen_c", "sen_d"] as const;

/** One generated operation against a pooled Senior. */
interface Operation {
  readonly kind: "enroll" | "remove";
  readonly seniorId: string;
}

const operationArb: fc.Arbitrary<Operation> = fc.record({
  kind: fc.constantFrom<"enroll" | "remove">("enroll", "remove"),
  seniorId: fc.constantFrom(...SENIOR_POOL),
});

describe("Property 8: partner billed quantity never goes negative", () => {
  beforeEach(() => {
    store.reset();
  });

  it("billed quantity equals the active-enrolled count and never drops below zero", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(operationArb, { minLength: 1, maxLength: 24 }),
        async (operations) => {
          store.reset();

          for (const op of operations) {
            if (op.kind === "enroll") {
              const result = await enrollPartnerMember({
                partnerUserId: PARTNER_USER_ID,
                seniorId: op.seniorId,
              });
              expect(result.ok).toBe(true);
            } else {
              // A remove on a non-active member is rejected by the membership
              // guard (not_authorized) and must leave state untouched; an active
              // member is removed successfully.
              const wasActive = store.memberships.get(op.seniorId)?.active === true;
              const result = await removePartnerMember({
                partnerUserId: PARTNER_USER_ID,
                seniorId: op.seniorId,
              });
              expect(result.ok).toBe(wasActive);
            }

            // Invariant after every operation: the billed quantity mirrors the
            // active-enrolled count and is never negative.
            const active = store.activeCount(PARTNER_ID);
            const billed = store.billedQuantity();
            expect(billed).toBe(active);
            expect(billed).toBeGreaterThanOrEqual(0);
          }

          // The read action reports the same non-negative billed quantity.
          const billing = await getPartnerBilling({
            partnerUserId: PARTNER_USER_ID,
          });
          expect(billing.ok).toBe(true);
          if (billing.ok) {
            expect(billing.data.quantity).toBe(store.activeCount(PARTNER_ID));
            expect(billing.data.quantity).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
