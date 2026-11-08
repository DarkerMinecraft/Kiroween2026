import { beforeEach, describe, expect, it, vi } from "vitest";

// Data-loading tests for the Senior_Dashboard loader (task 15.5). These verify
// that the loader returns ONLY the authenticated Senior's records (every query
// scoped to the resolved SeniorProfile.id), renders the empty state when there
// are no Call_Records, and on the load-failure path (missing SeniorProfile)
// throws rather than ever falling back to another Senior's data.
// Validates: Requirements 10.3, 10.6, 10.7

// --- Mock @/lib/prisma. ----------------------------------------------------
const seniorProfile = { findUnique: vi.fn() };
const callRecord = { findMany: vi.fn() };
const knownContact = { findMany: vi.fn() };

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seniorProfile,
    callRecord,
    knownContact,
  },
}));

// Import after mocks are registered so the loader binds to the mocked modules.
const { loadSeniorDashboard, SeniorProfileNotFoundError } = await import("./senior");

const SENIOR_USER_ID = "user-senior-1";
const SENIOR_PROFILE_ID = "senior-profile-1";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadSeniorDashboard", () => {
  it("returns only the authenticated Senior's records, scoped to the resolved profile id (Req 10.6)", async () => {
    seniorProfile.findUnique.mockResolvedValue({
      id: SENIOR_PROFILE_ID,
      forwardingActive: true,
    });
    callRecord.findMany.mockResolvedValue([
      {
        id: "call-1",
        callerNumber: "+15555550100",
        knownContactName: "Daughter",
        startedAt: new Date("2026-01-02T10:00:00Z"),
        screeningOutcome: "connected",
      },
    ]);
    knownContact.findMany.mockResolvedValue([
      { id: "kc-1", e164Number: "+15555550100", displayName: "Daughter" },
    ]);

    const data = await loadSeniorDashboard(SENIOR_USER_ID);

    // The profile is resolved by the authenticated account's userId, never a
    // client-supplied profile id (Req 10.6).
    expect(seniorProfile.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: SENIOR_USER_ID } }),
    );
    // Both reads are scoped to the resolved SeniorProfile.id.
    expect(callRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { seniorId: SENIOR_PROFILE_ID } }),
    );
    expect(knownContact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { seniorId: SENIOR_PROFILE_ID } }),
    );
    expect(data.callRecords).toHaveLength(1);
    expect(data.callRecords[0]).toMatchObject({
      id: "call-1",
      callerIdentifier: "+15555550100",
      outcome: "connected",
    });
    expect(data.forwardingStatus).toBe("active");
  });

  it("returns an empty callRecords array when the Senior has no calls (empty state, Req 10.3)", async () => {
    seniorProfile.findUnique.mockResolvedValue({
      id: SENIOR_PROFILE_ID,
      forwardingActive: false,
    });
    callRecord.findMany.mockResolvedValue([]);
    knownContact.findMany.mockResolvedValue([]);

    const data = await loadSeniorDashboard(SENIOR_USER_ID);

    expect(data.callRecords).toEqual([]);
    expect(data.knownContacts).toEqual([]);
    expect(data.forwardingStatus).toBe("inactive");
  });

  it("throws SeniorProfileNotFoundError and reads no records when the profile is missing (Req 10.7)", async () => {
    seniorProfile.findUnique.mockResolvedValue(null);

    await expect(loadSeniorDashboard(SENIOR_USER_ID)).rejects.toBeInstanceOf(
      SeniorProfileNotFoundError,
    );

    // The load-failure path never queries another Senior's data (Req 10.7).
    expect(callRecord.findMany).not.toHaveBeenCalled();
    expect(knownContact.findMany).not.toHaveBeenCalled();
  });
});
