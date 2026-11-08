import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  loadPartnerDashboard,
  type PartnerBillingSummary,
  type PartnerMemberSummary,
} from "@/lib/dashboard/partner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { type SubscriptionState } from "@/lib/constants";

/**
 * Human-readable labels for each per-member Subscription state. Keyed by the
 * `SUBSCRIPTION_STATES` values (a const map, not an enum) so the union stays
 * exhaustive. `null` (no Subscription yet) is handled separately by the caller.
 */
const SUBSCRIPTION_STATE_LABELS: Record<SubscriptionState, string> = {
  active: "Active",
  past_due: "Past due",
  canceled: "Canceled",
  incomplete: "Incomplete",
};

/**
 * Renders the per-member Subscription state and billed quantity. Shows a
 * "no subscription yet" copy when the Partner has not established a per-member
 * plan (Req 13.5).
 */
const BillingSummaryCard = ({ billing }: { billing: PartnerBillingSummary }) => {
  const stateLabel =
    billing.state === null
      ? "No active subscription"
      : SUBSCRIPTION_STATE_LABELS[billing.state];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Per-member billing</CardTitle>
        <CardDescription>
          Your per-member subscription state and the quantity you are billed
          for.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <p className="text-muted-foreground">Subscription state</p>
          <p className="text-sm font-medium">{stateLabel}</p>
        </div>
        <div className="space-y-1">
          <p className="text-muted-foreground">Billed quantity</p>
          <p className="text-sm font-medium">{billing.quantity}</p>
        </div>
      </CardContent>
    </Card>
  );
};

/**
 * Lists the Partner's own active enrolled members, or an empty state when the
 * Partner manages none. Each member is already scoped to this Partner by the
 * loader, so nothing here can surface another Partner's member.
 */
const MembersCard = ({
  members,
}: {
  members: readonly PartnerMemberSummary[];
}) => {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Enrolled members</CardTitle>
        <CardDescription>
          The active members you manage ({members.length}).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {members.length === 0 ? (
          <p className="text-muted-foreground">
            You have no active members enrolled yet.
          </p>
        ) : (
          <ul className="divide-y divide-foreground/10">
            {members.map((member) => (
              <li
                key={member.seniorId}
                className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{member.name}</p>
                  <p className="truncate text-muted-foreground">
                    {member.email}
                  </p>
                </div>
                <span className="shrink-0 text-muted-foreground">
                  Forwarding {member.forwardingActive ? "active" : "inactive"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
};

/**
 * Partner view (RSC, task 15.3).
 *
 * Resolves the Better Auth session server-side and redirects unauthenticated
 * visitors to the sign-in page. Loads the signed-in Partner's own per-member
 * Subscription state, billed quantity, and active members through
 * {@link loadPartnerDashboard}, which scopes every member through
 * `assertPartnerMembership` (Req 13.5, 13.6). An account that is not a Partner
 * is shown a role-denied notice rather than any billing data. Rendering is RSC
 * with no client components; Next.js requires the page component to be the
 * file's default export.
 */
/**
 * Reads the Better Auth session at request time, so under Cache Components this
 * route can't be prerendered. Keep it a blocking server render.
 */
export const instant = false;

const PartnerDashboardPage = async () => {
  const session = await auth.api.getSession({ headers: await headers() });

  if (!session) {
    redirect("/");
  }

  const result = await loadPartnerDashboard(session.user.id);

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Partner access required</CardTitle>
            <CardDescription>
              This page is only available to partner accounts.
            </CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  const { billing, members } = result.data;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="font-heading text-lg font-medium">Partner dashboard</h1>
        <p className="text-muted-foreground">
          Billing and members for your organization.
        </p>
      </div>
      <BillingSummaryCard billing={billing} />
      <MembersCard members={members} />
    </main>
  );
};

export default PartnerDashboardPage;
