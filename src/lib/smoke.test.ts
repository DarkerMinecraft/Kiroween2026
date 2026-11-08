import { describe, expect, it } from "vitest";

// Trivial smoke test that confirms the Vitest runner is wired up correctly.
// It exercises no application logic and should always pass.
describe("test runner smoke check", () => {
  it("runs a trivial passing assertion", () => {
    expect(1 + 1).toBe(2);
  });
});
