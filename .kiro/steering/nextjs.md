---
inclusion: always
---

# Next.js / React / TypeScript Rules

You are an expert in TypeScript, Node.js, Next.js App Router, React, shadcn/ui, Radix UI, and Tailwind CSS.

Adapted for Kiro from the Next.js rules published at https://cursor.directory/plugins/nextjs.

## Code Style and Structure

- Write concise, technical TypeScript code with accurate examples.
- Use functional and declarative programming patterns; avoid classes.
- Prefer iteration and modularization over code duplication.
- Use descriptive variable names with auxiliary verbs (e.g. `isLoading`, `hasError`).
- Structure files: exported component, subcomponents, helpers, static content, types.

## Naming Conventions

- Use lowercase with dashes for directories (e.g. `components/auth-wizard`).
- Favor named exports for components.

## TypeScript Usage

- Use TypeScript for all code; prefer interfaces over types.
- Avoid enums; use maps instead.
- Use functional components with TypeScript interfaces.

## Syntax and Formatting

- Declare all functions as arrow-function constants with named exports:
  `export const funcName = () => {}`. Do not use the `function` keyword for
  components, handlers, or helpers, and avoid default exports.
- Exception: Next.js App Router file conventions (`page.tsx`, `layout.tsx`,
  `loading.tsx`, `error.tsx`, `route.ts` segment configs, etc.) require a
  default export. For these, define the component as an arrow-function const and
  default-export that const: `const Page = () => {}; export default Page;`.
- Avoid unnecessary curly braces in conditionals; use concise syntax for simple statements.
- Use declarative JSX.

## UI and Styling

- Use shadcn/ui, Radix, and Tailwind for components and styling.
- Implement responsive design with Tailwind CSS; use a mobile-first approach.

## Performance Optimization

- Minimize `use client`, `useEffect`, and `setState`; favor React Server Components (RSC).
- Wrap client components in Suspense with a fallback.
- Use dynamic loading for non-critical components.
- Optimize images: use WebP format, include size data, implement lazy loading.

## Key Conventions

- Use `nuqs` for URL search parameter state management.
- Optimize Web Vitals (LCP, CLS, FID).
- Limit `use client`:
  - Favor server components and Next.js SSR.
  - Use only for Web API access in small components.
  - Avoid for data fetching or state management.
- Follow Next.js docs for Data Fetching, Rendering, and Routing.
