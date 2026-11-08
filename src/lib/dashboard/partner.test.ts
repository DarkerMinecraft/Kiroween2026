import { beforeEach, describe, expect, it, vi } from "vitest";

// Data-loading tests for the Partner dashboard loader (task 15.5). The scoping
// case verified here is the fail-closed one: an account that owns no
// PartnerProfile gets a typed `not_partner` failure and NONE of another
// account's billing or member data — the loader returns before any membership
// is read.
// Validates: Requirements 9.2 (empty/denied state analogue for Partner)

// --- Mock @/lib/authz. -----------------------------------------------------
const assertPartnerMembership = vi.fn<(partnerUserId: string, seniorId: string) => Promise<void>>();

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
  assertCareLink: vi.fn(),
  assertPartnerMembership: (...args: [string, string]) => assertPartnerMembership(...args),
  AuthorizationError,
}));

// --- Mock @/lib/stripe (clampQuantity is imported by the loader). ----------
vi.mock("@/lib/stripe", () => ({
  clampQuantity: (n: number) => Math.max(0, Math.trunc(n)),
}));

// --- Mock @/lib/prisma. ----------------------------------------------------
const partnerProfile = { findUnique: vi.fn() };

vi.mock("@/lib/prisma", () => ({
  prisma: {
    partnerProfile,
  },
}));

// Import after mocks are registered so the loader binds to the mocked modules.
const { loadPartnerDashboard } = await import("./partner");

const PARTNER_USER_ID = "user-partner-1";

beforeEach(() => {
  vi.clearAllMocks();
  assertPartnerMembership.mockResolvedValue(undefined);
});

describe("loadPartnerDashboard", () => {
  it("returns { ok: false, error: 'not_partner' } for a non-Partner account with no other account's data", async () => {
    partnerProfile.findUnique.mockResolvedValue(null);

    const result = await loadPartnerDashboard(PARTNER_USER_ID);

    expect(result).toEqual({ ok: false, error: "not_partner" });
    // Fail-closed: no membership check runs, so no other account's members or
    // billing can surface.
    expect(assertPartnerMembership).not.toHaveBeenCalled();
  });

  it("returns the Partner's own members and billing when the profile exists", async () => {
    partnerProfile.findUnique.mockResolvedValue({
      id: "partner-profile-1",
      subscription: {
        stripeSubscriptionId: "sub_1",
        state: "active",
        quantity: 1,
      },
      memberships: [
        {
          seniorId: "senior-1",
          senior: {
            forwardingActive: true,
            user: { name: "Mabel", email: "mabel@example.com" },
          },
        },
      ],
    });

    const result = await loadPartnerDashboard(PARTNER_USER_ID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.billing).toEqual({
        stripeSubscriptionId: "sub_1",
        state: "active",
        quantity: 1,
      });
      expect(result.data.members).toEqual([
        {
          seniorId: "senior-1",
          name: "Mabel",
          email: "mabel@example.com",
          forwardingActive: true,
        },
      ]);
    }
    // Each listed member is re-verified against this Partner.
    expect(assertPartnerMembership).toHaveBeenCalledWith(PARTNER_USER_ID, "senior-1");
  });

  it("drops members that fail the per-Partner membership re-check", async () => {
    partnerProfile.findUnique.mockResolvedValue({
      id: "partner-profile-1",
      subscription: { stripeSubscriptionId: "sub_1", state: "active", quantity: 2 },
      memberships: [
        {
          seniorId: "senior-1",
          senior: {
            forwardingActive: true,
            user: { name: "Mabel", email: "mabel@example.com" },
          },
        },
        {
          seniorId: "senior-2",
          senior: {
            forwardingActive: false,
            user: { name: "Ezra", email: "ezra@example.com" },
          },
        },
      ],
    });
    assertPartnerMembership.mockImplementation(async (_partnerUserId, seniorId) => {
      if (seniorId === "senior-2") {
        throw new AuthorizationError("partner_membership_absent", "not a member");
      }
    });

    const result = await loadPartnerDashboard(PARTNER_USER_ID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.members).toEqual([
        {
          seniorId: "senior-1",
          name: "Mabel",
          email: "mabel@example.com",
          forwardingActive: true,
        },
      ]);
    }
  });
});
