# Implementation Plan: Senior Call Shield (Mabel)

## Overview

This plan implements Senior Call Shield on the existing stack (Next.js 16 App Router, React 19 RSC, TypeScript, Better Auth, Prisma 7/PostgreSQL, shadcn/ui + Radix + Tailwind v4), with SignalWire for telephony and Stripe for billing.

Tasks are ordered to validate core logic early: the Prisma schema and migration come first, then the pure `src/lib` decision logic (phone normalization, risk/forwarding gate) with its property-based tests, then the external-client wrappers (SignalWire, Stripe), then the route handlers, server actions, dashboards, and finally the retention job. Each pure-logic module is tested with `fast-check` + `vitest` property tests (minimum 100 generated cases each) tied to the design's Correctness Properties 1-9, and integration edges use mock-based tests.

Follow the workspace Next.js rules throughout: arrow-function consts with named exports (default export only for App Router file conventions), interfaces over types, const maps instead of enums, RSC-first with minimal `use client`.

## Tasks

- [x] 1. Set up data model, const maps, and test tooling
  - [x] 1.1 Add application models to the Prisma schema and run the migration
    - Add `CaregiverProfile`, `SeniorProfile`, `PartnerProfile`, `CareLink`, `ProtectionNumber`, `KnownContact`, `ConsentRecord`, `CallRecord`, `CallReport`, `BillingAccount`, `Subscription`, `PartnerMembership`, `ProcessedWebhookEvent`, and `RetentionConfig` to `prisma/schema.prisma` exactly as specified in the design Data Models section (string cuid ids, `@@map` names, unique/index constraints)
    - Add the three profile back-relations (`CaregiverProfile?`, `SeniorProfile?`, `PartnerProfile?`) to the existing `User` model; leave the other Better Auth tables unchanged
    - Create and apply the Prisma migration and regenerate the client into `src/generated/prisma`
    - _Requirements: 1.3, 1.4, 2.2, 3.2, 4.3, 5.6, 7.1, 7.7, 12.12, 13.2, 14.5_

  - [x] 1.2 Create the application-level const value maps
    - Create `src/lib/constants.ts` exporting `ROLES`, `RISK_CATEGORIES`, `CALL_DISPOSITIONS`, `PROVISIONING_STATES`, `SUBSCRIPTION_STATES`, and `FORWARDING_STATES` as `as const` maps (no Prisma/TS enums), plus derived union types for each
    - _Requirements: 6.2, 9.8, 10.5, 12.12_

  - [x] 1.3 Install and configure the test framework
    - Add `vitest`, `fast-check`, and `libphonenumber-js` as dependencies and add a `vitest` config plus a `test` script using `--run` (single execution, not watch mode)
    - Add a trivial passing smoke test to confirm the runner works
    - _Requirements: 11.1_

- [x] 2. Implement pure phone-number normalization and matching
  - [x] 2.1 Implement E.164 normalization and matching in `src/lib/phone.ts`
    - Write pure arrow-function consts: `normalizeToE164(input, defaultRegion)` returning a success/failure result, and `matchesKnownContact(callerE164, contactE164)` doing exact character-for-character comparison on normalized forms
    - Apply the configured default region when the input omits a country code; reject empty input, disallowed characters, and values that do not resolve to a valid 1-15 digit E.164 number
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

  - [x] 2.2 Write property test for E.164 normalization idempotence
    - **Property 1: E.164 normalization is idempotent**
    - **Validates: Requirements 11.5, 11.1**
    - Tag: `// Feature: senior-call-shield, Property 1: ...`; generate valid numbers, normalize twice, assert character-for-character equality; minimum 100 cases

  - [x] 2.3 Write property test for exact known-contact matching
    - **Property 2: Known-contact matching is exact on normalized forms**
    - **Validates: Requirements 11.3, 5.4**
    - Tag: `// Feature: senior-call-shield, Property 2: ...`; generate contact/caller pairs and assert match iff normalized strings are identical; minimum 100 cases

  - [x] 2.4 Write property test for invalid-number fall-through
    - **Property 3: Invalid caller numbers fall through to Unknown without mutation**
    - **Validates: Requirements 11.4**
    - Tag: `// Feature: senior-call-shield, Property 3: ...`; generate empty/malformed/out-of-range inputs and assert Unknown classification, normalization-failure flag, and unmodified original value; minimum 100 cases

- [x] 3. Implement pure risk gating and forwarding-gate logic
  - [x] 3.1 Implement risk-to-disposition mapping and the forwarding gate in `src/lib/screening.ts`
    - Write pure arrow-function consts: `dispositionForRisk(riskAssessment)` returning `connected` for Known/Allowed and `declined` for Spam/Fraud (score constrained to integer 0-100), and `isForwardingActive(seniorState)` returning active iff a valid non-withdrawn consent exists AND an active subscription exists that is not past-due or canceled
    - _Requirements: 3.3, 6.2, 6.3, 6.4, 6.5, 12.5, 12.6, 12.7_

  - [x] 3.2 Write property test for risk-category disposition mapping
    - **Property 4: Risk category determines connect-vs-decline disposition**
    - **Validates: Requirements 6.2, 6.4, 6.5**
    - Tag: `// Feature: senior-call-shield, Property 4: ...`; generate arbitrary Risk_Assessments and assert disposition and the 0-100 integer score bound; minimum 100 cases

  - [x] 3.3 Write property test for the forwarding gate
    - **Property 5: Forwarding is active if and only if consent and an active subscription both hold**
    - **Validates: Requirements 3.3, 6.3, 12.5, 12.6, 12.7**
    - Tag: `// Feature: senior-call-shield, Property 5: ...`; generate all consent/subscription-state combinations and assert the active-iff condition; minimum 100 cases

- [x] 4. Implement authorization scoping
  - [x] 4.1 Implement role resolution and scoping checks in `src/lib/authz.ts`
    - Write `resolveRole(userId)` (returns a `ROLES` value by checking which profile row exists), `assertCareLink(caregiverUserId, seniorId)`, and `assertPartnerMembership(partnerUserId, seniorId)`, each throwing a typed `AuthorizationError` when the active link/membership is absent
    - _Requirements: 1.6, 1.7, 2.4, 2.5, 7.4, 8.5, 9.4, 12.3, 12.10, 13.6_

  - [x] 4.2 Write property test for care-link scoping
    - **Property 7: Care-link scoping confines Senior data to linked caregivers**
    - **Validates: Requirements 2.4, 2.5, 7.4, 8.5, 9.4**
    - Tag: `// Feature: senior-call-shield, Property 7: ...`; generate caregiver/senior pairs with and without active care-links and assert success only when linked, authorization error otherwise with no data; minimum 100 cases

- [x] 5. Implement the SignalWire client wrapper and SWML builders
  - [x] 5.1 Implement the SignalWire REST wrapper in `src/lib/signalwire.ts`
    - Write `searchAvailable`, `purchaseNumber`, `configureInboundHandler`, and `releaseNumber` using `SIGNALWIRE_PROJECT_ID`/`SIGNALWIRE_API_TOKEN`/`SIGNALWIRE_SPACE_URL` from env (never hardcoded); surface failures as a typed `TelephonyError`
    - _Requirements: 4.1, 4.5, 4.7, 4.8_

  - [x] 5.2 Implement the SWML document builders
    - Write pure builders for the three flows: known-contact connect, unknown-caller AI screening block (with `post_prompt_url` and a 60-second conversation timeout), and forwarding-inactive hangup, returning the SWML JSON shapes from the design
    - _Requirements: 5.4, 6.1, 6.3, 6.6_

  - [x] 5.3 Write unit tests for the SignalWire wrapper and SWML builders
    - Mock the SignalWire REST client: assert purchase/configure/release success and typed-error paths; assert each builder produces the expected SWML JSON shape
    - _Requirements: 4.1, 4.5, 4.7, 4.8, 5.4, 6.1, 6.3_

- [x] 6. Implement the Stripe client wrapper and mappers
  - [x] 6.1 Implement the Stripe wrapper in `src/lib/stripe.ts`
    - Write `ensureBillingAccount`, `createFamilySubscription`, `cancelSubscription`, `createPartnerSubscription`, and `setPartnerQuantity` (quantity >= 0) using `STRIPE_SECRET_KEY` and the configured price ids from env; write subscription-state mappers from Stripe status to `SUBSCRIPTION_STATES`; surface failures as a typed `BillingError`
    - _Requirements: 12.1, 12.2, 12.9, 13.1, 13.2, 13.3, 13.4_

  - [x] 6.2 Write unit tests for the Stripe wrapper and mappers
    - Mock the Stripe SDK: assert customer creation, family/partner subscription creation, quantity updates clamped at zero, cancellation, and typed-error paths; assert state mapping covers active/past_due/canceled/incomplete
    - _Requirements: 12.1, 12.2, 12.9, 12.11, 13.1, 13.4, 13.8_

- [x] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement the telephony route handlers
  - [x] 8.1 Implement `/api/telephony/inbound` SWML route handler
    - Add the POST route handler that resolves the Senior by the called Protection_Number, applies `isForwardingActive` (inactive -> hangup SWML + "not forwarded" Call_Record), normalizes the caller number (failure -> Unknown + normalization-failure indication), returns the known-contact connect SWML on exact match (stamping the display name), and otherwise returns the unknown-caller AI screening SWML
    - Validate the shared-secret token on the webhook URL
    - _Requirements: 4.5, 5.4, 5.7, 6.1, 6.3, 11.3, 11.4_

  - [x] 8.2 Implement `/api/telephony/report` route handler
    - Add the POST route handler that receives the AI conversation summary, computes the Risk_Assessment via `src/lib/screening.ts`, writes the Call_Record and Call_Report, returns a follow-up connect SWML for Known/Allowed or a decline for Spam/Fraud, and records `unscreened` on screening timeout
    - Retry Call_Record creation up to 3 times, falling back to a minimal `recording_failure` record that preserves caller number and start timestamp; mark `CallReport.available = false` on report-generation failure without rolling back the Call_Record; record stated purpose as `undetermined` when it cannot be determined
    - _Requirements: 6.2, 6.4, 6.5, 6.6, 7.1, 7.2, 8.1, 8.2, 8.3, 8.6_

  - [x] 8.3 Write integration tests for the telephony handlers
    - Mock inbound payloads: assert the three inbound SWML paths (known-contact connect, unknown AI block, forwarding-inactive hangup) and the report handler mapping summaries to Risk_Assessment/Call_Record/Call_Report, including the undetermined-purpose, report-failure, recording-failure, and unscreened-timeout paths
    - _Requirements: 5.4, 6.1, 6.3, 6.6, 7.2, 8.3, 8.6_

- [x] 9. Implement the billing webhook route handler
  - [x] 9.1 Implement `/api/billing/webhook` signature-verified idempotent handler
    - Add the POST route handler that reads the raw body, verifies `Stripe-Signature` with `STRIPE_WEBHOOK_SECRET` (failure -> HTTP 400, no state change), deduplicates by `ProcessedWebhookEvent.stripeEventId`, maps `customer.subscription.*` lifecycle events to `SUBSCRIPTION_STATES`, updates the `Subscription` row, re-runs the forwarding gate for each affected Senior, records unmatched verified events and returns HTTP 200, and records the event id in the same transaction as the state change
    - _Requirements: 12.7, 12.12, 13.7, 14.1, 14.2, 14.3, 14.4, 14.5, 14.6_

  - [x] 9.2 Write property test for webhook idempotence
    - **Property 6: Webhook processing is idempotent by event id**
    - **Validates: Requirements 14.5**
    - Tag: `// Feature: senior-call-shield, Property 6: ...`; generate signature-verified events and replay by matching event id, asserting identical resulting Subscription and forwarding state with no second application; minimum 100 cases

  - [x] 9.3 Write integration tests for the billing webhook
    - Mock Stripe signature verification: assert valid lifecycle event updates state and re-gates forwarding, bad signature -> 400 with no change, unmatched event -> 200 with no forwarding change
    - _Requirements: 14.2, 14.3, 14.4, 14.6_

- [x] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Implement registration, linking, and consent server actions
  - [x] 11.1 Implement registration and role-setup actions
    - Write `registerCaregiver` and `createSeniorProfile` server actions that validate email (RFC 5322, <=254 chars) and password (8-128), reject duplicate email case-insensitively, delegate to Better Auth, and create exactly one profile row (Caregiver or Senior) per account; return typed `{ ok: false, field, message }` on validation failure with no partial writes
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1_

  - [x] 11.2 Implement care-link management actions
    - Write `createSeniorProfile` care-link creation (active link within cap) and `removeCareLink`; enforce the 1-50 active care-link cap in the same transaction, rejecting over-cap requests without mutation; mark links inactive on removal to revoke access
    - _Requirements: 2.1, 2.2, 2.3, 2.6_

  - [x] 11.3 Implement consent actions
    - Write `submitConsent` and `withdrawConsent`; capture senior id, Protection_Number, and UTC second-precision timestamp; reject when a required field is absent; keep forwarding inactive without a valid consent; recompute and materialize `SeniorProfile.forwardingActive` on withdrawal
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 11.4 Write unit tests for registration, linking, and consent
    - Assert email/password bounds, case-insensitive duplicate rejection, role assignment, care-link cap at the 50 boundary, and consent missing-field rejection plus withdrawal deactivating forwarding
    - _Requirements: 1.2, 1.5, 2.3, 3.4, 3.5_

- [x] 12. Implement provisioning and known-contact server actions
  - [x] 12.1 Implement Protection_Number provisioning actions
    - Write `provisionProtectionNumber` and `releaseProtectionNumber`; reject when an active Protection_Number already exists; validate the Personal_Number as non-empty E.164 (<=15 digits) before provisioning; on SignalWire error set `provisioningState = "failed"`, store no Personal_Number, and report failure; configure the inbound handler on success; on release failure keep the number active and report failure
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_

  - [x] 12.2 Implement known-contact actions
    - Write `addKnownContact` and `removeKnownContact`; normalize to E.164 and reject invalid format; reject duplicate `(seniorId, e164Number)` leaving the existing contact unchanged; store a display name of up to 100 characters; preserve prior state on failure
    - _Requirements: 5.1, 5.2, 5.3, 5.5, 5.6_

  - [x] 12.3 Write unit tests for provisioning and known-contact actions
    - Mock SignalWire: assert provisioning success, duplicate-active rejection, invalid Personal_Number, provider error with no partial state, release success/failure; assert known-contact invalid-format and duplicate rejection and display-name storage
    - _Requirements: 4.2, 4.4, 4.6, 4.8, 5.2, 5.3_

- [x] 13. Implement billing server actions
  - [x] 13.1 Implement Family_Plan subscription actions
    - Write `subscribeFamilyPlan`, `cancelFamilyPlan`, and `listSubscriptions`; create the Billing_Account when absent; enforce `assertCareLink`; reject a second active Subscription for a Senior; on Stripe error report the failure and retain prior state; cancellation requests cancellation through Stripe and re-gates forwarding
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.8, 12.9, 12.10, 12.11_

  - [x] 13.2 Implement Partner enrollment and billing actions
    - Write `enrollPartnerMember`, `removePartnerMember`, and `getPartnerBilling`; create the Billing_Account when absent; set the per-member Subscription quantity to the count of active enrolled Seniors (clamped at zero); enforce `assertPartnerMembership`; on Stripe error report the failure and retain prior state and quantity
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.8_

  - [x] 13.3 Write property test for partner billed quantity
    - **Property 8: Partner billed quantity never goes negative**
    - **Validates: Requirements 13.3, 13.4**
    - Tag: `// Feature: senior-call-shield, Property 8: ...`; generate sequences of enrollments and removals and assert billed quantity equals the active-enrolled count and never drops below zero; minimum 100 cases

  - [x] 13.4 Write unit tests for billing actions
    - Mock Stripe: assert care-link/membership authorization rejection, duplicate-active-subscription rejection, Stripe-error paths leaving prior state unchanged, and cancellation re-gating forwarding
    - _Requirements: 12.3, 12.4, 12.10, 12.11, 13.6, 13.8_

- [x] 14. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Implement the dashboards
  - [x] 15.1 Implement the Caregiver_Dashboard (RSC)
    - Build the caregiver dashboard that loads linked Seniors (active care-links) server-side with an empty state when none, and on selection loads that Senior's Call_Records, Call_Reports, Known_Contacts, Protection_Number provisioning status, and Subscription state scoped by `assertCareLink`; wire the add/remove Known_Contact controls (shadcn/ui + Radix, minimal `use client`) to the server actions, revalidating the list and preserving prior state on failure; render a load-failure error boundary that never shows another Senior's data
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_

  - [x] 15.2 Implement the Senior_Dashboard (RSC)
    - Build the senior dashboard that loads the authenticated Senior's 20 most recent Call_Records (newest first, each with caller identifier, timestamp, outcome), Known_Contacts, and forwarding status rendered as exactly `active` or `inactive`, strictly scoped to the authenticated Senior; render empty and error states that never show another Senior's data
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7_

  - [x] 15.3 Implement the Partner view (RSC)
    - Build the partner dashboard that loads per-member Subscription state and billed quantity for the Partner's own members, scoped by `assertPartnerMembership`
    - _Requirements: 13.5_

  - [x] 15.4 Write property test for call-history ordering
    - **Property 9: Call history ordering is newest-first**
    - **Validates: Requirements 7.3, 7.5, 7.6, 10.1**
    - Tag: `// Feature: senior-call-shield, Property 9: ...`; generate Call_Record sets and assert strictly descending order by start timestamp with an empty set returning an empty result; minimum 100 cases

  - [x] 15.5 Write dashboard data-loading tests
    - Assert scoping (linked vs unlinked Senior denied, Senior sees only own data), empty states, and load-failure behavior that never falls back to another user's data
    - _Requirements: 9.2, 9.4, 10.3, 10.6, 10.7_

- [x] 16. Implement the retention background job
  - [x] 16.1 Implement the Call_Record retention job
    - Add a scheduled task / cron route handler that reads the configured retention window from `RetentionConfig` (1-3650 days, default 365) and deletes Call_Records whose age exceeds it
    - _Requirements: 7.7, 7.8_

  - [x] 16.2 Write unit tests for the retention job
    - Assert records older than the configured window are deleted and newer records are kept, and that the default of 365 days applies when unconfigured
    - _Requirements: 7.7, 7.8_

- [x] 17. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never marked optional.
- Each task references specific requirements (granular sub-requirements) for traceability.
- Property-based tests use `fast-check` + `vitest` with a minimum of 100 generated cases each, one per Correctness Property (1-9), tagged `// Feature: senior-call-shield, Property N: ...`, and placed close to the logic they validate to catch errors early.
- Integration and mock-based tests cover the SignalWire, Stripe, SWML, and dashboard edges where behavior does not vary meaningfully with input.
- Checkpoints provide incremental validation at natural breaks.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1", "3.1", "4.1", "5.1", "5.2", "6.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "3.2", "3.3", "4.2", "5.3", "6.2"] },
    { "id": 3, "tasks": ["8.1", "8.2", "9.1"] },
    { "id": 4, "tasks": ["8.3", "9.2", "9.3"] },
    { "id": 5, "tasks": ["11.1", "11.2", "11.3", "12.1", "12.2", "13.1", "13.2"] },
    { "id": 6, "tasks": ["11.4", "12.3", "13.3", "13.4"] },
    { "id": 7, "tasks": ["15.1", "15.2", "15.3", "16.1"] },
    { "id": 8, "tasks": ["15.4", "15.5", "16.2"] }
  ]
}
```
