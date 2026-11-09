"use server";

/**
 * Registration and role-setup server actions.
 *
 * `registerCaregiver` handles the public caregiver registration flow; a
 * successful call creates a Better Auth account plus exactly one
 * `CaregiverProfile` (Req 1.1, 1.3). `createSeniorProfile` handles the
 * Caregiver-initiated creation of a Senior account plus exactly one
 * `SeniorProfile` (Req 1.4, 2.1).
 *
 * Validation (email RFC 5322 / ≤254 chars, password 8–128, case-insensitive
 * duplicate email) runs before any write, so a validation failure produces a
 * typed `{ ok: false, field, message }` with no partial writes (Req 1.2, 1.5).
 * When Better Auth creates the account but profile creation then fails, the
 * orphaned `User` is removed so no account is left without its role row.
 *
 * NOTE: the Caregiver↔Senior Care_Link (and its 1–50 cap) is intentionally NOT
 * created here — that is task 11.2. `createSeniorProfile` returns the new
 * Senior's id so the linking action can attach a Care_Link in a follow-up step.
 */

import { headers } from "next/headers";
import { z } from "zod";
import { APIError } from "better-auth/api";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveRole } from "@/lib/authz";
import { ROLES } from "@/lib/constants";

/** Maximum length of an email address per RFC 5321/5322. */
const MAX_EMAIL_LENGTH = 254;
/** Minimum password length accepted at registration (Req 1.1, 1.2). */
const MIN_PASSWORD_LENGTH = 8;
/** Maximum password length accepted at registration (Req 1.1, 1.2). */
const MAX_PASSWORD_LENGTH = 128;

/**
 * Pragmatic RFC 5322 email matcher: a single `@`, a dot-separated local part of
 * unquoted atoms, and a dotted domain with a 2+ char TLD. Paired with the
 * `MAX_EMAIL_LENGTH` bound it rejects the malformed shapes the registration
 * flow must turn away (Req 1.2) without pulling in a full grammar.
 */
const EMAIL_PATTERN =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

/**
 * The result returned by every registration/role-setup action. A failure names
 * the offending `field` so the UI can surface a field-level message, and
 * guarantees no partial write occurred.
 */
export type ActionResult =
  | { ok: true }
  | { ok: false; field: string; message: string };

/** A success carrying the created profile id, for actions that chain further. */
interface ProfileCreated {
  readonly ok: true;
  readonly profileId: string;
}

/** The result of `createSeniorProfile`: the new SeniorProfile id on success. */
export type SeniorProfileResult =
  | ProfileCreated
  | { ok: false; field: string; message: string };

/** Input to the public caregiver registration flow. */
export interface RegisterCaregiverInput {
  readonly email: string;
  readonly password: string;
  readonly name: string;
}

/** Input to Caregiver-initiated Senior account creation. */
export interface CreateSeniorProfileInput {
  readonly email: string;
  readonly password: string;
  readonly name: string;
}

/**
 * The validated, normalized registration input produced by {@link inputSchema}.
 * `email` is already trimmed + lowercased and `name` is already trimmed, so the
 * downstream duplicate lookup, account creation, and profile write all consume
 * the normalized values.
 */
interface ValidatedInput {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

/**
 * Name field: trimmed, then required to be non-empty. The transform runs before
 * the `min(1)` check so a whitespace-only name rejects with "Name is required".
 */
const nameSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1, { message: "Name is required" }));

/**
 * Email field, reproducing the hand-rolled validator's order exactly: trim +
 * lowercase first, then the non-empty / ≤254 / RFC 5322 shape checks run on the
 * NORMALIZED value. The normalized email is what the schema yields, so the
 * downstream case-insensitive duplicate lookup and account creation use it.
 *
 * `z.string` short-circuits on the first failing check, so the messages surface
 * in the same precedence the inline validator used (required → too long → bad
 * shape).
 */
const emailSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(
    z
      .string()
      .min(1, { message: "Email is required" })
      .max(MAX_EMAIL_LENGTH, {
        message: "Email must be at most 254 characters",
      })
      .regex(EMAIL_PATTERN, { message: "Email is not a valid address" }),
  );

/**
 * Password field: the 8–128 length bound, checked against the raw value (never
 * trimmed, so leading/trailing characters count toward the length exactly as
 * before). `min` is listed first so a short password reports the floor message.
 */
const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, {
    message: "Password must be at least 8 characters",
  })
  .max(MAX_PASSWORD_LENGTH, {
    message: "Password must be at most 128 characters",
  });

/**
 * The combined registration input schema. Each field keeps its own message
 * strings; field-first ordering (name → email → password) is applied by
 * {@link validateInput} rather than relying on zod's issue collection order.
 */
const inputSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
});

/** The field-first precedence the UI and preservation tests depend on. */
const FIELD_ORDER = ["name", "email", "password"] as const;

/**
 * Validates and normalizes a registration input via {@link inputSchema},
 * reproducing the hand-rolled validators' outcome exactly: on failure it
 * returns the single highest-precedence offending field (name → email →
 * password) with the original message string; on success it returns the
 * normalized (trimmed name, trimmed + lowercased email) values so no account or
 * profile is created from un-normalized input.
 */
const validateInput = (
  input: ValidatedInput,
):
  | { ok: true; value: ValidatedInput }
  | { ok: false; field: string; message: string } => {
  const parsed = inputSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };

  const issues = parsed.error.issues;
  // Pick the first offending field in the fixed name → email → password order,
  // so the surfaced field/message never depends on zod's internal issue order.
  for (const field of FIELD_ORDER) {
    const issue = issues.find((candidate) => candidate.path[0] === field);
    if (issue) return { ok: false, field, message: issue.message };
  }

  // Unreachable: an invalid parse always carries at least one field issue.
  const [first] = issues;
  return {
    ok: false,
    field: String(first?.path[0] ?? "name"),
    message: first?.message ?? "Invalid input",
  };
};

/**
 * A generic, user-safe message for infrastructure/internal failures. It carries
 * no exception internals and never echoes the submitted credentials, so it is
 * safe to surface directly to the user (Req 2.4).
 */
const GENERIC_FAILURE_MESSAGE = "Something went wrong. Please try again.";

/**
 * Checks whether an account already exists for `normalizedEmail`. Emails are
 * stored lowercased and `User.email` is unique, so the lookup is a
 * case-insensitive duplicate check (Req 1.5).
 *
 * The Prisma lookup is wrapped: a DB/adapter failure (cold Neon endpoint,
 * connection exhaustion) is converted to a typed failure instead of escaping
 * `"use server"` as an HTTP 500 (Req 2.1, 2.3). The actual-duplicate case is
 * reported unchanged so the caller surfaces the same "already registered"
 * email error. Success distinguishes "found" from "not found" via `exists`.
 */
const emailAlreadyRegistered = async (
  normalizedEmail: string,
): Promise<
  | { ok: true; exists: boolean }
  | { ok: false; field: string; message: string }
> => {
  try {
    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });
    return { ok: true, exists: existing !== null };
  } catch {
    return { ok: false, field: "form", message: GENERIC_FAILURE_MESSAGE };
  }
};

/**
 * Creates the Better Auth account for a validated, non-duplicate registration.
 * Returns the new user id, or a typed failure when account creation fails.
 *
 * An `APIError` (e.g. a duplicate Better Auth detects itself) surfaces its own
 * user-facing message. Any other error — a Better Auth internal error, a
 * Prisma/Neon adapter failure during the write — is converted to a generic,
 * user-safe message instead of being re-thrown, so a non-`APIError` can never
 * escape `"use server"` and become an opaque HTTP 500 (Req 2.1, 2.3). No raw
 * exception internals and no password ever reach the returned message (Req 2.4).
 */
const createAccount = async (
  name: string,
  email: string,
  password: string,
): Promise<{ ok: true; userId: string } | { ok: false; message: string }> => {
  try {
    const result = await auth.api.signUpEmail({
      body: { name, email, password },
    });
    return { ok: true, userId: result.user.id };
  } catch (error) {
    // `APIError` carries Better Auth's own user-facing status text (e.g. a
    // duplicate-email message), so it is safe to surface. Everything else — a
    // Better Auth internal error, a Prisma/Neon adapter failure — is collapsed
    // to the generic message so no exception internals escape (Req 2.1, 2.3).
    //
    // Defense in depth for Req 2.4: the raw password is only ever passed to
    // `signUpEmail` and must never reappear on the error surface. On the off
    // chance a surfaced `APIError.message` were to echo the submitted password,
    // fall back to the generic message rather than leaking it.
    if (error instanceof APIError) {
      const surfaced = error.message || "Unable to create the account";
      if (surfaced.includes(password))
        return { ok: false, message: GENERIC_FAILURE_MESSAGE };
      return { ok: false, message: surfaced };
    }
    return { ok: false, message: GENERIC_FAILURE_MESSAGE };
  }
};

/**
 * Registers a new Caregiver: validates the submitted details, rejects a
 * duplicate email case-insensitively, delegates account creation to Better
 * Auth, then creates exactly one `CaregiverProfile` for the new account.
 *
 * On any validation failure no account is created. If account creation
 * succeeds but the profile write fails, the orphaned account is removed so no
 * account is left without its role row (no partial writes).
 */
export const registerCaregiver = async (
  input: RegisterCaregiverInput,
): Promise<ActionResult> => {
  const validated = validateInput(input);
  if (!validated.ok)
    return { ok: false, field: validated.field, message: validated.message };
  const { name, email, password } = validated.value;

  const duplicate = await emailAlreadyRegistered(email);
  if (!duplicate.ok)
    return { ok: false, field: duplicate.field, message: duplicate.message };
  if (duplicate.exists)
    return {
      ok: false,
      field: "email",
      message: "This email is already registered",
    };

  const account = await createAccount(name, email, password);
  if (!account.ok)
    return { ok: false, field: "email", message: account.message };

  try {
    await prisma.caregiverProfile.create({
      data: { userId: account.userId },
    });
  } catch {
    // Roll back the orphaned account so no User is left without a role row,
    // then report a typed failure instead of re-throwing — a profile-write
    // failure must not escape "use server" as an HTTP 500 (Req 2.3, 3.3). The
    // rollback is retained exactly: no partial writes remain.
    await prisma.user.delete({ where: { id: account.userId } }).catch(() => {});
    return { ok: false, field: "form", message: GENERIC_FAILURE_MESSAGE };
  }

  return { ok: true };
};

/**
 * Creates a Senior account during Caregiver-initiated setup: the same
 * validation and duplicate-email rules as caregiver registration, then exactly
 * one `SeniorProfile` for the new account (Req 1.4).
 *
 * This action deliberately stops at the Senior profile. The active Care_Link
 * between the initiating Caregiver and this Senior — and the 1–50 active-link
 * cap — are handled by the care-link management action (task 11.2), which can
 * use the returned `profileId`. On profile-write failure the orphaned account
 * is removed so no partial writes remain.
 */
export const createSeniorProfile = async (
  input: CreateSeniorProfileInput,
): Promise<SeniorProfileResult> => {
  const validated = validateInput(input);
  if (!validated.ok)
    return { ok: false, field: validated.field, message: validated.message };
  const { name, email, password } = validated.value;

  const duplicate = await emailAlreadyRegistered(email);
  if (!duplicate.ok)
    return { ok: false, field: duplicate.field, message: duplicate.message };
  if (duplicate.exists)
    return {
      ok: false,
      field: "email",
      message: "This email is already registered",
    };

  const account = await createAccount(name, email, password);
  if (!account.ok)
    return { ok: false, field: "email", message: account.message };

  try {
    const profile = await prisma.seniorProfile.create({
      data: { userId: account.userId },
      select: { id: true },
    });
    return { ok: true, profileId: profile.id };
  } catch {
    // Roll back the orphaned account so no User is left without a role row,
    // then report a typed failure instead of re-throwing — a profile-write
    // failure must not escape "use server" as an HTTP 500 (Req 2.3, 3.3). The
    // rollback is retained exactly: no partial writes remain.
    await prisma.user.delete({ where: { id: account.userId } }).catch(() => {});
    return { ok: false, field: "form", message: GENERIC_FAILURE_MESSAGE };
  }
};

/** The dashboard path each role lands on after authenticating. */
const ROLE_DASHBOARD_PATH: Record<string, string> = {
  [ROLES.caregiver]: "/caregiver",
  [ROLES.senior]: "/senior",
  [ROLES.partner]: "/partner",
};

/** Fallback path when the signed-in account has no role profile yet. */
const NO_ROLE_PATH = "/";

/**
 * Resolves where the currently signed-in account should land after
 * authenticating, based on its effective role.
 *
 * The three dashboards each gate on role server-side (e.g. the Caregiver
 * dashboard redirects any non-Caregiver back to `/`), so the sign-in UI can't
 * send every account to `/caregiver`; a Senior or Partner would just bounce
 * back to the home page. This action reads the Better Auth session on the
 * server, resolves the role from the single profile row the account owns, and
 * returns the matching dashboard path — or `/` when the account has no profile
 * yet (so there is nothing to bounce into).
 *
 * Returns a plain path string so the client can `router.push` to it without
 * any role logic leaking into the browser.
 */
export const resolvePostAuthPath = async (): Promise<string> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NO_ROLE_PATH;

  const role = await resolveRole(session.user.id);
  if (!role) return NO_ROLE_PATH;

  return ROLE_DASHBOARD_PATH[role] ?? NO_ROLE_PATH;
};
