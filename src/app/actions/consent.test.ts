import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests for the consent server actions (task 11.4).
//
// `submitConsent` captures a Senior's consent and `withdrawConsent` revokes it;
// both recompute and materialize `SeniorProfile.forwardingActive` through the
// real forwarding gate in `@/lib/screening` (left unmocked here). These tests
// mock `@/lib/prisma` (seniorProfile.findUnique/update, consentRecord.upsert/
// findUnique/update) to assert that a missing required field is rejected with a
// typed error and no write (Req 3.4), and that withdrawal deactivates
// forwarding (Req 3.5).
// Validates: Requirements 3.4, 3.5

const { prismaMock } = vi.hoisted(() => {
  const prismaMock = {
    seniorProfile: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    consentRecord: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };

  return { prismaMock };
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// Imported after the mock is registered; `@/lib/screening` runs for real.
import { submitConsent, withdrawConsent } from "./consent";

afterEach(() => {
  vi.clearAllMocks();
});

describe("submitConsent - missing required field (Req 3.4)", () => {
  beforeEach(() => {
    // The findUnique used to confirm the Senior exists; irrelevant for the
    // early field-validation paths but set so an accidental call is harmless.
    prismaMock.seniorProfile.findUnique.mockResolvedValue({ id: "sen_1" });
  });

  it("rejects a missing seniorId with a typed field error and performs no write", async () => {
    const result = await submitConsent({ seniorId: "   ", protectionNumber: "+15125550100" });

    expect(result).toEqual({
      ok: false,
      field: "seniorId",
      message: expect.any(String),
    });
    expect(prismaMock.consentRecord.upsert).not.toHaveBeenCalled();
    expect(prismaMock.seniorProfile.update).not.toHaveBeenCalled();
  });

  it("rejects a missing protectionNumber with a typed field error and performs no write", async () => {
    const result = await submitConsent({ seniorId: "sen_1", protectionNumber: "" });

    expect(result).toEqual({
      ok: false,
      field: "protectionNumber",
      message: expect.any(String),
    });
    expect(prismaMock.consentRecord.upsert).not.toHaveBeenCalled();
    expect(prismaMock.seniorProfile.update).not.toHaveBeenCalled();
  });
});

describe("withdrawConsent - deactivates forwarding (Req 3.5)", () => {
  it("marks the consent withdrawn and materializes forwardingActive = false", async () => {
    // An active subscription exists, so only the withdrawal flips the gate off:
    // this proves withdrawal — not a missing subscription — deactivates it.
    prismaMock.consentRecord.findUnique.mockResolvedValue({ id: "con_1" });
    prismaMock.consentRecord.update.mockResolvedValue({ id: "con_1", withdrawn: true });
    prismaMock.seniorProfile.findUnique.mockResolvedValue({
      id: "sen_1",
      consent: { id: "con_1", withdrawn: true },
      subscription: { state: "active" },
    });
    prismaMock.seniorProfile.update.mockResolvedValue({ id: "sen_1", forwardingActive: false });

    const result = await withdrawConsent({ seniorId: "sen_1" });

    expect(result).toEqual({
      ok: true,
      forwardingActive: false,
      message: expect.stringContaining("inactive"),
    });

    // The consent row is flipped to withdrawn.
    expect(prismaMock.consentRecord.update).toHaveBeenCalledWith({
      where: { seniorId: "sen_1" },
      data: { withdrawn: true },
    });
    // The recomputed gate is materialized as inactive onto the SeniorProfile.
    expect(prismaMock.seniorProfile.update).toHaveBeenCalledWith({
      where: { id: "sen_1" },
      data: { forwardingActive: false },
    });
  });

  it("rejects a missing seniorId with a typed field error and performs no write", async () => {
    const result = await withdrawConsent({ seniorId: "  " });

    expect(result).toEqual({
      ok: false,
      field: "seniorId",
      message: expect.any(String),
    });
    expect(prismaMock.consentRecord.update).not.toHaveBeenCalled();
    expect(prismaMock.seniorProfile.update).not.toHaveBeenCalled();
  });

  it("rejects withdrawal when no consent record exists for the Senior", async () => {
    prismaMock.consentRecord.findUnique.mockResolvedValue(null);

    const result = await withdrawConsent({ seniorId: "sen_1" });

    expect(result).toEqual({
      ok: false,
      field: "seniorId",
      message: expect.any(String),
    });
    expect(prismaMock.consentRecord.update).not.toHaveBeenCalled();
    expect(prismaMock.seniorProfile.update).not.toHaveBeenCalled();
  });
});
