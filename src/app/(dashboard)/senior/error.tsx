"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Senior_Dashboard error boundary.
 *
 * Catches any failure thrown while loading or rendering the Senior_Dashboard —
 * including a failed `loadSeniorDashboard` call or a missing SeniorProfile —
 * and shows a generic load-failure message. It deliberately renders nothing
 * from the thrown error object and never any dashboard data, so a load failure
 * can never surface another Senior's Call_Records, Known_Contacts, or
 * forwarding status (Req 10.7).
 *
 * Error boundaries must be Client Components; Next.js requires this component
 * to be the file's default export, defined here as an arrow-function const and
 * default-exported per the App Router file-convention exception.
 */
const SeniorDashboardError = ({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) => {
  useEffect(() => {
    // Surface the failure to the server/browser console for diagnostics; the
    // error details are never rendered into the UI (Req 10.7).
    console.error("Senior dashboard failed to load", error);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-6">
      <Card>
        <CardHeader>
          <CardTitle>We couldn&apos;t load your dashboard</CardTitle>
          <CardDescription>
            Your dashboard data could not be loaded. Please try again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => retry()} variant="outline">
            Try again
          </Button>
        </CardContent>
      </Card>
    </main>
  );
};

export default SeniorDashboardError;
