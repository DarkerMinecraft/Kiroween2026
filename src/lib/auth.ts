import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
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
  // `nextCookies` MUST be the last plugin. Its `before` hook lets Better Auth
  // set the session cookie on the response when an `auth.api.*` method (e.g.
  // `signUpEmail`) is called from a Next.js Server Action — such as the
  // `registerCaregiver` action. Without it, that cookie-setting step produces a
  // response the Server Action runtime can't interpret, surfacing on the client
  // as "An unexpected response was received from the server."
  plugins: [nextCookies()],
  // Add social providers here, for example:
  // socialProviders: {
  //   github: {
  //     clientId: process.env.GITHUB_CLIENT_ID!,
  //     clientSecret: process.env.GITHUB_CLIENT_SECRET!,
  //   },
  // },
});
