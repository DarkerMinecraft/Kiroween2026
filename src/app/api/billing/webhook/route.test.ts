// Feature: senior-call-shield, Task 9.3: billing webhook integration tests.
//
// Exercises the `/api/billing/webhook` POST handler end-to-end with the Stripe
// SDK and Prisma client mocked. Stripe signature verification is the only
// external gate: `stripe.webhooks.constructEvent` either returns a crafted
// `Stripe.Event` (valid signature) or throws (bad signature). The pure
// decision modules (`isForwardingActive`, `subscriptionStateFromStripe`) run
// for real so the test observes the actual re-gating behavior.
//
// Validates: Requirements 14.2, 14.3, 14.4, 14.6

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks -----------------------------------------------------------------
//
// `vi.mock` factories are hoisted above the imports, so the shared handles they
// close over are created in `vi.hoisted` to run first. `constructEvent` is a
// per-test mock the handler calls through `new Stripe(secretKey)`.
const { stripeMock, prismaMock, constructEventMock } = vi.hoisted(() => {
  const constructEventMock = vi.fn();

  const stripeMock = {
    webhooks: { constructEvent: constructEventMock },
  };

  // Transaction-scoped client reused by `$transaction(fn)`; the same object is
  // exposed at the top level so unmatched/dedup paths share the method handles.
  const prismaMock = {
    processedWebhookEvent: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    subscription: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    seniorProfile: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    partnerMembership: {
      findMany: vi.fn(),
    },
    // `$transaction(fn)` invokes the callback with the same mock client so the
    // reads/writes inside the transaction hit the handles asserted on here.
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prismaMock)),
  };

  return { stripeMock, prismaMock, constructEventMock };
});

vi.mock("stripe", () => {
  // Plain function so the handler's `new Stripe(secretKey)` yields the mock.
  const StripeConstructor = vi.fn(function StripeConstructor() {
    return stripeMock;
  });
  return { default: StripeConstructor };
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// Imported after the mocks are registered so the module picks up the mocks.
import { POST } from "./route";

/** Builds a `customer.subscription.updated` event with a given status. */
const makeSubscriptionEvent = (
  overrides: {
    id?: string;
    type?: string;
    subscriptionId?: string;
    status?: string;
    quantity?: number;
  } = {},
) =>
  ({
    id: overrides.id ?? "evt_1",
    type: overrides.type ?? "customer.subscription.updated",
    data: {
      object: {
        id: overrides.subscriptionId ?? "sub_123",
        status: overrides.status ?? "active",
        items: {
          data: [
            {
              id: "si_1",
              ...(overrides.quantity === undefined ? {} : { quantity: overrides.quantity }),
            },
          ],
        },
      },
    },
  }) as unknown;

/** Builds a POST Request carrying a raw body and a stripe-signature header. */
const makeRequest = (rawBody: string, signature = "t=1,v1=deadbeef"): Request =>
  new Request("https://example.com/api/billing/webhook", {
    method: "POST",
    headers: { "stripe-signature": signature },
    body: rawBody,
  });

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test_123");
  // Default: a first-time (non-duplicate) event.
  prismaMock.processedWebhookEvent.findUnique.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("POST /api/billing/webhook", () => {
  it("applies a valid lifecycle event: updates Subscription state and re-gates forwarding", async () => {
    const event = makeSubscriptionEvent({
      id: "evt_valid",
      subscriptionId: "sub_fam",
      status: "past_due",
    });
    constructEventMock.mockReturnValue(event);

    // The event matches an existing Family_Plan Subscription for one Senior.
    prismaMock.subscription.findUnique.mockResolvedValue({
      id: "subrow_1",
      seniorId: "sen_1",
      partnerId: null,
    });
    // Re-gate reads the Senior's consent + subscription state. With a valid
    // consent but a past_due subscription, forwarding must resolve to false.
    prismaMock.seniorProfile.findUnique.mockResolvedValue({
      consent: { withdrawn: false },
      subscription: { state: "past_due" },
    });

    const response = await POST(makeRequest(JSON.stringify(event)));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ received: true, matched: true });

    // Verification ran against the raw body + webhook secret.
    expect(constructEventMock).toHaveBeenCalledWith(
      JSON.stringify(event),
      "t=1,v1=deadbeef",
      "whsec_test_123",
    );

    // Subscription row updated with the mapped state (past_due -> past_due).
    expect(prismaMock.subscription.update).toHaveBeenCalledWith({
      where: { id: "subrow_1" },
      data: { state: "past_due" },
    });

    // Forwarding re-gated: valid consent + non-active subscription -> inactive.
    expect(prismaMock.seniorProfile.update).toHaveBeenCalledWith({
      where: { id: "sen_1" },
      data: { forwardingActive: false },
    });

    // Event recorded as matched, in the same transaction as the state change.
    expect(prismaMock.processedWebhookEvent.create).toHaveBeenCalledWith({
      data: { stripeEventId: "evt_valid", eventType: "customer.subscription.updated", matched: true },
    });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it("re-gates forwarding to active when a valid consent meets an active subscription", async () => {
    const event = makeSubscriptionEvent({
      id: "evt_active",
      subscriptionId: "sub_fam",
      status: "active",
    });
    constructEventMock.mockReturnValue(event);

    prismaMock.subscription.findUnique.mockResolvedValue({
      id: "subrow_2",
      seniorId: "sen_2",
      partnerId: null,
    });
    prismaMock.seniorProfile.findUnique.mockResolvedValue({
      consent: { withdrawn: false },
      subscription: { state: "active" },
    });

    const response = await POST(makeRequest(JSON.stringify(event)));

    expect(response.status).toBe(200);
    expect(prismaMock.subscription.update).toHaveBeenCalledWith({
      where: { id: "subrow_2" },
      data: { state: "active" },
    });
    expect(prismaMock.seniorProfile.update).toHaveBeenCalledWith({
      where: { id: "sen_2" },
      data: { forwardingActive: true },
    });
  });

  it("rejects a bad signature with HTTP 400 and makes no prisma writes", async () => {
    const event = makeSubscriptionEvent({ id: "evt_bad", subscriptionId: "sub_fam" });
    // constructEvent throws on an invalid signature, exactly as the real SDK does.
    constructEventMock.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature");
    });

    const response = await POST(makeRequest(JSON.stringify(event), "t=1,v1=bogus"));

    expect(response.status).toBe(400);

    // No state read or write occurred: the handler bailed before the ledger.
    expect(prismaMock.processedWebhookEvent.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.processedWebhookEvent.create).not.toHaveBeenCalled();
    expect(prismaMock.subscription.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.subscription.update).not.toHaveBeenCalled();
    expect(prismaMock.seniorProfile.update).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("acknowledges a verified subscription event matching no local Subscription with HTTP 200 and no forwarding change", async () => {
    const event = makeSubscriptionEvent({
      id: "evt_unmatched",
      subscriptionId: "sub_unknown",
      status: "active",
    });
    constructEventMock.mockReturnValue(event);

    // No local Subscription matches the Stripe subscription id.
    prismaMock.subscription.findUnique.mockResolvedValue(null);

    const response = await POST(makeRequest(JSON.stringify(event)));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ received: true, matched: false });

    // Recorded as matched:false; no subscription or forwarding writes.
    expect(prismaMock.processedWebhookEvent.create).toHaveBeenCalledWith({
      data: {
        stripeEventId: "evt_unmatched",
        eventType: "customer.subscription.updated",
        matched: false,
      },
    });
    expect(prismaMock.subscription.update).not.toHaveBeenCalled();
    expect(prismaMock.seniorProfile.update).not.toHaveBeenCalled();
  });

  it("acknowledges a verified non-subscription event with HTTP 200 and records it unmatched with no forwarding change", async () => {
    const event = makeSubscriptionEvent({
      id: "evt_other",
      type: "invoice.paid",
    });
    constructEventMock.mockReturnValue(event);

    const response = await POST(makeRequest(JSON.stringify(event)));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ received: true, matched: false });

    expect(prismaMock.processedWebhookEvent.create).toHaveBeenCalledWith({
      data: { stripeEventId: "evt_other", eventType: "invoice.paid", matched: false },
    });
    // Non-subscription events never open the reconciliation transaction.
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.subscription.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.seniorProfile.update).not.toHaveBeenCalled();
  });
});
