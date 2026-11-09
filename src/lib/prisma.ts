import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * Prisma client singleton.
 *
 * Prisma 7 requires a driver adapter to connect; PostgreSQL uses
 * `@prisma/adapter-pg`, constructed from a Neon Postgres connection string.
 * Runtime queries prefer the pooled endpoint (`DATABASE_URL_POOLED`) so the
 * serverless/dev connection pattern does not exhaust or cold-timeout the
 * direct endpoint, falling back to `DATABASE_URL` when the pooled string is
 * not set. Migrations continue to use the direct `DATABASE_URL` via
 * `prisma7.config.ts`.
 *
 * In development, Next.js hot-reloading can otherwise create a new
 * PrismaClient on every reload and exhaust connections, so we cache the
 * instance on `globalThis` and reuse it across reloads.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Builds a PrismaClient wired to the PostgreSQL driver adapter.
 *
 * Prefers the pooled connection string (`DATABASE_URL_POOLED`) and falls back
 * to `DATABASE_URL`, and tunes query logging based on `NODE_ENV` (verbose
 * warnings in development, errors only otherwise).
 */
const createPrismaClient = () => {
  const adapter = new PrismaPg({
    connectionString:
      process.env.DATABASE_URL_POOLED ?? process.env.DATABASE_URL,
  });

  return new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? ["error", "warn"]
        : ["error"],
  });
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
