import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

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
 * - An authenticated request to `/login` is redirected to the dashboard, so a
 *   signed-in user never sees the sign-in form.
 *
 * Next.js 16 supports a named `proxy` export or a default export; a named
 * export is used here. The `getSessionCookie` helper is Edge-safe because it
 * inspects the request cookie rather than calling the auth server.
 */

/** Dashboard route prefixes that require an authenticated session. */
const PROTECTED_PREFIXES = ["/caregiver", "/senior", "/partner"] as const;

/** The dedicated sign-in / sign-up route. */
const LOGIN_PATH = "/login";

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

  // Keep authenticated visitors off the sign-in page.
  if (pathname === LOGIN_PATH && hasSession) {
    return NextResponse.redirect(new URL("/caregiver", request.url));
  }

  return NextResponse.next();
};

/**
 * Limit the proxy to app routes: skip Next internals, the auth/billing/etc.
 * API handlers, and static assets. Dashboards and `/login` still match.
 */
export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
