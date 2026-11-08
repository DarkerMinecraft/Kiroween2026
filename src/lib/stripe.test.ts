import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SUBSCRIPTION_STATES } from "./constants";

// --- Stripe SDK mock -------------------------------------------------------
//
// The wrapper constructs `new Stripe(secretKey)` and calls into
// `stripe.customers.create`, `stripe.subscriptions.{create,cancel,retrieve,update}`.
// Its typed-error path keys off `cause instanceof Stripe.errors.StripeError`,
// so the mocked default export must expose `errors.StripeError` as a real
// class and the errors thrown by the mock must be instances of that same class.

// `vi.mock` factories are hoisted above the rest of the module, so everything
// they close over — the error class and the shared method mocks — is created
// inside `vi.hoisted` to run before the hoisted factories execute.
const { MockStripeError, stripeMock, prismaMock } = vi.hoisted(() => {
  /** Stand-in for Stripe's `StripeError`, carrying a `code` like the real one. */
  class MockStripeError extends Error {
    readonly code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.name = "StripeError";
      this.code = code;
      Object.setPrototypeOf(this, MockStripeError.prototype);
    }
  }

  /** Per-test handles to the Stripe method mocks shared with the module mock. */
  const stripeMock = {
    customers: { create: vi.fn() },
    subscriptions: {
      create: vi.fn(),
      cancel: vi.fn(),
      retrieve: vi.fn(),
      update: vi.fn(),
    },
  };

  /** Per-test handles to the prisma `billingAccount` mocks. */
  const prismaMock = {
    billingAccount: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  };

  return { MockStripeError, stripeMock, prismaMock };
});

vi.mock("stripe", () => {
  // A plain function (not an arrow) so the wrapper's `new Stripe(secretKey)`
  // call succeeds and yields the shared method mocks.
  const StripeConstructor = vi.fn(function StripeConstructor() {
    return stripeMock;
  });
  // Attach the errors namespace to the constructor so `Stripe.errors.StripeError`
  // resolves against the same class the mock throws.
  (StripeConstructor as unknown as { errors: { StripeError: typeof MockStripeError } }).errors = {
    StripeError: MockStripeError,
  };
  return { default: StripeConstructor };
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// Imported after the mocks are registered so the module picks up the mocks.
import {
  BillingError,
  cancelSubscription,
  clampQuantity,
  createFamilySubscription,
  createPartnerSubscription,
  ensureBillingAccount,
  setPartnerQuantity,
  subscriptionStateFromStripe,
} from "./stripe";

/** Builds a minimal Stripe-subscription-shaped object for the mock to return. */
const makeSubscription = (
  overrides: {
    id?: string;
    status?: string;
    itemId?: string;
    quantity?: number;
  } = {},
) => ({
  id: overrides.id ?? "sub_123",
  status: overrides.status ?? "active",
  items: {
    data: [
      {
        id: overrides.itemId ?? "si_123",
        ...(overrides.quantity === undefined ? {} : { quantity: overrides.quantity }),
      },
    ],
  },
});

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
  vi.stubEnv("STRIPE_FAMILY_PRICE_ID", "price_family");
  vi.stubEnv("STRIPE_PARTNER_PRICE_ID", "price_partner");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("ensureBillingAccount", () => {
  it("reuses an existing billing account's Stripe customer without creating a new one", async () => {
    prismaMock.billingAccount.findFirst.mockResolvedValue({
      id: "ba_1",
      stripeCustomerId: "cus_existing",
    });

    const result = await ensureBillingAccount({ caregiverId: "cg_1" });

    expect(result).toEqual({ id: "ba_1", stripeCustomerId: "cus_existing" });
    expect(stripeMock.customers.create).not.toHaveBeenCalled();
    expect(prismaMock.billingAccount.create).not.toHaveBeenCalled();
  });

  it("creates a Stripe customer and persists a new billing account when none exists", async () => {
    prismaMock.billingAccount.findFirst.mockResolvedValue(null);
    stripeMock.customers.create.mockResolvedValue({ id: "cus_new" });
    prismaMock.billingAccount.create.mockResolvedValue({
      id: "ba_2",
      stripeCustomerId: "cus_new",
    });

    const result = await ensureBillingAccount({
      caregiverId: "cg_2",
      email: "cg@example.com",
      name: "Care Giver",
    });

    expect(stripeMock.customers.create).toHaveBeenCalledWith({
      email: "cg@example.com",
      name: "Care Giver",
      metadata: { caregiverId: "cg_2" },
    });
    expect(prismaMock.billingAccount.create).toHaveBeenCalledWith({
      data: {
        caregiverId: "cg_2",
        partnerId: null,
        stripeCustomerId: "cus_new",
      },
      select: { id: true, stripeCustomerId: true },
    });
    expect(result).toEqual({ id: "ba_2", stripeCustomerId: "cus_new" });
  });

  it("rejects an owner that is neither caregiver nor partner", async () => {
    await expect(ensureBillingAccount({})).rejects.toBeInstanceOf(BillingError);
    expect(prismaMock.billingAccount.findFirst).not.toHaveBeenCalled();
  });

  it("rejects an owner that is both caregiver and partner", async () => {
    await expect(
      ensureBillingAccount({ caregiverId: "cg", partnerId: "pn" }),
    ).rejects.toBeInstanceOf(BillingError);
    expect(prismaMock.billingAccount.findFirst).not.toHaveBeenCalled();
  });
});

describe("createFamilySubscription", () => {
  it("creates a per-Senior subscription with the configured family price and senior metadata", async () => {
    stripeMock.subscriptions.create.mockResolvedValue(
      makeSubscription({ id: "sub_fam", status: "active" }),
    );

    const result = await createFamilySubscription("cus_1", "sen_1");

    expect(stripeMock.subscriptions.create).toHaveBeenCalledWith({
      customer: "cus_1",
      items: [{ price: "price_family" }],
      metadata: { seniorId: "sen_1" },
    });
    expect(result).toEqual({
      stripeSubscriptionId: "sub_fam",
      state: SUBSCRIPTION_STATES.active,
    });
  });
});

describe("createPartnerSubscription", () => {
  it("creates a quantity-based subscription with the configured partner price and partner metadata", async () => {
    stripeMock.subscriptions.create.mockResolvedValue(
      makeSubscription({ id: "sub_par", status: "active", quantity: 3 }),
    );

    const result = await createPartnerSubscription("cus_2", "pn_1", 3);

    expect(stripeMock.subscriptions.create).toHaveBeenCalledWith({
      customer: "cus_2",
      items: [{ price: "price_partner", quantity: 3 }],
      metadata: { partnerId: "pn_1" },
    });
    expect(result).toEqual({
      stripeSubscriptionId: "sub_par",
      state: SUBSCRIPTION_STATES.active,
      quantity: 3,
    });
  });

  it("clamps a negative initial quantity to zero before creating the subscription", async () => {
    stripeMock.subscriptions.create.mockResolvedValue(
      makeSubscription({ id: "sub_par0", status: "active", quantity: 0 }),
    );

    const result = await createPartnerSubscription("cus_2", "pn_1", -5);

    expect(stripeMock.subscriptions.create).toHaveBeenCalledWith({
      customer: "cus_2",
      items: [{ price: "price_partner", quantity: 0 }],
      metadata: { partnerId: "pn_1" },
    });
    expect(result.quantity).toBe(0);
  });
});

describe("setPartnerQuantity", () => {
  it("clamps a negative requested quantity to zero when updating the subscription item", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue(
      makeSubscription({ id: "sub_q", itemId: "si_q", quantity: 4 }),
    );
    stripeMock.subscriptions.update.mockResolvedValue(
      makeSubscription({ id: "sub_q", itemId: "si_q", status: "active", quantity: 0 }),
    );

    const result = await setPartnerQuantity("sub_q", -10);

    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith("sub_q", {
      items: [{ id: "si_q", quantity: 0 }],
    });
    expect(result.quantity).toBe(0);
  });

  it("updates the subscription item to the clamped (truncated) quantity", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue(
      makeSubscription({ id: "sub_q", itemId: "si_q", quantity: 2 }),
    );
    stripeMock.subscriptions.update.mockResolvedValue(
      makeSubscription({ id: "sub_q", itemId: "si_q", status: "active", quantity: 7 }),
    );

    const result = await setPartnerQuantity("sub_q", 7.9);

    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith("sub_q", {
      items: [{ id: "si_q", quantity: 7 }],
    });
    expect(result.quantity).toBe(7);
  });

  it("throws a BillingError when the subscription has no line item to update", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      id: "sub_empty",
      status: "active",
      items: { data: [] },
    });

    await expect(setPartnerQuantity("sub_empty", 1)).rejects.toBeInstanceOf(
      BillingError,
    );
    expect(stripeMock.subscriptions.update).not.toHaveBeenCalled();
  });
});

describe("cancelSubscription", () => {
  it("cancels the subscription and returns the mapped canceled state", async () => {
    stripeMock.subscriptions.cancel.mockResolvedValue(
      makeSubscription({ id: "sub_c", status: "canceled" }),
    );

    const result = await cancelSubscription("sub_c");

    expect(stripeMock.subscriptions.cancel).toHaveBeenCalledWith("sub_c");
    expect(result.stripeSubscriptionId).toBe("sub_c");
    expect(result.state).toBe(SUBSCRIPTION_STATES.canceled);
  });
});

describe("typed-error paths", () => {
  it("surfaces a thrown Stripe error as a BillingError carrying the operation and code", async () => {
    stripeMock.subscriptions.create.mockRejectedValue(
      new MockStripeError("card declined", "card_declined"),
    );

    const error = await createFamilySubscription("cus_1", "sen_1").catch((e) => e);

    expect(error).toBeInstanceOf(BillingError);
    expect((error as BillingError).operation).toBe("createFamilySubscription");
    expect((error as BillingError).code).toBe("card_declined");
    expect((error as BillingError).message).toContain("card declined");
  });

  it("wraps a non-Stripe failure as a BillingError without a code", async () => {
    stripeMock.subscriptions.cancel.mockRejectedValue(new Error("network down"));

    const error = await cancelSubscription("sub_c").catch((e) => e);

    expect(error).toBeInstanceOf(BillingError);
    expect((error as BillingError).operation).toBe("cancelSubscription");
    expect((error as BillingError).code).toBeUndefined();
    expect((error as BillingError).message).toContain("network down");
  });

  it("throws a BillingError when STRIPE_SECRET_KEY is absent", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");

    await expect(createFamilySubscription("cus_1", "sen_1")).rejects.toBeInstanceOf(
      BillingError,
    );
    expect(stripeMock.subscriptions.create).not.toHaveBeenCalled();
  });

  it("throws a BillingError when the family price id is absent", async () => {
    vi.stubEnv("STRIPE_FAMILY_PRICE_ID", "");

    await expect(createFamilySubscription("cus_1", "sen_1")).rejects.toBeInstanceOf(
      BillingError,
    );
    expect(stripeMock.subscriptions.create).not.toHaveBeenCalled();
  });
});

describe("clampQuantity", () => {
  it("clamps negatives to zero, truncates fractions, and rejects non-finite input", () => {
    expect(clampQuantity(-1)).toBe(0);
    expect(clampQuantity(-0.5)).toBe(0);
    expect(clampQuantity(0)).toBe(0);
    expect(clampQuantity(3)).toBe(3);
    expect(clampQuantity(3.9)).toBe(3);
    expect(clampQuantity(Number.NaN)).toBe(0);
    expect(clampQuantity(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("subscriptionStateFromStripe", () => {
  it("maps active and trialing to active", () => {
    expect(subscriptionStateFromStripe("active")).toBe(SUBSCRIPTION_STATES.active);
    expect(subscriptionStateFromStripe("trialing")).toBe(SUBSCRIPTION_STATES.active);
  });

  it("maps past_due and unpaid to past_due", () => {
    expect(subscriptionStateFromStripe("past_due")).toBe(SUBSCRIPTION_STATES.pastDue);
    expect(subscriptionStateFromStripe("unpaid")).toBe(SUBSCRIPTION_STATES.pastDue);
  });

  it("maps canceled to canceled", () => {
    expect(subscriptionStateFromStripe("canceled")).toBe(SUBSCRIPTION_STATES.canceled);
  });

  it("maps incomplete, incomplete_expired, and paused to incomplete", () => {
    expect(subscriptionStateFromStripe("incomplete")).toBe(
      SUBSCRIPTION_STATES.incomplete,
    );
    expect(subscriptionStateFromStripe("incomplete_expired")).toBe(
      SUBSCRIPTION_STATES.incomplete,
    );
    expect(subscriptionStateFromStripe("paused")).toBe(SUBSCRIPTION_STATES.incomplete);
  });

  it("folds any unrecognized status to incomplete so it never reads as active", () => {
    expect(subscriptionStateFromStripe("something_new")).toBe(
      SUBSCRIPTION_STATES.incomplete,
    );
  });
});
