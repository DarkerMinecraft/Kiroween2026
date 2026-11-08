import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

/**
 * Catch-all route handler that mounts the Better Auth API under
 * `/api/auth/*`. All sign-in, sign-up, session, and OAuth callback endpoints
 * are served from here.
 */
export const { GET, POST } = toNextJsHandler(auth);
