import { prisma } from "@/lib/prisma";

/**
 * Call_Record retention logic.
 *
 * Requirement 7.7: each Call_Record is retained for a configurable retention
 * period in whole days, ranging 1..3650 and defaulting to 365 when no value is
 * configured. Requirement 7.8: a Call_Record whose age exceeds the configured
 * period is deleted.
 *
 * The decision logic here is kept free of the HTTP layer so it can be unit
 * tested directly (task 16.2): `resolveRetentionDays` is pure, and
 * `deleteExpiredCallRecords` takes an injectable `now` and optional client.
 */

/** Minimum configurable retention window, in whole days. */
export const MIN_RETENTION_DAYS = 1;

/** Maximum configurable retention window, in whole days. */
export const MAX_RETENTION_DAYS = 3650;

/** Retention window applied when no valid value is configured. */
export const DEFAULT_RETENTION_DAYS = 365;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The shape of the stored retention configuration this module depends on. */
export interface RetentionConfigInput {
  retentionDays: number;
}

/** Summary of a retention sweep. */
export interface RetentionResult {
  retentionDays: number;
  cutoff: Date;
  deletedCount: number;
}

/** Minimal client surface the deletion step needs (eases testing). */
export interface RetentionPrismaClient {
  callRecord: {
    deleteMany: (args: {
      where: { startedAt: { lt: Date } };
    }) => Promise<{ count: number }>;
  };
}

/**
 * Resolves the effective retention window in whole days.
 *
 * Returns {@link DEFAULT_RETENTION_DAYS} when the config is absent or its value
 * is not a usable integer, and clamps any configured value into the inclusive
 * 1..3650 range.
 */
export const resolveRetentionDays = (
  config: RetentionConfigInput | null | undefined,
): number => {
  if (!config) return DEFAULT_RETENTION_DAYS;

  const { retentionDays } = config;
  if (!Number.isFinite(retentionDays)) return DEFAULT_RETENTION_DAYS;

  const whole = Math.trunc(retentionDays);
  if (whole < MIN_RETENTION_DAYS) return MIN_RETENTION_DAYS;
  if (whole > MAX_RETENTION_DAYS) return MAX_RETENTION_DAYS;

  return whole;
};

/**
 * Computes the deletion cutoff: Call_Records started strictly before this
 * instant have exceeded the retention window and are eligible for deletion.
 */
export const retentionCutoff = (now: Date, retentionDays: number): Date =>
  new Date(now.getTime() - retentionDays * MS_PER_DAY);

/**
 * Reads the configured retention window and deletes every Call_Record whose
 * start timestamp precedes the computed cutoff.
 *
 * The `now` argument is injected so tests can pin the clock, and `client`
 * defaults to the shared Prisma singleton.
 */
export const deleteExpiredCallRecords = async (
  now: Date = new Date(),
  client: RetentionPrismaClient = prisma,
): Promise<RetentionResult> => {
  const config = await prisma.retentionConfig.findFirst();
  const retentionDays = resolveRetentionDays(config);
  const cutoff = retentionCutoff(now, retentionDays);

  const { count } = await client.callRecord.deleteMany({
    where: { startedAt: { lt: cutoff } },
  });

  return { retentionDays, cutoff, deletedCount: count };
};
