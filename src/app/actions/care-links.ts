"use server";

/**
 * Care-link management server actions (Req 2.1, 2.2, 2.3, 2.6).
 *
 * This file owns the Caregiver↔Senior association layer that task 11.1
 * deliberately left out of `./auth`:
 *
 * - `createSeniorProfile` is the caregiver-initiated flow that both creates the
 *   Senior account (delegated to the auth action, imported here as
 *   `createSeniorAccount` to avoid a name clash) AND attaches an active
 *   Care_Link, enforcing the 1–50 active-link cap (Req 2.1, 2.2, 2.3).
 * - `removeCareLink` marks a Care_Link inactive to revoke the Caregiver's
 *   access to that Senior's protection settings (Req 2.6).
 *
 * The 1–50 cap and the link write run in the same `$transaction`, so an
 * over-cap request mutates nothing (Req 2.3): the transaction re-counts active
 * links at commit time and throws before the `CareLink` insert, rolling back.
 * The pre-count before Senior creation keeps an already-full Caregiver from
 * ever creating an orphan Senior account.
 */

import { createSeniorProfile as createSeniorAccount } from "@/app/actions/auth";
import { prisma } from "@/lib/prisma";

/** Maximum number of active Care_Links one Caregiver may hold (Req 2.2, 2.3). */
const MAX_ACTIVE_CARE_LINKS = 50;

/**
 * A typed result for care-link actions that return no payload. A failure names
 * the offending `field` (matching the convention of `./auth`'s `ActionResult`)
 * and guarantees no partial write occurred.
 */
export type ActionResult =
  | { ok: true }
  | { ok: false; field: string; message: string };

/**
 * The result of {@link createSeniorProfile}: the new SeniorProfile id on
 * success so the caller can chain provisioning/consent steps.
 */
export type CreateSeniorProfileResult =
  | { ok: true; seniorId: string }
  | { ok: false; field: string; message: string };

/** Input to the caregiver-initiated Senior creation + linking flow. */
export interface CreateSeniorProfileInput {
  readonly caregiverUserId: string;
  readonly email: string;
  readonly password: string;
  readonly name: string;
}

/** Input to {@link removeCareLink}. */
export interface RemoveCareLinkInput {
  readonly caregiverUserId: string;
  /** The SeniorProfile id whose Care_Link should be revoked. */
  readonly seniorId: string;
}

/**
 * Resolves the CaregiverProfile id for an account, or `null` when the account
 * holds no Caregiver role.
 */
const resolveCaregiverId = async (
  caregiverUserId: string,
): Promise<string | null> => {
  const caregiver = await prisma.caregiverProfile.findUnique({
    where: { userId: caregiverUserId },
    select: { id: true },
  });
  return caregiver?.id ?? null;
};

/**
 * Creates a Senior account on behalf of a Caregiver and links the two with an
 * active Care_Link (Req 2.1).
 *
 * The 1–50 active-link cap (Req 2.2, 2.3) is enforced twice for correctness and
 * to avoid orphaned accounts:
 *
 * 1. A pre-check counts the Caregiver's active links before any write; an
 *    already-full Caregiver is rejected before a Senior account is created, so
 *    an over-cap request never provisions an account.
 * 2. The Care_Link insert runs inside a `$transaction` that re-counts active
 *    links and throws before inserting when the count is at the cap, so a race
 *    that would push the Caregiver over 50 rolls back with no mutation.
 *
 * When the cap pre-check passes but the transactional link write still fails
 * the cap (the race path), the just-created Senior account is removed so no
 * partial state survives.
 */
export const createSeniorProfile = async (
  input: CreateSeniorProfileInput,
): Promise<CreateSeniorProfileResult> => {
  const caregiverId = await resolveCaregiverId(input.caregiverUserId);
  if (!caregiverId)
    return {
      ok: false,
      field: "caregiverUserId",
      message: "Account is not a caregiver",
    };

  // Pre-check the cap before creating any account so a full Caregiver never
  // produces an orphan Senior (Req 2.3: existing links retained, no mutation).
  const activeBefore = await prisma.careLink.count({
    where: { caregiverId, active: true },
  });
  if (activeBefore >= MAX_ACTIVE_CARE_LINKS)
    return {
      ok: false,
      field: "caregiverUserId",
      message: "Maximum linked seniors reached",
    };

  const account = await createSeniorAccount({
    email: input.email,
    password: input.password,
    name: input.name,
  });
  if (!account.ok) return account;

  const seniorId = account.profileId;

  try {
    await prisma.$transaction(async (tx) => {
      // Re-count inside the transaction so the cap check and the link insert
      // are atomic: an over-cap request throws here and rolls back the insert,
      // leaving the Caregiver's existing links unchanged (Req 2.3).
      const activeCount = await tx.careLink.count({
        where: { caregiverId, active: true },
      });
      if (activeCount >= MAX_ACTIVE_CARE_LINKS)
        throw new Error("CARE_LINK_CAP_EXCEEDED");

      await tx.careLink.create({
        data: { caregiverId, seniorId, active: true },
      });
    });
  } catch (error) {
    // The link write failed (cap race or DB error): remove the orphan Senior
    // account so the over-cap request mutates nothing observable (Req 2.3).
    // Deleting the User cascades to its SeniorProfile (onDelete: Cascade).
    try {
      const senior = await prisma.seniorProfile.findUnique({
        where: { id: seniorId },
        select: { userId: true },
      });
      if (senior)
        await prisma.user.delete({ where: { id: senior.userId } });
    } catch {
      // Best-effort rollback; swallow cleanup errors so the original cause
      // (cap exceeded or DB error) is the failure the caller observes.
    }

    if (error instanceof Error && error.message === "CARE_LINK_CAP_EXCEEDED")
      return {
        ok: false,
        field: "caregiverUserId",
        message: "Maximum linked seniors reached",
      };
    throw error;
  }

  return { ok: true, seniorId };
};

/**
 * Revokes a Caregiver's access to a Senior by marking their Care_Link inactive
 * (Req 2.6). Inactive links fail `assertCareLink`, so subsequent reads/writes
 * for that Senior are denied. Returns a typed failure when the account is not a
 * Caregiver or no link exists between the two.
 */
export const removeCareLink = async (
  input: RemoveCareLinkInput,
): Promise<ActionResult> => {
  const caregiverId = await resolveCaregiverId(input.caregiverUserId);
  if (!caregiverId)
    return {
      ok: false,
      field: "caregiverUserId",
      message: "Account is not a caregiver",
    };

  const link = await prisma.careLink.findUnique({
    where: {
      caregiverId_seniorId: { caregiverId, seniorId: input.seniorId },
    },
    select: { id: true },
  });

  if (!link)
    return {
      ok: false,
      field: "seniorId",
      message: "No care-link exists for this senior",
    };

  await prisma.careLink.update({
    where: { id: link.id },
    data: { active: false },
  });

  return { ok: true };
};
