import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests for the care-link management flow (task 11.4), focused on the
// 1-50 active-link cap boundary (Req 2.3).
//
// `createSeniorProfile` (the care-links orchestrator) pre-counts the
// Caregiver's active links before creating any account, then re-counts inside a
// `$transaction` before inserting the CareLink. These tests mock `@/lib/auth`
// (auth.api.signUpEmail, used by the delegated account-creation action) and
// `@/lib/prisma` (careLink.count/create/findUnique, caregiverProfile.findUnique,
// seniorProfile.create/findUnique, user.delete, and `$transaction(fn)` invoking
// fn with the mock client).
// Validates: Requirements 2.3

const { authMock, prismaMock } = vi.hoisted(() => {
  const authMock = {
    api: {
      signUpEmail: vi.fn(),
    },
  };

  const prismaMock = {
    user: {
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    caregiverProfile: {
      findUnique: vi.fn(),
    },
    seniorProfile: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    careLink: {
      count: vi.fn(),
      create: vi.fn(),
    },
    // `$transaction(fn)` runs the callback with the same mock client, so the
    // in-transaction re-count and insert hit the shared `careLink` mocks.
    $transaction: vi.fn(async (fn: (tx: typeof prismaMock) => unknown) => fn(prismaMock)),
  };

  return { authMock, prismaMock };
});

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// Imported after the mocks are registered so the module picks up the mocks.
import { createSeniorProfile } from "./care-links";

/** A valid Senior-creation payload reused across the cap tests. */
const input = {
  caregiverUserId: "cg_user_1",
  email: "senior@example.com",
  password: "a-good-password",
  name: "Senior Person",
};

beforeEach(() => {
  // The initiating account is a caregiver, the submitted email is unique, and
  // Better Auth + SeniorProfile creation succeed by default. Each test then
  // overrides `careLink.count` to sit at or below the 50 cap boundary.
  prismaMock.caregiverProfile.findUnique.mockResolvedValue({ id: "cg_1" });
  prismaMock.user.findUnique.mockResolvedValue(null);
  prismaMock.user.delete.mockResolvedValue({});
  authMock.api.signUpEmail.mockResolvedValue({ user: { id: "u_sen" } });
  prismaMock.seniorProfile.create.mockResolvedValue({ id: "sen_new" });
  prismaMock.seniorProfile.findUnique.mockResolvedValue({ userId: "u_sen" });
  prismaMock.careLink.create.mockResolvedValue({ id: "link_new" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("createSeniorProfile - active care-link cap boundary (Req 2.3)", () => {
  it("rejects a new link at the 50-link cap without creating a Senior account or link", async () => {
    // Already at the cap: the pre-count short-circuits before any account or
    // link write, so the Caregiver's existing links are retained unchanged.
    prismaMock.careLink.count.mockResolvedValue(50);

    const result = await createSeniorProfile(input);

    expect(result).toEqual({
      ok: false,
      field: "caregiverUserId",
      message: expect.stringContaining("Maximum"),
    });
    expect(authMock.api.signUpEmail).not.toHaveBeenCalled();
    expect(prismaMock.seniorProfile.create).not.toHaveBeenCalled();
    expect(prismaMock.careLink.create).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("succeeds at 49 active links, creating the Senior and an active care-link", async () => {
    // One below the cap: both the pre-count and the in-transaction re-count
    // pass, so the account and the active CareLink are created.
    prismaMock.careLink.count.mockResolvedValue(49);

    const result = await createSeniorProfile(input);

    expect(result).toEqual({ ok: true, seniorId: "sen_new" });
    expect(authMock.api.signUpEmail).toHaveBeenCalledTimes(1);
    expect(prismaMock.seniorProfile.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.careLink.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.careLink.create).toHaveBeenCalledWith({
      data: { caregiverId: "cg_1", seniorId: "sen_new", active: true },
    });
    // No rollback occurred.
    expect(prismaMock.user.delete).not.toHaveBeenCalled();
  });

  it("rolls back the Senior account when the cap is hit during the transaction race", async () => {
    // Pre-count passes (49) but the in-transaction re-count sees the cap (50):
    // the insert is skipped and the just-created Senior account is removed, so
    // the over-cap request mutates nothing observable.
    prismaMock.careLink.count
      .mockResolvedValueOnce(49) // pre-check before account creation
      .mockResolvedValueOnce(50); // re-count inside the transaction

    const result = await createSeniorProfile(input);

    expect(result).toEqual({
      ok: false,
      field: "caregiverUserId",
      message: expect.stringContaining("Maximum"),
    });
    expect(prismaMock.careLink.create).not.toHaveBeenCalled();
    expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: "u_sen" } });
  });
});
