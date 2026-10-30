import { describe, expect, it, vi } from "vitest";
import { createClient } from "../src/index.ts";
import type { Unauthorized } from "../src/index.ts";
import { BASE, fakeFetch, json } from "./_support.ts";

// A problem that already carries a `cause`, which the real parser never sets.
vi.mock("../src/errors.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/errors.ts")>();
  return {
    ...original,
    problemFromResponse: async (response: Response) => {
      const problem = await original.problemFromResponse(response);
      problem.cause = "original";
      return problem;
    },
  };
});

describe("onUnauthorized failing on a problem that has a cause", () => {
  it("keeps the cause and exposes the callback error as onUnauthorizedError", async () => {
    const boom = new Error("redirect failed");
    const { fetch } = fakeFetch(() => json({}, { status: 401 }));
    const client = createClient({
      baseUrl: BASE,
      manifestUrl: `${BASE}/m`,
      fetch,
      onUnauthorized: () => {
        throw boom;
      },
    });
    const error = (await client
      .manifest()
      .catch((e: unknown) => e)) as Unauthorized & {
      onUnauthorizedError?: unknown;
    };
    expect(error.cause).toBe("original");
    expect(error.onUnauthorizedError).toBe(boom);
    expect(Object.keys(error)).not.toContain("onUnauthorizedError");
  });
});
