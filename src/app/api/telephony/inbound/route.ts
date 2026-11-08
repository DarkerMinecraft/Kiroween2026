import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import { CALL_DISPOSITIONS } from "@/lib/constants";
import type { SubscriptionState } from "@/lib/constants";
import { matchesKnownContact, normalizeToE164 } from "@/lib/phone";
import type { DefaultRegion } from "@/lib/phone";
import { prisma } from "@/lib/prisma";
import { isForwardingActive } from "@/lib/screening";
import type { SubscriptionStateInput } from "@/lib/screening";
import {
  buildForwardingInactiveSwml,
  buildKnownContactConnectSwml,
  buildUnknownCallerScreeningSwml,
  type SwmlDocument,
} from "@/lib/swml";

/**
 * `/api/telephony/inbound` — the SWML entry point SignalWire fetches for every
 * inbound call to a Protection_Number.
 *
 * The POST handler:
 *  1. Validates a shared-secret token on the webhook URL (Req 4.5).
 *  2. Resolves the Senior by the dialed Protection_Number; an unknown number
 *     hangs up.
 *  3. Applies the forwarding gate (`isForwardingActive`); when inactive it logs
 *     a "not forwarded" Call_Record and returns a hangup SWML (Req 6.3).
 *  4. Normalizes the caller number; on failure the caller is treated as Unknown
 *     and a normalization-failure indication is recorded (Req 11.3, 11.4).
 *  5. Returns the known-contact connect SWML on an exact match, stamping the
 *     display name into the Call_Record (Req 5.4, 5.7).
 *  6. Otherwise returns the unknown-caller AI screening SWML whose summary posts
 *     back to `/api/telephony/report` (Req 6.1).
 *
 * The handler is unauthenticated by session (SignalWire is the caller) and is
 * guarded solely by the shared-secret token plus resolution by the dialed
 * number.
 */

/** Default region applied when a caller number omits a country code (Req 11.2). */
const DEFAULT_REGION_FALLBACK: DefaultRegion = "US";

/** The parsed, provider-agnostic shape of an inbound SignalWire call webhook. */
interface InboundCall {
  /** The Protection_Number that was dialed (`call.to`). */
  readonly to: string | null;
  /** The raw Caller_Number as presented (`call.from_number`). */
  readonly from: string | null;
  /** The provider call id, forwarded to the report endpoint when present. */
  readonly callId: string | null;
}

/** JSON helper that returns an SWML document with the SWML content type. */
const swmlResponse = (document: SwmlDocument): Response =>
  Response.json(document);

/** Reads a string field from a loosely typed record, ignoring non-strings. */
const readString = (source: Record<string, unknown>, key: string): string | null => {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/**
 * Validates the shared-secret `token` query parameter against
 * `TELEPHONY_WEBHOOK_SECRET` using a length-safe constant-time comparison.
 * Returns `false` when the secret is unset or the token is absent or mismatched.
 */
const isValidToken = (provided: string | null): boolean => {
  const expected = process.env.TELEPHONY_WEBHOOK_SECRET;
  if (!expected || !provided) return false;

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
};

/**
 * Parses the inbound webhook body into an {@link InboundCall}, accepting both
 * JSON and `application/x-www-form-urlencoded`/multipart bodies and both the
 * nested (`call.to`, `call.from_number`) and flat (`to`, `from`) field shapes
 * SignalWire may send.
 */
const parseInboundCall = async (request: NextRequest): Promise<InboundCall> => {
  const contentType = request.headers.get("content-type") ?? "";

  let payload: Record<string, unknown> = {};
  if (contentType.includes("application/json")) {
    const parsed = await request.json().catch(() => null);
    if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
  } else {
    const form = await request.formData().catch(() => null);
    if (form) {
      for (const [key, value] of form.entries()) {
        if (typeof value === "string") payload[key] = value;
      }
    } else {
      // Fall back to JSON when the content type is unknown or missing.
      const parsed = await request.json().catch(() => null);
      if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
    }
  }

  const call =
    payload.call && typeof payload.call === "object"
      ? (payload.call as Record<string, unknown>)
      : {};

  const to = readString(call, "to") ?? readString(payload, "to");
  const from =
    readString(call, "from_number") ??
    readString(call, "from") ??
    readString(payload, "from_number") ??
    readString(payload, "from") ??
    readString(payload, "Caller");

  const callId =
    readString(call, "call_id") ??
    readString(call, "id") ??
    readString(payload, "call_id") ??
    readString(payload, "CallSid");

  return { to, from, callId };
};

/**
 * Derives the effective Subscription state for a Senior for the forwarding gate.
 *
 * Prefers the Senior's own Family_Plan Subscription; when the Senior is instead
 * actively enrolled under a Partner, uses that Partner's per-member Subscription
 * state. Returns `null` when neither exists.
 */
const deriveSubscriptionState = (senior: {
  subscription: { state: string } | null;
  partnerMembership: { active: boolean; partner: { subscription: { state: string } | null } } | null;
}): SubscriptionStateInput => {
  const own = senior.subscription?.state;
  if (own) return own as SubscriptionState;

  const membership = senior.partnerMembership;
  if (membership?.active) {
    const partnerState = membership.partner.subscription?.state;
    if (partnerState) return partnerState as SubscriptionState;
  }

  return null;
};

/** Builds the absolute post-prompt URL the AI screening summary is sent to. */
const buildPostPromptUrl = (request: NextRequest, token: string, callId: string | null): string => {
  const url = new URL("/api/telephony/report", request.nextUrl.origin);
  url.searchParams.set("token", token);
  if (callId) url.searchParams.set("call", callId);
  return url.toString();
};

export const POST = async (request: NextRequest): Promise<Response> => {
  const token = request.nextUrl.searchParams.get("token");
  if (!isValidToken(token)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const call = await parseInboundCall(request);

  // Without a dialed number we cannot resolve a Senior; end the call.
  if (!call.to) {
    return swmlResponse(buildForwardingInactiveSwml());
  }

  const senior = await prisma.seniorProfile.findFirst({
    where: { protectionNumber: { e164Number: call.to } },
    include: {
      protectionNumber: true,
      knownContacts: true,
      consent: true,
      subscription: true,
      partnerMembership: { include: { partner: { include: { subscription: true } } } },
    },
  });

  // Unknown Protection_Number: nothing to forward to, hang up.
  if (!senior || !senior.protectionNumber) {
    return swmlResponse(buildForwardingInactiveSwml());
  }

  const startedAt = new Date();

  const hasValidConsent = senior.consent !== null && !senior.consent.withdrawn;
  const subscriptionState = deriveSubscriptionState(senior);

  // Forwarding gate: inactive -> record a "not forwarded" call and hang up.
  if (!isForwardingActive({ hasValidConsent, subscriptionState })) {
    await prisma.callRecord.create({
      data: {
        seniorId: senior.id,
        callerNumber: call.from ?? "",
        startedAt,
        screeningOutcome: "not_forwarded",
        disposition: CALL_DISPOSITIONS.notForwarded,
      },
    });
    return swmlResponse(buildForwardingInactiveSwml());
  }

  // Normalize the caller number; failure => treat as Unknown_Caller (Req 11.4).
  const defaultRegion = (process.env.DEFAULT_PHONE_REGION as DefaultRegion) || DEFAULT_REGION_FALLBACK;
  const rawCaller = call.from ?? "";
  const normalized = normalizeToE164(rawCaller, defaultRegion);

  if (normalized.ok) {
    // Known_Contact exact match => connect straight through (Req 5.4, 5.7).
    const match = senior.knownContacts.find((contact) =>
      matchesKnownContact(normalized.e164, contact.e164Number),
    );

    if (match) {
      await prisma.callRecord.create({
        data: {
          seniorId: senior.id,
          callerNumber: normalized.e164,
          knownContactName: match.displayName ?? null,
          startedAt,
          screeningOutcome: "known_contact",
          disposition: CALL_DISPOSITIONS.connected,
        },
      });
      return swmlResponse(buildKnownContactConnectSwml(senior.protectionNumber.personalNumber));
    }
  }

  // Unknown caller (no match, or normalization failed): hand to the AI screener.
  // The report handler (task 8.2) writes the screened Call_Record, so here we
  // only ensure a normalization-failure indication is preserved when relevant.
  if (!normalized.ok) {
    await prisma.callRecord.create({
      data: {
        seniorId: senior.id,
        callerNumber: rawCaller,
        rawCallerNumber: rawCaller,
        normalizationFailed: true,
        startedAt,
        screeningOutcome: "screening",
        disposition: CALL_DISPOSITIONS.unscreened,
      },
    });
  }

  const postPromptUrl = buildPostPromptUrl(request, token as string, call.callId);
  return swmlResponse(buildUnknownCallerScreeningSwml({ postPromptUrl }));
};
