import { describe, expect, it } from "vitest";
import {
  cachePolicyFromManifest,
  tanstackCachePolicy,
} from "../../src/cache/index.ts";

describe("cachePolicyFromManifest", () => {
  it("reads the hints", () => {
    expect(
      cachePolicyFromManifest({
        cache: {
          max_age: 30,
          stats_ttl: 5,
          stale_while_revalidate: 60,
          etag: true,
          revalidate_only: false,
        },
      }),
    ).toEqual({
      enabled: true,
      maxAge: 30,
      statsTtl: 5,
      staleWhileRevalidate: 60,
      etag: true,
      revalidateOnly: false,
    });
  });

  it("treats null and junk hints as zero, and keeps etag unless it is false", () => {
    const p = cachePolicyFromManifest({
      cache: { max_age: "x", stats_ttl: null, stale_while_revalidate: -3 },
    });
    expect(p).toMatchObject({
      maxAge: 0,
      statsTtl: 0,
      staleWhileRevalidate: 0,
    });
    expect(p.etag).toBe(true);
    expect(cachePolicyFromManifest({ cache: { etag: false } }).etag).toBe(
      false,
    );
    expect(cachePolicyFromManifest({ cache: null })).toMatchObject({
      maxAge: 0,
      revalidateOnly: false,
    });
    expect(cachePolicyFromManifest({}).enabled).toBe(true);
    expect(
      cachePolicyFromManifest({ cache: { max_age: Infinity } }).maxAge,
    ).toBe(0);
  });

  it("lets overrides win", () => {
    expect(
      cachePolicyFromManifest(
        { cache: { max_age: 30, revalidate_only: true, etag: false } },
        {
          maxAge: 1,
          statsTtl: 2,
          staleWhileRevalidate: 3,
          revalidateOnly: false,
          etag: true,
          enabled: false,
        },
      ),
    ).toEqual({
      enabled: false,
      maxAge: 1,
      statsTtl: 2,
      staleWhileRevalidate: 3,
      etag: true,
      revalidateOnly: false,
    });
  });
});

describe("tanstackCachePolicy", () => {
  it("defaults to revalidate-only and can be overridden", () => {
    expect(tanstackCachePolicy({ cache: { max_age: 30 } }).revalidateOnly).toBe(
      true,
    );
    expect(
      tanstackCachePolicy({}, { revalidateOnly: false }).revalidateOnly,
    ).toBe(false);
  });
});
