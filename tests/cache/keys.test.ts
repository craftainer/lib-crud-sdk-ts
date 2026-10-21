import { describe, expect, it } from "vitest";
import {
  buildKey,
  canonicalQuery,
  eventPrefixes,
  manifestKey,
  recordPrefix,
  resourcePrefixes,
} from "../../src/cache/index.ts";
import { isCacheKind, isStatsKind } from "../../src/cache/keys.ts";

describe("canonicalQuery", () => {
  it("sorts the pairs the client sent and drops id", () => {
    expect(canonicalQuery("?limit=10&id=5&name__icontains=a%20b&skip=0")).toBe(
      "limit=10&name__icontains=a%20b&skip=0",
    );
  });

  it("never decodes or re-encodes", () => {
    expect(canonicalQuery("b=%2C%7e&a=%20+")).toBe("a=%20+&b=%2C%7e");
  });

  it("orders by name, then value, and keeps valueless pairs", () => {
    expect(canonicalQuery("a=2&a=1&a&&b=")).toBe("a&a=1&a=2&b=");
    expect(canonicalQuery("a=1&a=2")).toBe("a=1&a=2");
    expect(canonicalQuery("a=1&a=1")).toBe("a=1&a=1");
  });

  it("accepts a query without a question mark and an empty one", () => {
    expect(canonicalQuery("z=1&y=2")).toBe("y=2&z=1");
    expect(canonicalQuery("")).toBe("");
    expect(canonicalQuery("?id=1")).toBe("");
  });
});

describe("buildKey", () => {
  const base = { resource: "heroes", scope: "anon", apiVersion: null };

  it("puts the version after kind and subject, with _ for none", () => {
    expect(buildKey({ ...base, kind: "list", query: "?skip=0&limit=5" })).toBe(
      "v1/heroes/list/_/_/anon/limit=5&skip=0",
    );
    expect(
      buildKey({ ...base, kind: "record", recordId: 7, apiVersion: "v2" }),
    ).toBe("v1/heroes/record/7/v2/anon/");
    expect(buildKey({ ...base, kind: "revisions", recordId: 7 })).toBe(
      "v1/heroes/revisions/7/_/anon/",
    );
  });

  it("uses _ as the subject for non-per-record kinds and a missing id", () => {
    expect(buildKey({ ...base, kind: "stats", recordId: 7 })).toBe(
      "v1/heroes/stats/_/_/anon/",
    );
    expect(buildKey({ ...base, kind: "record" })).toBe(
      "v1/heroes/record/_/_/anon/",
    );
  });

  it("keys the manifest per scope", () => {
    expect(manifestKey("abc")).toBe("v1/_manifest/abc");
  });
});

describe("prefixes", () => {
  const collections = ["v1/h/list/", "v1/h/stats/", "v1/h/predict/"];

  it("follows the spec's table", () => {
    expect(eventPrefixes("h", "create", 1)).toEqual(collections);
    for (const action of ["update", "delete", "restore"]) {
      expect(eventPrefixes("h", action, 4)).toEqual([
        ...collections,
        "v1/h/record/4/",
        "v1/h/revisions/4/",
      ]);
    }
    expect(eventPrefixes("h", "update", undefined)).toEqual(
      resourcePrefixes("h"),
    );
    expect(eventPrefixes("h", "explode", 4)).toEqual(resourcePrefixes("h"));
    expect(resourcePrefixes("h")).toEqual([
      ...collections,
      "v1/h/record/",
      "v1/h/revisions/",
    ]);
    expect(recordPrefix("h", 3)).toBe("v1/h/record/3/");
  });

  it("classifies ops", () => {
    expect(isCacheKind("list")).toBe(true);
    expect(isCacheKind("create")).toBe(false);
    expect(isStatsKind("predict")).toBe(true);
    expect(isStatsKind("list")).toBe(false);
  });
});
