"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { signIn } from "@/lib/auth-client";
import { registerCaregiver, resolvePostAuthPath } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Sign-in / sign-up page (`/login`).
 *
 * The dedicated authentication surface for the app. Sign-up registers a new
 * Caregiver through the `registerCaregiver` server action (which creates the
 * account AND its CaregiverProfile, so the account has a role), then signs in
 * to establish the session. Sign-in uses the Better Auth client directly.
 * After either flow succeeds, `resolvePostAuthPath` resolves the account's
 * role on the server and returns the matching dashboard path, so each role
 * lands on its own dashboard rather than bouncing off `/caregiver`.
 *
 * Unauthenticated visitors are routed here by `proxy.ts` when they hit a
 * protected dashboard route; authenticated visitors are redirected away from
 * this page by the same proxy.
 *
 * The `?mode=signup` search param opens the page in sign-up mode (linked from
 * the home page's "Create an account" call-to-action); any other value opens
 * sign-in mode. Reading search params requires a Suspense boundary, so the
 * form lives in `LoginForm` and the default export wraps it.
 *
 * Next.js requires the page component to be the file's default export, defined
 * as an arrow-function const per the workspace App Router file-convention
 * exception.
 */

/** The sign-in / sign-up form, split out so it can read search params inside Suspense. */
const LoginForm = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isSignUp = searchParams.get("mode") === "signup";

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSignIn = async () => {
    setLoading(true);
    const { error } = await signIn.email({ email, password });
    if (error) {
      setLoading(false);
      toast.error(error.message ?? "Sign in failed");
      return;
    }
    // Route by role: a Caregiver, Senior, and Partner each land on their own
    // dashboard. Resolving this on the server avoids sending, say, a Senior to
    // `/caregiver` only to be bounced back to `/`.
    const destination = await resolvePostAuthPath();
    setLoading(false);
    toast.success("Signed in");
    router.push(destination);
    router.refresh();
  };

  const handleSignUp = async () => {
    setLoading(true);

    // Register through the server action rather than the raw Better Auth
    // client: `registerCaregiver` creates the account AND exactly one
    // CaregiverProfile in one step. Without that profile `resolveRole` returns
    // null and the Caregiver_Dashboard redirects back to `/`, so a client-only
    // `signUp.email` would leave the new account unable to reach any dashboard.
    const result = await registerCaregiver({ name, email, password });
    if (!result.ok) {
      setLoading(false);
      toast.error(result.message);
      return;
    }

    // The server action creates the account but does not establish a browser
    // session, so sign in with the same credentials to set the session cookie
    // before navigating to the dashboard.
    const { error } = await signIn.email({ email, password });
    if (error) {
      setLoading(false);
      // The account exists; signing in is all that remains. Point the user at
      // the sign-in form rather than silently failing.
      toast.error(error.message ?? "Account created — please sign in");
      return;
    }

    // Registration always creates a Caregiver, so this resolves to
    // `/caregiver`; the shared resolver keeps the two handlers consistent.
    const destination = await resolvePostAuthPath();
    setLoading(false);
    toast.success("Account created");
    router.push(destination);
    router.refresh();
  };

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{isSignUp ? "Create your account" : "Welcome back"}</CardTitle>
        <CardDescription>
          {isSignUp
            ? "Sign up to start protecting the calls of the people you care for."
            : "Sign in to manage call protection for your seniors."}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {isSignUp && (
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ada Lovelace"
            />
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="ada@example.com"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>
      </CardContent>

      <CardFooter className="flex flex-col gap-3">
        <Button
          onClick={isSignUp ? handleSignUp : handleSignIn}
          disabled={loading}
          className="w-full"
        >
          {isSignUp ? "Create account" : "Sign in"}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          {isSignUp ? (
            <>
              Already have an account?{" "}
              <Link href="/login" className="text-primary underline-offset-4 hover:underline">
                Sign in
              </Link>
            </>
          ) : (
            <>
              New here?{" "}
              <Link
                href="/login?mode=signup"
                className="text-primary underline-offset-4 hover:underline"
              >
                Create an account
              </Link>
            </>
          )}
        </p>
      </CardFooter>
    </Card>
  );
};

const LoginPage = () => (
  <main className="flex flex-1 items-center justify-center p-6">
    <Suspense>
      <LoginForm />
    </Suspense>
  </main>
);

export default LoginPage;
