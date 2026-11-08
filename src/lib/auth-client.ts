import { createAuthClient } from "better-auth/react";

/**
 * Better Auth client for use in React components.
 *
 * Exposes hooks and methods such as `signIn`, `signUp`, `signOut`, and
 * `useSession`. The base URL defaults to the current origin; set
 * NEXT_PUBLIC_BETTER_AUTH_URL to override it.
 */
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL,
});

export const { signIn, signUp, signOut, useSession } = authClient;
