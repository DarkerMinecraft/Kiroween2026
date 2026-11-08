import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests for the Protection_Number provisioning Server Actions (task 12.1 /
// 12.3). The actions compose `assertCareLink` (authz), the SignalWire REST
// wrapper, and Prisma; all three are mocked so the tests exercise the action's
// own control flow — authorization, duplicate-active rejection, Personal_Number
// validation, provider-error handling with no partial state, and release
// success/failure — without touching the network or a database.
// Validates: Requirements 4.2, 4.4, 4.6, 4.8

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

// --- Mock @/lib/signalwire. ------------------------------------------------
const purchaseNumber = vi.fn();
const configureInboundHandler = vi.fn();
const releaseNumber = vi.fn();

class TelephonyError extends Error {
  readonly operation: string;
  readonly status?: number;
  constructor(operation: string, message: string, options?: { status?: number }) {
    super(message);
    this.name = "TelephonyError";
    this.operation = operation;
    this.status = options?.status;
  }
}

vi.mock("@/lib/signalwire", () => ({
  purchaseNumber: (...args: unknown[]) => purchaseNumber(...args),
  configureInboundHandler: (...args: unknown[]) => configureInboundHandler(...args),
  releaseNumber: (...args: unknown[]) => releaseNumber(...args),
  TelephonyError,
}));

// --- Mock @/lib/prisma. ----------------------------------------------------
const protectionNumber = {
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
};
const seniorProfile = { update: vi.fn() };
// `$transaction` receives an array of prepared Prisma promises; it awaits them
// all, mirroring the real client's array form used by releaseProtectionNumber.
const $transaction = vi.fn(async (ops: unknown[]) => Promise.all(ops));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    protectionNumber,
    seniorProfile,
    $transaction: (...args: unknown[]) => $transaction(...(args as [unknown[]])),
  },
}));

// Import after mocks are registered so the action binds to the mocked modules.
const { provisionProtectionNumber, releaseProtectionNumber } = await import("./provisioning");

const CAREGIVER_ID = "user-caregiver-1";
const SENIOR_ID = "senior-1";

beforeEach(() => {
  vi.stubEnv("TELEPHONY_WEBHOOK_SECRET", "shared-secret");
  vi.stubEnv("APP_BASE_URL", "https://mabel.example.com");
  vi.stubEnv("DEFAULT_PHONE_REGION", "US");

  assertCareLink.mockResolvedValue(undefined);
  purchaseNumber.mockReset();
  configureInboundHandler.mockReset().mockResolvedValue(undefined);
  releaseNumber.mockReset().mockResolvedValue(undefined);
  protectionNumber.findUnique.mockReset();
  protectionNumber.create.mockReset();
  protectionNumber.update.mockReset();
  protectionNumber.upsert.mockReset();
  protectionNumber.delete.mockReset();
  seniorProfile.update.mockReset();
  $transaction.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("provisionProtectionNumber", () => {
  it("provisions an active ProtectionNumber and configures the inbound handler on success", async () => {
    protectionNumber.findUnique.mockResolvedValue(null);
    purchaseNumber.mockResolvedValue({ e164: "+14155550123", signalwireId: "pn-abc" });
    protectionNumber.upsert.mockResolvedValue({
      id: "prot-1",
      e164Number: "+14155550123",
      provisioningState: "active",
    });

    const result = await provisionProtectionNumber({
      caregiverUserId: CAREGIVER_ID,
      seniorId: SENIOR_ID,
      personalNumber: "+14155559999",
    });

    expect(result).toEqual({
      ok: true,
      data: {
        protectionNumberId: "prot-1",
        e164Number: "+14155550123",
        provisioningState: "active",
      },
    });

    expect(purchaseNumber).toHaveBeenCalledTimes(1);
    expect(configureInboundHandler).toHaveBeenCalledTimes(1);
    const [numberId, swmlUrl] = configureInboundHandler.mock.calls[0];
    expect(numberId).toBe("pn-abc");
    expect(swmlUrl).toBe(
      "https://mabel.example.com/api/telephony/inbound?token=shared-secret",
    );

    // The persisted row is active and stores the normalized Personal_Number.
    const upsertArg = protectionNumber.upsert.mock.calls[0][0];
    expect(upsertArg.create.provisioningState).toBe("active");
    expect(upsertArg.create.personalNumber).toBe("+14155559999");
    expect(upsertArg.create.signalwireId).toBe("pn-abc");
  });

  it("rejects a duplicate when an active ProtectionNumber already exists, retaining it", async () => {
    protectionNumber.findUnique.mockResolvedValue({ provisioningState: "active" });

    const result = await provisionProtectionNumber({
      caregiverUserId: CAREGIVER_ID,
      seniorId: SENIOR_ID,
      personalNumber: "+14155559999",
    });

    expect(result).toEqual({
      ok: false,
      code: "already_active",
      message: expect.any(String),
    });

    // No provider call and no write occurred: the existing number is retained.
    expect(purchaseNumber).not.toHaveBeenCalled();
    expect(configureInboundHandler).not.toHaveBeenCalled();
    expect(protectionNumber.upsert).not.toHaveBeenCalled();
    expect(protectionNumber.update).not.toHaveBeenCalled();
    expect(protectionNumber.delete).not.toHaveBeenCalled();
  });

  it("rejects an empty Personal_Number before any provider call", async () => {
    protectionNumber.findUnique.mockResolvedValue(null);

    const result = await provisionProtectionNumber({
      caregiverUserId: CAREGIVER_ID,
      seniorId: SENIOR_ID,
      personalNumber: "",
    });

    expect(result).toEqual({
      ok: false,
      code: "invalid_personal_number",
      message: expect.any(String),
    });
    expect(purchaseNumber).not.toHaveBeenCalled();
    expect(protectionNumber.upsert).not.toHaveBeenCalled();
  });

  it("rejects a non-E.164 Personal_Number before any provider call", async () => {
    protectionNumber.findUnique.mockResolvedValue(null);

    const result = await provisionProtectionNumber({
      caregiverUserId: CAREGIVER_ID,
      seniorId: SENIOR_ID,
      personalNumber: "not-a-phone-number",
    });

    expect(result).toEqual({
      ok: false,
      code: "invalid_personal_number",
      message: expect.any(String),
    });
    expect(purchaseNumber).not.toHaveBeenCalled();
    expect(protectionNumber.upsert).not.toHaveBeenCalled();
  });

  it("on a SignalWire error records provisioningState=failed with NO Personal_Number and reports failure", async () => {
    protectionNumber.findUnique.mockResolvedValue(null);
    purchaseNumber.mockRejectedValue(new TelephonyError("purchaseNumber", "provider down", { status: 502 }));
    protectionNumber.upsert.mockResolvedValue({});

    const result = await provisionProtectionNumber({
      caregiverUserId: CAREGIVER_ID,
      seniorId: SENIOR_ID,
      personalNumber: "+14155559999",
    });

    expect(result).toMatchObject({ ok: false, code: "telephony_error" });

    // The failed attempt is recorded as `failed` with an empty Personal_Number.
    expect(protectionNumber.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = protectionNumber.upsert.mock.calls[0][0];
    expect(upsertArg.create.provisioningState).toBe("failed");
    expect(upsertArg.create.personalNumber).toBe("");
    expect(upsertArg.update.provisioningState).toBe("failed");
    expect(upsertArg.update.personalNumber).toBe("");
    // The inbound handler was never configured for a failed purchase.
    expect(configureInboundHandler).not.toHaveBeenCalled();
  });

  it("returns an authorization failure when the care-link is absent", async () => {
    assertCareLink.mockRejectedValue(new AuthorizationError("care_link_absent", "no link"));

    const result = await provisionProtectionNumber({
      caregiverUserId: CAREGIVER_ID,
      seniorId: SENIOR_ID,
      personalNumber: "+14155559999",
    });

    expect(result).toMatchObject({ ok: false, code: "unauthorized" });
    expect(protectionNumber.findUnique).not.toHaveBeenCalled();
    expect(purchaseNumber).not.toHaveBeenCalled();
  });
});

describe("releaseProtectionNumber", () => {
  it("deactivates forwarding and removes the number on a successful release", async () => {
    protectionNumber.findUnique.mockResolvedValue({ id: "prot-1", signalwireId: "pn-abc" });

    const result = await releaseProtectionNumber({
      caregiverUserId: CAREGIVER_ID,
      seniorId: SENIOR_ID,
    });

    expect(result).toEqual({ ok: true });
    expect(releaseNumber).toHaveBeenCalledWith("pn-abc");
    // Forwarding deactivated and the row removed together in one transaction.
    expect(seniorProfile.update).toHaveBeenCalledWith({
      where: { id: SENIOR_ID },
      data: { forwardingActive: false },
    });
    expect(protectionNumber.delete).toHaveBeenCalledWith({ where: { id: "prot-1" } });
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  it("keeps the number active and reports failure when the SignalWire release fails", async () => {
    protectionNumber.findUnique.mockResolvedValue({ id: "prot-1", signalwireId: "pn-abc" });
    releaseNumber.mockRejectedValue(new TelephonyError("releaseNumber", "release failed", { status: 500 }));

    const result = await releaseProtectionNumber({
      caregiverUserId: CAREGIVER_ID,
      seniorId: SENIOR_ID,
    });

    expect(result).toMatchObject({ ok: false, code: "telephony_error" });
    // Nothing was torn down: the number is kept active and forwarding unchanged.
    expect($transaction).not.toHaveBeenCalled();
    expect(seniorProfile.update).not.toHaveBeenCalled();
    expect(protectionNumber.delete).not.toHaveBeenCalled();
  });

  it("reports not_provisioned when the senior has no Protection_Number", async () => {
    protectionNumber.findUnique.mockResolvedValue(null);

    const result = await releaseProtectionNumber({
      caregiverUserId: CAREGIVER_ID,
      seniorId: SENIOR_ID,
    });

    expect(result).toMatchObject({ ok: false, code: "not_provisioned" });
    expect(releaseNumber).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });
});
