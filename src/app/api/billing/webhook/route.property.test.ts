import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import { SUBSCRIPTION_STATES } from "@/lib/constants";

// Feature: senior-call-shield, Property 6: Webhook processing is idempotent by
// event id. A signature-verified `customer.subscription.*` event, POSTed once,
// drives the local Subscription state and each affected Senior's forwarding
// projection. Re-POSTing the SAME Stripe event id produces the identical
// resulting Subscription state and SeniorProfile.forwardingActive, is NOT
// applied a second time (the ProcessedWebhookEvent ledger still holds exactly
// one entry for that id), and the duplicate POST returns the prior result.
//
// Validates: Requirements 14.5

// --- Mock wiring -----------------------------------------------------------
//
// The route constructs `new Stripe(secretKey)` and verifies the signature with
// `stripe.webhooks.constructEvent(rawBody, signature, secret)`. The mock below
// bypasses real signature crypto: `constructEvent` simply parses the raw JSON
// body back into a Stripe.Event-shaped object, so any body POSTed with a
// present signature header is treated as signature-verified.
//
// `@/lib/prisma` is replaced with an in-memory model: a Map of
// processedWebhookEvent keyed by stripeEventId, a Map of subscriptions keyed by
// stripeSubscriptionId (also indexed by row id), and a Map of seniorProfile
// records. `$transaction(fn)` just invokes `fn` with the same mock client, so
// the ledger write and the state change commit together exactly as in prod.
//
// `@/lib/screening` and `@/lib/stripe` are left unmocked so the real forwarding
// gate and the real Stripe-status mapper run against the crafted events.

/** In-memory SeniorProfile row: only the fields the route reads/writes. */
interface SeniorRecord {
  id: string;
  consent: { withdrawn: boolean } | null;
  forwardingActive: boolean;
}

/** In-memory Subscription row keyed by both row id and Stripe subscription id. */
interface SubscriptionRecord {
  id: string;
  stripeSubscriptionId: string;
  seniorId: string | null;
  partnerId: string | null;
  state: string;
  quantity: number;
}

/** In-memory ProcessedWebhookEvent ledger row keyed by Stripe event id. */
interface ProcessedEventRecord {
  stripeEventId: string;
  eventType: string;
  matched: boolean;
}

// `vi.hoisted` runs before the hoisted `vi.mock` factories, so the in-memory
// store and the mock client they close over are created here.
const { prismaMock, store } = vi.hoisted(() => {
  const seniors = new Map<string, SeniorRecord>();
  const subscriptionsById = new Map<string, SubscriptionRecord>();
  const subscriptionsByStripeId = new Map<string, SubscriptionRecord>();
  const processed = new Map<string, ProcessedEventRecord>();

  // A single mock client used both as `prisma` and as the `$transaction`
  // callback argument, so reads and writes hit the same in-memory maps.
  const client = {
    seniorProfile: {
      // Returns the nested `{ consent, subscription }` shape the route selects.
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const senior = seniors.get(where.id);
        if (!senior) return null;
        const sub = [...subscriptionsById.values()].find(
          (s) => s.seniorId === senior.id,
        );
        return {
          consent: senior.consent ? { withdrawn: senior.consent.withdrawn } : null,
          subscription: sub ? { state: sub.state } : null,
        };
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { forwardingActive: boolean };
        }) => {
          const senior = seniors.get(where.id);
          if (senior) senior.forwardingActive = data.forwardingActive;
          return senior;
        },
      ),
    },
    subscription: {
      findUnique: vi.fn(
        async ({ where }: { where: { stripeSubscriptionId: string } }) => {
          const sub = subscriptionsByStripeId.get(where.stripeSubscriptionId);
          if (!sub) return null;
          return { id: sub.id, seniorId: sub.seniorId, partnerId: sub.partnerId };
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { state?: string; quantity?: number };
        }) => {
          const sub = subscriptionsById.get(where.id);
          if (!sub) return null;
          if (data.state !== undefined) sub.state = data.state;
          if (data.quantity !== undefined) sub.quantity = data.quantity;
          return sub;
        },
      ),
    },
    partnerMembership: {
      findMany: vi.fn(async () => []),
    },
    processedWebhookEvent: {
      findUnique: vi.fn(
        async ({ where }: { where: { stripeEventId: string } }) => {
          const row = processed.get(where.stripeEventId);
          return row ? { matched: row.matched } : null;
        },
      ),
      create: vi.fn(async ({ data }: { data: ProcessedEventRecord }) => {
        // Mirror the DB unique constraint on stripeEventId so a genuine
        // double-apply would surface as an error rather than silently overwrite.
        if (processed.has(data.stripeEventId)) {
          throw new Error(
            `Unique constraint violated on stripeEventId ${data.stripeEventId}`,
          );
        }
        processed.set(data.stripeEventId, { ...data });
        return { ...data };
      }),
    },
    // `$transaction(fn)` runs the callback against the same client so every
    // write in the reconcile path lands in the same in-memory maps.
    $transaction: vi.fn(async (fn: (tx: typeof client) => Promise<unknown>) =>
      fn(client),
    ),
  };

  const store = {
    seniors,
    subscriptionsById,
    subscriptionsByStripeId,
    processed,
    /** Clears all maps + mock call history and seeds a fresh scenario. */
    reset(subs: SubscriptionRecord[], sens: SeniorRecord[]) {
      seniors.clear();
      subscriptionsById.clear();
      subscriptionsByStripeId.clear();
      processed.clear();
      vi.clearAllMocks();
      for (const s of sens) seniors.set(s.id, { ...s });
      for (const sub of subs) {
        const row = { ...sub };
        subscriptionsById.set(row.id, row);
        subscriptionsByStripeId.set(row.stripeSubscriptionId, row);
      }
    },
  };

  return { prismaMock: client, store };
});

vi.mock("stripe", () => {
  // Plain function (not an arrow) so the route's `new Stripe(secretKey)` call
  // yields the mock instance.
  const StripeConstructor = vi.fn(function StripeConstructor() {
    return {
      webhooks: {
        // Bypass real signature crypto: the raw body already carries the event,
        // so parse it straight back into a Stripe.Event-shaped object.
        constructEvent: (rawBody: string) => JSON.parse(rawBody),
      },
    };
  });
  return { default: StripeConstructor };
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// Imported after the mocks are registered so the route picks them up.
import { POST } from "./route";

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_webhook");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Stripe statuses the webhook reconciles, spanning every mapped local state. */
const STRIPE_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "paused",
] as const;

/** The subscription lifecycle event types the handler reconciles. */
const SUBSCRIPTION_EVENT_TYPES = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
] as const;

/** The local SubscriptionState the route's mapper folds each Stripe status to. */
const expectedStateFor = (status: string): string => {
  if (status === "active" || status === "trialing") return SUBSCRIPTION_STATES.active;
  if (status === "past_due" || status === "unpaid") return SUBSCRIPTION_STATES.pastDue;
  if (status === "canceled") return SUBSCRIPTION_STATES.canceled;
  return SUBSCRIPTION_STATES.incomplete;
};

/** Builds a crafted, "signature-verified" Stripe.Event as a raw JSON body. */
const buildEventBody = (params: {
  eventId: string;
  eventType: string;
  stripeSubscriptionId: string;
  status: string;
  quantity: number;
}): string =>
  JSON.stringify({
    id: params.eventId,
    type: params.eventType,
    data: {
      object: {
        id: params.stripeSubscriptionId,
        status: params.status,
        items: { data: [{ quantity: params.quantity }] },
      },
    },
  });

/** POSTs a crafted event body with a present (stub) signature header. */
const postEvent = (body: string): Promise<Response> =>
  POST(
    new Request("https://example.test/api/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=stub" },
      body,
    }),
  );

describe("Property 6: webhook processing is idempotent by event id", () => {
  it("replaying the same event id yields identical state and applies only once", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Varied event id, lifecycle type, resulting status, billed quantity,
        // and consent presence span the subscription lifecycle input space.
        fc.string({ minLength: 1, maxLength: 24 }).map((s) => `evt_${s}`),
        fc.constantFrom(...SUBSCRIPTION_EVENT_TYPES),
        fc.constantFrom(...STRIPE_STATUSES),
        fc.integer({ min: 0, max: 50 }),
        fc.boolean(),
        async (eventId, eventType, status, quantity, hasValidConsent) => {
          const stripeSubscriptionId = "sub_prop6";
          const seniorId = "sen_prop6";

          // Seed a Senior whose subscription is the one the event targets.
          // Start forwarding at `true` so a genuine first apply is observable
          // whenever the gate decides `false`, and so a (buggy) second apply
          // would also be detectable.
          store.reset(
            [
              {
                id: "subrow_1",
                stripeSubscriptionId,
                seniorId,
                partnerId: null,
                state: SUBSCRIPTION_STATES.incomplete,
                quantity: 0,
              },
            ],
            [
              {
                id: seniorId,
                consent: { withdrawn: !hasValidConsent },
                forwardingActive: true,
              },
            ],
          );

          const body = buildEventBody({
            eventId,
            eventType,
            stripeSubscriptionId,
            status,
            quantity,
          });

          // First processing: applies the event exactly once.
          const firstResponse = await postEvent(body);
          const firstJson = (await firstResponse.json()) as {
            received: boolean;
            matched: boolean;
            duplicate?: boolean;
          };

          const afterFirst = {
            subscriptionState:
              store.subscriptionsByStripeId.get(stripeSubscriptionId)?.state,
            forwardingActive: store.seniors.get(seniorId)?.forwardingActive,
          };

          expect(firstResponse.status).toBe(200);
          expect(firstJson.matched).toBe(true);
          expect(firstJson.duplicate).toBeUndefined();
          expect(store.processed.size).toBe(1);

          // Resulting state reflects the real status mapper + forwarding gate.
          const mappedState = expectedStateFor(status);
          const expectedForwarding =
            hasValidConsent && mappedState === SUBSCRIPTION_STATES.active;
          expect(afterFirst.subscriptionState).toBe(mappedState);
          expect(afterFirst.forwardingActive).toBe(expectedForwarding);

          // How many times the apply path touched state on the first POST.
          const updateCallsAfterFirst =
            prismaMock.subscription.update.mock.calls.length;
          const createCallsAfterFirst =
            prismaMock.processedWebhookEvent.create.mock.calls.length;

          // Replay: POST the SAME event id (same body) again.
          const secondResponse = await postEvent(body);
          const secondJson = (await secondResponse.json()) as {
            received: boolean;
            matched: boolean;
            duplicate?: boolean;
          };

          // (a) Resulting Subscription + forwarding state are identical.
          expect(
            store.subscriptionsByStripeId.get(stripeSubscriptionId)?.state,
          ).toBe(afterFirst.subscriptionState);
          expect(store.seniors.get(seniorId)?.forwardingActive).toBe(
            afterFirst.forwardingActive,
          );

          // (b) Not applied a second time: the ledger still holds exactly one
          // entry for that id, and no further Subscription update / ledger
          // create ran on the replay.
          expect(store.processed.size).toBe(1);
          expect(store.processed.has(eventId)).toBe(true);
          expect(prismaMock.subscription.update.mock.calls.length).toBe(
            updateCallsAfterFirst,
          );
          expect(prismaMock.processedWebhookEvent.create.mock.calls.length).toBe(
            createCallsAfterFirst,
          );

          // The duplicate POST returns the prior result, flagged as duplicate.
          expect(secondResponse.status).toBe(200);
          expect(secondJson.duplicate).toBe(true);
          expect(secondJson.matched).toBe(firstJson.matched);
        },
      ),
      { numRuns: 200 },
    );
  });
});
