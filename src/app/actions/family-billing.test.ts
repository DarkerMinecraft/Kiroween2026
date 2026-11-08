import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SUBSCRIPTION_STATES } from "@/lib/constants";

/**
 * Unit tests for the Family_Plan billing Server Actions
 * (`src/app/actions/family-billing.ts`).
 *
 * These exercise the SERVER ACTIONS' authorization and error handling, not the
 * Stripe wrapper (covered by `src/lib/stripe.test.ts`). The Stripe wrapper and
 * the prisma client are mocked; the real {@link BillingError} and
 * {@link AuthorizationError} classes are kept (via `importOriginal`) so the
 * actions' `instanceof` branches fire exactly as in production. `@/lib/screening`
 * runs real so forwarding re-gating reflects the true forwarding gate.
 *
 * Covers Req 12.3, 12.4, 12.10, 12.11.
 */

// Shared mock handles, created in `vi.hoisted` so the hoisted `vi.mock`
// factories below can close over them.
const { stripeMock, authzMock, prismaMock } = vi.hoisted(() => {
  const stripeMock = {
    ensureBillingAccount: vi.fn(),
    createFamilySubscription: vi.fn(),
    cancelSubscription: vi.fn(),
  };

  const authzMock = {
    assertCareLink: vi.fn(),
  };

  const prismaMock = {
    caregiverProfile: { findUnique: vi.fn() },
    subscription: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    careLink: { findMany: vi.fn() },
    seniorProfile: { findUnique: vi.fn(), update: vi.fn() },
  };

  return { stripeMock, authzMock, prismaMock };
});

// Keep the real BillingError (and clampQuantity) so the action's
// `error instanceof BillingError` branch matches what the wrapper throws.
vi.mock("@/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe")>();
  return {
    BillingError: actual.BillingError,
    clampQuantity: actual.clampQuantity,
    ensureBillingAccount: stripeMock.ensureBillingAccount,
    createFamilySubscription: stripeMock.createFamilySubscription,
    cancelSubscription: stripeMock.cancelSubscription,
  };
});

// Keep the real AuthorizationError so the action's `instanceof` branch matches.
vi.mock("@/lib/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authz")>();
  return {
    AuthorizationError: actual.AuthorizationError,
    assertCareLink: authzMock.assertCareLink,
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// Imported after the mocks are registered so the module picks up the mocks.
import { BillingError } from "@/lib/stripe";
import { AuthorizationError } from "@/lib/authz";
import { cancelFamilyPlan, subscribeFamilyPlan } from "./family-billing";

const CAREGIVER_USER_ID = "user_caregiver";
const SENIOR_ID = "senior_1";

beforeEach(() => {
  // A caregiver profile exists by default; individual tests override as needed.
  prismaMock.caregiverProfile.findUnique.mockResolvedValue({
    id: "cg_1",
    user: { email: "cg@example.com", name: "Care Giver" },
  });
  // Default: a valid, non-withdrawn consent and an active subscription so
  // regateForwarding has a Senior to read when a test reaches it.
  prismaMock.seniorProfile.findUnique.mockResolvedValue({
    consent: { withdrawn: false },
    subscription: { state: SUBSCRIPTION_STATES.active },
  });
  prismaMock.seniorProfile.update.mockResolvedValue({});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("subscribeFamilyPlan", () => {
  it("rejects as not_authorized when the care-link assertion fails, touching no Stripe call or subscription write (Req 12.3)", async () => {
    authzMock.assertCareLink.mockRejectedValue(
      new AuthorizationError("care_link_absent", "no link"),
    );

    const result = await subscribeFamilyPlan({
      caregiverUserId: CAREGIVER_USER_ID,
      seniorId: SENIOR_ID,
    });

    expect(result).toEqual({
      ok: false,
      code: "not_authorized",
      message: expect.any(String),
    });
    expect(stripeMock.ensureBillingAccount).not.toHaveBeenCalled();
    expect(stripeMock.createFamilySubscription).not.toHaveBeenCalled();
    expect(prismaMock.subscription.upsert).not.toHaveBeenCalled();
    expect(prismaMock.seniorProfile.update).not.toHaveBeenCalled();
  });

  it("rejects with subscription_exists when an active Subscription already exists, leaving it untouched (Req 12.4)", async () => {
    authzMock.assertCareLink.mockResolvedValue(undefined);
    prismaMock.subscription.findUnique.mockResolvedValue({
      state: SUBSCRIPTION_STATES.active,
    });

    const result = await subscribeFamilyPlan({
      caregiverUserId: CAREGIVER_USER_ID,
      seniorId: SENIOR_ID,
    });

    expect(result).toEqual({
      ok: false,
      code: "subscription_exists",
      message: expect.any(String),
    });
    // No Stripe resource created and the existing row is not rewritten.
    expect(stripeMock.ensureBillingAccount).not.toHaveBeenCalled();
    expect(stripeMock.createFamilySubscription).not.toHaveBeenCalled();
    expect(prismaMock.subscription.upsert).not.toHaveBeenCalled();
  });

  it("reports billing_failed and writes no subscription row when Stripe raises a BillingError (Req 12.11)", async () => {
    authzMock.assertCareLink.mockResolvedValue(undefined);
    prismaMock.subscription.findUnique.mockResolvedValue(null);
    stripeMock.ensureBillingAccount.mockResolvedValue({
      id: "ba_1",
      stripeCustomerId: "cus_1",
    });
    stripeMock.createFamilySubscription.mockRejectedValue(
      new BillingError("createFamilySubscription", "card declined", {
        code: "card_declined",
      }),
    );

    const result = await subscribeFamilyPlan({
      caregiverUserId: CAREGIVER_USER_ID,
      seniorId: SENIOR_ID,
    });

    expect(result).toEqual({
      ok: false,
      code: "billing_failed",
      message: expect.any(String),
    });
    // Prior state unchanged: no subscription persisted, no forwarding re-gate.
    expect(prismaMock.subscription.upsert).not.toHaveBeenCalled();
    expect(prismaMock.seniorProfile.update).not.toHaveBeenCalled();
  });

  it("persists the Subscription and re-gates forwarding on success", async () => {
    authzMock.assertCareLink.mockResolvedValue(undefined);
    prismaMock.subscription.findUnique.mockResolvedValue(null);
    stripeMock.ensureBillingAccount.mockResolvedValue({
      id: "ba_1",
      stripeCustomerId: "cus_1",
    });
    stripeMock.createFamilySubscription.mockResolvedValue({
      stripeSubscriptionId: "sub_fam",
      state: SUBSCRIPTION_STATES.active,
    });
    prismaMock.subscription.upsert.mockResolvedValue({});

    const result = await subscribeFamilyPlan({
      caregiverUserId: CAREGIVER_USER_ID,
      seniorId: SENIOR_ID,
    });

    expect(result).toEqual({ ok: true });
    expect(stripeMock.createFamilySubscription).toHaveBeenCalledWith(
      "cus_1",
      SENIOR_ID,
    );
    expect(prismaMock.subscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { seniorId: SENIOR_ID } }),
    );
    // Forwarding re-gated: consent valid + active subscription -> active true.
    expect(prismaMock.seniorProfile.update).toHaveBeenCalledWith({
      where: { id: SENIOR_ID },
      data: { forwardingActive: true },
    });
  });
});

describe("cancelFamilyPlan", () => {
  it("rejects as not_authorized when the care-link assertion fails, leaving the subscription unchanged (Req 12.10)", async () => {
    authzMock.assertCareLink.mockRejectedValue(
      new AuthorizationError("care_link_absent", "no link"),
    );

    const result = await cancelFamilyPlan({
      caregiverUserId: CAREGIVER_USER_ID,
      seniorId: SENIOR_ID,
    });

    expect(result).toEqual({
      ok: false,
      code: "not_authorized",
      message: expect.any(String),
    });
    expect(stripeMock.cancelSubscription).not.toHaveBeenCalled();
    expect(prismaMock.subscription.update).not.toHaveBeenCalled();
    expect(prismaMock.seniorProfile.update).not.toHaveBeenCalled();
  });

  it("cancels, updates state, and re-gates forwarding inactive on success", async () => {
    authzMock.assertCareLink.mockResolvedValue(undefined);
    prismaMock.subscription.findUnique.mockResolvedValue({
      stripeSubscriptionId: "sub_fam",
    });
    stripeMock.cancelSubscription.mockResolvedValue({
      stripeSubscriptionId: "sub_fam",
      state: SUBSCRIPTION_STATES.canceled,
    });
    prismaMock.subscription.update.mockResolvedValue({});
    // After cancellation the Senior's subscription is no longer active.
    prismaMock.seniorProfile.findUnique.mockResolvedValue({
      consent: { withdrawn: false },
      subscription: { state: SUBSCRIPTION_STATES.canceled },
    });

    const result = await cancelFamilyPlan({
      caregiverUserId: CAREGIVER_USER_ID,
      seniorId: SENIOR_ID,
    });

    expect(result).toEqual({ ok: true });
    expect(stripeMock.cancelSubscription).toHaveBeenCalledWith("sub_fam");
    expect(prismaMock.subscription.update).toHaveBeenCalledWith({
      where: { seniorId: SENIOR_ID },
      data: { state: SUBSCRIPTION_STATES.canceled },
    });
    // Forwarding re-gated: canceled subscription -> forwarding inactive.
    expect(prismaMock.seniorProfile.update).toHaveBeenCalledWith({
      where: { id: SENIOR_ID },
      data: { forwardingActive: false },
    });
  });

  it("reports billing_failed and retains prior state when Stripe raises a BillingError (Req 12.11)", async () => {
    authzMock.assertCareLink.mockResolvedValue(undefined);
    prismaMock.subscription.findUnique.mockResolvedValue({
      stripeSubscriptionId: "sub_fam",
    });
    stripeMock.cancelSubscription.mockRejectedValue(
      new BillingError("cancelSubscription", "network down"),
    );

    const result = await cancelFamilyPlan({
      caregiverUserId: CAREGIVER_USER_ID,
      seniorId: SENIOR_ID,
    });

    expect(result).toEqual({
      ok: false,
      code: "billing_failed",
      message: expect.any(String),
    });
    // Prior state retained: no local state update, no forwarding re-gate.
    expect(prismaMock.subscription.update).not.toHaveBeenCalled();
    expect(prismaMock.seniorProfile.update).not.toHaveBeenCalled();
  });
});
