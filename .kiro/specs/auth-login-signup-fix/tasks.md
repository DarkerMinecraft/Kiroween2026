# Implementation Plan

## Overview

This plan fixes the `/login` sign-in and sign-up HTTP 500s using the bug condition methodology. It is test-driven: exploratory bug-condition tests demonstrate the throw/500 on unfixed code (Property 1), preservation property tests capture the behavior and validation boundaries that must stay unchanged (Property 2), then the fix is applied across `package.json`, `src/app/actions/auth.ts`, `src/lib/prisma.ts`, and `src/lib/auth.ts`, after which the same tests are re-run to confirm the fix and the absence of regressions.

## Task Dependency Graph

```json
{
  "waves": [
    {
      "wave": 1,
      "tasks": ["1", "2"],
      "description": "Run on UNFIXED code first: task 1 tests FAIL (confirm bug), task 2 tests PASS (baseline to preserve)."
    },
    {
      "wave": 2,
      "tasks": ["3.1", "3.5", "3.6"],
      "dependsOn": ["1", "2"],
      "description": "Add zod dependency; harden the shared prisma connection; verify Better Auth wiring. Independent of each other."
    },
    {
      "wave": 3,
      "tasks": ["3.2"],
      "dependsOn": ["3.1"],
      "description": "Define zod schemas (requires zod installed)."
    },
    {
      "wave": 4,
      "tasks": ["3.3"],
      "dependsOn": ["3.2"],
      "description": "Convert thrown errors into typed results (shares the validation/result plumbing)."
    },
    {
      "wave": 5,
      "tasks": ["3.4"],
      "dependsOn": ["3.3"],
      "description": "Guarantee safe password handling across the hardened result paths."
    },
    {
      "wave": 6,
      "tasks": ["3.7", "3.8"],
      "dependsOn": ["3.4", "3.5", "3.6"],
      "description": "Re-run task 1 tests (now PASS) and task 2 tests (still PASS) on fixed code."
    },
    {
      "wave": 7,
      "tasks": ["4"],
      "dependsOn": ["3.7", "3.8"],
      "description": "Checkpoint: full suite plus build/type-check."
    }
  ]
}
```

## Tasks

- [x] 1. Write bug condition exploration tests (BEFORE implementing the fix)
  - **Property 1: Bug Condition** - Auth failures escape as an unhandled error instead of a typed field result
  - **CRITICAL**: These tests MUST FAIL on unfixed code - the failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails** at this stage
  - **NOTE**: These tests encode the expected behavior - they will validate the fix once they pass after implementation
  - **GOAL**: Surface counterexamples that demonstrate a non-`APIError` escapes `registerCaregiver` / `createSeniorProfile` and becomes an HTTP 500
  - **Scoped PBT Approach**: the bug is deterministic given a throwing dependency, so scope each case to a concrete failing input (valid name/email/password) with a mocked dependency forced to reject
  - Extend `src/app/actions/auth.test.ts` using the existing `vitest` + `vi.mock('@/lib/auth')` + `vi.mock('@/lib/prisma')` harness
  - Case 1 — signUpEmail internal error: mock `auth.api.signUpEmail` to reject with a plain `Error` (non-`APIError`); assert `registerCaregiver` currently re-throws instead of returning `{ ok: false, field, message }` (from Bug Condition: `createAccount` only catches `APIError`)
  - Case 2 — duplicate-lookup DB error: mock `prisma.user.findUnique` to reject with a connection error; assert the action currently throws rather than returning a typed result
  - Case 3 — profile-write failure delivery: mock `caregiverProfile.create` to reject; assert the account is rolled back (`user.delete` called) AND the action currently re-throws — this documents the precise behavior change (today: throw; after fix: typed failure)
  - Case 4 (edge) — sign-in handler error: simulate the Better Auth sign-in path producing a non-credential internal (500-class) error and assert the current path yields an unhandled rejection rather than a surfaced error message
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests FAIL / throw (this is correct - it proves the bug exists)
  - Document the counterexamples found (e.g. "registerCaregiver(validInput) throws when signUpEmail rejects with Error instead of returning { ok: false }")
  - Mark task complete when the tests are written, run, and the failures are documented
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 2. Write preservation property tests (BEFORE implementing the fix)
  - **Property 2: Preservation** - Non-buggy inputs and validation boundaries are unchanged
  - **IMPORTANT**: Follow the observation-first methodology - record what the UNFIXED code does, then assert it
  - Use `fast-check` (already a dependency) for boundary parity, following the pattern in the existing `*.property.test.ts` files
  - Observe and capture the current `validateEmail` / `validatePassword` accept/reject decisions and field ordering (name -> email -> password) on the unfixed code
  - Boundary parity: generate random emails (including a 254-char valid email and an over-254-char email), passwords (including 8- and 128-char and out-of-range lengths), and names (including empty/whitespace and trimmed non-empty); assert the accept/reject outcome and the offending `field` match the current hand-rolled validators exactly (Req 3.6)
  - Duplicate-email preservation: a case-variant duplicate lowercases to the same `user.findUnique` lookup and returns the "already registered" email error, existing account untouched (Req 3.2)
  - Exactly-one-profile preservation: a successful `registerCaregiver` creates one `CaregiverProfile` and no `SeniorProfile`; `createSeniorProfile` creates one `SeniorProfile`, returns its `profileId`, and creates no Care_Link (Req 3.1, 3.4)
  - Orphan rollback preservation: on profile-write failure the orphaned account is deleted (Req 3.3)
  - Role-resolution preservation: `resolvePostAuthPath` returns `/caregiver`, `/senior`, `/partner`, and `/` when no role profile exists (Req 3.5)
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms the baseline behavior that must be preserved)
  - Mark task complete when the tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 3. Fix auth 500s, add zod validation, and harden the shared DB connection

  - [x] 3.1 Add zod as a pinned dependency
    - Add `zod` to `package.json` `dependencies` at an exact/pinned version (not a range)
    - Run the install so the lockfile is updated; no other runtime dependency is required
    - _Requirements: 2.5_

  - [x] 3.2 Replace hand-rolled validators with zod schemas in `src/app/actions/auth.ts`
    - Define zod schemas reproducing the current boundaries exactly: email trimmed + lowercased, non-empty, `<= MAX_EMAIL_LENGTH` (254), matching the existing `EMAIL_PATTERN` regex -> `field: "email"`; password `>= MIN_PASSWORD_LENGTH` (8) and `<= MAX_PASSWORD_LENGTH` (128) -> `field: "password"`; name trimmed, `min(1)` -> `field: "name"`
    - Combine into a single input schema whose `safeParse` yields the offending field + message, preserving the field-first ordering (name -> email -> password) and the existing message strings so UI copy and tests do not regress
    - Reject with the typed field result and create no account / write no profile row on validation failure
    - _Bug_Condition: isBugCondition(input) from design (validation path must stay a typed result)_
    - _Preservation: email (RFC 5322 shape, <=254), password (8-128), name (non-empty, trimmed) boundaries from Preservation Requirements_
    - _Requirements: 2.5, 2.6, 3.6_

  - [x] 3.3 Convert any thrown error into a typed result (primary 500 fix) in `src/app/actions/auth.ts`
    - `createAccount` returns a typed failure for both `APIError` and any other error, without leaking internals
    - In `registerCaregiver` / `createSeniorProfile`, after the orphan-account rollback return a typed `{ ok: false, field, message }` instead of `throw error`
    - Wrap the duplicate-email lookup (`user.findUnique`) and the profile writes (`caregiverProfile.create`, `seniorProfile.create`) so a DB/adapter error becomes a typed result rather than an escape
    - Retain the orphan rollback (`user.delete`) exactly - no partial writes
    - Keep `ActionResult` / `SeniorProfileResult` shapes and the `field` values the login UI depends on unchanged
    - _Bug_Condition: isBugCondition(input) where server-side execution raises a non-APIError (DB/adapter failure, Better Auth internal error, or post-rollback re-throw)_
    - _Expected_Behavior: expectedBehavior(result) from design - valid requests succeed; unrecoverable failures return `{ ok: false, field, message }`; no 500; no partial writes_
    - _Preservation: exactly-one-profile, case-insensitive duplicate rejection, orphan rollback, `createSeniorProfile` id return from Preservation Requirements_
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4_

  - [x] 3.4 Guarantee safe password handling in `src/app/actions/auth.ts`
    - Ensure no `console.*` or error payload ever includes the raw password; sanitize messages derived from caught exceptions to a generic, user-safe string
    - Pass the password only to `auth.api.signUpEmail` / sign-in; never place it in a returned `message`, log line, or thrown error
    - _Expected_Behavior: result.message DOES NOT CONTAIN input.password (from Fix Checking pseudocode)_
    - _Requirements: 2.4_

  - [x] 3.5 Harden the shared database connection in `src/lib/prisma.ts`
    - Prefer the pooled Neon connection string for runtime queries: use `DATABASE_URL_POOLED` when set, falling back to `DATABASE_URL`
    - Keep the `globalThis` singleton; migrations continue to use the direct `DATABASE_URL` via `prisma7.config.ts` (unchanged)
    - _Expected_Behavior: hardens the shared connection both sign-up and sign-in depend on, reducing the common-case 500 source_
    - _Requirements: 2.1, 2.2_

  - [x] 3.6 Verify Better Auth DB wiring in `src/lib/auth.ts`
    - Confirm `prismaAdapter(prisma, { provider: "postgresql" })` + `nextCookies()` is correct for the schema
    - Change only if verification reveals a concrete misconfiguration; otherwise leave unchanged (it benefits from the hardened `prisma` connection)
    - _Requirements: 2.1_

  - [x] 3.7 Verify bug condition exploration tests now pass
    - **Property 1: Expected Behavior** - Auth failures return a typed field result, never a 500
    - **IMPORTANT**: Re-run the SAME tests from task 1 - do NOT write new tests
    - Each previously-throwing case (signUpEmail internal error, duplicate-lookup DB error, profile-write failure, sign-in handler error) now resolves to a typed `{ ok: false, field, message }` (or a surfaced sign-in error) with no partial writes and no password in the message
    - Run the exploration tests from task 1
    - **EXPECTED OUTCOME**: Tests PASS (confirms the bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.8 Verify preservation property tests still pass
    - **Property 2: Preservation** - Non-buggy inputs and validation boundaries are unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run the preservation property tests from task 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions in validation boundaries, duplicate rejection, one-profile creation, orphan rollback, id return, and role resolution)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 4. Checkpoint - Ensure all tests pass
  - Run the full test suite and the project build/type-check
  - Confirm the unit, property-based, and exploration/preservation tests all pass with no regressions
  - Ensure all tests pass, ask the user if questions arise

## Notes

- Tasks 1 and 2 must be executed on the UNFIXED code first: task 1's tests are expected to FAIL (confirming the bug), and task 2's tests are expected to PASS (establishing the preserved baseline). Do not implement the fix until both are run and their outcomes documented.
- Tests follow the existing `vitest` + `vi.mock('@/lib/auth')` / `vi.mock('@/lib/prisma')` harness in `src/app/actions/auth.test.ts`; property-based preservation tests use `fast-check`, matching the existing `*.property.test.ts` files.
- The zod schemas must reproduce the current accept/reject boundaries exactly (email RFC 5322 shape + ≤254 chars, password 8–128, name trimmed non-empty) and preserve the field-first ordering (name → email → password) and existing message strings.
- Raw passwords must never appear in logs, returned messages, or thrown errors; sanitize any message derived from a caught exception.
- `src/lib/auth.ts` is verify-only — change it only if a concrete misconfiguration is found during task 3.6.
- The checkpoint (task 4) runs the full suite plus the project build/type-check before the spec is considered done.
