import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  CALL_DISPOSITIONS,
  RISK_CATEGORIES,
  type RiskCategory,
} from "./constants";
import {
  dispositionForRisk,
  RISK_SCORE_MAX,
  RISK_SCORE_MIN,
  type RiskAssessment,
} from "./screening";

// Feature: senior-call-shield, Property 4: Risk category determines
// connect-vs-decline disposition. Known/Allowed callers are connected and
// Spam/Fraud callers are declined, across every valid integer score in the
// inclusive 0..100 range; scores outside that range or non-integers are a
// programming error and throw RangeError.
// Validates: Requirements 6.2, 6.4, 6.5

/** The four risk categories as a tuple for arbitrary selection. */
const riskCategoryValues = Object.values(RISK_CATEGORIES) as readonly RiskCategory[];

/** Arbitrary over the four {@link RISK_CATEGORIES} values. */
const riskCategoryArb: fc.Arbitrary<RiskCategory> = fc.constantFrom(
  ...riskCategoryValues,
);

/** Arbitrary over valid integer risk scores in the inclusive 0..100 range. */
const validScoreArb: fc.Arbitrary<number> = fc.integer({
  min: RISK_SCORE_MIN,
  max: RISK_SCORE_MAX,
});

/** Arbitrary over well-formed Risk_Assessments (valid category + valid score). */
const riskAssessmentArb: fc.Arbitrary<RiskAssessment> = fc.record({
  category: riskCategoryArb,
  score: validScoreArb,
});

/** Categories that must connect. */
const connectCategories = new Set<RiskCategory>([
  RISK_CATEGORIES.known,
  RISK_CATEGORIES.allowed,
]);

describe("dispositionForRisk (Property 4)", () => {
  it("maps Known/Allowed to connected and Spam/Fraud to declined for every valid score", () => {
    fc.assert(
      fc.property(riskAssessmentArb, (assessment) => {
        // Score is a valid integer inside the documented bound.
        expect(Number.isInteger(assessment.score)).toBe(true);
        expect(assessment.score).toBeGreaterThanOrEqual(RISK_SCORE_MIN);
        expect(assessment.score).toBeLessThanOrEqual(RISK_SCORE_MAX);

        const disposition = dispositionForRisk(assessment);
        const expected = connectCategories.has(assessment.category)
          ? CALL_DISPOSITIONS.connected
          : CALL_DISPOSITIONS.declined;

        expect(disposition).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });

  it("throws RangeError for out-of-range integer scores", () => {
    fc.assert(
      fc.property(
        riskCategoryArb,
        fc.integer().filter((n) => n < RISK_SCORE_MIN || n > RISK_SCORE_MAX),
        (category, score) => {
          expect(() => dispositionForRisk({ category, score })).toThrow(
            RangeError,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("throws RangeError for non-integer scores", () => {
    fc.assert(
      fc.property(
        riskCategoryArb,
        fc
          .double({ noNaN: true, noDefaultInfinity: true })
          .filter((n) => !Number.isInteger(n)),
        (category, score) => {
          expect(() => dispositionForRisk({ category, score })).toThrow(
            RangeError,
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
