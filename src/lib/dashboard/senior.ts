/**
 * Senior_Dashboard data loader (`src/lib/dashboard/senior.ts`).
 *
 * Loads everything the Senior_Dashboard renders for the *authenticated* Senior,
 * and nothing belonging to anyone else. The loader resolves the Senior by the
 * authenticated account's user id (never by a client-supplied SeniorProfile id)
 * and scopes every query to that resolved profile, so one Senior's data can
 * never leak into another Senior's view (Req 10.6).
 *
 * Returned shape:
 * - the 20 most recent `Call_Records`, ordered newest-first by `startedAt`,
 *   each exposing a caller identifier, a timestamp, and an outcome (Req 10.1,
 *   10.2);
 * - the Senior's `Known_Contacts` (Req 10.4);
 * - the call forwarding status mapped to exactly one of the `FORWARDING_STATES`
 *   values `active` / `inactive`, from `SeniorProfile.forwardingActive`
 *   (Req 10.5).
 *
 * This is a plain async function (not a React component) so it can be unit
 * tested in isolation; the Senior_Dashboard page awaits it inside the request
 * (task 15.5 covers the data-loading tests).
 */

import { prisma } from "@/lib/prisma";
import { FORWARDING_STATES, type ForwardingState } from "@/lib/constants";

/** Most recent Call_Records shown on the Senior_Dashboard (Req 10.1). */
const RECENT_CALL_RECORD_LIMIT = 20;

/**
 * A single Call_Record row as the Senior_Dashboard renders it: a caller
 * identifier, the call timestamp, and the call outcome (Req 10.2).
 */
export interface SeniorCallRecordView {
  readonly id: string;
  /** The caller identifier: the normalized E.164 number, or the raw value preserved on normalization failure. */
  readonly callerIdentifier: string;
  /** The display name of a matched Known_Contact, when one was recorded. */
  readonly knownContactName: string | null;
  /** The call start timestamp (UTC). */
  readonly timestamp: Date;
  /** The screening outcome recorded for the call. */
  readonly outcome: string;
}

/** A single Known_Contact row shown on the Senior_Dashboard (Req 10.4). */
export interface SeniorKnownContactView {
  readonly id: string;
  readonly e164Number: string;
  readonly displayName: string | null;
}

/** Everything the Senior_Dashboard renders for the authenticated Senior. */
export interface SeniorDashboardData {
  readonly callRecords: readonly SeniorCallRecordView[];
  readonly knownContacts: readonly SeniorKnownContactView[];
  /** Forwarding status as exactly `active` or `inactive` (Req 10.5). */
  readonly forwardingStatus: ForwardingState;
}

/**
 * Thrown when the authenticated account has no `SeniorProfile`. Callers map
 * this to the dashboard error state; it never results in another Senior's data
 * being shown (Req 10.7).
 */
export class SeniorProfileNotFoundError extends Error {
  constructor(userId: string) {
    super(`No senior profile for user ${userId}`);
    this.name = "SeniorProfileNotFoundError";
    Object.setPrototypeOf(this, SeniorProfileNotFoundError.prototype);
  }
}

/**
 * Loads the Senior_Dashboard data for the authenticated Senior identified by
 * `seniorUserId` (a Better Auth `User.id`).
 *
 * Resolves the `SeniorProfile` by `userId` and scopes the Call_Records and
 * Known_Contacts strictly to that profile. Returns the 20 most recent
 * Call_Records (newest-first), the Known_Contacts, and the forwarding status.
 *
 * Throws {@link SeniorProfileNotFoundError} when no profile exists for the
 * account. Any database failure propagates so the page renders its error state
 * rather than ever falling back to another Senior's data (Req 10.6, 10.7).
 */
export const loadSeniorDashboard = async (
  seniorUserId: string,
): Promise<SeniorDashboardData> => {
  const senior = await prisma.seniorProfile.findUnique({
    where: { userId: seniorUserId },
    select: { id: true, forwardingActive: true },
  });

  if (!senior) {
    throw new SeniorProfileNotFoundError(seniorUserId);
  }

  const [callRecords, knownContacts] = await Promise.all([
    prisma.callRecord.findMany({
      where: { seniorId: senior.id },
      orderBy: { startedAt: "desc" },
      take: RECENT_CALL_RECORD_LIMIT,
      select: {
        id: true,
        callerNumber: true,
        knownContactName: true,
        startedAt: true,
        screeningOutcome: true,
      },
    }),
    prisma.knownContact.findMany({
      where: { seniorId: senior.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, e164Number: true, displayName: true },
    }),
  ]);

  return {
    callRecords: callRecords.map((record) => ({
      id: record.id,
      callerIdentifier: record.callerNumber,
      knownContactName: record.knownContactName,
      timestamp: record.startedAt,
      outcome: record.screeningOutcome,
    })),
    knownContacts: knownContacts.map((contact) => ({
      id: contact.id,
      e164Number: contact.e164Number,
      displayName: contact.displayName,
    })),
    forwardingStatus: senior.forwardingActive
      ? FORWARDING_STATES.active
      : FORWARDING_STATES.inactive,
  };
};
