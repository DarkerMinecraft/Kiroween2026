import Link from "next/link";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { resolveRole } from "@/lib/authz";
import { ROLES } from "@/lib/constants";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Marketing home page for Senior Call Shield (`/`).
 *
 * A React Server Component (no client state) that introduces the product and
 * routes visitors to the sign-in / sign-up flow at `/login`. When a session is
 * already active it shows a "go to dashboard" link instead of the sign-in
 * call-to-action; the per-role dashboards resolve the effective role and land
 * the account on the right view.
 *
 * Content is derived from the project README: an email/password-authenticated,
 * Prisma + Better Auth app that screens inbound calls for the seniors a
 * caregiver looks after. Next.js requires the page component to be the file's
 * default export, defined here as an arrow-function const per the workspace
 * App Router file-convention exception.
 */

/** A single feature highlighted on the landing page. */
interface Feature {
  readonly title: string;
  readonly description: string;
}

/** The product capabilities surfaced to visitors, summarized from the README. */
const FEATURES: readonly Feature[] = [
  {
    title: "Call screening",
    description:
      "Inbound calls are screened and classified as Known, Allowed, Spam, or Fraud before they ever reach your senior.",
  },
  {
    title: "Protection numbers",
    description:
      "Each senior gets a dedicated protection number. Known contacts connect straight through; everyone else gets screened.",
  },
  {
    title: "Caregiver dashboards",
    description:
      "Review call history, AI call reports, known contacts, and forwarding status for every senior you care for.",
  },
  {
    title: "Family & partner billing",
    description:
      "Per-senior Family plans and per-member Partner plans, with billing kept in sync to active enrollment.",
  },
];

/**
 * This page reads the Better Auth session (via `headers()`) to decide between
 * the sign-in and dashboard calls-to-action, so under Cache Components it can't
 * be prerendered into the static shell. Opt it into a blocking server render
 * rather than streaming the whole page behind a Suspense boundary.
 */
export const instant = false;

/** Maps an effective role to its dashboard path for the "go to dashboard" link. */
const DASHBOARD_PATH_BY_ROLE: Record<string, string> = {
  [ROLES.caregiver]: "/caregiver",
  [ROLES.senior]: "/senior",
  [ROLES.partner]: "/partner",
};

const Home = async () => {
  const session = await auth.api.getSession({ headers: await headers() });

  // Point the signed-in call-to-action at the account's own dashboard. A
  // hardcoded `/caregiver` would bounce a Senior or Partner back here, since
  // each dashboard gates on role server-side. An account with no profile yet
  // has no dashboard, so it falls through to the signed-out call-to-action.
  const role = session ? await resolveRole(session.user.id) : null;
  const dashboardPath = role ? DASHBOARD_PATH_BY_ROLE[role] : undefined;

  return (
    <main className="flex flex-1 flex-col">
      <section className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-center gap-8 px-6 py-16 text-center">
        <div className="space-y-4">
          <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
            Senior Call Shield
          </p>
          <h1 className="font-heading text-4xl font-semibold tracking-tight sm:text-5xl">
            Protect the people you care for from unwanted calls.
          </h1>
          <p className="mx-auto max-w-2xl text-base text-muted-foreground sm:text-lg">
            Senior Call Shield screens inbound calls, connects the people your
            senior knows, and quietly turns away spam and fraud — so every ring
            is one you can trust.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          {dashboardPath ? (
            <Link
              href={dashboardPath}
              className={cn(buttonVariants({ size: "lg" }))}
            >
              Go to your dashboard
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                className={cn(buttonVariants({ size: "lg" }))}
              >
                Sign in
              </Link>
              <Link
                href="/login?mode=signup"
                className={cn(buttonVariants({ size: "lg", variant: "outline" }))}
              >
                Create an account
              </Link>
            </>
          )}
        </div>
      </section>

      <section className="mx-auto w-full max-w-4xl px-6 pb-20">
        <div className="grid gap-4 sm:grid-cols-2">
          {FEATURES.map((feature) => (
            <Card key={feature.title}>
              <CardHeader>
                <CardTitle className="text-base">{feature.title}</CardTitle>
                <CardDescription>{feature.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>
    </main>
  );
};

export default Home;
