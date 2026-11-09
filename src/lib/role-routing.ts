/**
 * Shared role → dashboard routing used by the Edge proxy, the post-auth server
 * action, and the marketing home page.
 *
 * The Edge proxy (`src/proxy.ts`) cannot read the database, so it relies on a
 * small, optimistic *role hint* cookie to route a signed-in visitor straight to
 * their dashboard without the extra `/caregiver` bounce. This module is the
 * single place that defines the cookie name, the role → path map, and the
 * default fallback, so the Edge proxy and the Node-side code that writes the
 * cookie never drift apart.
 *
 * SECURITY: the hint cookie is advisory only. It is used purely to pick which
 * dashboard to redirect to; it never grants access. Every dashboard RSC and
 * server action still calls `getSession` + `resolveRole` server-side, so a
 * spoofed or stale hint at worst sends the user to a dashboard that then
 * re-checks and redirects them. This matches the proxy's existing optimistic
 * posture (it already trusts mere cookie *presence* for routing).
 *
 * This file imports nothing from Prisma or Node APIs so it stays safe to import
 * from the Edge runtime.
 */

import { ROLES, type Role } from "@/lib/constants";

/**
 * Name of the optimistic role hint cookie. Read by the Edge proxy and written
 * by the client after a successful sign-in / sign-up.
 */
export const ROLE_HINT_COOKIE = "scs_role";

/** Dashboard path for a resolved {@link Role}. */
const DASHBOARD_PATH_BY_ROLE: Record<Role, string> = {
  [ROLES.caregiver]: "/caregiver",
  [ROLES.senior]: "/senior",
  [ROLES.partner]: "/partner",
};

/**
 * Where an authenticated visitor with no resolvable role hint is sent. The
 * caregiver dashboard re-checks the session and role server-side, so this is a
 * safe landing spot that will itself redirect a Senior or Partner onward.
 */
export const DEFAULT_DASHBOARD_PATH = "/caregiver";

/**
 * Maps a role string (e.g. from the hint cookie or `resolveRole`) to its
 * dashboard path, falling back to {@link DEFAULT_DASHBOARD_PATH} for an unknown,
 * missing, or not-yet-provisioned role.
 */
export const dashboardPathForRole = (role: string | null | undefined): string =>
  (role && DASHBOARD_PATH_BY_ROLE[role as Role]) || DEFAULT_DASHBOARD_PATH;
