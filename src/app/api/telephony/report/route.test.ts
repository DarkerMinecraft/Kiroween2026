import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Integration tests for `/api/telephony/report` (task 8.3).
//
// This endpoint is the SignalWire AI `post_prompt_url` target. It distills the
// conversation summary into a Risk_Assessment, writes a Call_Record and
// Call_Report, and returns a connect SWML for Known/Allowed or a decline SWML
// for Spam/Fraud. `@/lib/prisma` is mocked so the retry/failure resilience
// paths (recording failure, report-unavailable) can be exercised by making the
// mocked writes reject a controlled number of times.
//
// Validates: Requirements 6.2, 6.4, 6.5, 6.6, 7.2, 8.3, 8.6

const WEBHOOK_SECRET = "s3cr3t-webhook-token";
const SENIOR_ID = "senior-1";
const PERSONAL_NUMBER = "+15125559999";
const CALLER = "+15125558888";

/** Prisma mock surface the report handler touches. */
const callRecordCreate = vi.fn();
const callReportCreate = vi.fn();
const callReportUpsert = vi.fn();
const protectionNumberFindUnique = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    callRecord: {
      create: (...args: unknown[]) => callRecordCreate(...args),
    },
    callReport: {
      create: (...args: unknown[]) => callReportCreate(...args),
      upsert: (...args: unknown[]) => callReportUpsert(...args),
    },
    protectionNumber: {
      findUnique: (...args: unknown[]) => protectionNumberFindUnique(...args),
    },
  },
}));

// Imported after vi.mock so the handler binds to the mocked prisma.
let POST: typeof import("./route").POST;

beforeEach(async () => {
  vi.stubEnv("TELEPHONY_WEBHOOK_SECRET", WEBHOOK_SECRET);

  callRecordCreate.mockReset();
  callReportCreate.mockReset();
  callReportUpsert.mockReset();
  protectionNumberFindUnique.mockReset();

  // Sensible happy-path defaults; individual tests override as needed.
  callRecordCreate.mockResolvedValue({ id: "cr-1" });
  callReportCreate.mockResolvedValue({ id: "rep-1" });
  callReportUpsert.mockResolvedValue({ id: "rep-1" });
  protectionNumberFindUnique.mockResolvedValue({ personalNumber: PERSONAL_NUMBER });

  ({ POST } = await import("./route"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * Builds a JSON POST Request to the report endpoint with the senior linkage and
 * caller supplied via query params and the AI summary in the body.
 */
const buildRequest = (
  token: string | null,
  body: Record<string, unknown>,
  params: Record<string, string> = {},
): Request => {
  const url = new URL("https://mabel.example.com/api/telephony/report");
  if (token !== null) url.searchParams.set("token", token);
  url.searchParams.set("senior", SENIOR_ID);
  url.searchParams.set("from", CALLER);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
};

describe("POST /api/telephony/report", () => {
  it("rejects a bad token with 403 and touches no data", async () => {
    const response = await POST(
      buildRequest("wrong", { risk_category: "spam", risk_score: 90 }),
    );

    expect(response.status).toBe(403);
    expect(callRecordCreate).not.toHaveBeenCalled();
  });

  it("returns 400 when the senior linkage is absent", async () => {
    const url = new URL("https://mabel.example.com/api/telephony/report");
    url.searchParams.set("token", WEBHOOK_SECRET);
    const response = await POST(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ risk_category: "allowed", risk_score: 10 }),
      }),
    );

    expect(response.status).toBe(400);
    expect(callRecordCreate).not.toHaveBeenCalled();
  });

  it("connects on a Known/Allowed summary and writes a report (Req 6.2, 8.1)", async () => {
    const response = await POST(
      buildRequest(WEBHOOK_SECRET, {
        risk_category: "allowed",
        risk_score: 12,
        stated_purpose: "appointment reminder",
        reason_text: "Caller is a clinic confirming a visit.",
      }),
    );

    expect(response.status).toBe(200);
    const doc = await response.json();
    expect(doc.sections.main).toEqual([
      { answer: {} },
      { connect: { to: PERSONAL_NUMBER } },
    ]);

    // Call_Record written with a connected disposition.
    expect(callRecordCreate).toHaveBeenCalledTimes(1);
    expect(callRecordCreate.mock.calls[0][0].data).toMatchObject({
      seniorId: SENIOR_ID,
      disposition: "connected",
      riskCategory: "Allowed",
      riskScore: 12,
    });

    // Call_Report written with the stated purpose.
    expect(callReportCreate).toHaveBeenCalledTimes(1);
    expect(callReportCreate.mock.calls[0][0].data).toMatchObject({
      callRecordId: "cr-1",
      statedPurpose: "appointment reminder",
      riskCategory: "Allowed",
      available: true,
    });
  });

  it("declines on a Spam/Fraud summary with a declined disposition (Req 6.5)", async () => {
    const response = await POST(
      buildRequest(WEBHOOK_SECRET, { risk_category: "fraud", risk_score: 95 }),
    );

    expect(response.status).toBe(200);
    const doc = await response.json();
    // Decline uses the forwarding-inactive hangup shape (no connect).
    expect(doc.sections.main.some((i: Record<string, unknown>) => "hangup" in i)).toBe(true);
    expect(doc.sections.main.some((i: Record<string, unknown>) => "connect" in i)).toBe(false);

    expect(callRecordCreate.mock.calls[0][0].data.disposition).toBe("declined");
    // Connecting is never attempted for a declined call.
    expect(protectionNumberFindUnique).not.toHaveBeenCalled();
  });

  it("records unscreened on a screening timeout and declines (Req 6.6)", async () => {
    const response = await POST(
      buildRequest(WEBHOOK_SECRET, { timed_out: true }),
    );

    expect(response.status).toBe(200);
    const doc = await response.json();
    expect(doc.sections.main.some((i: Record<string, unknown>) => "hangup" in i)).toBe(true);

    expect(callRecordCreate).toHaveBeenCalledTimes(1);
    expect(callRecordCreate.mock.calls[0][0].data).toMatchObject({
      disposition: "unscreened",
      screeningOutcome: "unscreened",
    });
    // No report is written for an unscreened call.
    expect(callReportCreate).not.toHaveBeenCalled();
  });

  it("records unscreened when the risk category is missing (Req 6.6)", async () => {
    const response = await POST(
      buildRequest(WEBHOOK_SECRET, { risk_score: 40, stated_purpose: "survey" }),
    );

    expect(response.status).toBe(200);
    expect(callRecordCreate.mock.calls[0][0].data.disposition).toBe("unscreened");
    expect(callReportCreate).not.toHaveBeenCalled();
  });

  it("defaults the stated purpose to 'undetermined' when absent (Req 8.3)", async () => {
    await POST(
      buildRequest(WEBHOOK_SECRET, { risk_category: "allowed", risk_score: 20 }),
    );

    expect(callReportCreate).toHaveBeenCalledTimes(1);
    expect(callReportCreate.mock.calls[0][0].data.statedPurpose).toBe("undetermined");
  });

  it("falls back to a recording_failure record after 3 create rejections (Req 7.2)", async () => {
    // First three attempts reject; the fourth (minimal fallback) succeeds.
    callRecordCreate
      .mockRejectedValueOnce(new Error("db down"))
      .mockRejectedValueOnce(new Error("db down"))
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({ id: "cr-fallback" });

    const startedAt = "2026-01-01T10:00:00.000Z";
    const response = await POST(
      buildRequest(
        WEBHOOK_SECRET,
        { risk_category: "allowed", risk_score: 15 },
        { started_at: startedAt },
      ),
    );

    expect(response.status).toBe(200);
    // Three full attempts plus the minimal fallback create = 4 calls.
    expect(callRecordCreate).toHaveBeenCalledTimes(4);

    const fallbackData = callRecordCreate.mock.calls[3][0].data;
    expect(fallbackData).toMatchObject({
      seniorId: SENIOR_ID,
      callerNumber: CALLER,
      disposition: "recording_failure",
      screeningOutcome: "recording_failure",
    });
    // The fallback preserves the original start timestamp.
    expect(new Date(fallbackData.startedAt).toISOString()).toBe(startedAt);
  });

  it("marks the report available:false via upsert when create rejects, preserving the record (Req 8.6)", async () => {
    callReportCreate.mockRejectedValueOnce(new Error("report gen failed"));

    const response = await POST(
      buildRequest(WEBHOOK_SECRET, { risk_category: "known", risk_score: 5 }),
    );

    expect(response.status).toBe(200);
    // The Call_Record is still created (not rolled back).
    expect(callRecordCreate).toHaveBeenCalledTimes(1);

    // Report falls back to an unavailable upsert against the same record.
    expect(callReportUpsert).toHaveBeenCalledTimes(1);
    const upsertArg = callReportUpsert.mock.calls[0][0];
    expect(upsertArg.where).toEqual({ callRecordId: "cr-1" });
    expect(upsertArg.update).toEqual({ available: false });
    expect(upsertArg.create).toMatchObject({ callRecordId: "cr-1", available: false });

    // A Known caller still connects despite the report failure.
    const doc = await response.json();
    expect(doc.sections.main).toEqual([
      { answer: {} },
      { connect: { to: PERSONAL_NUMBER } },
    ]);
  });

  it("declines gracefully when no Personal_Number is on file for a connect", async () => {
    protectionNumberFindUnique.mockResolvedValue(null);

    const response = await POST(
      buildRequest(WEBHOOK_SECRET, { risk_category: "known", risk_score: 3 }),
    );

    expect(response.status).toBe(200);
    const doc = await response.json();
    expect(doc.sections.main.some((i: Record<string, unknown>) => "connect" in i)).toBe(false);
    expect(doc.sections.main.some((i: Record<string, unknown>) => "hangup" in i)).toBe(true);
  });
});
