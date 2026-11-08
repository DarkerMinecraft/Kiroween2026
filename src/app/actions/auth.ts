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

import { APIError } from "better-auth/api";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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
 * Validates the email against the RFC 5322 shape and the 254-char bound.
 * Returns the lowercased, trimmed email on success, or a typed failure.
 */
const validateEmail = (
  email: string,
): { ok: true; normalized: string } | { ok: false; message: string } => {
  const normalized = email.trim().toLowerCase();

  if (normalized.length === 0)
    return { ok: false, message: "Email is required" };
  if (normalized.length > MAX_EMAIL_LENGTH)
    return { ok: false, message: "Email must be at most 254 characters" };
  if (!EMAIL_PATTERN.test(normalized))
    return { ok: false, message: "Email is not a valid address" };

  return { ok: true, normalized };
};

/** Validates the password length bound (8–128), returning a typed failure. */
const validatePassword = (
  password: string,
): { ok: true } | { ok: false; message: string } => {
  if (password.length < MIN_PASSWORD_LENGTH)
    return { ok: false, message: "Password must be at least 8 characters" };
  if (password.length > MAX_PASSWORD_LENGTH)
    return { ok: false, message: "Password must be at most 128 characters" };

  return { ok: true };
};

/**
 * Checks whether an account already exists for `normalizedEmail`. Emails are
 * stored lowercased and `User.email` is unique, so the lookup is a
 * case-insensitive duplicate check (Req 1.5).
 */
const emailAlreadyRegistered = async (
  normalizedEmail: string,
): Promise<boolean> => {
  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });
  return existing !== null;
};

/**
 * Creates the Better Auth account for a validated, non-duplicate registration.
 * Returns the new user id, or a typed failure when Better Auth rejects the
 * sign-up (e.g. a duplicate it detects itself). No profile row is created here.
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
    if (error instanceof APIError)
      return {
        ok: false,
        message: error.message || "Unable to create the account",
      };
    throw error;
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
  const name = input.name.trim();
  if (name.length === 0)
    return { ok: false, field: "name", message: "Name is required" };

  const email = validateEmail(input.email);
  if (!email.ok) return { ok: false, field: "email", message: email.message };

  const password = validatePassword(input.password);
  if (!password.ok)
    return { ok: false, field: "password", message: password.message };

  if (await emailAlreadyRegistered(email.normalized))
    return {
      ok: false,
      field: "email",
      message: "This email is already registered",
    };

  const account = await createAccount(name, email.normalized, input.password);
  if (!account.ok)
    return { ok: false, field: "email", message: account.message };

  try {
    await prisma.caregiverProfile.create({
      data: { userId: account.userId },
    });
  } catch (error) {
    // Roll back the orphaned account so no User is left without a role row.
    await prisma.user.delete({ where: { id: account.userId } }).catch(() => {});
    throw error;
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
  const name = input.name.trim();
  if (name.length === 0)
    return { ok: false, field: "name", message: "Name is required" };

  const email = validateEmail(input.email);
  if (!email.ok) return { ok: false, field: "email", message: email.message };

  const password = validatePassword(input.password);
  if (!password.ok)
    return { ok: false, field: "password", message: password.message };

  if (await emailAlreadyRegistered(email.normalized))
    return {
      ok: false,
      field: "email",
      message: "This email is already registered",
    };

  const account = await createAccount(name, email.normalized, input.password);
  if (!account.ok)
    return { ok: false, field: "email", message: account.message };

  try {
    const profile = await prisma.seniorProfile.create({
      data: { userId: account.userId },
      select: { id: true },
    });
    return { ok: true, profileId: profile.id };
  } catch (error) {
    // Roll back the orphaned account so no User is left without a role row.
    await prisma.user.delete({ where: { id: account.userId } }).catch(() => {});
    throw error;
  }
};
