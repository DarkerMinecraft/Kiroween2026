/**
 * Pure E.164 telephone-number normalization and Known_Contact matching.
 *
 * All logic here is deterministic and side-effect free so it can be validated
 * with property-based tests (design Correctness Properties 1-3). Normalization
 * is backed by `libphonenumber-js`, which gives idempotent E.164 output.
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5.
 */

import {
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js";

/** Default region applied when an input number omits a country code (Req 11.2). */
export type DefaultRegion = CountryCode;

/**
 * Discriminated-union result of a normalization attempt.
 *
 * On success, `e164` is the normalized `+<1-15 digits>` string. On failure, the
 * caller must be treated as an Unknown_Caller and a normalization-failure
 * indication recorded while retaining the original unmodified input (Req 11.4).
 */
export interface NormalizeSuccess {
  readonly ok: true;
  readonly e164: string;
}

export interface NormalizeFailure {
  readonly ok: false;
}

export type NormalizeResult = NormalizeSuccess | NormalizeFailure;

/**
 * Characters permitted in a raw inbound Caller_Number per Req 11.4: digits,
 * spaces, hyphens, parentheses, and at most a single leading plus sign. Any
 * other character (letters, extra plus signs, punctuation) rejects the input.
 */
const ALLOWED_PHONE_INPUT = /^\+?[0-9 ()-]+$/;

/** A fully normalized E.164 value: a leading plus and 1-15 digits (Req 11.1). */
const E164_PATTERN = /^\+[1-9][0-9]{0,14}$/;

const hasOnlyAllowedCharacters = (input: string): boolean => {
  if (!ALLOWED_PHONE_INPUT.test(input)) return false;
  // A plus sign is only allowed as the single leading character.
  const plusCount = (input.match(/\+/g) ?? []).length;
  if (plusCount === 0) return true;
  return plusCount === 1 && input.startsWith("+");
};

/**
 * Normalize a raw telephone-number string to E.164.
 *
 * Applies `defaultRegion` when the input omits a country code (Req 11.2).
 * Rejects empty input, inputs containing disallowed characters, and inputs that
 * do not resolve to a valid E.164 value of 1-15 digits (Req 11.4). On an
 * already-normalized E.164 value the output is character-for-character
 * identical, giving idempotence (Req 11.5).
 */
export const normalizeToE164 = (
  input: string,
  defaultRegion: DefaultRegion,
): NormalizeResult => {
  if (typeof input !== "string") return { ok: false };

  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false };
  if (!hasOnlyAllowedCharacters(trimmed)) return { ok: false };

  const parsed = parsePhoneNumberFromString(trimmed, defaultRegion);
  if (!parsed || !parsed.isValid()) return { ok: false };

  const e164 = parsed.number;
  if (!E164_PATTERN.test(e164)) return { ok: false };

  return { ok: true, e164 };
};

/**
 * Exact Known_Contact match on normalized E.164 forms.
 *
 * Two numbers match only when their full E.164 strings are character-for-
 * character identical; no partial or numeric-equivalence matching is performed
 * (Req 11.3). Inputs are expected to be already-normalized E.164 values.
 */
export const matchesKnownContact = (
  callerE164: string,
  contactE164: string,
): boolean => callerE164 === contactE164;
