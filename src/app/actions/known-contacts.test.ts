import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests for the Known_Contact allowlist Server Actions (task 12.2 / 12.3).
// `addKnownContact` composes `assertCareLink` (authz), pure E.164 normalization,
// and Prisma writes; all external dependencies are mocked so the tests exercise
// the action's own control flow: invalid-format rejection (no write), duplicate
// (seniorId, e164Number) rejection leaving the existing contact unchanged, and
// display-name storage on success.
// Validates: Requirements 5.2, 5.3

// --- Mock @/lib/authz: assertCareLink resolves (authorized) by default. ----
const assertCareLink = vi.fn<(caregiverUserId: string, seniorId: string) => Promise<void>>();

class AuthorizationError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "AuthorizationError";
    this.reason = reason;
  }
}

vi.mock("@/lib/authz", () => ({
  assertCareLink: (...args: [string, string]) => assertCareLink(...args),
  AuthorizationError,
}));

// --- Mock @/lib/prisma. ----------------------------------------------------
const knownContact = {
  findUnique: vi.fn(),
  create: vi.fn(),
  deleteMany: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: { knownContact },
}));

// `Prisma.PrismaClientKnownRequestError` is referenced by the action's
// duplicate backstop; a minimal stub with the same shape (name + `code`) is
// enough for the `instanceof` guard path, though these tests drive the
// duplicate case through the pre-check `findUnique` returning an existing row.
class PrismaClientKnownRequestError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "PrismaClientKnownRequestError";
    this.code = code;
  }
}

vi.mock("@/generated/prisma/client", () => ({
  Prisma: { PrismaClientKnownRequestError },
}));

// Import after mocks are registered so the action binds to the mocked modules.
const { addKnownContact } = await import("./known-contacts");

const CAREGIVER_ID = "user-caregiver-1";
const SENIOR_ID = "senior-1";

beforeEach(() => {
  vi.stubEnv("DEFAULT_PHONE_REGION", "US");

  assertCareLink.mockResolvedValue(undefined);
  knownContact.findUnique.mockReset();
  knownContact.create.mockReset();
  knownContact.deleteMany.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("addKnownContact", () => {
  it("rejects an invalid number format without creating a contact", async () => {
    const result = await addKnownContact({
      caregiverUserId: CAREGIVER_ID,
      seniorId: SENIOR_ID,
      number: "not-a-phone-number",
      displayName: "Alice",
    });

    expect(result).toEqual({
      ok: false,
      field: "number",
      message: expect.any(String),
    });
    // Validation precedes any read or write, so no row is created.
    expect(knownContact.findUnique).not.toHaveBeenCalled();
    expect(knownContact.create).not.toHaveBeenCalled();
  });

  it("rejects a duplicate (seniorId, e164Number), leaving the existing contact unchanged", async () => {
    knownContact.findUnique.mockResolvedValue({ id: "contact-existing" });

    const result = await addKnownContact({
      caregiverUserId: CAREGIVER_ID,
      seniorId: SENIOR_ID,
      number: "+14155559999",
      displayName: "Alice",
    });

    expect(result).toEqual({
      ok: false,
      field: "number",
      message: expect.any(String),
    });
    // The duplicate pre-check scopes by the composite unique key.
    expect(knownContact.findUnique).toHaveBeenCalledWith({
      where: { seniorId_e164Number: { seniorId: SENIOR_ID, e164Number: "+14155559999" } },
      select: { id: true },
    });
    // No create: the existing contact is retained untouched.
    expect(knownContact.create).not.toHaveBeenCalled();
  });

  it("stores the display name (<=100 chars) on a successful add", async () => {
    knownContact.findUnique.mockResolvedValue(null);
    knownContact.create.mockResolvedValue({ id: "contact-new" });

    const result = await addKnownContact({
      caregiverUserId: CAREGIVER_ID,
      seniorId: SENIOR_ID,
      number: "+14155559999",
      displayName: "Alice Smith",
    });

    expect(result).toEqual({ ok: true });
    expect(knownContact.create).toHaveBeenCalledTimes(1);
    const createArg = knownContact.create.mock.calls[0][0];
    expect(createArg.data).toEqual({
      seniorId: SENIOR_ID,
      e164Number: "+14155559999",
      displayName: "Alice Smith",
    });
  });

  it("rejects a display name longer than 100 characters without creating a contact", async () => {
    knownContact.findUnique.mockResolvedValue(null);

    const result = await addKnownContact({
      caregiverUserId: CAREGIVER_ID,
      seniorId: SENIOR_ID,
      number: "+14155559999",
      displayName: "x".repeat(101),
    });

    expect(result).toEqual({
      ok: false,
      field: "displayName",
      message: expect.any(String),
    });
    expect(knownContact.create).not.toHaveBeenCalled();
  });

  it("stores a null display name when none is provided", async () => {
    knownContact.findUnique.mockResolvedValue(null);
    knownContact.create.mockResolvedValue({ id: "contact-new" });

    const result = await addKnownContact({
      caregiverUserId: CAREGIVER_ID,
      seniorId: SENIOR_ID,
      number: "+14155559999",
    });

    expect(result).toEqual({ ok: true });
    const createArg = knownContact.create.mock.calls[0][0];
    expect(createArg.data.displayName).toBeNull();
  });

  it("returns an authorization failure when the care-link is absent", async () => {
    assertCareLink.mockRejectedValue(new AuthorizationError("care_link_absent", "no link"));

    const result = await addKnownContact({
      caregiverUserId: CAREGIVER_ID,
      seniorId: SENIOR_ID,
      number: "+14155559999",
      displayName: "Alice",
    });

    expect(result).toMatchObject({ ok: false, field: "authorization" });
    expect(knownContact.findUnique).not.toHaveBeenCalled();
    expect(knownContact.create).not.toHaveBeenCalled();
  });
});
