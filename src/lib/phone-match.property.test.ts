import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { matchesKnownContact } from "./phone";

// Feature: senior-call-shield, Property 2: Known-contact matching is exact on
// normalized forms.
//
// For any stored Known_Contact and any inbound Caller_Number, the system treats
// the caller as matching that Known_Contact if and only if their full E.164
// normalized strings are character-for-character identical. There is no
// partial, prefix, or numeric-equivalence matching.
//
// Validates: Requirements 11.3, 5.4

/**
 * Arbitrary producing E.164-like strings: a leading `+`, a non-zero leading
 * digit, and 1-14 further digits (total 2-15 digits), mirroring the shape of a
 * normalized E.164 value produced by `normalizeToE164`.
 */
const e164Like: fc.Arbitrary<string> = fc
  .tuple(
    fc.integer({ min: 1, max: 9 }),
    fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength: 14 }),
  )
  .map(([lead, rest]) => `+${lead}${rest.join("")}`);

describe("matchesKnownContact (Property 2: exact normalized-form matching)", () => {
  it("matches if and only if the normalized strings are character-for-character identical", () => {
    fc.assert(
      fc.property(e164Like, e164Like, (caller, contact) => {
        const identical = caller === contact;
        expect(matchesKnownContact(caller, contact)).toBe(identical);
      }),
      { numRuns: 200 },
    );
  });

  it("always matches when the same normalized value is supplied for both sides", () => {
    fc.assert(
      fc.property(e164Like, (value) => {
        expect(matchesKnownContact(value, value)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("never matches when a single character differs", () => {
    // Build a differing pair from a base string by mutating exactly one digit,
    // guaranteeing the two strings are not character-for-character identical.
    const differingPair = e164Like
      .chain((base) =>
        fc
          .tuple(
            fc.integer({ min: 1, max: base.length - 1 }),
            fc.integer({ min: 0, max: 9 }),
          )
          .map(([index, replacement]) => {
            const current = base[index];
            // Pick a digit different from the current one at that position.
            const newDigit =
              current === String(replacement)
                ? String((replacement + 1) % 10)
                : String(replacement);
            const mutated =
              base.slice(0, index) + newDigit + base.slice(index + 1);
            return [base, mutated] as const;
          }),
      )
      .filter(([base, mutated]) => base !== mutated);

    fc.assert(
      fc.property(differingPair, ([base, mutated]) => {
        expect(matchesKnownContact(base, mutated)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
