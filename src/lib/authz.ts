/**
 * Authorization scoping (`src/lib/authz.ts`).
 *
 * Resolves the effective role for an account and enforces the two scoping
 * relationships that confine a Senior's data to authorized viewers:
 *
 * - `assertCareLink` — a Caregiver may only read/write a Senior's data when an
 *   ACTIVE Care_Link exists between them (Req 2.4, 2.5, 7.4, 8.5, 9.4, 12.3,
 *   12.10).
 * - `assertPartnerMembership` — a Partner may only read/write billing for a
 *   Senior actively enrolled under them (Req 13.6).
 *
 * Role is derived from which single profile row an account owns (Req 1.6, 1.7);
 * a const map (not an enum) defines the role keys, per workspace rules.
 */

import { prisma } from "@/lib/prisma";
import { ROLES, type Role } from "@/lib/constants";

/**
 * The authenticated context passed through layouts and Server Actions.
 */
export interface AuthContext {
  readonly userId: string;
  readonly role: Role;
}

/**
 * The reasons an authorization check can fail, used to narrow error handling.
 */
export type AuthorizationReason =
  | "no_profile"
  | "not_caregiver"
  | "not_partner"
  | "care_link_absent"
  | "partner_membership_absent";

/**
 * Thrown when an account lacks the role or the active link/membership required
 * to access a Senior's data. Carries a typed `reason` so callers can map the
 * failure to the correct response without string matching.
 */
export class AuthorizationError extends Error {
  readonly reason: AuthorizationReason;

  constructor(reason: AuthorizationReason, message: string) {
    super(message);
    this.name = "AuthorizationError";
    this.reason = reason;
    // Restore the prototype chain when targeting ES5 transpilation.
    Object.setPrototypeOf(this, AuthorizationError.prototype);
  }
}

/**
 * Resolves the effective {@link Role} for an account by checking which profile
 * row exists. Exactly one profile is created per account, so at most one of the
 * three lookups matches. Returns `null` when the account has no profile yet.
 */
export const resolveRole = async (userId: string): Promise<Role | null> => {
  const [caregiver, senior, partner] = await Promise.all([
    prisma.caregiverProfile.findUnique({
      where: { userId },
      select: { id: true },
    }),
    prisma.seniorProfile.findUnique({
      where: { userId },
      select: { id: true },
    }),
    prisma.partnerProfile.findUnique({
      where: { userId },
      select: { id: true },
    }),
  ]);

  if (caregiver) return ROLES.caregiver;
  if (senior) return ROLES.senior;
  if (partner) return ROLES.partner;
  return null;
};

/**
 * Asserts that the Caregiver account identified by `caregiverUserId` holds an
 * ACTIVE Care_Link to the Senior identified by `seniorId` (a SeniorProfile id).
 *
 * Throws {@link AuthorizationError} when the account has no CaregiverProfile or
 * when no active link exists. Returns nothing (and leaks no data) otherwise.
 */
export const assertCareLink = async (
  caregiverUserId: string,
  seniorId: string,
): Promise<void> => {
  const caregiver = await prisma.caregiverProfile.findUnique({
    where: { userId: caregiverUserId },
    select: { id: true },
  });

  if (!caregiver) {
    throw new AuthorizationError(
      "not_caregiver",
      "Account is not a caregiver",
    );
  }

  const link = await prisma.careLink.findUnique({
    where: {
      caregiverId_seniorId: { caregiverId: caregiver.id, seniorId },
    },
    select: { active: true },
  });

  if (!link || !link.active) {
    throw new AuthorizationError(
      "care_link_absent",
      "No active care-link between caregiver and senior",
    );
  }
};

/**
 * Asserts that the Partner account identified by `partnerUserId` holds an
 * ACTIVE Partner_Membership to the Senior identified by `seniorId` (a
 * SeniorProfile id).
 *
 * Throws {@link AuthorizationError} when the account has no PartnerProfile or
 * when no active membership exists. Returns nothing (and leaks no data)
 * otherwise.
 */
export const assertPartnerMembership = async (
  partnerUserId: string,
  seniorId: string,
): Promise<void> => {
  const partner = await prisma.partnerProfile.findUnique({
    where: { userId: partnerUserId },
    select: { id: true },
  });

  if (!partner) {
    throw new AuthorizationError("not_partner", "Account is not a partner");
  }

  const membership = await prisma.partnerMembership.findUnique({
    where: { seniorId },
    select: { partnerId: true, active: true },
  });

  if (!membership || !membership.active || membership.partnerId !== partner.id) {
    throw new AuthorizationError(
      "partner_membership_absent",
      "No active partner membership between partner and senior",
    );
  }
};
