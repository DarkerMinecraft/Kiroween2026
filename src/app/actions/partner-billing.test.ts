import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the Partner per-member billing Server Actions
 * (`src/app/actions/partner-billing.ts`).
 *
 * These exercise the SERVER ACTIONS' authorization and error handling, not the
 * Stripe wrapper (covered by `src/lib/stripe.test.ts`) nor the clamped quantity
 * arithmetic (property-tested in task 13.3). The Stripe wrapper and the prisma
 * client are mocked; the real {@link BillingError}, {@link clampQuantity}, and
 * {@link AuthorizationError} are kept (via `importOriginal`) so the actions'
 * `instanceof` branches and quantity math behave as in production.
 *
 * Covers Req 13.6, 13.8.
 */

// Shared mock handles, created in `vi.hoisted` so the hoisted `vi.mock`
// factories below can close over them.
const { stripeMock, authzMock, prismaMock } = vi.hoisted(() => {
  const stripeMock = {
    ensureBillingAccount: vi.fn(),
    createPartnerSubscription: vi.fn(),
    setPartnerQuantity: vi.fn(),
  };

  const authzMock = {
    assertPartnerMembership: vi.fn(),
  };

  const prismaMock = {
    partnerProfile: { findUnique: vi.fn() },
    partnerMembership: {
      findUnique: vi.fn(),
      count: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    subscription: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  };

  return { stripeMock, authzMock, prismaMock };
});

// Keep the real BillingError and clampQuantity so the action's
// `error instanceof BillingError` branch matches and quantity math is real.
vi.mock("@/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe")>();
  return {
    BillingError: actual.BillingError,
    clampQuantity: actual.clampQuantity,
    ensureBillingAccount: stripeMock.ensureBillingAccount,
    createPartnerSubscription: stripeMock.createPartnerSubscription,
    setPartnerQuantity: stripeMock.setPartnerQuantity,
  };
});

// Keep the real AuthorizationError so the action's `instanceof` branch matches.
vi.mock("@/lib/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authz")>();
  return {
    AuthorizationError: actual.AuthorizationError,
    assertPartnerMembership: authzMock.assertPartnerMembership,
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// Imported after the mocks are registered so the module picks up the mocks.
import { BillingError } from "@/lib/stripe";
import { AuthorizationError } from "@/lib/authz";
import { enrollPartnerMember, removePartnerMember } from "./partner-billing";

const PARTNER_USER_ID = "user_partner";
const PARTNER_ID = "pn_1";
const SENIOR_ID = "senior_1";

beforeEach(() => {
  // A partner profile exists by default; individual tests override as needed.
  prismaMock.partnerProfile.findUnique.mockResolvedValue({
    id: PARTNER_ID,
    user: { email: "pn@example.com", name: "Partner Co" },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("enrollPartnerMember", () => {
  it("reports billing_failed and leaves membership and quantity unchanged when Stripe raises a BillingError (Req 13.8)", async () => {
    // No prior membership for this Senior; one active member already exists.
    prismaMock.partnerMembership.findUnique.mockResolvedValue(null);
    prismaMock.partnerMembership.count.mockResolvedValue(1);
    prismaMock.subscription.findUnique.mockResolvedValue({
      stripeSubscriptionId: "sub_par",
    });
    stripeMock.ensureBillingAccount.mockResolvedValue({
      id: "ba_1",
      stripeCustomerId: "cus_1",
    });
    // Stripe quantity update fails BEFORE any local write.
    stripeMock.setPartnerQuantity.mockRejectedValue(
      new BillingError("setPartnerQuantity", "card declined", {
        code: "card_declined",
      }),
    );

    const result = await enrollPartnerMember({
      partnerUserId: PARTNER_USER_ID,
      seniorId: SENIOR_ID,
    });

    expect(result).toEqual({
      ok: false,
      code: "billing_failed",
      message: expect.any(String),
    });
    // Prior membership state and billed quantity unchanged: no local writes.
    expect(prismaMock.partnerMembership.upsert).not.toHaveBeenCalled();
    expect(prismaMock.subscription.update).not.toHaveBeenCalled();
    expect(prismaMock.subscription.create).not.toHaveBeenCalled();
  });
});

describe("removePartnerMember", () => {
  it("rejects as not_authorized when the membership assertion fails, touching no Stripe call or local write (Req 13.6)", async () => {
    authzMock.assertPartnerMembership.mockRejectedValue(
      new AuthorizationError("partner_membership_absent", "not a member"),
    );

    const result = await removePartnerMember({
      partnerUserId: PARTNER_USER_ID,
      seniorId: SENIOR_ID,
    });

    expect(result).toEqual({
      ok: false,
      code: "not_authorized",
      message: expect.any(String),
    });
    expect(stripeMock.setPartnerQuantity).not.toHaveBeenCalled();
    expect(prismaMock.partnerMembership.update).not.toHaveBeenCalled();
    expect(prismaMock.subscription.update).not.toHaveBeenCalled();
  });

  it("reports billing_failed and leaves membership and quantity unchanged when Stripe raises a BillingError (Req 13.8)", async () => {
    authzMock.assertPartnerMembership.mockResolvedValue(undefined);
    // One active member before removal; a Subscription exists to update.
    prismaMock.partnerMembership.count.mockResolvedValue(1);
    prismaMock.subscription.findUnique.mockResolvedValue({
      stripeSubscriptionId: "sub_par",
    });
    // Stripe quantity update fails BEFORE the membership is marked inactive.
    stripeMock.setPartnerQuantity.mockRejectedValue(
      new BillingError("setPartnerQuantity", "network down"),
    );

    const result = await removePartnerMember({
      partnerUserId: PARTNER_USER_ID,
      seniorId: SENIOR_ID,
    });

    expect(result).toEqual({
      ok: false,
      code: "billing_failed",
      message: expect.any(String),
    });
    // Prior membership stays active and the quantity is not updated locally.
    expect(prismaMock.partnerMembership.update).not.toHaveBeenCalled();
    expect(prismaMock.subscription.update).not.toHaveBeenCalled();
  });
});
