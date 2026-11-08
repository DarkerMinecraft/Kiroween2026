import { beforeEach, describe, expect, it, vi } from "vitest";

// Data-loading tests for the Caregiver_Dashboard loaders (task 15.5). These
// exercise scoping and empty-state behavior: a Caregiver only ever sees Seniors
// they hold an active Care_Link to, an unlinked request is denied by
// `assertCareLink` and reads NO Senior data, and a Caregiver with no profile or
// no active links renders the empty state rather than an error.
// Validates: Requirements 9.2, 9.4

// --- Mock @/lib/authz: assertCareLink resolves (authorized) by default. ----
const assertCareLink = vi.fn<(caregiverUserId: string, seniorId: string) => Promise<void>>();

class AuthorizationError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "AuthorizationError";
    this.reason = reason;
    Object.setPrototypeOf(this, AuthorizationError.prototype);
  }
}

vi.mock("@/lib/authz", () => ({
  assertCareLink: (...args: [string, string]) => assertCareLink(...args),
  assertPartnerMembership: vi.fn(),
  AuthorizationError,
}));

// --- Mock @/lib/prisma. ----------------------------------------------------
const caregiverProfile = { findUnique: vi.fn() };
const careLink = { findMany: vi.fn() };
const seniorProfile = { findUnique: vi.fn() };

vi.mock("@/lib/prisma", () => ({
  prisma: {
    caregiverProfile,
    careLink,
    seniorProfile,
  },
}));

// Import after mocks are registered so the loader binds to the mocked modules.
const { loadLinkedSeniors, loadSeniorDetail } = await import("./caregiver");

const CAREGIVER_USER_ID = "user-caregiver-1";
const CAREGIVER_PROFILE_ID = "caregiver-profile-1";
const SENIOR_ID = "senior-1";

beforeEach(() => {
  vi.clearAllMocks();
  assertCareLink.mockResolvedValue(undefined);
});

describe("loadLinkedSeniors", () => {
  it("returns the Seniors the Caregiver holds an active Care_Link to (Req 9.1)", async () => {
    caregiverProfile.findUnique.mockResolvedValue({ id: CAREGIVER_PROFILE_ID });
    careLink.findMany.mockResolvedValue([
      {
        senior: {
          id: SENIOR_ID,
          user: { name: "Mabel", email: "mabel@example.com" },
        },
      },
      {
        senior: {
          id: "senior-2",
          user: { name: null, email: "ezra@example.com" },
        },
      },
    ]);

    const result = await loadLinkedSeniors(CAREGIVER_USER_ID);

    expect(result).toEqual([
      { id: SENIOR_ID, name: "Mabel", email: "mabel@example.com" },
      { id: "senior-2", name: null, email: "ezra@example.com" },
    ]);
    // Links are scoped to this Caregiver's profile and the active flag.
    expect(careLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { caregiverId: CAREGIVER_PROFILE_ID, active: true },
      }),
    );
  });

  it("returns an empty array when the account has no CaregiverProfile (empty state, Req 9.2)", async () => {
    caregiverProfile.findUnique.mockResolvedValue(null);

    const result = await loadLinkedSeniors(CAREGIVER_USER_ID);

    expect(result).toEqual([]);
    // No profile means no links are even queried.
    expect(careLink.findMany).not.toHaveBeenCalled();
  });

  it("returns an empty array when the Caregiver has no active links (empty state, Req 9.2)", async () => {
    caregiverProfile.findUnique.mockResolvedValue({ id: CAREGIVER_PROFILE_ID });
    careLink.findMany.mockResolvedValue([]);

    const result = await loadLinkedSeniors(CAREGIVER_USER_ID);

    expect(result).toEqual([]);
  });
});

describe("loadSeniorDetail", () => {
  it("returns the selected Senior's detail when the Care_Link assertion resolves (Req 9.3)", async () => {
    seniorProfile.findUnique.mockResolvedValue({
      id: SENIOR_ID,
      user: { name: "Mabel", email: "mabel@example.com" },
      protectionNumber: { provisioningState: "active", e164Number: "+15555550123" },
      subscription: { state: "active", monthlyPriceCents: 999 },
      knownContacts: [],
      callRecords: [],
    });

    const detail = await loadSeniorDetail(CAREGIVER_USER_ID, SENIOR_ID);

    // Authorization was checked for exactly this caregiver/senior pair first.
    expect(assertCareLink).toHaveBeenCalledWith(CAREGIVER_USER_ID, SENIOR_ID);
    expect(detail.senior).toEqual({
      id: SENIOR_ID,
      name: "Mabel",
      email: "mabel@example.com",
    });
    // The Senior read is scoped to the requested id only.
    expect(seniorProfile.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: SENIOR_ID } }),
    );
  });

  it("rejects with AuthorizationError and reads NO Senior data when unlinked (Req 9.4)", async () => {
    assertCareLink.mockRejectedValue(
      new AuthorizationError("care_link_absent", "No active care-link"),
    );

    await expect(loadSeniorDetail(CAREGIVER_USER_ID, SENIOR_ID)).rejects.toBeInstanceOf(
      AuthorizationError,
    );

    // The denial happens before any Senior data is read — no leak of another
    // user's data (Req 9.4).
    expect(seniorProfile.findUnique).not.toHaveBeenCalled();
  });
});
