import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Feature: senior-call-shield, Property 7: Care-link scoping confines Senior
// data to linked caregivers. For every generated caregiver/senior pair,
// `assertCareLink` resolves without throwing exactly when the caregiver has a
// profile AND an ACTIVE Care_Link to that senior; in every other case (missing
// caregiver profile, no link row, or an inactive link) it throws
// AuthorizationError and returns no data.
// Validates: Requirements 2.4, 2.5, 7.4, 8.5, 9.4

/**
 * In-memory stand-ins for the two Prisma tables `assertCareLink` reads. The
 * mock below closes over these; each generated case rewrites them so no real
 * database is touched.
 */
interface CaregiverRow {
  readonly id: string;
  readonly userId: string;
}

interface CareLinkRow {
  readonly caregiverId: string;
  readonly seniorId: string;
  readonly active: boolean;
}

/** caregiverUserId -> caregiver profile row. */
const caregiverProfiles = new Map<string, CaregiverRow>();
/** `${caregiverId}::${seniorId}` -> care-link row. */
const careLinks = new Map<string, CareLinkRow>();

const linkKey = (caregiverId: string, seniorId: string): string =>
  `${caregiverId}::${seniorId}`;

// Model the shared Prisma client as an in-memory lookup. `vi.mock` is hoisted,
// so the factory must not reference outer non-hoisted bindings except through
// the closures it defines here; the Maps above are module-level and safe.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    caregiverProfile: {
      findUnique: vi.fn(
        async ({ where }: { where: { userId: string } }) => {
          const row = caregiverProfiles.get(where.userId);
          return row ? { id: row.id } : null;
        },
      ),
    },
    careLink: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: {
            caregiverId_seniorId: { caregiverId: string; seniorId: string };
          };
        }) => {
          const { caregiverId, seniorId } = where.caregiverId_seniorId;
          const row = careLinks.get(linkKey(caregiverId, seniorId));
          return row ? { active: row.active } : null;
        },
      ),
    },
  },
}));

import { assertCareLink, AuthorizationError } from "./authz";

/** Non-empty opaque id generator (cuid-like for the purpose of the test). */
const idArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 24 })
  .filter((s) => s.trim().length > 0);

/**
 * A generated scenario: the caregiver account, the target senior, and the
 * shape of the backing rows. `hasProfile` controls whether a CaregiverProfile
 * exists; `linkState` controls the Care_Link row.
 */
interface Scenario {
  readonly caregiverUserId: string;
  readonly caregiverId: string;
  readonly seniorId: string;
  readonly hasProfile: boolean;
  readonly linkState: "active" | "inactive" | "absent";
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  caregiverUserId: idArb,
  caregiverId: idArb,
  seniorId: idArb,
  hasProfile: fc.boolean(),
  linkState: fc.constantFrom("active", "inactive", "absent"),
});

/** Resets the in-memory tables and loads the rows implied by a scenario. */
const applyScenario = (s: Scenario): void => {
  caregiverProfiles.clear();
  careLinks.clear();

  if (s.hasProfile) {
    caregiverProfiles.set(s.caregiverUserId, {
      id: s.caregiverId,
      userId: s.caregiverUserId,
    });
  }

  if (s.linkState !== "absent") {
    careLinks.set(linkKey(s.caregiverId, s.seniorId), {
      caregiverId: s.caregiverId,
      seniorId: s.seniorId,
      active: s.linkState === "active",
    });
  }
};

/** Linked = caregiver profile exists AND an active care-link exists. */
const isLinked = (s: Scenario): boolean =>
  s.hasProfile && s.linkState === "active";

describe("assertCareLink (Property 7)", () => {
  beforeEach(() => {
    caregiverProfiles.clear();
    careLinks.clear();
  });

  it("resolves only when linked and otherwise throws AuthorizationError", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        applyScenario(scenario);

        if (isLinked(scenario)) {
          // Linked: the assertion must resolve to undefined, no throw, no data.
          await expect(
            assertCareLink(scenario.caregiverUserId, scenario.seniorId),
          ).resolves.toBeUndefined();
          return;
        }

        // Not linked: must throw AuthorizationError with a scoping reason, and
        // the call must surface no settings (it resolves to void or throws).
        await expect(
          assertCareLink(scenario.caregiverUserId, scenario.seniorId),
        ).rejects.toBeInstanceOf(AuthorizationError);

        try {
          await assertCareLink(scenario.caregiverUserId, scenario.seniorId);
          throw new Error("expected assertCareLink to throw");
        } catch (error) {
          expect(error).toBeInstanceOf(AuthorizationError);
          const reason = (error as AuthorizationError).reason;
          const expectedReason = scenario.hasProfile
            ? "care_link_absent"
            : "not_caregiver";
          expect(reason).toBe(expectedReason);
        }
      }),
      { numRuns: 200 },
    );
  });
});
