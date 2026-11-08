"use server";

/**
 * Protection_Number provisioning Server Actions.
 *
 * `provisionProtectionNumber` buys a SignalWire number, points its inbound
 * handler at the Mabel SWML endpoint, and records an active ProtectionNumber
 * for a Senior; `releaseProtectionNumber` tears it down. Both are confined to
 * Caregivers holding an active Care_Link to the Senior (Req 4 via
 * {@link assertCareLink}).
 *
 * Failure handling follows the acceptance criteria exactly:
 * - a second provisioning for a Senior that already has an active number is
 *   rejected with the existing number retained (Req 4.2);
 * - an empty or non-E.164 Personal_Number is rejected before any provider call
 *   (Req 4.3, 4.4);
 * - a SignalWire error during provisioning records `provisioningState =
 *   "failed"`, stores NO Personal_Number, and reports failure (Req 4.6);
 * - a SignalWire error during release keeps the number active and reports
 *   failure (Req 4.8).
 */

import { prisma } from "@/lib/prisma";
import { assertCareLink, AuthorizationError } from "@/lib/authz";
import { normalizeToE164, type DefaultRegion } from "@/lib/phone";
import {
  PROVISIONING_STATES,
  type ProvisioningState,
} from "@/lib/constants";
import {
  purchaseNumber,
  configureInboundHandler,
  releaseNumber,
  TelephonyError,
} from "@/lib/signalwire";

/**
 * Discriminated-union result returned by every provisioning action. Callers
 * narrow on `ok` to read either the success payload or the typed failure.
 */
export type ActionResult<T = undefined> =
  | ({ readonly ok: true } & (T extends undefined ? object : { readonly data: T }))
  | { readonly ok: false; readonly code: ActionErrorCode; readonly message: string };

/** The reasons a provisioning action can fail, for typed caller handling. */
export type ActionErrorCode =
  | "unauthorized"
  | "already_active"
  | "invalid_personal_number"
  | "not_provisioned"
  | "telephony_error";

/** Parameters for {@link provisionProtectionNumber}. */
export interface ProvisionProtectionNumberParams {
  /** The requesting Caregiver's `User.id`. */
  readonly caregiverUserId: string;
  /** The target `SeniorProfile.id`. */
  readonly seniorId: string;
  /** The Senior's existing phone number to forward connected calls to. */
  readonly personalNumber: string;
  /** Optional area code to buy a local number within; defaults when absent. */
  readonly areaCode?: string;
}

/** The provisioned ProtectionNumber summary returned on success. */
export interface ProvisionedProtectionNumber {
  readonly protectionNumberId: string;
  readonly e164Number: string;
  readonly provisioningState: ProvisioningState;
}

/** Parameters for {@link releaseProtectionNumber}. */
export interface ReleaseProtectionNumberParams {
  /** The requesting Caregiver's `User.id`. */
  readonly caregiverUserId: string;
  /** The target `SeniorProfile.id`. */
  readonly seniorId: string;
}

/** The default US area code used when a caller supplies none. */
const DEFAULT_AREA_CODE = "415";

const authFailure = (): Extract<ActionResult, { ok: false }> => ({
  ok: false,
  code: "unauthorized",
  message: "You are not linked to this senior.",
});

/**
 * Resolves the default region used to validate the Personal_Number, matching
 * the region applied to inbound caller numbers (`DEFAULT_PHONE_REGION`).
 */
const defaultRegion = (): DefaultRegion =>
  (process.env.DEFAULT_PHONE_REGION as DefaultRegion | undefined) ?? "US";

/**
 * Builds the SWML inbound-handler URL SignalWire POSTs to for each inbound
 * call: the app base URL + `/api/telephony/inbound`, carrying the shared-secret
 * token the route validates. The base URL is read from `APP_BASE_URL`, falling
 * back to `BETTER_AUTH_URL`.
 */
const inboundHandlerUrl = (): string => {
  const base = (process.env.APP_BASE_URL ?? process.env.BETTER_AUTH_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  const token = process.env.TELEPHONY_WEBHOOK_SECRET ?? "";
  const query = new URLSearchParams({ token });
  return `${base}/api/telephony/inbound?${query.toString()}`;
};

/**
 * Provisions a Protection_Number for a Senior and routes its inbound calls to
 * the Mabel SWML endpoint.
 *
 * Order of checks (each rejecting before any provider call so no partial state
 * is left behind): care-link authorization (Req 4 scoping), existing-active
 * rejection (Req 4.2), then Personal_Number E.164 validation (Req 4.3, 4.4).
 * Only then does it call SignalWire. A {@link TelephonyError} records a `failed`
 * ProtectionNumber with no Personal_Number and reports failure (Req 4.6); on
 * success it persists an `active` ProtectionNumber with the purchased number,
 * the Personal_Number, and the SignalWire resource id (Req 4.1, 4.5).
 */
export const provisionProtectionNumber = async (
  params: ProvisionProtectionNumberParams,
): Promise<ActionResult<ProvisionedProtectionNumber>> => {
  const { caregiverUserId, seniorId, personalNumber, areaCode } = params;

  try {
    await assertCareLink(caregiverUserId, seniorId);
  } catch (error) {
    if (error instanceof AuthorizationError) return authFailure();
    throw error;
  }

  const existing = await prisma.protectionNumber.findUnique({
    where: { seniorId },
    select: { provisioningState: true },
  });

  if (existing && existing.provisioningState === PROVISIONING_STATES.active) {
    return {
      ok: false,
      code: "already_active",
      message: "An active Protection Number already exists for this senior.",
    };
  }

  const normalized = normalizeToE164(personalNumber ?? "", defaultRegion());
  if (!normalized.ok) {
    return {
      ok: false,
      code: "invalid_personal_number",
      message: "The personal number must be a valid phone number.",
    };
  }
  const normalizedPersonalNumber = normalized.e164;

  try {
    const purchased = await purchaseNumber({
      areaCode: areaCode ?? DEFAULT_AREA_CODE,
    });
    await configureInboundHandler(purchased.signalwireId, inboundHandlerUrl());

    const record = await prisma.protectionNumber.upsert({
      where: { seniorId },
      create: {
        seniorId,
        e164Number: purchased.e164,
        personalNumber: normalizedPersonalNumber,
        signalwireId: purchased.signalwireId,
        provisioningState: PROVISIONING_STATES.active,
      },
      update: {
        e164Number: purchased.e164,
        personalNumber: normalizedPersonalNumber,
        signalwireId: purchased.signalwireId,
        provisioningState: PROVISIONING_STATES.active,
      },
      select: { id: true, e164Number: true, provisioningState: true },
    });

    return {
      ok: true,
      data: {
        protectionNumberId: record.id,
        e164Number: record.e164Number,
        provisioningState: record.provisioningState as ProvisioningState,
      },
    };
  } catch (error) {
    if (error instanceof TelephonyError) {
      // Record the failed attempt with NO Personal_Number stored (Req 4.6).
      await prisma.protectionNumber.upsert({
        where: { seniorId },
        create: {
          seniorId,
          e164Number: `failed:${seniorId}`,
          personalNumber: "",
          provisioningState: PROVISIONING_STATES.failed,
        },
        update: {
          personalNumber: "",
          signalwireId: null,
          provisioningState: PROVISIONING_STATES.failed,
        },
      });

      return {
        ok: false,
        code: "telephony_error",
        message: `Provisioning failed: ${error.message}`,
      };
    }
    throw error;
  }
};

/**
 * Releases a Senior's Protection_Number through SignalWire and deactivates
 * forwarding (Req 4.7).
 *
 * On a {@link TelephonyError} the number is left active and forwarding is
 * unchanged, and the failure is reported (Req 4.8). On success the SignalWire
 * number is released, the Senior's `forwardingActive` is cleared, and the
 * ProtectionNumber row is removed in a single transaction.
 */
export const releaseProtectionNumber = async (
  params: ReleaseProtectionNumberParams,
): Promise<ActionResult> => {
  const { caregiverUserId, seniorId } = params;

  try {
    await assertCareLink(caregiverUserId, seniorId);
  } catch (error) {
    if (error instanceof AuthorizationError) return authFailure();
    throw error;
  }

  const existing = await prisma.protectionNumber.findUnique({
    where: { seniorId },
    select: { id: true, signalwireId: true },
  });

  if (!existing) {
    return {
      ok: false,
      code: "not_provisioned",
      message: "This senior has no Protection Number to release.",
    };
  }

  try {
    if (existing.signalwireId) {
      await releaseNumber(existing.signalwireId);
    }
  } catch (error) {
    if (error instanceof TelephonyError) {
      // Keep the number active and forwarding unchanged (Req 4.8).
      return {
        ok: false,
        code: "telephony_error",
        message: `Release failed: ${error.message}`,
      };
    }
    throw error;
  }

  await prisma.$transaction([
    prisma.seniorProfile.update({
      where: { id: seniorId },
      data: { forwardingActive: false },
    }),
    prisma.protectionNumber.delete({ where: { id: existing.id } }),
  ]);

  return { ok: true };
};
