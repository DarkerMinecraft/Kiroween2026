/**
 * Stripe billing webhook route handler (`/api/billing/webhook`).
 *
 * Stripe is the system of record for subscription state; this endpoint is the
 * only writer of `Subscription.state`. It reconciles local state from
 * signature-verified `customer.subscription.*` lifecycle events and re-runs the
 * forwarding gate for every affected Senior (Req 12.7, 12.12, 13.7, 14.1-14.6).
 *
 * The handler is a Next.js App Router Route Handler: it exports an async `POST`
 * function (per `node_modules/next/dist/docs/.../route-handlers.md`) and reads
 * the raw request body with `await request.text()` so the exact bytes Stripe
 * signed are available for `stripe.webhooks.constructEvent` verification.
 *
 * Processing is a short, well-defined pipeline:
 *
 * 1. Verify the `Stripe-Signature` header against `STRIPE_WEBHOOK_SECRET`. On
 *    failure → HTTP 400, no state change (Req 14.2, 14.3).
 * 2. Deduplicate by `ProcessedWebhookEvent.stripeEventId`. A previously seen
 *    event returns its prior result without re-applying (Req 14.5).
 * 3. For a `customer.subscription.*` event, map the Stripe status to a local
 *    {@link SubscriptionState}, update the matching `Subscription` row, and
 *    re-gate forwarding for each affected Senior (Req 14.4).
 * 4. An event that matches no local `Subscription` is recorded as unmatched and
 *    acknowledged with HTTP 200 (Req 14.6).
 * 5. The `ProcessedWebhookEvent` row is written in the SAME transaction as the
 *    state change, so the dedup ledger and the state it guards commit together
 *    (Req 14.5).
 *
 * `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are read from the environment
 * at request time and never hardcoded or logged.
 */

import Stripe from "stripe";

import { prisma } from "@/lib/prisma";
import { isForwardingActive } from "@/lib/screening";
import { subscriptionStateFromStripe } from "@/lib/stripe";
import type { SubscriptionState } from "@/lib/constants";

/** Stripe subscription lifecycle event types this handler reconciles. */
const SUBSCRIPTION_EVENT_TYPES = new Set<string>([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

/**
 * Lazily constructs a Stripe client from `STRIPE_SECRET_KEY`.
 *
 * Reads the secret at call time so it is never captured at module load. The
 * webhook secret is used only for signature verification and is resolved
 * separately. Returns `null` when the secret is absent so the caller can fail
 * the request without attempting verification with incomplete configuration.
 */
const resolveStripe = (): Stripe | null => {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;
  return new Stripe(secretKey);
};

/**
 * The outcome of reconciling a single verified event, persisted on the
 * `ProcessedWebhookEvent` ledger and returned to Stripe.
 */
interface ReconcileResult {
  /** `true` when the event matched a local Subscription and applied a change. */
  readonly matched: boolean;
}

/**
 * Re-computes and materializes `SeniorProfile.forwardingActive` for one Senior.
 *
 * Runs inside the provided transaction client so the forwarding projection
 * commits together with the Subscription state change. Reads the Senior's
 * consent and subscription state, routes them through the single forwarding
 * predicate {@link isForwardingActive}, and writes the result.
 */
const regateSeniorForwarding = async (
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  seniorId: string,
): Promise<void> => {
  const senior = await tx.seniorProfile.findUnique({
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

  const forwardingActive = isForwardingActive({ hasValidConsent, subscriptionState });

  await tx.seniorProfile.update({
    where: { id: seniorId },
    data: { forwardingActive },
  });
};

/**
 * Resolves the Senior ids a reconciled Subscription affects.
 *
 * A Family_Plan subscription carries a single `seniorId`. A Partner per-member
 * subscription carries a `partnerId`; every actively enrolled Senior under that
 * Partner is affected and must be re-gated (Req 13.7, 14.4).
 */
const affectedSeniorIds = async (
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  subscription: { seniorId: string | null; partnerId: string | null },
): Promise<string[]> => {
  if (subscription.seniorId) return [subscription.seniorId];
  if (subscription.partnerId) {
    const memberships = await tx.partnerMembership.findMany({
      where: { partnerId: subscription.partnerId, active: true },
      select: { seniorId: true },
    });
    return memberships.map((m) => m.seniorId);
  }
  return [];
};

/**
 * Applies a verified `customer.subscription.*` event inside a single
 * transaction: updates the matching `Subscription` row, re-gates forwarding for
 * each affected Senior, and records the event id on the dedup ledger.
 *
 * When no local `Subscription` matches the Stripe subscription id, no state is
 * changed; the event is still recorded (as unmatched) so a replay is a no-op
 * (Req 14.6). The `ProcessedWebhookEvent` write shares the transaction with the
 * state change so the ledger and state commit atomically (Req 14.5).
 */
const reconcileSubscriptionEvent = async (event: Stripe.Event): Promise<ReconcileResult> => {
  const subscription = event.data.object as Stripe.Subscription;
  const state = subscriptionStateFromStripe(subscription.status);
  const quantity = subscription.items.data[0]?.quantity;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.subscription.findUnique({
      where: { stripeSubscriptionId: subscription.id },
      select: { id: true, seniorId: true, partnerId: true },
    });

    if (!existing) {
      await tx.processedWebhookEvent.create({
        data: { stripeEventId: event.id, eventType: event.type, matched: false },
      });
      return { matched: false };
    }

    await tx.subscription.update({
      where: { id: existing.id },
      data: {
        state,
        ...(quantity === undefined ? {} : { quantity: Math.max(0, quantity) }),
      },
    });

    const seniorIds = await affectedSeniorIds(tx, existing);
    for (const seniorId of seniorIds) {
      await regateSeniorForwarding(tx, seniorId);
    }

    await tx.processedWebhookEvent.create({
      data: { stripeEventId: event.id, eventType: event.type, matched: true },
    });

    return { matched: true };
  });
};

/**
 * Records a verified event that is not a subscription lifecycle event.
 *
 * Such events alter no Subscription or forwarding state but are still written
 * to the dedup ledger (as unmatched) so a replay returns the same no-op result
 * (Req 14.5, 14.6).
 */
const recordUnmatchedEvent = async (event: Stripe.Event): Promise<ReconcileResult> => {
  await prisma.processedWebhookEvent.create({
    data: { stripeEventId: event.id, eventType: event.type, matched: false },
  });
  return { matched: false };
};

/**
 * Stripe billing webhook endpoint (Req 14.1).
 *
 * Verifies the signature, enforces idempotence by event id, reconciles
 * subscription lifecycle events, and acknowledges every verified event with
 * HTTP 200. A signature failure is the only non-200 path (HTTP 400, no state
 * change).
 */
export async function POST(request: Request): Promise<Response> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripe = resolveStripe();
  if (!webhookSecret || !stripe) {
    // Misconfiguration: reject without touching state (Req 14.3).
    return new Response("Webhook not configured", { status: 400 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing signature", { status: 400 });
  }

  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch {
    // Signature verification failed: no state change, HTTP 400 (Req 14.2, 14.3).
    return new Response("Invalid signature", { status: 400 });
  }

  // Idempotence: a previously processed event id returns its prior result
  // without re-applying the event (Req 14.5).
  const prior = await prisma.processedWebhookEvent.findUnique({
    where: { stripeEventId: event.id },
    select: { matched: true },
  });
  if (prior) {
    return Response.json({ received: true, duplicate: true, matched: prior.matched });
  }

  const result = SUBSCRIPTION_EVENT_TYPES.has(event.type)
    ? await reconcileSubscriptionEvent(event)
    : await recordUnmatchedEvent(event);

  // Every verified event is acknowledged with HTTP 200, including unmatched
  // ones (Req 14.6).
  return Response.json({ received: true, matched: result.matched });
}
