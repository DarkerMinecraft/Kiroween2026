import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * Prisma client singleton.
 *
 * Prisma 7 requires a driver adapter to connect; PostgreSQL uses
 * `@prisma/adapter-pg`, constructed from the `DATABASE_URL` connection string
 * (a Neon Postgres URL in this project).
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
 * Reads the connection string from `DATABASE_URL` and tunes query logging
 * based on `NODE_ENV` (verbose warnings in development, errors only otherwise).
 */
const createPrismaClient = () => {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
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
