/**
 * Pure risk-gating and forwarding-gate logic for call screening.
 *
 * This module is deliberately free of database/IO access so it can be reasoned
 * about and validated with property-based tests (design Correctness Properties
 * 4 and 5). All exports are arrow-function consts (workspace Next.js rules).
 */

import {
  CALL_DISPOSITIONS,
  RISK_CATEGORIES,
  SUBSCRIPTION_STATES,
  type CallDisposition,
  type RiskCategory,
} from "./constants";

/**
 * Lowest and highest permitted risk score (inclusive). A Risk_Assessment score
 * is an integer in this range (Req 6.2).
 */
export const RISK_SCORE_MIN = 0;
export const RISK_SCORE_MAX = 100;

/**
 * A Risk_Assessment produced by the Screening_Agent for an unknown caller.
 * `category` is one of {@link RISK_CATEGORIES}; `score` is an integer in the
 * inclusive range {@link RISK_SCORE_MIN}..{@link RISK_SCORE_MAX}.
 */
export interface RiskAssessment {
  category: RiskCategory;
  score: number;
}

/**
 * The minimal Senior state the forwarding gate depends on: whether a valid,
 * non-withdrawn Consent_Record exists and the current Subscription state. The
 * gate reads only these fields (no DB/IO).
 */
export interface SeniorForwardingState {
  /** A valid Consent_Record exists and has not been withdrawn. */
  hasValidConsent: boolean;
  /**
   * Current Subscription state as one of {@link SUBSCRIPTION_STATES}, or
   * `null`/`undefined` when the Senior has no Subscription at all.
   */
  subscriptionState: SubscriptionStateInput;
}

/** Subscription state the gate accepts, including the no-subscription case. */
export type SubscriptionStateInput =
  | (typeof SUBSCRIPTION_STATES)[keyof typeof SUBSCRIPTION_STATES]
  | null
  | undefined;

/**
 * Returns `true` when `score` is an integer within the inclusive
 * {@link RISK_SCORE_MIN}..{@link RISK_SCORE_MAX} range.
 */
export const isValidRiskScore = (score: number): boolean =>
  Number.isInteger(score) && score >= RISK_SCORE_MIN && score <= RISK_SCORE_MAX;

/**
 * Maps a Risk_Assessment category to a call disposition: `connected` for Known
 * or Allowed callers, `declined` for Spam or Fraud (Req 6.2, 6.4, 6.5).
 *
 * The risk score is constrained to an integer in 0..100; a score outside that
 * range (or non-integer) is a programming error and throws, so callers never
 * silently act on a malformed Risk_Assessment.
 */
export const dispositionForRisk = (riskAssessment: RiskAssessment): CallDisposition => {
  if (!isValidRiskScore(riskAssessment.score)) {
    throw new RangeError(
      `Risk score must be an integer in ${RISK_SCORE_MIN}..${RISK_SCORE_MAX}, received ${riskAssessment.score}`,
    );
  }

  switch (riskAssessment.category) {
    case RISK_CATEGORIES.known:
    case RISK_CATEGORIES.allowed:
      return CALL_DISPOSITIONS.connected;
    case RISK_CATEGORIES.spam:
    case RISK_CATEGORIES.fraud:
      return CALL_DISPOSITIONS.declined;
    default: {
      // Exhaustiveness guard: a new RiskCategory must be handled explicitly.
      const unreachable: never = riskAssessment.category;
      throw new RangeError(`Unhandled risk category: ${String(unreachable)}`);
    }
  }
};

/**
 * The forwarding gate: forwarding is active if and only if a valid,
 * non-withdrawn Consent_Record exists AND an active Subscription exists that is
 * not past-due, canceled, or incomplete (Req 3.3, 6.3, 12.5, 12.6, 12.7).
 *
 * Every connect decision and reconciliation path routes through this single
 * predicate so the invariant holds in one place.
 */
export const isForwardingActive = (seniorState: SeniorForwardingState): boolean =>
  seniorState.hasValidConsent &&
  seniorState.subscriptionState === SUBSCRIPTION_STATES.active;
