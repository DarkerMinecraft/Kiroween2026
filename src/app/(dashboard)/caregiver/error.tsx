"use client";

/**
 * Error boundary for the Caregiver_Dashboard segment (Req 9.4, 9.7).
 *
 * Catches any uncaught error thrown while loading the dashboard — including the
 * {@link AuthorizationError} thrown by `loadSeniorDetail` when the Caregiver is
 * not linked to the requested Senior (Req 9.4), and any Senior-detail load
 * failure (Req 9.7). It renders a generic failure message only and deliberately
 * surfaces NO Senior data: the boundary receives the thrown error, not the
 * attempted payload, so it cannot and does not fall back to another Senior's
 * information.
 *
 * Next.js App Router requires an `error` file to be a Client Component with a
 * default export; per the workspace rule's file-convention exception it is an
 * arrow-function const default-exported below. Next.js 16 passes a `retry`
 * callback (not `reset`) to re-render the segment.
 */

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/** Props Next.js passes to a segment error boundary in the App Router. */
interface CaregiverDashboardErrorProps {
  /** The caught error. Never rendered verbatim to avoid leaking details. */
  readonly error: Error & { digest?: string };
  /** Re-renders the segment to retry the failed load. */
  readonly retry: () => void;
}

/**
 * Renders the dashboard load-failure state. Shows only a generic message, a
 * retry action, and a link back to the dashboard root — never any Senior data.
 */
const CaregiverDashboardError = ({
  error,
  retry,
}: CaregiverDashboardErrorProps) => {
  useEffect(() => {
    // Log for diagnostics; the message is intentionally not shown to the user.
    console.error("Caregiver dashboard load failed", error);
  }, [error]);

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 p-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            We couldn&apos;t load this dashboard
          </CardTitle>
          <CardDescription>
            The dashboard data could not be loaded. No information is shown
            until it loads successfully.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button onClick={() => retry()}>Try again</Button>
          <Button variant="outline" render={<Link href="/caregiver" />}>
            Back to dashboard
          </Button>
        </CardContent>
      </Card>
    </main>
  );
};

export default CaregiverDashboardError;
