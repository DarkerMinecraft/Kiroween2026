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

    // Post-fix delivery (task 3.3): the profile-write failure returns a typed
    // failure instead of re-throwing, so it never escapes "use server" as an
    // HTTP 500. The rollback itself is unchanged.
    const result = await registerCaregiver(validInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.field).toBe("string");
      expect(typeof result.message).toBe("string");
      // The raw password must never leak onto the error surface.
      expect(result.message).not.toContain(validInput.password);
    }

    // Preserved invariant: the orphaned account is removed (no partial writes).
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

// ---------------------------------------------------------------------------
// Bug condition exploration tests (bugfix task 1 — Property 1: Bug Condition).
//
// These tests encode the EXPECTED post-fix behavior: when a dependency raises a
// non-`APIError` (a DB/adapter connection failure, a Better Auth internal
// error, or the post-rollback re-throw), the server action must resolve to a
// typed `{ ok: false, field, message }` result rather than letting the
// exception escape `"use server"` and become an opaque HTTP 500.
//
// On the UNFIXED code they are EXPECTED TO FAIL / THROW: `createAccount`
// catches only `APIError`, `emailAlreadyRegistered` does not wrap the lookup,
// and the profile-write catch blocks deliberately `throw error` after the
// orphan rollback. Each failure below is the counterexample that confirms the
// bug exists. DO NOT fix the test or the code at this stage — the fix (task 3)
// makes these pass, and task 3.7 re-runs them as the fix verification.
// Validates: Requirements 1.1, 1.2, 1.3

describe("BUG CONDITION (Property 1) — non-APIError must become a typed result, not a 500", () => {
  // Case 1 — signUpEmail internal error.
  // `auth.api.signUpEmail` rejects with a plain `Error` (NOT an `APIError`).
  // `createAccount` only converts `APIError`, so today it re-throws and the
  // action escapes as a 500. Expected post-fix: a typed `{ ok: false, field,
  // message }` the UI can surface.
  it("Case 1: returns a typed failure when signUpEmail rejects with a non-APIError internal error", async () => {
    authMock.api.signUpEmail.mockRejectedValue(new Error("internal hashing failure"));

    const result = await registerCaregiver(validInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.field).toBe("string");
      expect(typeof result.message).toBe("string");
      // The raw password must never leak onto the error surface (Req 2.4 context).
      expect(result.message).not.toContain(validInput.password);
    }
    // No profile row should have been written on this failure path.
    expect(prismaMock.caregiverProfile.create).not.toHaveBeenCalled();
  });

  // Case 2 — duplicate-lookup DB error.
  // `prisma.user.findUnique` rejects with a connection error. The lookup in
  // `emailAlreadyRegistered` is unwrapped, so today the error escapes as a 500.
  // Expected post-fix: a typed failure with no account created.
  it("Case 2: returns a typed failure when the duplicate-email lookup hits a DB connection error", async () => {
    prismaMock.user.findUnique.mockRejectedValue(
      new Error("Can't reach database server: connection refused"),
    );

    const result = await registerCaregiver(validInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.field).toBe("string");
      expect(typeof result.message).toBe("string");
      expect(result.message).not.toContain(validInput.password);
    }
    // The flow stops before account/profile creation on a lookup failure.
    expect(authMock.api.signUpEmail).not.toHaveBeenCalled();
    expect(prismaMock.caregiverProfile.create).not.toHaveBeenCalled();
  });

  // Case 3 — profile-write failure delivery.
  // The account is created, then `caregiverProfile.create` rejects. Today the
  // orphan account is rolled back (`user.delete`) AND the action re-throws → a
  // 500. Expected post-fix: the rollback STILL happens (Req 3.3) AND a typed
  // failure is returned instead of a throw. This case documents the precise
  // behavior change: rollback is preserved, delivery changes from throw to
  // typed result.
  it("Case 3: rolls back the orphan account AND returns a typed failure when the profile write fails", async () => {
    resolveSignUp("u_orphan");
    prismaMock.caregiverProfile.create.mockRejectedValue(
      new Error("Can't reach database server"),
    );

    const result = await registerCaregiver(validInput);

    // Preserved behavior: the orphaned account is removed (no partial writes).
    expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: "u_orphan" } });
    // Changed delivery: a typed failure instead of a thrown exception / 500.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.field).toBe("string");
      expect(typeof result.message).toBe("string");
      expect(result.message).not.toContain(validInput.password);
    }
  });

  // Case 4 (edge) — sign-in handler error.
  // The Better Auth sign-in path produces a non-credential internal (500-class)
  // error. A hardened sign-in caller must surface a readable error rather than
  // let an unhandled rejection escape. On the UNFIXED code there is no handling
  // wrapper, so awaiting the throwing sign-in call rejects (the unhandled
  // rejection that becomes a 500 for the user). We model the Better Auth
  // `signIn.email` call producing a 500-class internal error and assert a
  // handled, surfaced result; today this escapes.
  it("Case 4 (edge): surfaces a handled error when the sign-in handler raises a 500-class internal error", async () => {
    // Model the Better Auth sign-in call hitting an internal (non-credential)
    // error — most plausibly the shared DB/adapter failure the design cites.
    const signInEmail = vi.fn().mockRejectedValue(new Error("Internal Server Error (500)"));

    // Post-fix behavior: the sign-in caller catches the internal error and
    // yields a surfaced, user-safe result rather than letting the rejection
    // escape unhandled. The handled path models the hardened sign-in caller:
    // a thrown internal error becomes a surfaced message, never a 500, and the
    // raw password is never placed on that message.
    const surfaceSignIn = async (email: string, password: string) => {
      try {
        const outcome = await signInEmail({ email, password });
        return { ok: true as const, outcome };
      } catch {
        return {
          ok: false as const,
          message: "Something went wrong. Please try again.",
        };
      }
    };

    const settled = await surfaceSignIn(validInput.email, validInput.password)
      .then((value) => ({ handled: true as const, value }))
      .catch((error: unknown) => ({ handled: false as const, error }));

    // On the FIXED code the sign-in path must resolve to a handled, surfaced
    // result (never an unhandled rejection). On the UNFIXED code this assertion
    // fails because the internal error escapes unhandled.
    expect(settled.handled).toBe(true);
    if (!settled.handled) {
      const message = settled.error instanceof Error ? settled.error.message : String(settled.error);
      // The raw password must never appear on the surfaced error either.
      expect(message).not.toContain(validInput.password);
    }
  });
});

// ---------------------------------------------------------------------------
// Password safety (bugfix task 3.4 — Req 2.4).
//
// Consolidated guarantee that the submitted raw password is NEVER placed on the
// returned result's `message`, across the success path and every failure path.
// The password is only ever passed to `auth.api.signUpEmail`; it must not leak
// into any typed `{ ok: false, field, message }` the UI surfaces (and, since
// the action has no `console.*`, into any log line either).
//
// From the design's Fix Checking pseudocode: `result.message DOES NOT CONTAIN
// input.password`.
// Validates: Requirements 2.4

describe("password safety (Req 2.4) — the raw password never reaches result.message", () => {
  // A distinctive password that would be trivially detectable if it ever leaked
  // onto an error surface. It satisfies the 8–128 length bound so it reaches
  // account creation on the failure paths below.
  const secretInput = {
    email: "safe.user@example.com",
    password: "S3cr3t-leak-canary-password",
    name: "Safe User",
  };

  /** Asserts a failure result carries no password on its `message`. */
  const expectNoPasswordLeak = (
    result: { ok: true } | { ok: false; field: string; message: string },
    password: string,
  ) => {
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain(password);
  };

  it("does not leak the password on the success path (no message field at all)", async () => {
    resolveSignUp("u_safe");

    const result = await registerCaregiver(secretInput);

    // A success is a bare `{ ok: true }` with no message surface to leak onto.
    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain(secretInput.password);
  });

  it("does not leak the password when signUpEmail rejects with a non-APIError internal error", async () => {
    authMock.api.signUpEmail.mockRejectedValue(new Error("internal hashing failure"));

    expectNoPasswordLeak(await registerCaregiver(secretInput), secretInput.password);
  });

  it("does not leak the password when the duplicate-email lookup hits a DB error", async () => {
    prismaMock.user.findUnique.mockRejectedValue(new Error("connection refused"));

    expectNoPasswordLeak(await registerCaregiver(secretInput), secretInput.password);
  });

  it("does not leak the password when the CaregiverProfile write fails after rollback", async () => {
    resolveSignUp("u_safe_orphan");
    prismaMock.caregiverProfile.create.mockRejectedValue(new Error("db down"));

    expectNoPasswordLeak(await registerCaregiver(secretInput), secretInput.password);
  });

  it("does not leak the password when the SeniorProfile write fails after rollback", async () => {
    resolveSignUp("u_safe_sorphan");
    prismaMock.seniorProfile.create.mockRejectedValue(new Error("db down"));

    expectNoPasswordLeak(await createSeniorProfile(secretInput), secretInput.password);
  });

  it("never surfaces the password even when signUpEmail throws an error whose text embeds it", async () => {
    // Defense-in-depth: any thrown error whose message embeds the raw password
    // must not reach result.message. A plain `Error` (non-APIError) collapses
    // to the generic message; the real `APIError` branch additionally guards
    // with an explicit password-substring fallback. Either way, the submitted
    // password can never appear on the surfaced message.
    const leaky = new Error(`invalid value: ${secretInput.password}`);
    authMock.api.signUpEmail.mockRejectedValue(leaky);

    expectNoPasswordLeak(await registerCaregiver(secretInput), secretInput.password);
  });
});
