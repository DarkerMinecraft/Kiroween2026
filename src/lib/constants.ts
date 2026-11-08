/**
 * Application-level const value maps.
 *
 * Role and status values are persisted as plain `String` columns and
 * constrained in application code by these maps rather than Prisma/TS enums
 * (workspace rule: avoid enums). Each map is paired with a derived union type
 * so values flowing through the app stay narrowed to the allowed literals.
 */

/** User roles. One profile row per account determines the effective role. */
export const ROLES = {
  caregiver: "caregiver",
  senior: "senior",
  partner: "partner",
} as const;

/** Risk categories produced by call screening. */
export const RISK_CATEGORIES = {
  known: "Known",
  allowed: "Allowed",
  spam: "Spam",
  fraud: "Fraud",
} as const;

/** Final disposition recorded for a call. */
export const CALL_DISPOSITIONS = {
  connected: "connected",
  declined: "declined",
  notForwarded: "not_forwarded",
  unscreened: "unscreened",
  recordingFailure: "recording_failure",
} as const;

/** Lifecycle states of a Protection_Number provisioning request. */
export const PROVISIONING_STATES = {
  none: "none",
  provisioning: "provisioning",
  active: "active",
  releasing: "releasing",
  failed: "failed",
} as const;

/** Subscription states mapped from the billing provider's status. */
export const SUBSCRIPTION_STATES = {
  active: "active",
  pastDue: "past_due",
  canceled: "canceled",
  incomplete: "incomplete",
} as const;

/** Whether inbound calls are forwarded for a Senior. */
export const FORWARDING_STATES = {
  active: "active",
  inactive: "inactive",
} as const;

/** One of the {@link ROLES} values. */
export type Role = (typeof ROLES)[keyof typeof ROLES];
/** One of the {@link RISK_CATEGORIES} values. */
export type RiskCategory = (typeof RISK_CATEGORIES)[keyof typeof RISK_CATEGORIES];
/** One of the {@link CALL_DISPOSITIONS} values. */
export type CallDisposition = (typeof CALL_DISPOSITIONS)[keyof typeof CALL_DISPOSITIONS];
/** One of the {@link PROVISIONING_STATES} values. */
export type ProvisioningState = (typeof PROVISIONING_STATES)[keyof typeof PROVISIONING_STATES];
/** One of the {@link SUBSCRIPTION_STATES} values. */
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[keyof typeof SUBSCRIPTION_STATES];
/** One of the {@link FORWARDING_STATES} values. */
export type ForwardingState = (typeof FORWARDING_STATES)[keyof typeof FORWARDING_STATES];
