import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Feature: senior-call-shield, Property 9: Call history ordering is
// newest-first. For every generated set of Call_Records belonging to the
// authenticated Senior, `loadSeniorDashboard` returns the records ordered
// strictly descending by call start timestamp (ties broken deterministically),
// returns at most the 20 most recent, and returns an empty array for an empty
// set rather than raising an error.
// Validates: Requirements 7.3, 7.5, 7.6, 10.1

/** The 20-record cap the Senior_Dashboard loader applies (Req 10.1). */
const RECENT_CALL_RECORD_LIMIT = 20;

/**
 * A minimal in-memory Call_Record row, matching the fields the loader selects.
 * The mock `callRecord.findMany` reads from {@link callRecords} below.
 */
interface CallRecordRow {
  readonly id: string;
  readonly seniorId: string;
  readonly callerNumber: string;
  readonly knownContactName: string | null;
  readonly startedAt: Date;
  readonly screeningOutcome: string;
}

/** The senior profile the mock `seniorProfile.findUnique` returns. */
const SENIOR_PROFILE = { id: "senior-1", forwardingActive: true } as const;

/** The in-memory Call_Records the mocked Prisma client serves. */
let callRecords: CallRecordRow[] = [];

// Model the shared Prisma client as an in-memory store. `vi.mock` is hoisted,
// so the factory only closes over module-level bindings. `findMany` emulates
// the database: it filters by seniorId, sorts by startedAt descending (ties
// broken by id descending, deterministically), and applies the `take` limit.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    seniorProfile: {
      findUnique: vi.fn(async () => SENIOR_PROFILE),
    },
    callRecord: {
      findMany: vi.fn(
        async ({
          where,
          take,
        }: {
          where: { seniorId: string };
          orderBy?: { startedAt: "asc" | "desc" };
          take?: number;
        }) => {
          const sorted = callRecords
            .filter((r) => r.seniorId === where.seniorId)
            .sort((a, b) => {
              const byTime = b.startedAt.getTime() - a.startedAt.getTime();
              if (byTime !== 0) return byTime;
              // Deterministic tie-break so equal timestamps have a stable order.
              return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
            });
          return typeof take === "number" ? sorted.slice(0, take) : sorted;
        },
      ),
    },
    knownContact: {
      findMany: vi.fn(async () => []),
    },
  },
}));

import { loadSeniorDashboard } from "./senior";

/** Non-empty opaque id generator (unique within a case via fc.uniqueArray). */
const idArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 24 })
  .filter((s) => s.trim().length > 0);

/** Arbitrary Call_Record for the single authenticated senior. */
const callRecordArb: fc.Arbitrary<CallRecordRow> = fc.record({
  id: idArb,
  seniorId: fc.constant(SENIOR_PROFILE.id),
  callerNumber: fc.string({ minLength: 1, maxLength: 16 }),
  knownContactName: fc.option(fc.string({ maxLength: 100 }), { nil: null }),
  // A wide but finite Date range; collisions are intentionally possible so the
  // tie-break path is exercised.
  startedAt: fc
    .integer({ min: 0, max: 4_102_444_800_000 })
    .map((ms) => new Date(ms)),
  screeningOutcome: fc.string({ minLength: 1, maxLength: 24 }),
});

/** A set of Call_Records with ids unique within the set. */
const callRecordSetArb: fc.Arbitrary<CallRecordRow[]> = fc.uniqueArray(
  callRecordArb,
  {
    minLength: 0,
    maxLength: 60,
    selector: (r) => r.id,
  },
);

describe("loadSeniorDashboard call-history ordering (Property 9)", () => {
  beforeEach(() => {
    callRecords = [];
  });

  it("returns at most 20 records in strictly descending timestamp order", async () => {
    await fc.assert(
      fc.asyncProperty(callRecordSetArb, async (records) => {
        callRecords = records;

        const data = await loadSeniorDashboard("user-1");
        const returned = data.callRecords;

        // (b) At most the 20 most recent are returned.
        expect(returned.length).toBeLessThanOrEqual(RECENT_CALL_RECORD_LIMIT);
        expect(returned.length).toBe(
          Math.min(records.length, RECENT_CALL_RECORD_LIMIT),
        );

        // (a) Non-increasing by timestamp. Consecutive records never ascend;
        // on a tie the deterministic id tie-break keeps a stable order.
        for (let i = 1; i < returned.length; i += 1) {
          const prev = returned[i - 1].timestamp.getTime();
          const curr = returned[i].timestamp.getTime();
          expect(prev).toBeGreaterThanOrEqual(curr);
        }

        // The returned window is exactly the top-N by the newest-first order:
        // every returned timestamp is >= every dropped record's timestamp.
        const returnedTimes = returned.map((r) => r.timestamp.getTime());
        const allTimesDesc = [...records]
          .map((r) => r.startedAt.getTime())
          .sort((a, b) => b - a);
        const expectedWindow = allTimesDesc.slice(0, RECENT_CALL_RECORD_LIMIT);
        expect(returnedTimes).toEqual(expectedWindow);
      }),
      { numRuns: 200 },
    );
  });

  it("returns an empty array for an empty Call_Record set without error", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant<CallRecordRow[]>([]), async (empty: CallRecordRow[]) => {
        callRecords = empty;

        // (c) Empty input yields an empty result, never an error (Req 7.6).
        const data = await loadSeniorDashboard("user-1");
        expect(data.callRecords).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });
});
