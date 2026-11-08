import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests for the registration / role-setup server actions (task 11.4).
//
// `registerCaregiver` and `createSeniorProfile` validate their input, reject
// duplicate emails case-insensitively, delegate account creation to Better
// Auth, and create exactly one profile row per account. These tests mock
// `@/lib/auth` (auth.api.signUpEmail) and `@/lib/prisma` (user.findUnique /
// user.delete, caregiverProfile.create, seniorProfile.create) so the pure
// validation and orchestration logic can be asserted without IO.
// Validates: Requirements 1.2, 1.3, 1.5

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
      create: vi.fn(),
    },
    seniorProfile: {
      create: vi.fn(),
    },
  };

  return { authMock, prismaMock };
});

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// Imported after the mocks are registered so the module picks up the mocks.
import { createSeniorProfile, registerCaregiver } from "./auth";

/** A valid caregiver registration payload reused across the success tests. */
const validInput = {
  email: "Care.Giver@Example.com",
  password: "a-good-password",
  name: "Care Giver",
};

/** Makes `signUpEmail` resolve with a Better Auth user carrying `userId`. */
const resolveSignUp = (userId: string) =>
  authMock.api.signUpEmail.mockResolvedValue({ user: { id: userId } });

beforeEach(() => {
  // Default: no duplicate email, successful account + profile creation.
  prismaMock.user.findUnique.mockResolvedValue(null);
  prismaMock.user.delete.mockResolvedValue({});
  prismaMock.caregiverProfile.create.mockResolvedValue({ id: "cg_1" });
  prismaMock.seniorProfile.create.mockResolvedValue({ id: "sen_1" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("registerCaregiver - email validation (Req 1.2)", () => {
  it("rejects an email with a bad format as a typed email field error and creates no account", async () => {
    const result = await registerCaregiver({ ...validInput, email: "not-an-email" });

    expect(result).toEqual({
      ok: false,
      field: "email",
      message: expect.any(String),
    });
    expect(authMock.api.signUpEmail).not.toHaveBeenCalled();
    expect(prismaMock.caregiverProfile.create).not.toHaveBeenCalled();
  });

  it("rejects an email longer than 254 characters without creating an account", async () => {
    // 64-char local part + '@' + a domain pushing the whole value past 254.
    const longLocal = "a".repeat(64);
    const longDomain = `${"d".repeat(200)}.com`;
    const tooLong = `${longLocal}@${longDomain}`;
    expect(tooLong.length).toBeGreaterThan(254);

    const result = await registerCaregiver({ ...validInput, email: tooLong });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("email");
    expect(authMock.api.signUpEmail).not.toHaveBeenCalled();
    expect(prismaMock.caregiverProfile.create).not.toHaveBeenCalled();
  });
});

describe("registerCaregiver - password bounds (Req 1.2)", () => {
  it("rejects a password shorter than 8 characters as a typed password field error", async () => {
    const result = await registerCaregiver({ ...validInput, password: "short" });

    expect(result).toEqual({
      ok: false,
      field: "password",
      message: expect.any(String),
    });
    expect(authMock.api.signUpEmail).not.toHaveBeenCalled();
    expect(prismaMock.caregiverProfile.create).not.toHaveBeenCalled();
  });

  it("rejects a password longer than 128 characters without creating an account", async () => {
    const result = await registerCaregiver({ ...validInput, password: "p".repeat(129) });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("password");
    expect(authMock.api.signUpEmail).not.toHaveBeenCalled();
    expect(prismaMock.caregiverProfile.create).not.toHaveBeenCalled();
  });

  it("accepts the 8- and 128-character password boundaries", async () => {
    resolveSignUp("u_min");
    const atMin = await registerCaregiver({ ...validInput, password: "p".repeat(8) });
    expect(atMin).toEqual({ ok: true });

    resolveSignUp("u_max");
    const atMax = await registerCaregiver({ ...validInput, password: "p".repeat(128) });
    expect(atMax).toEqual({ ok: true });
  });
});

describe("registerCaregiver - duplicate email (Req 1.5)", () => {
  it("rejects a duplicate email case-insensitively and leaves the existing account untouched", async () => {
    // The action lowercases the submitted email before the unique lookup, so a
    // differently-cased duplicate resolves to the same stored row.
    prismaMock.user.findUnique.mockResolvedValue({ id: "existing" });

    const result = await registerCaregiver({ ...validInput, email: "CARE.giver@EXAMPLE.com" });

    expect(result).toEqual({
      ok: false,
      field: "email",
      message: expect.stringContaining("already registered"),
    });
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { email: "care.giver@example.com" },
      select: { id: true },
    });
    expect(authMock.api.signUpEmail).not.toHaveBeenCalled();
    expect(prismaMock.caregiverProfile.create).not.toHaveBeenCalled();
    expect(prismaMock.user.delete).not.toHaveBeenCalled();
  });
});

describe("registerCaregiver - success and role assignment (Req 1.3)", () => {
  it("creates the account and exactly one CaregiverProfile for the new user", async () => {
    resolveSignUp("u_new");

    const result = await registerCaregiver(validInput);

    expect(result).toEqual({ ok: true });
    expect(authMock.api.signUpEmail).toHaveBeenCalledWith({
      body: {
        name: "Care Giver",
        email: "care.giver@example.com",
        password: "a-good-password",
      },
    });
    expect(prismaMock.caregiverProfile.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.caregiverProfile.create).toHaveBeenCalledWith({
      data: { userId: "u_new" },
    });
    // The Caregiver role is the only profile row created; no Senior row.
    expect(prismaMock.seniorProfile.create).not.toHaveBeenCalled();
  });

  it("removes the orphaned account when the CaregiverProfile write fails (no partial writes)", async () => {
    resolveSignUp("u_orphan");
    prismaMock.caregiverProfile.create.mockRejectedValue(new Error("db down"));

    await expect(registerCaregiver(validInput)).rejects.toThrow("db down");

    expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: "u_orphan" } });
  });
});

describe("createSeniorProfile - role assignment (Req 1.3/1.4)", () => {
  it("creates exactly one SeniorProfile and returns its id", async () => {
    resolveSignUp("u_sen");
    prismaMock.seniorProfile.create.mockResolvedValue({ id: "sen_42" });

    const result = await createSeniorProfile(validInput);

    expect(result).toEqual({ ok: true, profileId: "sen_42" });
    expect(prismaMock.seniorProfile.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.caregiverProfile.create).not.toHaveBeenCalled();
  });

  it("rejects a duplicate email case-insensitively before creating an account", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "existing" });

    const result = await createSeniorProfile({ ...validInput, email: "CARE.giver@EXAMPLE.com" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("email");
    expect(authMock.api.signUpEmail).not.toHaveBeenCalled();
    expect(prismaMock.seniorProfile.create).not.toHaveBeenCalled();
  });
});
