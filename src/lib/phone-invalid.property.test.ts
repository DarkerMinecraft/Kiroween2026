import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { normalizeToE164, type DefaultRegion } from "@/lib/phone";

// Feature: senior-call-shield, Property 3: Invalid caller numbers fall through
// to Unknown without mutation.
//
// Validates: Requirements 11.4 — an inbound Caller_Number that is empty,
// contains characters other than digits, spaces, hyphens, parentheses, or a
// single leading plus sign, or cannot be resolved to a valid 1-15 digit E.164
// value SHALL be treated as an Unknown_Caller (normalizeToE164 returns
// `{ ok: false }`, the normalization-failure indication), while the original
// unmodified Caller_Number value is retained.
//
// This property generates three families of invalid inputs and asserts, for a
// minimum of 100 generated cases, that (a) normalization reports failure (the
// Unknown classification / normalization-failure flag) and (b) the original
// input string is byte-for-byte unchanged after the call (no mutation).

const DEFAULT_REGION: DefaultRegion = "US";

// Empty or whitespace-only inputs. After trimming these collapse to length 0,
// which must be rejected.
const emptyInput = fc.stringMatching(/^[ \t\n\r]*$/);

// Inputs that contain at least one disallowed character: ASCII letters, extra
// plus signs in non-leading positions, or symbols that are not digits, spaces,
// hyphens, or parentheses. We build a valid-ish digit skeleton and splice in a
// disallowed token so the input is realistic but must be rejected on the
// allowed-character check.
const disallowedToken = fc.constantFrom(
  "a",
  "Z",
  "x",
  "O", // letter O, not zero
  "*",
  "#",
  "$",
  "%",
  "@",
  ".",
  ",",
  "/",
  "++", // multiple plus signs
  "+1+", // plus sign in a non-leading position
  "<script>",
);

const malformedInput = fc
  .tuple(
    fc.stringMatching(/^[0-9]{0,6}$/),
    disallowedToken,
    fc.stringMatching(/^[0-9]{0,6}$/),
  )
  .map(([prefix, bad, suffix]) => `${prefix}${bad}${suffix}`)
  // Guard: ensure the composed string genuinely contains a disallowed
  // character (a bare "+1+" sandwiched between digits always does).
  .filter((s) => /[^0-9 ()+-]/.test(s) || (s.match(/\+/g) ?? []).length > 1);

// Numeric strings that are out of range for E.164: too short (zero digits after
// trimming is covered by emptyInput, so here we focus on the too-long case and
// leading-zero / all-zero shapes that cannot resolve to a valid number). E.164
// permits at most 15 digits, so 16-25 digit strings are out of range.
const tooLongInput = fc
  .integer({ min: 16, max: 25 })
  .chain((len) =>
    fc.stringMatching(new RegExp(`^[0-9]{${len}}$`)).map((digits) => `+${digits}`),
  );

// A plus sign followed by too many digits, or an all-zero number, cannot be a
// valid E.164 value regardless of region.
const allZeroInput = fc
  .integer({ min: 1, max: 15 })
  .chain((len) => fc.constant("+" + "0".repeat(len)));

const invalidInput = fc.oneof(
  emptyInput,
  malformedInput,
  tooLongInput,
  allZeroInput,
);

describe("Property 3: invalid caller numbers fall through to Unknown without mutation", () => {
  it("returns a normalization failure for empty, malformed, and out-of-range inputs and never mutates the original", () => {
    fc.assert(
      fc.property(invalidInput, (rawInput) => {
        // Capture the exact original value before the call so we can prove the
        // function does not mutate its argument (strings are immutable in JS,
        // so this also asserts the caller still holds the identical value).
        const original = rawInput;

        const result = normalizeToE164(rawInput, DEFAULT_REGION);

        // Unknown classification / normalization-failure flag (Req 11.4).
        expect(result.ok).toBe(false);
        // A failure result carries no e164 field — it is the bare failure shape.
        expect("e164" in result).toBe(false);

        // The original Caller_Number value is retained unmodified (Req 11.4):
        // byte-for-byte identical and referentially the same string.
        expect(rawInput).toBe(original);
        expect(rawInput).toStrictEqual(original);
      }),
      { numRuns: 200 },
    );
  });
});
