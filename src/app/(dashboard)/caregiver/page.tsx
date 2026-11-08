/**
 * Caregiver_Dashboard page (RSC) — `/caregiver` (Req 9).
 *
 * A React Server Component that resolves the Better Auth session, loads the
 * Caregiver's actively linked Seniors (empty state when none), and — when a
 * Senior is selected via the `?senior=` search param — loads and renders that
 * Senior's Call_Records, Call_Reports, Known_Contacts, Protection_Number
 * provisioning status, and Subscription state, all scoped by `assertCareLink`
 * inside {@link loadSeniorDetail} (Req 9.1-9.4, 9.8).
 *
 * All data loading happens server-side through the loaders in
 * `src/lib/dashboard/caregiver.ts`; the only client surface is the small
 * {@link KnownContactsManager} control (Req 9.5-9.7). A load failure in
 * {@link loadSeniorDetail} (including an unauthorized Senior) throws and is
 * caught by the sibling `error.tsx`, which never renders another Senior's data
 * (Req 9.4, 9.7).
 *
 * Next.js App Router requires the page component to be the file's default
 * export; per the workspace rule's file-convention exception it is defined as
 * an arrow-function const and default-exported.
 */

import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { KnownContactsManager } from "@/components/dashboard/known-contacts-manager";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { resolveRole } from "@/lib/authz";
import { ROLES, type ProvisioningState, type SubscriptionState } from "@/lib/constants";
import {
  loadLinkedSeniors,
  loadSeniorDetail,
  type CallRecordView,
  type SeniorDetail,
} from "@/lib/dashboard/caregiver";

/** Human-readable labels for each Protection_Number provisioning state (Req 9.8). */
const PROVISIONING_LABELS: Record<ProvisioningState, string> = {
  none: "Not provisioned",
  provisioning: "Provisioning…",
  active: "Active",
  releasing: "Releasing…",
  failed: "Failed",
};

/** Human-readable labels for each Subscription state. */
const SUBSCRIPTION_LABELS: Record<SubscriptionState, string> = {
  active: "Active",
  past_due: "Past due",
  canceled: "Canceled",
  incomplete: "Incomplete",
};

/** Formats a UTC timestamp for display in the call history. */
const formatTimestamp = (value: Date): string =>
  value.toISOString().replace("T", " ").slice(0, 16) + " UTC";

/**
 * Renders a single Call_Record row with its caller identifier, timestamps,
 * outcome, Risk_Assessment, and (when available) the AI Call_Report summary
 * (Req 9.3).
 */
const CallRecordRow = ({ record }: { record: CallRecordView }) => (
  <li className="space-y-1 px-4 py-3">
    <div className="flex items-center justify-between gap-4">
      <span className="truncate text-sm font-medium">
        {record.knownContactName ?? record.callerNumber}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {formatTimestamp(record.startedAt)}
      </span>
    </div>
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>Outcome: {record.screeningOutcome}</span>
      <span>Disposition: {record.disposition}</span>
      {record.riskCategory ? (
        <span>
          Risk: {record.riskCategory}
          {record.riskScore !== null ? ` (${record.riskScore})` : ""}
        </span>
      ) : null}
    </div>
    {record.report ? (
      <p className="text-xs text-muted-foreground">
        {record.report.available
          ? `Report: ${record.report.statedPurpose} — ${record.report.reasonText}`
          : "Report unavailable for this call."}
      </p>
    ) : null}
  </li>
);

/**
 * Renders the full detail panel for the selected, linked Senior: Protection
 * status, Subscription, call history, and the Known_Contact manager (Req 9.3).
 */
const SeniorDetailPanel = ({
  caregiverUserId,
  detail,
}: {
  caregiverUserId: string;
  detail: SeniorDetail;
}) => (
  <div className="space-y-6">
    <Card>
      <CardHeader>
        <CardTitle>{detail.senior.name ?? detail.senior.email}</CardTitle>
        <CardDescription>{detail.senior.email}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-sm font-medium">Protection number</p>
          <p className="text-sm text-muted-foreground">
            {PROVISIONING_LABELS[detail.protectionNumber.provisioningState]}
            {detail.protectionNumber.e164Number
              ? ` · ${detail.protectionNumber.e164Number}`
              : ""}
          </p>
        </div>
        <div>
          <p className="text-sm font-medium">Subscription</p>
          <p className="text-sm text-muted-foreground">
            {detail.subscription.state
              ? SUBSCRIPTION_LABELS[detail.subscription.state]
              : "No subscription"}
          </p>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle className="text-base">Contacts</CardTitle>
      </CardHeader>
      <CardContent>
        <KnownContactsManager
          caregiverUserId={caregiverUserId}
          seniorId={detail.senior.id}
          contacts={detail.knownContacts}
        />
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle className="text-base">Call history</CardTitle>
        <CardDescription>Most recent calls first.</CardDescription>
      </CardHeader>
      <CardContent>
        {detail.callRecords.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No calls recorded yet.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {detail.callRecords.map((record) => (
              <CallRecordRow key={record.id} record={record} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  </div>
);

/**
 * The Caregiver_Dashboard page. Resolves the session and Caregiver role, loads
 * linked Seniors, and renders either the empty state, the Senior list, or the
 * selected Senior's detail.
 */
/**
 * Reads the Better Auth session and `searchParams` at request time, so under
 * Cache Components this route can't be prerendered. Keep it a blocking server
 * render.
 */
export const instant = false;

const CaregiverDashboardPage = async (
  props: PageProps<"/caregiver">,
) => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/");

  // Role gate: only Caregivers may view the Caregiver_Dashboard (Req 1.6).
  const role = await resolveRole(session.user.id);
  if (role !== ROLES.caregiver) redirect("/");

  const caregiverUserId = session.user.id;
  const seniors = await loadLinkedSeniors(caregiverUserId);

  const { senior: selectedParam } = await props.searchParams;
  const selectedSeniorId = Array.isArray(selectedParam)
    ? selectedParam[0]
    : selectedParam;

  // Only load detail for a Senior that appears in the linked list; a param for
  // an unlinked Senior still passes through loadSeniorDetail's assertCareLink,
  // which throws and is caught by error.tsx (Req 9.4).
  const detail = selectedSeniorId
    ? await loadSeniorDetail(caregiverUserId, selectedSeniorId)
    : null;

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Caregiver dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Manage call protection for the seniors you care for.
        </p>
      </header>

      {seniors.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No linked seniors</CardTitle>
            <CardDescription>
              You are not linked to any seniors yet. Add a senior to start
              protecting their calls.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-6 md:grid-cols-[16rem_1fr]">
          <nav aria-label="Linked seniors">
            <ul className="divide-y rounded-md border">
              {seniors.map((senior) => {
                const isSelected = senior.id === selectedSeniorId;
                return (
                  <li key={senior.id}>
                    <Link
                      href={`/caregiver?senior=${senior.id}`}
                      aria-current={isSelected ? "page" : undefined}
                      className={`block px-4 py-3 text-sm hover:bg-muted ${
                        isSelected ? "bg-muted font-medium" : ""
                      }`}
                    >
                      <span className="block truncate">
                        {senior.name ?? senior.email}
                      </span>
                      {senior.name ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {senior.email}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <section>
            {detail ? (
              <SeniorDetailPanel
                caregiverUserId={caregiverUserId}
                detail={detail}
              />
            ) : (
              <Card>
                <CardHeader>
                  <CardDescription>
                    Select a senior to view their call history, contacts, and
                    protection status.
                  </CardDescription>
                </CardHeader>
              </Card>
            )}
          </section>
        </div>
      )}
    </main>
  );
};

export default CaregiverDashboardPage;
