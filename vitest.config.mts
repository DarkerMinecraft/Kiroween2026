import { defineConfig } from "vitest/config";

// Vitest configuration for the Next.js 16 / React 19 / TypeScript project.
// `resolve.tsconfigPaths` wires up the `@/*` alias declared in tsconfig.json so
// tests can import from `@/lib/...` just like application code. The `test` npm
// script runs `vitest --run` for a single, non-watch execution suitable for CI.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    // Use the Node environment for pure-logic and server-side modules; dashboard
    // component tests that need a DOM can opt in per-file via a `// @vitest-environment`
    // comment when they are added later.
    environment: "node",
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
