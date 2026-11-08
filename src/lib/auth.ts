import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "@/lib/prisma";

/**
 * Better Auth server instance.
 *
 * Wired to Prisma via the Prisma adapter. Email/password sign-in is enabled
 * out of the box; add social providers, plugins, etc. as needed.
 *
 * Required environment variables:
 * - BETTER_AUTH_SECRET: random secret used to sign tokens/cookies.
 * - BETTER_AUTH_URL: the base URL of the app (e.g. http://localhost:3000).
 */
export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
  },
  // Add social providers here, for example:
  // socialProviders: {
  //   github: {
  //     clientId: process.env.GITHUB_CLIENT_ID!,
  //     clientSecret: process.env.GITHUB_CLIENT_SECRET!,
  //   },
  // },
});
