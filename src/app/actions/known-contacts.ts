"use server";

/**
 * Known_Contact allowlist server actions.
 *
 * A Caregiver manages the set of trusted Caller_Numbers that bypass screening
 * and connect straight through for a linked Senior (Req 5). Every mutation is
 * scoped by `assertCareLink` so a Caregiver can only touch a Senior they hold
 * an active Care_Link to (Req 2.4, 2.5, 9.4).
 *
 * - `addKnownContact` normalizes the submitted number to E.164 and rejects an
 *   invalid format (Req 5.1, 5.2, 11.1, 11.2); rejects a duplicate
 *   `(seniorId, e164Number)` leaving the existing contact unchanged (Req 5.3);
 *   and stores a display name of up to 100 characters (Req 5.6).
 * - `removeKnownContact` deletes a contact so future inbound calls from that
 *   number are no longer treated as known (Req 5.5).
 *
 * All validation happens before any write, so a rejected request never mutates
 * state and prior state is preserved on failure (Req 9.7).
 */

import { Prisma } from "@/generated/prisma/client";
import { assertCareLink, AuthorizationError } from "@/lib/authz";
import { normalizeToE164, type DefaultRegion } from "@/lib/phone";
import { prisma } from "@/lib/prisma";

/** Default region applied when a submitted number omits a country code (Req 11.2). */
const DEFAULT_REGION_FALLBACK: DefaultRegion = "US";

/** Maximum stored display-name length for a Known_Contact (Req 5.6). */
const MAX_DISPLAY_NAME_LENGTH = 100;

/** Prisma unique-constraint violation error code. */
const UNIQUE_CONSTRAINT_CODE = "P2002";

/** Fields a typed failure can point the UI at. */
export type KnownContactField = "number" | "displayName" | "contactId" | "authorization";

/**
 * Discriminated-union result returned by both actions. On success the UI
 * revalidates the list; on failure `field` and `message` drive field-level
 * form state without any state having been mutated.
 */
export interface ActionSuccess {
  readonly ok: true;
}

export interface ActionFailure {
  readonly ok: false;
  readonly field: KnownContactField;
  readonly message: string;
}

export type ActionResult = ActionSuccess | ActionFailure;

/** Input for {@link addKnownContact}. */
export interface AddKnownContactInput {
  readonly caregiverUserId: string;
  readonly seniorId: string;
  readonly number: string;
  readonly displayName?: string;
}

/** Input for {@link removeKnownContact}. */
export interface RemoveKnownContactInput {
  readonly caregiverUserId: string;
  readonly seniorId: string;
  readonly contactId: string;
}

/** Resolves the configured default region, falling back to `US` (Req 11.2). */
const resolveDefaultRegion = (): DefaultRegion =>
  (process.env.DEFAULT_PHONE_REGION as DefaultRegion) || DEFAULT_REGION_FALLBACK;

/**
 * Normalizes and validates an optional display name. Returns `null` for an
 * empty/whitespace-only value, or a failure when the trimmed value exceeds the
 * 100-character limit (Req 5.6). The caller treats `null` as "no display name".
 */
const validateDisplayName = (
  displayName: string | undefined,
):
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false } => {
  if (displayName === undefined) return { ok: true, value: null };

  const trimmed = displayName.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) return { ok: false };

  return { ok: true, value: trimmed };
};

/** True when a thrown error is a Prisma unique-constraint violation. */
const isUniqueConstraintError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === UNIQUE_CONSTRAINT_CODE;

/**
 * Adds a Known_Contact for a linked Senior.
 *
 * Enforces the Care_Link, normalizes the number to E.164 (rejecting an invalid
 * format), validates the display name, and rejects a duplicate
 * `(seniorId, e164Number)` without mutating the existing contact. On any
 * validation or authorization failure no row is written (Req 5.1-5.3, 5.6, 9.7).
 */
export const addKnownContact = async (
  input: AddKnownContactInput,
): Promise<ActionResult> => {
  const { caregiverUserId, seniorId, number, displayName } = input;

  try {
    await assertCareLink(caregiverUserId, seniorId);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return {
        ok: false,
        field: "authorization",
        message: "You are not linked to that senior.",
      };
    }
    throw error;
  }

  const normalized = normalizeToE164(number, resolveDefaultRegion());
  if (!normalized.ok) {
    return {
      ok: false,
      field: "number",
      message: "Enter a valid phone number.",
    };
  }

  const nameResult = validateDisplayName(displayName);
  if (!nameResult.ok) {
    return {
      ok: false,
      field: "displayName",
      message: `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`,
    };
  }

  // Pre-check the uniqueness of (seniorId, e164Number) so a duplicate is
  // rejected cleanly, leaving the existing contact untouched (Req 5.3).
  const existing = await prisma.knownContact.findUnique({
    where: {
      seniorId_e164Number: { seniorId, e164Number: normalized.e164 },
    },
    select: { id: true },
  });
  if (existing) {
    return {
      ok: false,
      field: "number",
      message: "That contact already exists.",
    };
  }

  try {
    await prisma.knownContact.create({
      data: {
        seniorId,
        e164Number: normalized.e164,
        displayName: nameResult.value,
      },
    });
  } catch (error) {
    // A concurrent insert can still race past the pre-check; the unique
    // constraint is the backstop and the existing contact stays unchanged.
    if (isUniqueConstraintError(error)) {
      return {
        ok: false,
        field: "number",
        message: "That contact already exists.",
      };
    }
    throw error;
  }

  return { ok: true };
};

/**
 * Removes a Known_Contact for a linked Senior so subsequent inbound calls from
 * that number are no longer treated as known (Req 5.5). Enforces the Care_Link
 * and scopes the delete to the given Senior so a Caregiver cannot remove
 * another Senior's contact. Prior state is preserved when nothing matches or on
 * failure (Req 9.7).
 */
export const removeKnownContact = async (
  input: RemoveKnownContactInput,
): Promise<ActionResult> => {
  const { caregiverUserId, seniorId, contactId } = input;

  try {
    await assertCareLink(caregiverUserId, seniorId);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return {
        ok: false,
        field: "authorization",
        message: "You are not linked to that senior.",
      };
    }
    throw error;
  }

  // Scope the delete to (id, seniorId) so a mismatched owner deletes nothing
  // and the prior state is preserved (Req 9.7).
  const { count } = await prisma.knownContact.deleteMany({
    where: { id: contactId, seniorId },
  });

  if (count === 0) {
    return {
      ok: false,
      field: "contactId",
      message: "That contact could not be found.",
    };
  }

  return { ok: true };
};
