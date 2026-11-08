import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Integration tests for `/api/telephony/inbound` (task 8.3).
//
// The handler resolves a Senior by the dialed Protection_Number, applies the
// forwarding gate, normalizes the caller number, and returns one of three SWML
// documents: known-contact connect, unknown-caller AI screening, or
// forwarding-inactive hangup. `@/lib/prisma` is mocked so the Senior lookup and
// Call_Record writes are controlled per test; the shared-secret token is
// supplied via `?token=` and validated against TELEPHONY_WEBHOOK_SECRET.
//
// Validates: Requirements 5.4, 6.1, 6.3, 11.3, 11.4

const WEBHOOK_SECRET = "s3cr3t-webhook-token";
const PROTECTION_NUMBER = "+15125550000";
const PERSONAL_NUMBER = "+15125559999";
const KNOWN_CONTACT = "+15125551234";

/** Prisma mock surface the inbound handler touches. */
const seniorFindFirst = vi.fn();
const callRecordCreate = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seniorProfile: {
      findFirst: (...args: unknown[]) => seniorFindFirst(...args),
    },
    callRecord: {
      create: (...args: unknown[]) => callRecordCreate(...args),
    },
  },
}));

// Imported after vi.mock so the handler binds to the mocked prisma.
let POST: typeof import("./route").POST;

beforeEach(async () => {
  vi.stubEnv("TELEPHONY_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.stubEnv("DEFAULT_PHONE_REGION", "US");

  seniorFindFirst.mockReset();
  callRecordCreate.mockReset();
  callRecordCreate.mockResolvedValue({ id: "cr-1" });

  ({ POST } = await import("./route"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * Builds a Senior row shaped like the handler's `include`. Overrides let each
 * test toggle consent/subscription/known contacts.
 */
const buildSenior = (
  overrides: Partial<{
    consent: { withdrawn: boolean } | null;
    subscription: { state: string } | null;
    knownContacts: ReadonlyArray<{ e164Number: string; displayName: string | null }>;
    partnerMembership: unknown;
    protectionNumber: { e164Number: string; personalNumber: string } | null;
  }> = {},
) => ({
  id: "senior-1",
  protectionNumber:
    overrides.protectionNumber === undefined
      ? { e164Number: PROTECTION_NUMBER, personalNumber: PERSONAL_NUMBER }
      : overrides.protectionNumber,
  knownContacts: overrides.knownContacts ?? [],
  consent: overrides.consent === undefined ? { withdrawn: false } : overrides.consent,
  subscription:
    overrides.subscription === undefined ? { state: "active" } : overrides.subscription,
  partnerMembership:
    overrides.partnerMembership === undefined ? null : overrides.partnerMembership,
});

/** Builds a JSON POST NextRequest with the given token and call body. */
const buildRequest = (
  token: string | null,
  body: Record<string, unknown>,
): NextRequest => {
  const url = new URL("https://mabel.example.com/api/telephony/inbound");
  if (token !== null) url.searchParams.set("token", token);
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
};

describe("POST /api/telephony/inbound", () => {
  it("rejects a missing token with 403 and touches no data", async () => {
    const response = await POST(buildRequest(null, { call: { to: PROTECTION_NUMBER } }));

    expect(response.status).toBe(403);
    expect(seniorFindFirst).not.toHaveBeenCalled();
    expect(callRecordCreate).not.toHaveBeenCalled();
  });

  it("rejects a bad token with 403", async () => {
    const response = await POST(
      buildRequest("wrong-token", { call: { to: PROTECTION_NUMBER } }),
    );

    expect(response.status).toBe(403);
    expect(seniorFindFirst).not.toHaveBeenCalled();
  });

  it("connects a known contact straight through (Req 5.4)", async () => {
    seniorFindFirst.mockResolvedValue(
      buildSenior({
        knownContacts: [{ e164Number: KNOWN_CONTACT, displayName: "Daughter" }],
      }),
    );

    const response = await POST(
      buildRequest(WEBHOOK_SECRET, {
        call: { to: PROTECTION_NUMBER, from_number: KNOWN_CONTACT },
      }),
    );

    expect(response.status).toBe(200);
    const doc = await response.json();
    expect(doc.sections.main).toEqual([
      { answer: {} },
      { connect: { to: PERSONAL_NUMBER } },
    ]);

    // A connected Call_Record stamped with the display name is written.
    expect(callRecordCreate).toHaveBeenCalledTimes(1);
    const { data } = callRecordCreate.mock.calls[0][0];
    expect(data).toMatchObject({
      seniorId: "senior-1",
      callerNumber: KNOWN_CONTACT,
      knownContactName: "Daughter",
      disposition: "connected",
      screeningOutcome: "known_contact",
    });
  });

  it("hands an unknown caller to the AI screening block (Req 6.1)", async () => {
    seniorFindFirst.mockResolvedValue(
      buildSenior({
        knownContacts: [{ e164Number: KNOWN_CONTACT, displayName: "Daughter" }],
      }),
    );

    const response = await POST(
      buildRequest(WEBHOOK_SECRET, {
        call: { to: PROTECTION_NUMBER, from_number: "+15125558888", call_id: "call-xyz" },
      }),
    );

    expect(response.status).toBe(200);
    const doc = await response.json();

    const aiInstruction = doc.sections.main.find(
      (instruction: Record<string, unknown>) => "ai" in instruction,
    );
    expect(aiInstruction).toBeDefined();
    const ai = aiInstruction.ai as Record<string, unknown>;
    expect(ai.params).toEqual({ conversation_timeout: 60 });

    // The post_prompt_url points back at the report endpoint and carries the
    // token plus the forwarded call id.
    const postPromptUrl = new URL(ai.post_prompt_url as string);
    expect(postPromptUrl.pathname).toBe("/api/telephony/report");
    expect(postPromptUrl.searchParams.get("token")).toBe(WEBHOOK_SECRET);
    expect(postPromptUrl.searchParams.get("call")).toBe("call-xyz");

    // A known caller did not match, so no connected record is written here.
    expect(callRecordCreate).not.toHaveBeenCalled();
  });

  it("records a normalization-failure indication for an unparseable caller (Req 11.4)", async () => {
    seniorFindFirst.mockResolvedValue(buildSenior());

    const response = await POST(
      buildRequest(WEBHOOK_SECRET, {
        call: { to: PROTECTION_NUMBER, from_number: "not-a-number" },
      }),
    );

    expect(response.status).toBe(200);
    const doc = await response.json();
    expect(doc.sections.main.some((i: Record<string, unknown>) => "ai" in i)).toBe(true);

    expect(callRecordCreate).toHaveBeenCalledTimes(1);
    const { data } = callRecordCreate.mock.calls[0][0];
    expect(data).toMatchObject({
      seniorId: "senior-1",
      rawCallerNumber: "not-a-number",
      normalizationFailed: true,
      disposition: "unscreened",
    });
  });

  it("hangs up and logs a not-forwarded record when consent is withdrawn (Req 6.3)", async () => {
    seniorFindFirst.mockResolvedValue(buildSenior({ consent: { withdrawn: true } }));

    const response = await POST(
      buildRequest(WEBHOOK_SECRET, {
        call: { to: PROTECTION_NUMBER, from_number: KNOWN_CONTACT },
      }),
    );

    expect(response.status).toBe(200);
    const doc = await response.json();
    expect(doc.sections.main.some((i: Record<string, unknown>) => "hangup" in i)).toBe(true);

    expect(callRecordCreate).toHaveBeenCalledTimes(1);
    const { data } = callRecordCreate.mock.calls[0][0];
    expect(data).toMatchObject({
      seniorId: "senior-1",
      disposition: "not_forwarded",
      screeningOutcome: "not_forwarded",
    });
  });

  it("hangs up and logs a not-forwarded record when the subscription is inactive (Req 6.3)", async () => {
    seniorFindFirst.mockResolvedValue(
      buildSenior({ subscription: { state: "past_due" } }),
    );

    const response = await POST(
      buildRequest(WEBHOOK_SECRET, {
        call: { to: PROTECTION_NUMBER, from_number: KNOWN_CONTACT },
      }),
    );

    expect(response.status).toBe(200);
    const doc = await response.json();
    expect(doc.sections.main.some((i: Record<string, unknown>) => "hangup" in i)).toBe(true);

    expect(callRecordCreate).toHaveBeenCalledTimes(1);
    expect(callRecordCreate.mock.calls[0][0].data.disposition).toBe("not_forwarded");
  });

  it("hangs up for an unknown Protection_Number without writing a record", async () => {
    seniorFindFirst.mockResolvedValue(null);

    const response = await POST(
      buildRequest(WEBHOOK_SECRET, { call: { to: "+15120000000" } }),
    );

    expect(response.status).toBe(200);
    const doc = await response.json();
    expect(doc.sections.main.some((i: Record<string, unknown>) => "hangup" in i)).toBe(true);
    expect(callRecordCreate).not.toHaveBeenCalled();
  });
});
