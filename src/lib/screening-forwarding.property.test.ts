import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { isForwardingActive, type SubscriptionStateInput } from "@/lib/screening";
import { SUBSCRIPTION_STATES } from "@/lib/constants";

// Feature: senior-call-shield, Property 5: Forwarding is active if and only if
// a valid, non-withdrawn Consent_Record exists AND an active Subscription
// holds. For every combination of consent presence and subscription state
// (including no-subscription), `isForwardingActive` returns `true` exactly when
// `hasValidConsent` is true and `subscriptionState` is the active state, and
// `false` in every other case (design Property 5).
//
// Validates: Requirements 3.3, 6.3, 12.5, 12.6, 12.7

// The full space of subscription states the gate accepts: every SUBSCRIPTION_STATES
// value plus the two no-subscription sentinels (null and undefined).
const subscriptionStateValues: readonly SubscriptionStateInput[] = [
  SUBSCRIPTION_STATES.active,
  SUBSCRIPTION_STATES.pastDue,
  SUBSCRIPTION_STATES.canceled,
  SUBSCRIPTION_STATES.incomplete,
  null,
  undefined,
];

describe("Property 5: forwarding is active iff consent and an active subscription both hold", () => {
  it("returns true exactly when consent holds and the subscription is active", () => {
    const hasValidConsentArb = fc.boolean();
    const subscriptionStateArb = fc.constantFrom(...subscriptionStateValues);

    fc.assert(
      fc.property(hasValidConsentArb, subscriptionStateArb, (hasValidConsent, subscriptionState) => {
        const expected =
          hasValidConsent && subscriptionState === SUBSCRIPTION_STATES.active;

        expect(isForwardingActive({ hasValidConsent, subscriptionState })).toBe(expected);
      }),
      { numRuns: 500 },
    );
  });

  it("covers every consent/subscription-state combination at least once", () => {
    // Exhaustive enumeration of the finite input space (2 consent values x 6
    // subscription states = 12 combinations) as a direct companion to the
    // randomized property above.
    for (const hasValidConsent of [true, false]) {
      for (const subscriptionState of subscriptionStateValues) {
        const expected =
          hasValidConsent && subscriptionState === SUBSCRIPTION_STATES.active;
        expect(isForwardingActive({ hasValidConsent, subscriptionState })).toBe(expected);
      }
    }
  });
});
