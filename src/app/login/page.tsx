"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { signIn, signUp } from "@/lib/auth-client";
import { resolvePostAuthPath } from "@/app/actions/auth";
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
 * The dedicated authentication surface for the app. It drives the Better Auth
 * client for email/password sign-in and sign-up. On success it calls the
 * `resolvePostAuthPath` server action, which resolves the account's role from
 * the database, sets the optimistic role hint cookie the Edge proxy reads, and
 * returns the role's dashboard path to navigate to. Unauthenticated visitors
 * are routed here by `proxy.ts` when they hit a protected dashboard route;
 * authenticated visitors are redirected away from this page by the same proxy.
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
    setLoading(false);
    if (error) {
      toast.error(error.message ?? "Sign in failed");
      return;
    }
    toast.success("Signed in");
    // Resolve the role-specific dashboard (and set the proxy's role hint
    // cookie) server-side, then navigate straight there.
    const destination = await resolvePostAuthPath();
    router.push(destination);
    router.refresh();
  };

  const handleSignUp = async () => {
    setLoading(true);
    const { error } = await signUp.email({ name, email, password });
    setLoading(false);
    if (error) {
      toast.error(error.message ?? "Sign up failed");
      return;
    }
    toast.success("Account created");
    // Resolve the role-specific dashboard (and set the proxy's role hint
    // cookie) server-side, then navigate straight there.
    const destination = await resolvePostAuthPath();
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
