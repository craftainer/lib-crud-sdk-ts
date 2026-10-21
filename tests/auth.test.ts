import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ANON, cacheScope, staticToken } from "../src/index.ts";

describe("cacheScope", () => {
  it("is anon without a token", async () => {
    expect(await cacheScope(null)).toBe(ANON);
    expect(await cacheScope(undefined)).toBe("anon");
  });

  it("is the first 32 hex of sha256 of the whole token", async () => {
    const token = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZG1pbiJ9.sig";
    const expected = createHash("sha256")
      .update(token)
      .digest("hex")
      .slice(0, 32);
    expect(await cacheScope(token)).toBe(expected);
    expect(await cacheScope("é")).toBe(
      createHash("sha256").update("é", "utf8").digest("hex").slice(0, 32),
    );
  });

  it("never decodes the token: same sub, different signature, different scope", async () => {
    const a = await cacheScope("h.eyJzdWIiOiJhZG1pbiJ9.s1");
    const b = await cacheScope("h.eyJzdWIiOiJhZG1pbiJ9.s2");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("staticToken", () => {
  it("returns the token whatever refresh says", () => {
    const provider = staticToken("t");
    expect(provider({ refresh: false })).toBe("t");
    expect(provider({ refresh: true })).toBe("t");
    expect(staticToken(null)({ refresh: false })).toBeNull();
  });
});
