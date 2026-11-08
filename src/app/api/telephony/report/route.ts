import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  CALL_DISPOSITIONS,
  RISK_CATEGORIES,
  type RiskCategory,
} from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import {
  dispositionForRisk,
  isValidRiskScore,
  type RiskAssessment,
} from "@/lib/screening";
import {
  buildForwardingInactiveSwml,
  buildKnownContactConnectSwml,
  type SwmlDocument,
} from "@/lib/swml";

/**
 * `/api/telephony/report` — the SignalWire AI `post_prompt_url` target.
 *
 * After the Screening_Agent finishes its interaction with an Unknown_Caller,
 * SignalWire POSTs the conversation summary here. This handler:
 *
 *  1. Validates the shared-secret `token` query parameter against
 *     `TELEPHONY_WEBHOOK_SECRET` (mismatch -> HTTP 403), matching the inbound
 *     handler's scheme (Req security note).
 *  2. Parses the AI post-prompt payload robustly, extracting a risk category
 *     (mapped to {@link RISK_CATEGORIES}), an integer score in 0..100, and the
 *     stated purpose.
 *  3. On screening timeout / no intent, records disposition `unscreened` and
 *     declines without a connect (Req 6.6).
 *  4. Otherwise computes the Risk_Assessment, writes the Call_Record and
 *     Call_Report, and returns a follow-up connect SWML for Known/Allowed or a
 *     decline SWML for Spam/Fraud (Req 6.2, 6.4, 6.5, 7.1, 8.1).
 *
 * Resilience: Call_Record creation is retried up to 3 times, falling back to a
 * minimal `recording_failure` record that preserves the caller number and the
 * start timestamp (Req 7.2). Call_Report generation failure marks the report
 * `available = false` without rolling back the Call_Record (Req 8.6). The
 * stated purpose defaults to `"undetermined"` when it cannot be determined
 * (Req 8.3).
 */

/** Maximum Call_Record creation attempts before the minimal fallback (Req 7.2). */
const MAX_CALL_RECORD_ATTEMPTS = 3;

/** Default stated purpose when the AI summary does not determine one (Req 8.3). */
const UNDETERMINED_PURPOSE = "undetermined";

/** The structured outcome distilled from the AI post-prompt payload. */
interface ScreeningSummary {
  /** Risk category when determinable, otherwise `null`. */
  readonly category: RiskCategory | null;
  /** Integer risk score in 0..100 when present, otherwise `null`. */
  readonly score: number | null;
  /** Stated purpose of the call, defaulting to `"undetermined"`. */
  readonly statedPurpose: string;
  /** Free-text reason/summary explaining the assessment. */
  readonly reasonText: string;
  /** True when the agent timed out or obtained no caller intent (Req 6.6). */
  readonly timedOut: boolean;
}

/** Validates the shared-secret `token` against `TELEPHONY_WEBHOOK_SECRET`. */
const isValidToken = (token: string | null): boolean => {
  const secret = process.env.TELEPHONY_WEBHOOK_SECRET;
  if (!secret || !token) return false;

  const tokenBytes = Buffer.from(token);
  const secretBytes = Buffer.from(secret);
  if (tokenBytes.length !== secretBytes.length) return false;

  return timingSafeEqual(tokenBytes, secretBytes);
};

/** Parses the request body into a plain record, tolerating JSON or form posts. */
const parseBody = async (request: Request): Promise<Record<string, unknown>> => {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      const parsed = (await request.json()) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    try {
      const form = await request.formData();
      const out: Record<string, unknown> = {};
      for (const [key, value] of form.entries()) out[key] = value;
      return out;
    } catch {
      return {};
    }
  }

  // Fall back to reading the raw text and attempting a JSON parse.
  try {
    const text = await request.text();
    if (!text) return {};
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

/** Type guard for a plain object record. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads the AI post-prompt result object out of the raw payload.
 *
 * SignalWire posts the structured `post_prompt` result in varying shapes; this
 * accepts the common ones (`post_prompt_data.parsed[0]`, `post_prompt_data`,
 * `parsed`, or the top-level body) and returns the first record found.
 */
const extractResult = (body: Record<string, unknown>): Record<string, unknown> => {
  const postPromptData = body.post_prompt_data;
  if (isRecord(postPromptData)) {
    const parsed = postPromptData.parsed;
    if (Array.isArray(parsed) && isRecord(parsed[0])) return parsed[0];
    const raw = postPromptData.raw;
    if (isRecord(raw)) return raw;
    return postPromptData;
  }

  const parsed = body.parsed;
  if (Array.isArray(parsed) && isRecord(parsed[0])) return parsed[0];
  if (isRecord(parsed)) return parsed;

  return body;
};

/** Maps a free-text category label to a {@link RISK_CATEGORIES} value, or null. */
const toRiskCategory = (value: unknown): RiskCategory | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "known":
      return RISK_CATEGORIES.known;
    case "allowed":
    case "allow":
    case "legitimate":
    case "legit":
      return RISK_CATEGORIES.allowed;
    case "spam":
      return RISK_CATEGORIES.spam;
    case "fraud":
    case "scam":
      return RISK_CATEGORIES.fraud;
    default:
      return null;
  }
};

/** Coerces a value to an integer score in 0..100, or null when out of range. */
const toRiskScore = (value: unknown): number | null => {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.round(numeric);
  return isValidRiskScore(rounded) ? rounded : null;
};

/** Reads the first present string field from a set of candidate keys. */
const firstString = (
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
};

/** Reads the first present truthy/boolean-ish field from candidate keys. */
const firstBoolean = (
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "timeout" || normalized === "unscreened") {
        return true;
      }
    }
  }
  return false;
};

/** Distills the raw AI payload into a {@link ScreeningSummary}. */
const summarize = (body: Record<string, unknown>): ScreeningSummary => {
  const result = extractResult(body);

  const timedOut =
    firstBoolean(result, ["timed_out", "timedOut", "no_intent", "unscreened"]) ||
    firstBoolean(body, ["timed_out", "timedOut", "no_intent", "unscreened"]);

  const category = toRiskCategory(
    result.risk_category ?? result.category ?? result.riskCategory,
  );
  const score = toRiskScore(result.risk_score ?? result.score ?? result.riskScore);

  const statedPurpose =
    firstString(result, ["stated_purpose", "purpose", "statedPurpose", "reason"]) ??
    UNDETERMINED_PURPOSE;

  const reasonText =
    firstString(result, ["reason_text", "reasonText", "explanation", "summary", "reason"]) ??
    firstString(body, ["summary", "post_prompt"]) ??
    "";

  return { category, score, statedPurpose, reasonText, timedOut };
};

/** Fields written to the Call_Record on creation. */
interface CallRecordInput {
  readonly seniorId: string;
  readonly callerNumber: string;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly screeningOutcome: string;
  readonly riskCategory: RiskCategory | null;
  readonly riskScore: number | null;
  readonly disposition: string;
}

/**
 * Creates the Call_Record, retrying up to {@link MAX_CALL_RECORD_ATTEMPTS}
 * times. On exhaustion, writes a minimal `recording_failure` record that
 * preserves the caller number and start timestamp (Req 7.2). Returns the new
 * record id, or `null` when even the fallback write fails.
 */
const createCallRecordWithRetry = async (
  input: CallRecordInput,
): Promise<string | null> => {
  for (let attempt = 1; attempt <= MAX_CALL_RECORD_ATTEMPTS; attempt += 1) {
    try {
      const record = await prisma.callRecord.create({
        data: {
          seniorId: input.seniorId,
          callerNumber: input.callerNumber,
          startedAt: input.startedAt,
          endedAt: input.endedAt,
          screeningOutcome: input.screeningOutcome,
          riskCategory: input.riskCategory,
          riskScore: input.riskScore,
          disposition: input.disposition,
        },
        select: { id: true },
      });
      return record.id;
    } catch {
      // Retry; on the final attempt fall through to the minimal record.
    }
  }

  try {
    const fallback = await prisma.callRecord.create({
      data: {
        seniorId: input.seniorId,
        callerNumber: input.callerNumber,
        startedAt: input.startedAt,
        disposition: CALL_DISPOSITIONS.recordingFailure,
        screeningOutcome: CALL_DISPOSITIONS.recordingFailure,
      },
      select: { id: true },
    });
    return fallback.id;
  } catch {
    return null;
  }
};

/**
 * Writes the Call_Report for a Call_Record. On failure, marks the report
 * `available = false` without touching the already-committed Call_Record
 * (Req 8.6). The stated purpose defaults to `"undetermined"` (Req 8.3).
 */
const writeCallReport = async (
  callRecordId: string,
  summary: ScreeningSummary,
  riskCategory: RiskCategory,
): Promise<void> => {
  try {
    await prisma.callReport.create({
      data: {
        callRecordId,
        statedPurpose: summary.statedPurpose || UNDETERMINED_PURPOSE,
        riskCategory,
        reasonText: summary.reasonText,
        available: true,
      },
    });
  } catch {
    // Report generation failed: record an unavailable report, keeping the
    // Call_Record intact (no rollback). Swallow a secondary failure so the
    // caller still receives its SWML response.
    try {
      await prisma.callReport.upsert({
        where: { callRecordId },
        update: { available: false },
        create: {
          callRecordId,
          statedPurpose: UNDETERMINED_PURPOSE,
          riskCategory,
          reasonText: "",
          available: false,
        },
      });
    } catch {
      // Nothing more we can do; the Call_Record is preserved regardless.
    }
  }
};

/** JSON response helper that returns a SWML document with a 200 status. */
const swmlResponse = (document: SwmlDocument): NextResponse =>
  NextResponse.json(document, { status: 200 });

export const POST = async (request: Request): Promise<NextResponse> => {
  const url = new URL(request.url);

  if (!isValidToken(url.searchParams.get("token"))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await parseBody(request);

  // Senior linkage comes from the query string (preferred) or the posted body.
  const seniorId =
    url.searchParams.get("senior") ??
    (typeof body.senior === "string" ? body.senior : null) ??
    (typeof body.seniorId === "string" ? body.seniorId : null);

  if (!seniorId) {
    return NextResponse.json({ error: "missing senior linkage" }, { status: 400 });
  }

  const callerNumber =
    url.searchParams.get("from") ??
    (typeof body.from === "string" ? body.from : null) ??
    (typeof body.from_number === "string" ? body.from_number : null) ??
    "";

  // Start timestamp: honor a provided value, otherwise stamp receipt time.
  const startedAtRaw =
    url.searchParams.get("started_at") ??
    (typeof body.started_at === "string" ? body.started_at : null);
  const startedAtParsed = startedAtRaw ? new Date(startedAtRaw) : null;
  const startedAt =
    startedAtParsed && !Number.isNaN(startedAtParsed.getTime())
      ? startedAtParsed
      : new Date();
  const endedAt = new Date();

  const summary = summarize(body);

  // Screening timeout / no intent: record `unscreened` and decline (Req 6.6).
  const screeningTimedOut =
    summary.timedOut || summary.category === null || summary.score === null;

  if (screeningTimedOut) {
    await createCallRecordWithRetry({
      seniorId,
      callerNumber,
      startedAt,
      endedAt,
      screeningOutcome: CALL_DISPOSITIONS.unscreened,
      riskCategory: summary.category,
      riskScore: summary.score,
      disposition: CALL_DISPOSITIONS.unscreened,
    });
    return swmlResponse(buildForwardingInactiveSwml());
  }

  // Safe: the timeout guard above ensures category and score are present.
  const riskAssessment: RiskAssessment = {
    category: summary.category as RiskCategory,
    score: summary.score as number,
  };
  const disposition = dispositionForRisk(riskAssessment);

  const callRecordId = await createCallRecordWithRetry({
    seniorId,
    callerNumber,
    startedAt,
    endedAt,
    screeningOutcome: riskAssessment.category,
    riskCategory: riskAssessment.category,
    riskScore: riskAssessment.score,
    disposition,
  });

  if (callRecordId) {
    await writeCallReport(callRecordId, summary, riskAssessment.category);
  }

  // Known/Allowed -> connect to the Personal_Number; Spam/Fraud -> decline.
  if (disposition === CALL_DISPOSITIONS.connected) {
    const protectionNumber = await prisma.protectionNumber.findUnique({
      where: { seniorId },
      select: { personalNumber: true },
    });

    if (protectionNumber?.personalNumber) {
      return swmlResponse(buildKnownContactConnectSwml(protectionNumber.personalNumber));
    }

    // No Personal_Number on file: cannot connect, so decline gracefully.
    return swmlResponse(buildForwardingInactiveSwml());
  }

  return swmlResponse(buildForwardingInactiveSwml());
};
