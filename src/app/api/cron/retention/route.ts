import { deleteExpiredCallRecords } from "@/lib/retention";

/**
 * Call_Record retention cron endpoint.
 *
 * A scheduled caller (e.g. a platform cron trigger) hits this route to sweep
 * Call_Records whose age exceeds the configured retention window
 * (RetentionConfig, 1..3650 days, default 365). See `src/lib/retention.ts` for
 * the pure decision logic; this file is only the HTTP shell.
 *
 * Access is gated by a shared secret from `CRON_SECRET`, supplied either as an
 * `Authorization: Bearer <secret>` header or a `?token=<secret>` query param.
 * Any mismatch (or an unset secret) returns HTTP 403.
 */

// This endpoint reads the request (auth header / token) and mutates data on
// every call, so it is inherently dynamic. Under Cache Components the explicit
// `export const dynamic = "force-dynamic"` segment config is disallowed, so it
// is intentionally omitted here.

const BEARER_PREFIX = "Bearer ";

/**
 * Constant-time-ish equality for the shared secret. Returns false whenever the
 * server secret is unset so the endpoint fails closed in misconfiguration.
 */
const isAuthorized = (request: Request): boolean => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization");
  if (header && header.startsWith(BEARER_PREFIX)) {
    if (header.slice(BEARER_PREFIX.length) === secret) return true;
  }

  const token = new URL(request.url).searchParams.get("token");
  return token === secret;
};

/** Runs the retention sweep and returns a JSON summary, or 403 on bad token. */
const handle = async (request: Request): Promise<Response> => {
  if (!isAuthorized(request)) {
    return Response.json(
      { ok: false, error: "forbidden" },
      { status: 403 },
    );
  }

  const { retentionDays, cutoff, deletedCount } =
    await deleteExpiredCallRecords();

  return Response.json({
    ok: true,
    retentionDays,
    cutoff: cutoff.toISOString(),
    deletedCount,
  });
};

/**
 * POST is the primary trigger for the retention sweep (mutating action).
 */
export const POST = (request: Request): Promise<Response> => handle(request);

/**
 * GET is supported so schedulers that can only issue GET requests can still
 * trigger the sweep; it performs the same token-gated deletion.
 */
export const GET = (request: Request): Promise<Response> => handle(request);
