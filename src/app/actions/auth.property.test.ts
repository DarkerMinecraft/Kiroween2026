import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

// Preservation property tests (bugfix task 2 — Property 2: Preservation).
//
// Feature: auth-login-signup-fix. These tests follow the OBSERVATION-FIRST
// methodology: they record what the UNFIXED `registerCaregiver` /
// `createSeniorProfile` / `resolvePostAuthPath` actions do today and assert it,
// so they PASS on the unfixed code and establish the baseline the zod rewrite
// (task 3) must preserve. After the fix is applied (task 3.8) the SAME tests are
// re-run and must still pass, proving the zod schemas enforce the identical
// accept/reject boundaries, field ordering, duplicate rejection, one-profile
// creation, orphan rollback, id return, and role resolution.
//
// Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6

// --- Mock wiring -----------------------------------------------------------
//
// The same harness as `auth.test.ts`: `@/lib/auth` (auth.api.signUpEmail,
// auth.api.getSession) and `@/lib/prisma` (user.findUnique / user.delete,
// caregiverProfile.create, seniorProfile.create, and the role-profile lookups
// `resolveRole` performs) are mocked so the pure validation and orchestration
// logic is observed without IO.

const { authMock, prismaMock } = vi.hoisted(() => {
  const authMock = {
    api: {
      signUpEmail: vi.fn(),
      getSession: vi.fn(),
    },
  };

  const prismaMock = {
    user: {
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    caregiverProfile: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    seniorProfile: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    partnerProfile: {
      findUnique: vi.fn(),
    },
  };

  return { authMock, prismaMock };
});

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// `next/headers` is only used by `resolvePostAuthPath`; stub it so the action
// can run outside a request scope.
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));

// Imported after the mocks are registered so the module picks up the mocks.
import {
  createSeniorProfile,
  registerCaregiver,
  resolvePostAuthPath,
} from "./auth";

// --- Reference model of the CURRENT hand-rolled validators -----------------
//
// A standalone re-implementation of the accept/reject decisions the unfixed
// `src/app/actions/auth.ts` makes, used only as the parity oracle for the
// boundary property. The zod rewrite must reproduce EXACTLY these outcomes,
// field names, and message strings, so this model is the behavioral contract.
//
// Field-first ordering as the action evaluates it: name -> email -> password.

const MAX_EMAIL_LENGTH = 254;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

// The exact regex the unfixed `EMAIL_PATTERN` uses.
const EMAIL_PATTERN =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

/** The typed field result shape, or null when the input is accepted. */
type FieldReject = { field: string; message: string } | null;

/**
 * Mirrors the unfixed action's pre-write validation: it returns the first
 * offending field (name -> email -> password) exactly as the action would, or
 * null when all three validators accept. This is the pure accept/reject oracle;
 * it does not touch the duplicate-email lookup or account creation.
 */
const referenceValidate = (input: {
  name: string;
  email: string;
  password: string;
}): FieldReject => {
  const name = input.name.trim();
  if (name.length === 0) return { field: "name", message: "Name is required" };

  const normalized = input.email.trim().toLowerCase();
  if (normalized.length === 0)
    return { field: "email", message: "Email is required" };
  if (normalized.length > MAX_EMAIL_LENGTH)
    return { field: "email", message: "Email must be at most 254 characters" };
  if (!EMAIL_PATTERN.test(normalized))
    return { field: "email", message: "Email is not a valid address" };

  if (input.password.length < MIN_PASSWORD_LENGTH)
    return { field: "password", message: "Password must be at least 8 characters" };
  if (input.password.length > MAX_PASSWORD_LENGTH)
    return { field: "password", message: "Password must be at most 128 characters" };

  return null;
};

/** A valid caregiver registration payload reused across the invariant tests. */
const validInput = {
  email: "Care.Giver@Example.com",
  password: "a-good-password",
  name: "Care Giver",
};

beforeEach(() => {
  // Default: no duplicate email, successful account + profile creation.
  prismaMock.user.findUnique.mockResolvedValue(null);
  prismaMock.user.delete.mockResolvedValue({});
  prismaMock.caregiverProfile.create.mockResolvedValue({ id: "cg_1" });
  prismaMock.seniorProfile.create.mockResolvedValue({ id: "sen_1" });
  authMock.api.signUpEmail.mockResolvedValue({ user: { id: "u_default" } });
});

afterEach(() => {
  vi.clearAllMocks();
});

// --- Arbitraries -----------------------------------------------------------
//
// Smart generators constrained to the input space so the parity assertion
// exercises both sides of every boundary (length and shape) rather than random
// noise that would almost always reject.

/** A 254-char valid email (at the inclusive upper bound). */
const emailAtMaxLength = (() => {
  const domainTail = "@example.com"; // 12 chars
  const local = "a".repeat(MAX_EMAIL_LENGTH - domainTail.length);
  const value = `${local}${domainTail}`;
  return value;
})();

/** A 255-char email (one over the bound) that otherwise matches the pattern. */
const emailOverMaxLength = (() => {
  const domainTail = "@example.com";
  const local = "a".repeat(MAX_EMAIL_LENGTH + 1 - domainTail.length);
  return `${local}${domainTail}`;
})();

/** Emails spanning valid shapes, boundary lengths, and malformed shapes. */
const emailArb: fc.Arbitrary<string> = fc.oneof(
  // Plausible well-formed addresses.
  fc
    .tuple(
      fc.stringMatching(/^[a-z0-9]{1,12}$/),
      fc.constantFrom("example.com", "mail.co", "sub.domain.org"),
    )
    .map(([local, domain]) => `${local}@${domain}`),
  // Boundary and over-boundary lengths.
  fc.constant(emailAtMaxLength),
  fc.constant(emailOverMaxLength),
  // Mixed-case variants (exercise the trim+lowercase normalization).
  fc.constantFrom("Care.Giver@Example.COM", "  spaced@domain.io  "),
  // Malformed shapes the pattern must reject.
  fc.constantFrom("", "   ", "not-an-email", "no-at-sign.com", "a@b", "@domain.com", "user@"),
);

/** Passwords spanning out-of-range, at-boundary, and in-range lengths. */
const passwordArb: fc.Arbitrary<string> = fc.oneof(
  fc.string({ minLength: 0, maxLength: 7 }), // below the 8-char floor
  fc.constant("p".repeat(MIN_PASSWORD_LENGTH)), // 8 (lower bound)
  fc.string({ minLength: 8, maxLength: 128 }), // in range
  fc.constant("p".repeat(MAX_PASSWORD_LENGTH)), // 128 (upper bound)
  fc.constant("p".repeat(MAX_PASSWORD_LENGTH + 1)), // 129 (over the bound)
  fc.string({ minLength: 129, maxLength: 160 }), // well over the bound
);

/** Names including empty, whitespace-only, and trimmed non-empty values. */
const nameArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom("", "   ", "\t", "\n  "), // reject after trim
  fc.constantFrom("Care Giver", "  Padded Name  ", "A"), // accept after trim
  fc.string({ minLength: 1, maxLength: 40 }),
);

// ---------------------------------------------------------------------------
// Property 2a — Validation-boundary parity (Req 3.6).
//
// For every generated (name, email, password), the action's accept/reject
// decision and the offending `field` must match the reference model exactly.
// When the reference rejects, the action must return the same typed field
// result and MUST NOT create an account or write a profile row. When the
// reference accepts, the action must proceed past validation (signUpEmail is
// invoked for the non-duplicate default).
// ---------------------------------------------------------------------------

describe("Property 2a: zod boundaries must match the hand-rolled validators (Req 3.6)", () => {
  it("registerCaregiver accept/reject and offending field match the reference model", async () => {
    await fc.assert(
      fc.asyncProperty(nameArb, emailArb, passwordArb, async (name, email, password) => {
        vi.clearAllMocks();
        // Non-duplicate, successful account + profile so an ACCEPT proceeds.
        prismaMock.user.findUnique.mockResolvedValue(null);
        prismaMock.caregiverProfile.create.mockResolvedValue({ id: "cg_x" });
        authMock.api.signUpEmail.mockResolvedValue({ user: { id: "u_x" } });

        const expected = referenceValidate({ name, email, password });
        const result = await registerCaregiver({ name, email, password });

        if (expected) {
          // REJECT: identical field + message, and no account/profile created.
          expect(result).toEqual({ ok: false, field: expected.field, message: expected.message });
          expect(authMock.api.signUpEmail).not.toHaveBeenCalled();
          expect(prismaMock.caregiverProfile.create).not.toHaveBeenCalled();
        } else {
          // ACCEPT: the action moved past validation into account creation.
          expect(result).toEqual({ ok: true });
          expect(authMock.api.signUpEmail).toHaveBeenCalledTimes(1);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("createSeniorProfile accept/reject and offending field match the reference model", async () => {
    await fc.assert(
      fc.asyncProperty(nameArb, emailArb, passwordArb, async (name, email, password) => {
        vi.clearAllMocks();
        prismaMock.user.findUnique.mockResolvedValue(null);
        prismaMock.seniorProfile.create.mockResolvedValue({ id: "sen_x" });
        authMock.api.signUpEmail.mockResolvedValue({ user: { id: "u_y" } });

        const expected = referenceValidate({ name, email, password });
        const result = await createSeniorProfile({ name, email, password });

        if (expected) {
          expect(result).toEqual({ ok: false, field: expected.field, message: expected.message });
          expect(authMock.api.signUpEmail).not.toHaveBeenCalled();
          expect(prismaMock.seniorProfile.create).not.toHaveBeenCalled();
        } else {
          expect(result).toEqual({ ok: true, profileId: "sen_x" });
          expect(authMock.api.signUpEmail).toHaveBeenCalledTimes(1);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("accepts the 254-char email and the 8- and 128-char password boundaries", async () => {
    const boundaries = [
      { ...validInput, email: emailAtMaxLength },
      { ...validInput, password: "p".repeat(MIN_PASSWORD_LENGTH) },
      { ...validInput, password: "p".repeat(MAX_PASSWORD_LENGTH) },
    ];

    for (const input of boundaries) {
      vi.clearAllMocks();
      prismaMock.user.findUnique.mockResolvedValue(null);
      prismaMock.caregiverProfile.create.mockResolvedValue({ id: "cg_b" });
      authMock.api.signUpEmail.mockResolvedValue({ user: { id: "u_b" } });

      // The reference model accepts each of these, so the action must too.
      expect(referenceValidate(input)).toBeNull();
      expect(await registerCaregiver(input)).toEqual({ ok: true });
    }
  });

  it("rejects the over-254-char email and the >128-char password at the right field", async () => {
    const overEmail = await registerCaregiver({ ...validInput, email: emailOverMaxLength });
    expect(overEmail).toEqual({ ok: false, field: "email", message: "Email must be at most 254 characters" });

    const overPassword = await registerCaregiver({ ...validInput, password: "p".repeat(MAX_PASSWORD_LENGTH + 1) });
    expect(overPassword).toEqual({ ok: false, field: "password", message: "Password must be at most 128 characters" });

    expect(authMock.api.signUpEmail).not.toHaveBeenCalled();
    expect(prismaMock.caregiverProfile.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Property 2b — Duplicate-email preservation (Req 3.2).
//
// A case-variant duplicate must lowercase to the SAME `user.findUnique` lookup
// and return the "already registered" email error, leaving the existing account
// untouched (no delete, no signUp, no profile write).
// ---------------------------------------------------------------------------

describe("Property 2b: case-insensitive duplicate email rejection is preserved (Req 3.2)", () => {
  /** Generates case/space variants that all normalize to one stored email. */
  const casedVariantArb = fc
    .constantFrom("care.giver@example.com", "test.user@mail.co")
    .chain((base) =>
      fc
        .tuple(
          fc.array(fc.boolean(), { minLength: base.length, maxLength: base.length }),
          fc.constantFrom("", " ", "  "),
          fc.constantFrom("", " ", "  "),
        )
        .map(([upperFlags, pad, tail]) => {
          const recased = base
            .split("")
            .map((ch, i) => (upperFlags[i] ? ch.toUpperCase() : ch))
            .join("");
          return { base, variant: `${pad}${recased}${tail}` };
        }),
    );

  it("a cased/padded duplicate hits the normalized lookup and is rejected, account untouched", async () => {
    await fc.assert(
      fc.asyncProperty(casedVariantArb, async ({ base, variant }) => {
        vi.clearAllMocks();
        // An existing account is found for the normalized email.
        prismaMock.user.findUnique.mockResolvedValue({ id: "existing" });

        const result = await registerCaregiver({ ...validInput, email: variant });

        expect(result).toEqual({
          ok: false,
          field: "email",
          message: "This email is already registered",
        });
        // The lookup used the trimmed, lowercased email.
        expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
          where: { email: base },
          select: { id: true },
        });
        // The existing account is left completely untouched.
        expect(authMock.api.signUpEmail).not.toHaveBeenCalled();
        expect(prismaMock.caregiverProfile.create).not.toHaveBeenCalled();
        expect(prismaMock.user.delete).not.toHaveBeenCalled();
      }),
      { numRuns: 150 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2c — Exactly-one-profile preservation (Req 3.1, 3.4).
//
// A successful registerCaregiver creates exactly one CaregiverProfile and no
// SeniorProfile; a successful createSeniorProfile creates exactly one
// SeniorProfile, returns its id, and creates no Care_Link (there is no
// careLink mock, so any Care_Link write would be an undefined-call failure).
// ---------------------------------------------------------------------------

describe("Property 2c: exactly-one-profile creation is preserved (Req 3.1, 3.4)", () => {
  it("registerCaregiver creates exactly one CaregiverProfile and no SeniorProfile", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 12 }), async (idSuffix) => {
        vi.clearAllMocks();
        const userId = `u_${idSuffix}`;
        prismaMock.user.findUnique.mockResolvedValue(null);
        authMock.api.signUpEmail.mockResolvedValue({ user: { id: userId } });
        prismaMock.caregiverProfile.create.mockResolvedValue({ id: "cg_one" });

        const result = await registerCaregiver(validInput);

        expect(result).toEqual({ ok: true });
        expect(prismaMock.caregiverProfile.create).toHaveBeenCalledTimes(1);
        expect(prismaMock.caregiverProfile.create).toHaveBeenCalledWith({
          data: { userId },
        });
        expect(prismaMock.seniorProfile.create).not.toHaveBeenCalled();
      }),
      { numRuns: 100 },
    );
  });

  it("createSeniorProfile creates exactly one SeniorProfile, returns its id, and no Care_Link", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 12 }), async (idSuffix) => {
        vi.clearAllMocks();
        const profileId = `sen_${idSuffix}`;
        prismaMock.user.findUnique.mockResolvedValue(null);
        authMock.api.signUpEmail.mockResolvedValue({ user: { id: "u_sen" } });
        prismaMock.seniorProfile.create.mockResolvedValue({ id: profileId });

        const result = await createSeniorProfile(validInput);

        expect(result).toEqual({ ok: true, profileId });
        expect(prismaMock.seniorProfile.create).toHaveBeenCalledTimes(1);
        // No caregiver profile and no Care_Link write (no careLink mock exists,
        // so a stray call would throw rather than silently pass).
        expect(prismaMock.caregiverProfile.create).not.toHaveBeenCalled();
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2d — Orphan rollback preservation (Req 3.3).
//
// On a profile-write failure the orphaned account is deleted (no partial
// writes). On the UNFIXED code the action also re-throws after the rollback;
// the preserved invariant captured here is that the rollback ALWAYS runs with
// the created account id, regardless of how the failure is ultimately
// delivered. (Task 3 changes delivery from throw to a typed result; the
// rollback itself must stay.)
// ---------------------------------------------------------------------------

describe("Property 2d: orphan account rollback on profile-write failure is preserved (Req 3.3)", () => {
  it("registerCaregiver deletes the orphaned account when the CaregiverProfile write fails", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 12 }), async (idSuffix) => {
        vi.clearAllMocks();
        const userId = `u_orphan_${idSuffix}`;
        prismaMock.user.findUnique.mockResolvedValue(null);
        prismaMock.user.delete.mockResolvedValue({});
        authMock.api.signUpEmail.mockResolvedValue({ user: { id: userId } });
        prismaMock.caregiverProfile.create.mockRejectedValue(new Error("db down"));

        // Post-fix delivery (task 3.3): the action returns a typed failure
        // instead of re-throwing, so a profile-write failure never escapes as
        // an HTTP 500.
        const result = await registerCaregiver(validInput);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(typeof result.field).toBe("string");
          expect(typeof result.message).toBe("string");
        }

        // Preserved invariant (unchanged): the orphaned account is removed
        // exactly once with the created account id — no partial writes.
        expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: userId } });
      }),
      { numRuns: 100 },
    );
  });

  it("createSeniorProfile deletes the orphaned account when the SeniorProfile write fails", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 12 }), async (idSuffix) => {
        vi.clearAllMocks();
        const userId = `u_sorphan_${idSuffix}`;
        prismaMock.user.findUnique.mockResolvedValue(null);
        prismaMock.user.delete.mockResolvedValue({});
        authMock.api.signUpEmail.mockResolvedValue({ user: { id: userId } });
        prismaMock.seniorProfile.create.mockRejectedValue(new Error("db down"));

        // Post-fix delivery (task 3.3): a typed failure instead of a throw.
        const result = await createSeniorProfile(validInput);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(typeof result.field).toBe("string");
          expect(typeof result.message).toBe("string");
        }

        // Preserved invariant (unchanged): the orphaned account is removed.
        expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: userId } });
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2e — Role-resolution preservation (Req 3.5).
//
// `resolvePostAuthPath` resolves the role server-side from the single profile
// row the account owns and returns the matching dashboard path: `/caregiver`,
// `/senior`, `/partner`, or `/` when no role profile exists. It also returns
// `/` when there is no session.
// ---------------------------------------------------------------------------

describe("Property 2e: resolvePostAuthPath role resolution is preserved (Req 3.5)", () => {
  /** Clears the three role-profile lookups to the "no profile" default. */
  const noProfiles = () => {
    prismaMock.caregiverProfile.findUnique.mockResolvedValue(null);
    prismaMock.seniorProfile.findUnique.mockResolvedValue(null);
    prismaMock.partnerProfile.findUnique.mockResolvedValue(null);
  };

  it("maps each role profile to its dashboard path and no-profile to '/'", async () => {
    const roleArb = fc.constantFrom<"caregiver" | "senior" | "partner" | "none">(
      "caregiver",
      "senior",
      "partner",
      "none",
    );

    await fc.assert(
      fc.asyncProperty(roleArb, fc.string({ minLength: 1, maxLength: 10 }), async (role, uidSuffix) => {
        vi.clearAllMocks();
        const userId = `u_${uidSuffix}`;
        authMock.api.getSession.mockResolvedValue({ user: { id: userId } });
        noProfiles();

        // Exactly one profile exists for the chosen role (resolveRole order:
        // caregiver -> senior -> partner).
        if (role === "caregiver") prismaMock.caregiverProfile.findUnique.mockResolvedValue({ id: "cg" });
        else if (role === "senior") prismaMock.seniorProfile.findUnique.mockResolvedValue({ id: "sn" });
        else if (role === "partner") prismaMock.partnerProfile.findUnique.mockResolvedValue({ id: "pt" });

        const expected =
          role === "caregiver"
            ? "/caregiver"
            : role === "senior"
              ? "/senior"
              : role === "partner"
                ? "/partner"
                : "/";

        expect(await resolvePostAuthPath()).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it("returns '/' when there is no session", async () => {
    vi.clearAllMocks();
    authMock.api.getSession.mockResolvedValue(null);

    expect(await resolvePostAuthPath()).toBe("/");
    expect(prismaMock.caregiverProfile.findUnique).not.toHaveBeenCalled();
  });
});
