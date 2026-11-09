# Kiroween2026

A full-stack [Next.js](https://nextjs.org) app with authentication and a database layer.

## Stack

- **[Next.js](https://nextjs.org) 16** (App Router, `src/` dir, TypeScript, Turbopack)
- **[Tailwind CSS](https://tailwindcss.com) v4**
- **[shadcn/ui](https://ui.shadcn.com)** component library (Mira preset, Hugeicons)
- **[Prisma](https://www.prisma.io) 7** ORM against **PostgreSQL** (Neon), via the `@prisma/adapter-pg` driver adapter
- **[Better Auth](https://www.better-auth.com)** for email/password authentication

## Getting started

1. Install dependencies:
   ```bash
   npm install
   ```
2. Set environment variables in `.env` (gitignored):
   - `DATABASE_URL` — your PostgreSQL connection string.
   - `BETTER_AUTH_SECRET` — a random secret. Generate one with `npx @better-auth/cli@latest secret`.
   - `BETTER_AUTH_URL` / `NEXT_PUBLIC_BETTER_AUTH_URL` — the app's base URL (e.g. `http://localhost:3000`).
   - `STRIPE_SECRET_KEY` — your Stripe secret key, used by the billing wrapper.
   - `STRIPE_FAMILY_PRICE_ID` / `STRIPE_PARTNER_PRICE_ID` — the configured Stripe Price ids for the per-Senior Family plan and the Partner per-member plan.
   - `STRIPE_FAMILY_PRICE_CENTS` — optional. The Family plan monthly price in cents, stored as a best-effort snapshot on each Subscription for display. Stripe remains the system of record for subscription state.
   - `STRIPE_WEBHOOK_SECRET` — the signing secret for the Stripe billing webhook, used to verify the `Stripe-Signature` header at `/api/billing/webhook`.
   - `SIGNALWIRE_PROJECT_ID` / `SIGNALWIRE_API_TOKEN` / `SIGNALWIRE_SPACE_URL` — SignalWire REST credentials used to provision and manage Protection_Numbers.
   - `TELEPHONY_WEBHOOK_SECRET` — the shared secret validated as the `?token=` query parameter on the SignalWire SWML webhook URLs (`/api/telephony/inbound`, `/api/telephony/report`).
   - `APP_BASE_URL` — the externally reachable base URL SignalWire calls back to; used to build the inbound SWML handler URL when provisioning a Protection_Number. Falls back to `BETTER_AUTH_URL` when unset.
   - `DEFAULT_PHONE_REGION` — ISO 3166-1 alpha-2 region (default `US`) applied when a caller number omits a country code during E.164 normalization.
   - `CRON_SECRET` — shared secret that gates the Call_Record retention cron endpoint (`/api/cron/retention`), supplied as an `Authorization: Bearer <secret>` header or a `?token=` query parameter; a mismatch or unset secret returns HTTP 403.
3. Apply the database schema:
   ```bash
   npx prisma migrate dev
   ```
4. Run the dev server:
   ```bash
   npm run dev
   ```
   Open http://localhost:3000. The home page (`/`) introduces the product and links to the sign-in / sign-up page at `/login`. Once signed in you land on a role dashboard (`/caregiver`, `/senior`, or `/partner`); `src/proxy.ts` redirects unauthenticated visitors from those routes back to `/login`.

## Scripts

- `npm run dev` — start the dev server (Turbopack).
- `npm run build` — production build.
- `npm run start` — serve the production build.
- `npm run lint` — run ESLint.
- `npx prisma migrate dev` — create/apply migrations.
- `npx prisma generate` — regenerate the Prisma client.
- `npx prisma studio` — browse the database.

## Project structure

- `src/app` — App Router routes and layouts. `src/app/page.tsx` is the public landing page; `src/app/login/page.tsx` is the email/password sign-in / sign-up form (open sign-up directly with `/login?mode=signup`). `src/app/api/auth/[...all]/route.ts` mounts the Better Auth API. `src/app/api/telephony/inbound/route.ts` returns the SWML call flow SignalWire fetches for each inbound call (token-guarded). `src/app/api/telephony/report/route.ts` is the AI `post_prompt_url` target (token-guarded) that turns the Screening_Agent summary into a Risk_Assessment, writes the Call_Record and Call_Report, and returns a follow-up connect SWML for Known/Allowed callers or a decline for Spam/Fraud. `src/app/api/cron/retention/route.ts` is the `CRON_SECRET`-guarded retention sweep (POST or GET) that deletes Call_Records older than the configured retention window.
- `src/app/actions` — server actions (`"use server"`) for mutations. `src/app/actions/auth.ts` holds the registration/role-setup actions (`registerCaregiver`, `createSeniorProfile`) that validate email/password, reject duplicate emails case-insensitively, delegate account creation to Better Auth, and create exactly one role profile per account.
- `src/app/actions/care-links.ts` — care-link management actions. `createSeniorProfile` is the caregiver-initiated flow that creates the Senior account (delegating to the `auth.ts` helper) and attaches an active Care_Link, enforcing the 1–50 active-link cap in the same transaction so an over-cap request mutates nothing. `removeCareLink` marks a Care_Link inactive to revoke the Caregiver's access to that Senior.
- `src/app/actions` — `"use server"` Server Actions for mutations. `src/app/actions/provisioning.ts` provisions and releases a Senior's Protection_Number through SignalWire (care-link scoped), configuring the inbound SWML handler on success and leaving no partial state on provider failure.
- `src/app/actions/family-billing.ts` — care-link-scoped Family_Plan billing actions (`subscribeFamilyPlan`, `cancelFamilyPlan`, `listSubscriptions`). They create the Caregiver's Billing_Account when absent, reject a second active Subscription per Senior, re-gate call forwarding after every state change, and retain prior state on a Stripe failure.
- `src/app/actions/partner-billing.ts` — partner-membership-scoped per-member billing actions (`enrollPartnerMember`, `removePartnerMember`, `getPartnerBilling`). They create the Partner's Billing_Account when absent and keep the per-member Subscription's billed quantity equal to the count of active enrolled Seniors (clamped at zero), updating Stripe before any local membership write so a Stripe failure retains the prior state and billed quantity.
- `src/components/ui` — shadcn/ui components.
- `src/lib/prisma.ts` — Prisma client singleton (pg driver adapter).
- `src/lib/retention.ts` — pure Call_Record retention logic: `resolveRetentionDays` (clamps the configured window to 1–3650 days, default 365) and `deleteExpiredCallRecords` (reads `RetentionConfig`, computes the cutoff, and deletes Call_Records started before it), kept free of the HTTP layer so it can be unit tested directly.
- `src/lib/auth.ts` — Better Auth server config.
- `src/lib/auth-client.ts` — Better Auth React client (`signIn`, `signUp`, `signOut`, `useSession`).
- `src/proxy.ts` — Next.js 16 Proxy (the renamed Middleware). Runs an optimistic session-cookie check on dashboard routes: it redirects unauthenticated visitors to `/login` and signed-in visitors away from `/login`. It never reads the database — the dashboards and server actions remain the authoritative authorization layer.
- `src/lib/stripe.ts` — Stripe billing wrapper (customer/subscription management) and Stripe-to-local subscription-state mappers.
- `src/generated/prisma` — generated Prisma client (gitignored).
- `prisma/schema.prisma` — database schema: Better Auth models (`user`, `session`, `account`, `verification`) plus the Senior Call Shield application models (`caregiver_profile`, `senior_profile`, `partner_profile`, `care_link`, `protection_number`, `known_contact`, `consent_record`, `call_record`, `call_report`, `billing_account`, `subscription`, `partner_membership`, `processed_webhook_event`, `retention_config`).
- `prisma7.config.ts` — Prisma 7 config (loads `.env` via dotenv).

## Authentication

Email/password sign-in is enabled out of the box, with the sign-in / sign-up form at `/login`. Sign-up registers a new Caregiver via the `registerCaregiver` server action — which creates the account **and** its `CaregiverProfile` in one step, so the account has a role — then signs in. After either sign-in or sign-up, the `resolvePostAuthPath` server action resolves the account's role on the server and routes it to the matching dashboard (`/caregiver`, `/senior`, or `/partner`), so no role is sent to a dashboard it would only be bounced out of. To add social providers, uncomment and fill in the `socialProviders` block in `src/lib/auth.ts`. Auth endpoints are served from `/api/auth/*`. The `nextCookies()` plugin is registered last in the Better Auth config so that `auth.api.*` calls made from Server Actions (such as `registerCaregiver`) can set the session cookie on the response — keep it last if you add more plugins.

Route protection runs in two layers: `src/proxy.ts` does a fast optimistic session-cookie check to keep unauthenticated users out of the dashboards, and each dashboard (plus every server action) re-verifies the session server-side and scopes data by role — the authoritative check lives next to the data, not in the proxy.

## MCP Servers

This project uses several [Model Context Protocol](https://modelcontextprotocol.io) (MCP) servers to extend Kiro's capabilities. The configuration lives in `mcp.json`.

### Installation

Kiro reads MCP config from `.kiro/settings/mcp.json` (workspace) or `~/.kiro/settings/mcp.json` (user). Copy the contents of the root `mcp.json` into one of those files, or merge it with your existing config. You can also open the Command Palette and search for **"MCP"** to manage servers through the UI.

### Configured servers

| Server | Command | Purpose | Status |
| --- | --- | --- | --- |
| `shadcn-ui` | `npx shadcn@latest mcp` | Browse, search, and install shadcn/ui components via natural language | Enabled |
| `aws-docs` | `uvx awslabs.aws-documentation-mcp-server@latest` | Search and read AWS documentation | Enabled |
| `aws-api` | `uvx awslabs.aws-api-mcp-server@latest` | Run AWS CLI / API calls against your account | Disabled (needs AWS credentials) |
| `npm-registry` | `npx -y npm-registry-mcp` | Search the npm registry, check versions, audit packages | Enabled |

### Prerequisites

- **`uvx`** (for the AWS servers) — install via [`uv`](https://docs.astral.sh/uv/getting-started/installation/).
- **`npx`** (for shadcn-ui, npm-registry) — ships with Node.js.

## Steering

`.kiro/steering/nextjs.md` is an always-included steering file with the project's Next.js / React / TypeScript conventions (adapted for Kiro from the [cursor.directory Next.js rules](https://cursor.directory/plugins/nextjs)). Notably, functions are declared as arrow-function constants with named exports (`export const funcName = () => {}`) rather than the `function` keyword; Next.js App Router files that require a default export (`page.tsx`, `layout.tsx`, etc.) define an arrow-function const and default-export it.

`.kiro/steering/signalwire.md` is an auto-included steering file that gives Kiro a SignalWire documentation index and orientation (voice, video, messaging, AI agents, SWML, Relay, REST APIs, Compatibility API). It activates on demand whenever a request involves SignalWire, pointing Kiro at the relevant [`llms.txt`](https://signalwire.com/docs/llms.txt) indexes and common starting guides.

## Notes

- **`aws-api`** is disabled by default. Before enabling, set `AWS_REGION` and `AWS_PROFILE` (or other AWS credential env vars) in its `env` block. It can make real API calls, so review its permissions.
- Do not commit real secrets (API tokens, credentials) into `mcp.json`. Prefer environment variables or a local, git-ignored config.
