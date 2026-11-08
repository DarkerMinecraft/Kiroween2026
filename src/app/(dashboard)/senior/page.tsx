import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { loadSeniorDashboard } from "@/lib/dashboard/senior";
import { FORWARDING_STATES } from "@/lib/constants";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Senior_Dashboard (`/senior`).
 *
 * A React Server Component that resolves the Better Auth session for the
 * current request, loads the authenticated Senior's dashboard data, and
 * renders it. Data loading lives in `loadSeniorDashboard`, scoped strictly to
 * the authenticated account's user id, so the page only ever displays the
 * signed-in Senior's Call_Records, Known_Contacts, and forwarding status
 * (Req 10.1-10.6).
 *
 * If `loadSeniorDashboard` throws, the error propagates to the sibling
 * `error.tsx` boundary, which shows a load-failure message and never falls
 * back to another Senior's data (Req 10.7). An unauthenticated request is sent
 * to the sign-in page rather than rendered.
 *
 * Next.js requires the page component to be the file's default export; it is
 * defined as an arrow-function const and default-exported per the App Router
 * file-convention exception to the workspace named-export rule.
 */

/** Formats a Call_Record timestamp for display in a stable, readable form. */
const formatTimestamp = (value: Date): string =>
  new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);

/** Renders the forwarding status as exactly `active` or `inactive` (Req 10.5). */
const ForwardingStatusBadge = ({ status }: { status: string }) => {
  const isActive = status === FORWARDING_STATES.active;
  return (
    <span
      className={
        isActive
          ? "inline-flex items-center rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-600 ring-1 ring-emerald-500/30"
          : "inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground ring-1 ring-foreground/10"
      }
    >
      {status}
    </span>
  );
};

/**
 * Reads the Better Auth session at request time, so under Cache Components this
 * route can't be prerendered. Keep it a blocking server render.
 */
export const instant = false;

const SeniorDashboardPage = async () => {
  const session = await auth.api.getSession({ headers: await headers() });

  if (!session) {
    redirect("/");
  }

  const data = await loadSeniorDashboard(session.user.id);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-xl font-semibold">Your calls</h1>
          <p className="text-sm text-muted-foreground">
            Recent calls and the people you know.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Forwarding</span>
          <ForwardingStatusBadge status={data.forwardingStatus} />
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Recent calls</CardTitle>
          <CardDescription>
            Your 20 most recent calls, newest first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.callRecords.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No calls have been received yet.
            </p>
          ) : (
            <ul className="divide-y divide-foreground/10">
              {data.callRecords.map((record) => (
                <li
                  key={record.id}
                  className="flex items-center justify-between gap-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {record.knownContactName ?? record.callerIdentifier}
                    </p>
                    {record.knownContactName && (
                      <p className="truncate text-xs text-muted-foreground">
                        {record.callerIdentifier}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-xs text-muted-foreground">
                      {formatTimestamp(record.timestamp)}
                    </span>
                    <span className="text-xs font-medium">{record.outcome}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Known contacts</CardTitle>
          <CardDescription>
            People whose calls reach you without screening.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.knownContacts.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              You have no known contacts yet.
            </p>
          ) : (
            <ul className="divide-y divide-foreground/10">
              {data.knownContacts.map((contact) => (
                <li
                  key={contact.id}
                  className="flex items-center justify-between gap-4 py-3"
                >
                  <span className="truncate font-medium">
                    {contact.displayName ?? contact.e164Number}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {contact.e164Number}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
};

export default SeniorDashboardPage;
