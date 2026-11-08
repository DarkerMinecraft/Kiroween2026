import { describe, expect, it } from "vitest";
import fc from "fast-check";
import examples from "libphonenumber-js/examples.mobile.json";
import {
  getExampleNumber,
  type CountryCode,
} from "libphonenumber-js";

import { normalizeToE164, type DefaultRegion } from "@/lib/phone";

// Feature: senior-call-shield, Property 1: E.164 normalization is idempotent.
// For any telephone number value that normalizes to a valid E.164 string,
// normalizing that already-normalized E.164 value again produces a
// character-for-character identical E.164 value (design Property 1).
//
// Validates: Requirements 11.5, 11.1

const DEFAULT_REGION: DefaultRegion = "US";

// A spread of ISO-3166 regions whose metadata ships with libphonenumber-js, so
// the generated numbers exercise a range of country codes and national-number
// lengths rather than a single dialing plan.
const REGIONS: readonly CountryCode[] = [
  "US",
  "GB",
  "DE",
  "FR",
  "JP",
  "AU",
  "BR",
  "IN",
  "ZA",
  "MX",
] as const;

// Arbitrary producing known-valid E.164 numbers. For each sampled region we take
// libphonenumber-js's canonical example number and emit its E.164 form. These are
// guaranteed to satisfy `isValid()`, so the first normalization always succeeds
// and the property under test is the idempotence of the second pass.
const validE164 = (): fc.Arbitrary<string> =>
  fc
    .constantFrom(...REGIONS)
    .map((region) => getExampleNumber(region, examples))
    .filter((parsed): parsed is NonNullable<typeof parsed> => parsed != null)
    .map((parsed) => parsed.number);

// Arbitrary producing valid numbers in loose, human-entered formats (spaces,
// hyphens, parentheses) so normalization has real work to do before the second,
// idempotent pass. Formats are derived from a known-valid example number.
const looselyFormatted = (): fc.Arbitrary<string> =>
  fc
    .constantFrom(...REGIONS)
    .map((region) => getExampleNumber(region, examples))
    .filter((parsed): parsed is NonNullable<typeof parsed> => parsed != null)
    .chain((parsed) =>
      fc.constantFrom(
        parsed.number, // E.164: +14155552671
        parsed.formatInternational(), // +1 415 555 2671
        parsed.formatInternational().replace(/\s+/g, "-"), // +1-415-555-2671
      ),
    );

describe("Property 1: E.164 normalization is idempotent", () => {
  it("normalizing an already-normalized E.164 value yields an identical string", () => {
    fc.assert(
      fc.property(validE164(), (e164) => {
        const first = normalizeToE164(e164, DEFAULT_REGION);
        // The generated inputs are always valid, so the first pass must succeed.
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        const second = normalizeToE164(first.e164, DEFAULT_REGION);
        expect(second.ok).toBe(true);
        if (!second.ok) return;

        // Character-for-character identity between the two normalized forms.
        expect(second.e164).toBe(first.e164);
      }),
      { numRuns: 500 },
    );
  });

  it("idempotence holds regardless of the input's original formatting", () => {
    fc.assert(
      fc.property(looselyFormatted(), (input) => {
        const first = normalizeToE164(input, DEFAULT_REGION);
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        const second = normalizeToE164(first.e164, DEFAULT_REGION);
        expect(second.ok).toBe(true);
        if (!second.ok) return;

        expect(second.e164).toBe(first.e164);
      }),
      { numRuns: 500 },
    );
  });
});
