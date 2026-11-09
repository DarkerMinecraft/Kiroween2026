# Auth Login/Signup Fix Bugfix Design

## Overview

The `/login` surface fails both sign-in and sign-up with an HTTP 500, and it validates registration input with hand-rolled helpers while passing raw passwords through server actions.

Reading the code pins the 500 to one mechanism in `src/app/actions/auth.ts`: the server actions only convert a narrow class of failures into the typed `{ ok, field, message }` result, and let every other exception escape. `createAccount` catches `APIError` from `auth.api.signUpEmail` and `throw error`s everything else; `registerCaregiver` and `createSeniorProfile` re-throw profile-write failures after rolling back the orphaned account. Any non-`APIError` thrown inside the action — a Better Auth internal error (password hashing, adapter call), a Prisma/Neon connectivity error on `user.findUnique` / `caregiverProfile.create`, or the deliberate re-throw after rollback — propagates out of the `"use server"` function. Next.js serializes an uncaught server-action rejection as an opaque HTTP 500, which the client's `registerCaregiver(...)` await rejects on, so no typed result is ever returned and the UI shows neither a field message nor a recoverable error (Req 1.1, 1.2, 1.3).

The sign-in path is adjacent: `signIn.email` (`src/lib/auth-client.ts`) posts to the Better Auth catch-all route at `src/app/api/auth/[...all]/route.ts`. When Better Auth's server handler throws an internal (non-credential) error — again, most plausibly a database/adapter failure through the Prisma adapter — it responds 500 rather than a structured error body, and the client surfaces it as a failed request instead of a field-level message (Req 1.1, 1.3).

The most likely concrete trigger, grounded in the wiring, is the database layer. `prisma.ts` builds `PrismaPg` from `process.env.DATABASE_URL` (a Neon URL requiring `sslmode=require&channel_binding=require`), and both the sign-up server action and the Better Auth sign-in handler depend on that connection for the very first write/read. If the connection or adapter configuration is off (direct non-pooled URL exhausting Neon connections under dev hot-reload, `channel_binding` handshake, or a cold Neon endpoint timing out), the adapter throws a plain `Error` — not an `APIError` — which is exactly the class the current catch does not handle. The fix therefore has two layers: (a) make the server actions resilient so any failure, DB or otherwise, becomes a typed field result instead of a 500; and (b) harden the database access the actions and Better Auth share so the common case succeeds (use the pooled Neon connection string under serverless/dev, and surface a clear typed message on connection failure).

The fix also swaps the bespoke `validateEmail` / `validatePassword` helpers for `zod` schemas (zod is not yet a dependency and must be added) that enforce the identical boundaries, and guarantees raw password strings are never logged or placed on any error surface.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug — a sign-in or sign-up request whose server-side execution raises a non-`APIError` exception (DB connectivity/adapter failure, Better Auth internal error, or the post-rollback re-throw) so the failure escapes as an HTTP 500 instead of a typed field result.
- **Property (P)**: The desired behavior — valid credentials authenticate and valid sign-up details create the account + `CaregiverProfile` and sign in; any unrecoverable failure returns a typed `{ ok: false, field, message }` (or a Better-Auth-mediated error) rather than a 500; input is validated by zod; passwords are never exposed in plaintext.
- **Preservation**: Existing registration/role semantics (exactly-one-profile creation, case-insensitive duplicate rejection, orphan-account rollback, `createSeniorProfile` id return, `resolvePostAuthPath` role resolution) and the exact accept/reject boundaries the current validators enforce, all of which must remain unchanged.
- **registerCaregiver / createSeniorProfile**: The `"use server"` actions in `src/app/actions/auth.ts` that validate input, reject duplicate emails, create a Better Auth account, then create exactly one role profile.
- **createAccount**: The private helper in `src/app/actions/auth.ts` wrapping `auth.api.signUpEmail`; today it rethrows any non-`APIError`.
- **signIn.email**: The Better Auth client call in `src/lib/auth-client.ts` used by the login page, routed through `src/app/api/auth/[...all]/route.ts`.
- **auth**: The Better Auth server instance in `src/lib/auth.ts`, wired to Prisma via `prismaAdapter` with the `postgresql` provider.
- **prisma**: The `PrismaClient` singleton in `src/lib/prisma.ts`, connected through `@prisma/adapter-pg` using `DATABASE_URL`.
- **ActionResult**: The existing typed union `{ ok: true } | { ok: false; field: string; message: string }` returned by the registration actions.

## Bug Details

### Bug Condition

The bug manifests when a sign-in or sign-up request executes server-side and a non-`APIError` exception is raised during the flow. `createAccount` only converts `APIError` into a typed result and re-throws every other error; `registerCaregiver` / `createSeniorProfile` deliberately re-throw profile-write failures after rolling back; and the Better Auth sign-in handler returns 500 on internal errors. In each case the failure escapes the typed-result contract and surfaces to the browser as an opaque HTTP 500.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type AuthRequest   -- a sign-in or sign-up submission
  OUTPUT: boolean

  RETURN serverSideExecutionRaises(input, error)
         AND NOT (error IS APIError handled by createAccount)
         AND resultDelivered(input) IS HTTP_500   -- not a typed { ok, field, message }
END FUNCTION
```

Equivalently, the bug condition holds for any request whose processing throws from: the Prisma adapter / Neon connection (`user.findUnique`, `caregiverProfile.create`, `seniorProfile.create`, `user.delete`), Better Auth internals inside `auth.api.signUpEmail` or the sign-in handler, or the explicit `throw error` after orphan rollback.

### Examples

- Sign-up with valid details while the Neon connection fails on `user.findUnique` (cold endpoint, `channel_binding`/pooling issue): expected a typed `{ ok: false, field: "email"/"form", message }` the UI can show; actual an HTTP 500 and the awaited action rejects.
- Sign-up where `auth.api.signUpEmail` throws a non-`APIError` internal error (e.g. adapter write failure): expected a typed failure; actual `createAccount` re-throws → 500.
- Sign-up where account creation succeeds but `caregiverProfile.create` throws: expected the orphan is rolled back AND a typed failure returned; actual the orphan is rolled back but the action re-throws → 500 (Req 3.3 preserved, but delivery is a 500).
- Sign-in with valid credentials while the Better Auth handler hits a database error: expected a session established (or a surfaced error message); actual HTTP 500 from `/api/auth/*`.
- Edge: validation failure (bad email, short password) — expected and actual both a typed field result today; this path must stay correct after moving to zod.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- A successful caregiver registration still creates exactly one account and exactly one `CaregiverProfile` (Req 3.1).
- Duplicate emails are still rejected case-insensitively against the lowercased unique `User.email`, leaving the existing account untouched (Req 3.2).
- When account creation succeeds but the profile write fails, the orphaned account is still removed so no account is left without a role row — no partial writes (Req 3.3).
- `createSeniorProfile` still creates exactly one `SeniorProfile`, returns its `profileId`, and creates no Care_Link (Req 3.4).
- `resolvePostAuthPath` still resolves the role server-side and returns `/caregiver`, `/senior`, `/partner`, or `/` (Req 3.5).
- Email/password/name values that validate today validate identically after the switch to zod — the same accept/reject boundaries (Req 3.6).

**Scope:**
All inputs that do NOT satisfy the bug condition must be completely unaffected by this fix. This includes:
- Requests with invalid input that already return a typed field result (the field + message boundaries must be identical).
- Successful sign-in / sign-up where no server-side exception is raised.
- The role-resolution and dashboard-routing behavior of `resolvePostAuthPath`.

**Note:** The expected correct behavior for buggy inputs is defined in the Correctness Properties section (Property 1).

## Hypothesized Root Cause

Based on the code, the most likely issues are:

1. **Over-narrow exception handling in the server actions (primary)**: `createAccount` catches only `APIError` and re-throws all else; the profile-write `catch` blocks re-throw after rollback. Any DB/internal error therefore escapes `"use server"` and Next.js returns an HTTP 500 instead of the action's typed `ActionResult` (Req 1.3, 2.3).

2. **Database/adapter connectivity as the exception source**: `src/lib/prisma.ts` connects `@prisma/adapter-pg` using `DATABASE_URL` (the non-pooled Neon URL). A pooled connection string (`DATABASE_URL_POOLED`) exists in `.env` but is unused. Under serverless/dev hot-reload the direct endpoint can exhaust connections or cold-start timeout, and the Neon URL requires `sslmode=require&channel_binding=require`; a failed handshake or connection throws a plain `Error`, which is precisely the unhandled class. Both the sign-up action and the Better Auth sign-in handler depend on this connection first, explaining why both flows 500.

3. **Sign-in path returns 500 at the route handler**: `signIn.email` posts to `/api/auth/[...all]`; a Better Auth internal error (most plausibly the shared DB failure) yields a 500 response the client cannot render as a field message (Req 1.1, 1.3).

4. **Unsafe password handling / hand-rolled validation**: passwords move as raw strings through the actions and `signIn.email`; any added diagnostics or error payloads risk exposing them. Validation is bespoke (`validateEmail` / `validatePassword`) rather than schema-based, so field errors are assembled by hand (Req 1.4, 1.5).

## Correctness Properties

Property 1: Bug Condition - Auth failures return a typed field result, never a 500

_For any_ sign-in or sign-up request where the bug condition holds (server-side execution raises a non-`APIError` exception — DB/adapter failure, Better Auth internal error, or post-rollback re-throw), the fixed code SHALL complete valid requests successfully (authenticate / create account + `CaregiverProfile` and sign in) and SHALL, for any unrecoverable failure, return a typed `{ ok: false, field, message }` from the server actions (or surface a Better-Auth-mediated error message on the sign-in path) rather than throwing an unhandled error that becomes an HTTP 500. No partial writes are left behind.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation - Non-buggy inputs and validation boundaries are unchanged

_For any_ input where the bug condition does NOT hold (valid requests that already succeed, and invalid requests that already return a typed field result), the fixed code SHALL produce the same observable result as the original code, preserving exactly-one-profile creation, case-insensitive duplicate rejection, orphan-account rollback, `createSeniorProfile` id return, `resolvePostAuthPath` role resolution, and the identical email (RFC 5322 shape, ≤254 chars), password (8–128 chars), and name (non-empty, trimmed) accept/reject boundaries now enforced by zod.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**

## Fix Implementation

### Changes Required

Assuming the root cause analysis is correct, the fix spans the server actions, the validation layer, the database wiring, and dependency management.

**File**: `package.json`

1. **Add zod as a dependency**: install `zod` at a pinned version (zod is not currently present under `dependencies`). No other runtime dependency is required.

**File**: `src/app/actions/auth.ts`

**Functions**: `createAccount`, `registerCaregiver`, `createSeniorProfile`, and the validators.

2. **Replace hand-rolled validators with zod schemas**: define zod schemas that reproduce the current boundaries exactly:
   - email: trimmed + lowercased, non-empty, `≤ MAX_EMAIL_LENGTH` (254), matching the existing `EMAIL_PATTERN` (reuse the same regex so the shape boundary is identical) — maps failures to `field: "email"`.
   - password: length `≥ MIN_PASSWORD_LENGTH` (8) and `≤ MAX_PASSWORD_LENGTH` (128) — maps failures to `field: "password"`.
   - name: trimmed, non-empty (`min(1)` after trim) — maps failures to `field: "name"`.
   - Combine into a single input schema whose `safeParse` yields the offending field and message, preserving the current field-first ordering (name → email → password) and the existing message strings where feasible so UI copy and tests do not regress.

3. **Convert any thrown error into a typed result (primary 500 fix)**: broaden the failure handling so no non-`APIError` escapes. `createAccount` returns a typed failure for both `APIError` and other errors (without leaking internals). In `registerCaregiver` / `createSeniorProfile`, after the orphan-account rollback the code returns a typed `{ ok: false, field, message }` instead of `throw error`, so a profile-write failure is reported, not surfaced as a 500. Wrap the duplicate-email lookup (`user.findUnique`) and profile writes so a DB error becomes a typed result as well. The orphan rollback itself (Req 3.3) is retained exactly.

4. **Safe password handling (Req 1.4, 2.4)**: ensure no `console.*` or error payload ever includes the raw password. Error messages derived from caught exceptions must be sanitized to a generic, user-safe string (never echoing `input.password` or the full request body). Pass the password only to `auth.api.signUpEmail`/sign-in; never place it in a returned `message`, log line, or thrown error. (A grep confirms there is no current `console.*` in the action; the constraint is codified so the fix and future edits cannot introduce one.)

5. **Preserve the typed contract and ordering**: keep `ActionResult` / `SeniorProfileResult` shapes, the `field` values used by the login UI, and the no-partial-write guarantee unchanged.

**File**: `src/lib/prisma.ts`

6. **Harden the shared database connection (common-case 500 fix)**: prefer the pooled Neon connection string for runtime queries (use `DATABASE_URL_POOLED` when set, falling back to `DATABASE_URL`) so the serverless/dev connection pattern that both the sign-up action and the Better Auth sign-in handler depend on does not exhaust or cold-timeout the direct endpoint. Keep the `globalThis` singleton. Migrations continue to use the direct `DATABASE_URL` via `prisma7.config.ts` (unchanged).

**File**: `src/lib/auth.ts` (verify only, change only if needed)

7. **Confirm Better Auth DB wiring**: the `prismaAdapter(prisma, { provider: "postgresql" })` + `nextCookies()` setup is correct for the schema; no change expected beyond benefiting from the hardened `prisma` connection. Only adjust if verification during implementation shows a concrete misconfiguration.

## Testing Strategy

### Validation Approach

The strategy is two-phase: first surface counterexamples that demonstrate the 500 on the unfixed code, confirming the root cause; then verify the fixed code returns typed results for failures, succeeds for valid input, and preserves every unchanged behavior and validation boundary. Tests follow the existing `vitest` + `vi.mock` pattern in `src/app/actions/auth.test.ts`; property-based tests use the already-present `fast-check`.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix, and confirm or refute the root-cause hypothesis (unhandled non-`APIError` escapes as a 500 / rethrow). If refuted, re-hypothesize.

**Test Plan**: Using the established mock harness (mock `@/lib/auth` and `@/lib/prisma`), make the mocked dependencies throw non-`APIError` errors and assert the current action re-throws (demonstrating the escape that becomes a 500) rather than returning a typed result. Run on the UNFIXED code to observe the throw.

**Test Cases**:
1. **signUpEmail internal error**: `auth.api.signUpEmail` rejects with a plain `Error` → `registerCaregiver` re-throws instead of returning `{ ok: false, ... }` (will fail/throw on unfixed code).
2. **Duplicate-lookup DB error**: `prisma.user.findUnique` rejects with a connection error → the action throws (will fail on unfixed code).
3. **Profile-write failure delivery**: `caregiverProfile.create` rejects → the account is rolled back AND the action re-throws (today) — assert the fixed code returns a typed failure instead (will fail on unfixed code). The existing test already asserts the re-throw + rollback, so this case documents the behavior change precisely.
4. **Sign-in handler error (edge)**: simulate the Better Auth sign-in path producing a 500-class internal error; assert the client receives a surfaced error rather than an unhandled rejection (will fail on unfixed code).

**Expected Counterexamples**:
- The server action throws (rather than returning `ActionResult`) whenever a dependency raises a non-`APIError`.
- Possible causes: over-narrow `APIError`-only catch, deliberate `throw error` after rollback, DB/adapter connectivity failure.

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior (valid requests succeed; unrecoverable failures return a typed field result, never a 500).

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := fixedAction(input)
  ASSERT result HAS SHAPE { ok: false, field, message }   -- or a successful { ok: true, ... }
  ASSERT NOT threw(result)                                 -- nothing escapes to an HTTP 500
  ASSERT noPartialWrite(input)
  ASSERT result.message DOES NOT CONTAIN input.password
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT originalAction(input) = fixedAction(input)
END FOR
```

**Testing Approach**: Property-based testing (with `fast-check`) is recommended for preservation because:
- It generates many inputs across the email/password/name domain automatically.
- It catches boundary cases the hand-written unit tests might miss (e.g. 254-char email, 8- and 128-char passwords, whitespace-only names).
- It gives a strong guarantee that the zod schemas accept/reject exactly what the hand-rolled validators did.

**Test Plan**: Capture the original accept/reject decisions (the current `validateEmail` / `validatePassword` boundaries and existing unit expectations), then assert the zod-based validation yields the identical field + accept/reject outcome for generated inputs.

**Test Cases**:
1. **Validation-boundary parity**: for generated emails, passwords, and names, assert the zod schema's accept/reject and offending `field` match the pre-fix behavior (Req 3.6).
2. **Duplicate-email preservation**: a case-variant duplicate still lowercases to the same lookup and returns the "already registered" email error, existing account untouched (Req 3.2).
3. **Exactly-one-profile preservation**: a successful `registerCaregiver` still creates one `CaregiverProfile` and no `SeniorProfile`; `createSeniorProfile` still creates one `SeniorProfile`, returns its id, and no Care_Link (Req 3.1, 3.4).
4. **Orphan rollback preservation**: on profile-write failure the orphaned account is still deleted (Req 3.3) — now paired with a typed failure return rather than a throw.
5. **Role-resolution preservation**: `resolvePostAuthPath` still returns the correct per-role path and `/` with no profile (Req 3.5).

### Unit Tests

- zod validation: rejects bad email shape, over-254-char email, <8 and >128 char passwords, empty/whitespace name — each as the correct typed `field` error with no account created (mirrors and replaces the current `validateEmail`/`validatePassword` unit tests).
- Typed-failure conversion: `signUpEmail` non-`APIError`, duplicate-lookup DB error, and profile-write failure each return `{ ok: false, field, message }` instead of throwing.
- Password safety: returned `message` and any error output never contain the submitted password.
- Boundary acceptance: 8- and 128-char passwords and a 254-char valid email are accepted (preserves existing boundary tests).

### Property-Based Tests

- Generate random valid/invalid emails, passwords, and names and assert zod's accept/reject + field matches the original validators exactly (boundary parity).
- Generate inputs that drive dependency failures and assert the action always resolves to a typed result (never throws) and never leaks the password.
- Generate successful registrations and assert the exactly-one-profile and no-partial-write invariants hold across many cases.

### Integration Tests

- Full sign-up flow through `registerCaregiver` then `signIn.email` resolves to a role dashboard path with no 500 (happy path).
- Full sign-in flow with valid credentials establishes a session without a 500.
- Induced DB failure on the shared connection surfaces a typed/handled error message on screen rather than an unhandled 500, for both sign-in and sign-up.
