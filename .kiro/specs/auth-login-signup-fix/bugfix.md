# Bugfix Requirements Document

## Introduction

The authentication surface at `/login` is broken in two related ways. First, both signing in and creating an account fail with an HTTP 500 server error: the sign-in path (`signIn.email` → Better Auth server handler) and the sign-up path (`registerCaregiver` server action → `auth.api.signUpEmail`, then `signIn.email`) each run server-side, and an exception escaping the typed-result path surfaces to the browser as a 500 rather than as a field-level message. Second, password handling is unsafe and validation is hand-rolled: passwords flow through the `registerCaregiver` / `createSeniorProfile` server actions and the `signIn.email` call as raw strings and are exposed in plaintext through the console, while input validation uses the bespoke `validateEmail` / `validatePassword` helpers in `src/app/actions/auth.ts` rather than a schema validator.

This bugfix restores successful sign-in and account creation, replaces the hand-rolled validators with zod so email, password, and name are validated against typed schemas that yield field-level errors, and ensures passwords are never logged or otherwise exposed in plaintext. It preserves the existing registration semantics defined by the surrounding `senior-call-shield` spec (Req 1.1–1.3, 1.5): a successful caregiver registration still creates exactly one account plus one `CaregiverProfile`, duplicate emails are still rejected case-insensitively, and no partial writes are left behind.

## Bug Analysis

### Current Behavior (Defect)

When a user submits the sign-in or sign-up form, the request fails server-side and passwords are handled unsafely instead of being validated and protected.

1.1 WHEN a user submits valid sign-in credentials at `/login` THEN the system fails with an HTTP 500 server error instead of establishing a session.

1.2 WHEN a user submits the sign-up form at `/login?mode=signup` with valid details THEN the system fails with an HTTP 500 server error instead of creating the account and signing in.

1.3 WHEN a sign-in or sign-up request fails server-side THEN the system surfaces an unhandled 500 error rather than a typed field-level message, so the failure is not shown as an on-screen validation error and the request does not hang.

1.4 WHEN a password is passed through the `registerCaregiver` / `createSeniorProfile` server actions or the `signIn.email` call THEN the system handles and exposes the password in plaintext through the console.

1.5 WHEN registration input (email, password, name) is checked THEN the system validates it with the hand-rolled `validateEmail` and `validatePassword` helpers rather than zod, so there is no typed schema and field-level errors are assembled by hand.

### Expected Behavior (Correct)

The authentication flows succeed, inputs are validated with zod, and passwords are stored only as bcrypt hashes and never exposed in plaintext.

2.1 WHEN a user submits valid sign-in credentials at `/login` THEN the system SHALL authenticate the account and establish a session without returning a 500 error.

2.2 WHEN a user submits the sign-up form at `/login?mode=signup` with valid details THEN the system SHALL create the account and its `CaregiverProfile`, sign the user in, and navigate to the role dashboard without returning a 500 error.

2.3 WHEN a sign-in or sign-up request cannot be completed THEN the system SHALL return a typed field-level result (`{ ok: false, field, message }`) that the UI surfaces as an on-screen message, rather than throwing an unhandled 500 error.

2.4 WHEN a password is passed through the server actions or the sign-in call THEN the system SHALL hash it with bcrypt before persisting it (storing only the bcrypt hash, never the plaintext) and SHALL NOT log or otherwise expose the plaintext password through the console or any other output.

2.5 WHEN registration input (email, password, name) is checked THEN the system SHALL validate it against zod schemas that enforce the email shape and ≤254-char bound, the 8–128-char password bound, and a non-empty name, producing typed field-level errors.

2.6 WHEN zod validation fails for a submitted field THEN the system SHALL reject the request, identify the offending field, and SHALL NOT create an account or write any profile row.

### Unchanged Behavior (Regression Prevention)

The surrounding registration and role-resolution semantics defined by the `senior-call-shield` spec must stay intact.

3.1 WHEN a caregiver registration succeeds THEN the system SHALL CONTINUE TO create exactly one account and exactly one `CaregiverProfile` for that account (Req 1.1, 1.3).

3.2 WHEN a registration email already belongs to an existing account (case-insensitive match) THEN the system SHALL CONTINUE TO reject the registration with an "already registered" message and leave the existing account unchanged (Req 1.5).

3.3 WHEN account creation succeeds but the subsequent profile write fails THEN the system SHALL CONTINUE TO remove the orphaned account so no account is left without its role row (no partial writes).

3.4 WHEN a `createSeniorProfile` call succeeds THEN the system SHALL CONTINUE TO create exactly one `SeniorProfile` and return its id, without creating a Care_Link.

3.5 WHEN an authenticated account reaches `resolvePostAuthPath` THEN the system SHALL CONTINUE TO resolve the role server-side and return the matching dashboard path (`/caregiver`, `/senior`, `/partner`, or `/` when no role profile exists).

3.6 WHEN email and password are submitted with the same values that validate today (valid RFC 5322 email ≤254 chars, password 8–128 chars, non-empty name) THEN the system SHALL CONTINUE TO accept them, so the zod schemas enforce the identical accept/reject boundaries as the hand-rolled validators.
