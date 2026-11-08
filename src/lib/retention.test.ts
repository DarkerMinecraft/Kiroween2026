import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Prisma mock -----------------------------------------------------------
//
// `deleteExpiredCallRecords` reads the stored window via
// `prisma.retentionConfig.findFirst` (the shared singleton) and deletes via an
// injectable client that defaults to that same singleton. Mocking `@/lib/prisma`
// lets us pin the configured window and observe the delete call without a real
// database.
//
// `vi.mock` factories are hoisted above the imports, so the shared method mocks
// are created inside `vi.hoisted` to exist before the factory runs.
const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    retentionConfig: {
      findFirst: vi.fn(),
    },
    callRecord: {
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// Imported after the mock is registered so the module picks up the mock.
import {
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  deleteExpiredCallRecords,
  resolveRetentionDays,
  retentionCutoff,
} from "./retention";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  prismaMock.retentionConfig.findFirst.mockReset();
  prismaMock.callRecord.deleteMany.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveRetentionDays", () => {
  it("defaults to 365 days when the config is null", () => {
    expect(resolveRetentionDays(null)).toBe(DEFAULT_RETENTION_DAYS);
    expect(DEFAULT_RETENTION_DAYS).toBe(365);
  });

  it("defaults to 365 days when the config is undefined", () => {
    expect(resolveRetentionDays(undefined)).toBe(DEFAULT_RETENTION_DAYS);
  });

  it("passes a valid in-range value through unchanged", () => {
    expect(resolveRetentionDays({ retentionDays: 30 })).toBe(30);
    expect(resolveRetentionDays({ retentionDays: 365 })).toBe(365);
    expect(resolveRetentionDays({ retentionDays: 3650 })).toBe(3650);
  });

  it("clamps values below the minimum up to 1 day", () => {
    expect(resolveRetentionDays({ retentionDays: 0 })).toBe(MIN_RETENTION_DAYS);
    expect(resolveRetentionDays({ retentionDays: -10 })).toBe(
      MIN_RETENTION_DAYS,
    );
    expect(MIN_RETENTION_DAYS).toBe(1);
  });

  it("clamps values above the maximum down to 3650 days", () => {
    expect(resolveRetentionDays({ retentionDays: 3651 })).toBe(
      MAX_RETENTION_DAYS,
    );
    expect(resolveRetentionDays({ retentionDays: 1_000_000 })).toBe(
      MAX_RETENTION_DAYS,
    );
    expect(MAX_RETENTION_DAYS).toBe(3650);
  });

  it("truncates fractional values toward zero before clamping", () => {
    expect(resolveRetentionDays({ retentionDays: 30.9 })).toBe(30);
  });

  it("falls back to the default for non-finite values", () => {
    expect(resolveRetentionDays({ retentionDays: Number.NaN })).toBe(
      DEFAULT_RETENTION_DAYS,
    );
    expect(resolveRetentionDays({ retentionDays: Number.POSITIVE_INFINITY })).toBe(
      DEFAULT_RETENTION_DAYS,
    );
  });
});

describe("retentionCutoff", () => {
  it("computes the cutoff as now minus the retention window", () => {
    const now = new Date("2026-06-15T00:00:00.000Z");
    const cutoff = retentionCutoff(now, 365);

    expect(cutoff.getTime()).toBe(now.getTime() - 365 * MS_PER_DAY);
  });
});

describe("deleteExpiredCallRecords", () => {
  it("deletes records older than the configured window and keeps newer ones", async () => {
    // Configure a 30-day window.
    prismaMock.retentionConfig.findFirst.mockResolvedValue({
      retentionDays: 30,
    });
    prismaMock.callRecord.deleteMany.mockResolvedValue({ count: 2 });

    const now = new Date("2026-06-15T00:00:00.000Z");
    const result = await deleteExpiredCallRecords(now, prismaMock);

    const expectedCutoff = new Date(now.getTime() - 30 * MS_PER_DAY);

    // The sweep targets exactly the records started before the cutoff — i.e.
    // older records are deleted while anything at or after the cutoff is kept.
    expect(prismaMock.callRecord.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.callRecord.deleteMany).toHaveBeenCalledWith({
      where: { startedAt: { lt: expectedCutoff } },
    });

    // The deleted record (e.g. 31 days old) sits before the cutoff; a 29-day
    // old record sits at/after the cutoff and is excluded by the `lt` clause.
    const olderThanWindow = new Date(now.getTime() - 31 * MS_PER_DAY);
    const newerThanWindow = new Date(now.getTime() - 29 * MS_PER_DAY);
    expect(olderThanWindow.getTime()).toBeLessThan(expectedCutoff.getTime());
    expect(newerThanWindow.getTime()).toBeGreaterThanOrEqual(
      expectedCutoff.getTime(),
    );

    expect(result.retentionDays).toBe(30);
    expect(result.cutoff).toEqual(expectedCutoff);
    expect(result.deletedCount).toBe(2);
  });

  it("applies the 365-day default when no RetentionConfig row exists", async () => {
    prismaMock.retentionConfig.findFirst.mockResolvedValue(null);
    prismaMock.callRecord.deleteMany.mockResolvedValue({ count: 0 });

    const now = new Date("2026-06-15T00:00:00.000Z");
    const result = await deleteExpiredCallRecords(now, prismaMock);

    const expectedCutoff = new Date(
      now.getTime() - DEFAULT_RETENTION_DAYS * MS_PER_DAY,
    );

    expect(result.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(prismaMock.callRecord.deleteMany).toHaveBeenCalledWith({
      where: { startedAt: { lt: expectedCutoff } },
    });
    expect(result.cutoff).toEqual(expectedCutoff);
    expect(result.deletedCount).toBe(0);
  });

  it("returns the deletedCount reported by the client", async () => {
    prismaMock.retentionConfig.findFirst.mockResolvedValue({
      retentionDays: 90,
    });
    prismaMock.callRecord.deleteMany.mockResolvedValue({ count: 7 });

    const result = await deleteExpiredCallRecords(
      new Date("2026-01-01T00:00:00.000Z"),
      prismaMock,
    );

    expect(result.deletedCount).toBe(7);
  });

  it("clamps an out-of-range configured window before computing the cutoff", async () => {
    prismaMock.retentionConfig.findFirst.mockResolvedValue({
      retentionDays: 10_000,
    });
    prismaMock.callRecord.deleteMany.mockResolvedValue({ count: 0 });

    const now = new Date("2026-06-15T00:00:00.000Z");
    const result = await deleteExpiredCallRecords(now, prismaMock);

    const expectedCutoff = new Date(
      now.getTime() - MAX_RETENTION_DAYS * MS_PER_DAY,
    );

    expect(result.retentionDays).toBe(MAX_RETENTION_DAYS);
    expect(prismaMock.callRecord.deleteMany).toHaveBeenCalledWith({
      where: { startedAt: { lt: expectedCutoff } },
    });
  });
});
