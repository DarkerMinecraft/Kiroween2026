import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { ROLE_HINT_COOKIE, dashboardPathForRole } from "@/lib/role-routing";

/**
 * Proxy (Next.js 16's renamed Middleware) for optimistic auth routing.
 *
 * Runs before every matched request and performs an *optimistic* session
 * check: it only reads the Better Auth session cookie, never the database, so
 * it stays fast on every navigation (including prefetches). The authoritative
 * checks still live in each dashboard RSC and the Data Access Layer
 * (`getSession` + `resolveRole` / `assertCareLink`), per the Next.js auth
 * guidance that proxy is a pre-filter, not the only line of defense.
 *
 * Behavior:
 * - An unauthenticated request to a protected dashboard route is redirected to
 *   `/login`, preserving the original path in a `?from=` param so the login
 *   flow could return there later.
 * - An authenticated request to `/login` or the marketing home page (`/`) is
 *   redirected straight to the account's role dashboard, so a signed-in user
 *   never sees the sign-in form or the landing page. The destination comes from
 *   an optimistic `scs_role` hint cookie written after sign-in, so there is no
 *   `/caregiver` bounce; when the hint is missing it falls back to the default
 *   dashboard, which re-resolves the role server-side.
 *
 * Next.js 16 supports a named `proxy` export or a default export; a named
 * export is used here. Both `getSessionCookie` and the role hint cookie are
 * Edge-safe because they inspect the request cookies rather than calling the
 * auth server or the database. The role hint is advisory only — every dashboard
 * and server action re-verifies session and role server-side.
 */

/** Dashboard route prefixes that require an authenticated session. */
const PROTECTED_PREFIXES = ["/caregiver", "/senior", "/partner"] as const;

/** The dedicated sign-in / sign-up route. */
const LOGIN_PATH = "/login";

/** The marketing home page. */
const HOME_PATH = "/";

/**
 * Public routes a signed-in user has no reason to see: the sign-in / sign-up
 * form and the marketing landing page. Hitting either while authenticated
 * bounces the user straight to their dashboard.
 */
const SIGNED_IN_REDIRECT_PATHS: readonly string[] = [LOGIN_PATH, HOME_PATH];

/** True when `pathname` is (or sits under) one of the protected dashboards. */
const isProtectedPath = (pathname: string): boolean =>
  PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

export const proxy = (request: NextRequest): NextResponse => {
  const { pathname } = request.nextUrl;
  // Optimistic check only: presence of the signed session cookie, no DB read.
  const hasSession = getSessionCookie(request) !== null;

  // Keep unauthenticated visitors out of the dashboards.
  if (isProtectedPath(pathname) && !hasSession) {
    const loginUrl = new URL(LOGIN_PATH, request.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Keep authenticated visitors off the public sign-in and landing pages,
  // sending them straight to their role dashboard. The role hint cookie
  // (written after sign-in) lets us skip the `/caregiver` bounce; when it is
  // absent we fall back to the default dashboard, which re-checks server-side.
  if (hasSession && SIGNED_IN_REDIRECT_PATHS.includes(pathname)) {
    const role = request.cookies.get(ROLE_HINT_COOKIE)?.value ?? null;
    const destination = dashboardPathForRole(role);
    return NextResponse.redirect(new URL(destination, request.url));
  }

  return NextResponse.next();
};

/**
 * Limit the proxy to app routes: skip Next internals, the auth/billing/etc.
 * API handlers, and static assets. The home page, dashboards, and `/login`
 * still match so their auth routing runs.
 */
export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
