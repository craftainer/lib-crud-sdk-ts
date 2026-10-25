import { describe, expect, it } from "vitest";
import {
  InvalidQueryError,
  buildQuery,
  encodeParams,
  formatScalar,
  quote,
} from "../src/index.ts";
import type { QueryField } from "../src/index.ts";

const f = (
  name: string,
  value_type: string,
  filter_ops: string[] = ["eq", "min", "max", "in"],
  extra: Partial<QueryField> = {},
): QueryField => ({
  name,
  value_type,
  filter_ops,
  sortable: true,
  choices: null,
  ...extra,
});

const FIELDS = [
  f("n", "integer"),
  f("when", "datetime"),
  f("day", "date"),
  f("kind", "enum", ["eq"], { choices: ["a", "b"] }),
  f("free", "enum", ["eq"]),
];

describe("quote", () => {
  it("encodes everything but A-Za-z0-9-._~", () => {
    expect(quote("AZaz09-._~")).toBe("AZaz09-._~");
    expect(quote("!'()* %/é+")).toBe("%21%27%28%29%2A%20%25%2F%C3%A9%2B");
  });
  it("encodes pairs", () => {
    expect(encodeParams([["a b", "c&d"]])).toBe("a%20b=c%26d");
    expect(encodeParams([])).toBe("");
  });
});

describe("formatScalar", () => {
  it("formats datetimes in UTC with trimmed milliseconds", () => {
    const at = (iso: string) => formatScalar(FIELDS[1]!, new Date(iso));
    expect(at("2026-01-02T03:04:05.000Z")).toBe("2026-01-02T03:04:05Z");
    expect(at("2026-01-02T03:04:05.120Z")).toBe("2026-01-02T03:04:05.12Z");
    expect(at("2026-01-02T03:04:05.006Z")).toBe("2026-01-02T03:04:05.006Z");
  });

  it("rejects invalid dates and datetimes", () => {
    const when = FIELDS[1]!;
    const day = FIELDS[2]!;
    expect(() => formatScalar(when, new Date(Number.NaN))).toThrow(
      InvalidQueryError,
    );
    expect(() =>
      formatScalar(when, new Date("+012026-01-01T00:00:00Z")),
    ).toThrow(InvalidQueryError);
    expect(() => formatScalar(when, "2026-01-01")).toThrow(InvalidQueryError);
    expect(formatScalar(day, "2024-02-29")).toBe("2024-02-29");
    for (const bad of ["2025-02-29", "2025-13-01", "2025-1-1", 5, new Date()]) {
      expect(() => formatScalar(day, bad)).toThrow(InvalidQueryError);
    }
  });

  it("checks enum choices only when the manifest lists them", () => {
    expect(formatScalar(FIELDS[3]!, "a")).toBe("a");
    expect(() => formatScalar(FIELDS[3]!, "z")).toThrow(InvalidQueryError);
    expect(formatScalar(FIELDS[4]!, "anything")).toBe("anything");
  });

  it("is strict about integers", () => {
    const n = FIELDS[0]!;
    expect(() => formatScalar(n, 2 ** 60)).toThrow(InvalidQueryError);
    expect(() => formatScalar(n, Number.NaN)).toThrow(InvalidQueryError);
    expect(formatScalar(f("x", "number"), 1.5)).toBe("1.5");
    expect(() =>
      formatScalar(f("x", "number"), Number.POSITIVE_INFINITY),
    ).toThrow(InvalidQueryError);
  });
});

describe("buildQuery", () => {
  it("emits nothing for no parameters", () => {
    expect(buildQuery(FIELDS)).toBe("");
    expect(buildQuery(FIELDS, { filters: {} })).toBe("");
  });

  it("uses default and custom paging names and the max limit", () => {
    expect(buildQuery(FIELDS, { sort: "n", skip: 1, limit: 2 })).toBe(
      "sort=n&skip=1&limit=2",
    );
    expect(
      buildQuery(FIELDS, {
        sort: ["-n"],
        skip: 1,
        limit: 2,
        sortParam: "o",
        skipParam: "s",
        limitParam: "l",
      }),
    ).toBe("o=-n&s=1&l=2");
    expect(buildQuery(FIELDS, { limit: 5000 })).toBe("limit=5000");
    expect(() => buildQuery(FIELDS, { limit: 5, maxLimit: 4 })).toThrow(
      InvalidQueryError,
    );
    expect(buildQuery(FIELDS, { limit: 4, maxLimit: 4 })).toBe("limit=4");
  });

  it("rejects an in-list that is not an array and duplicate operators", () => {
    expect(() => buildQuery(FIELDS, { filters: { n__in: "1" } })).toThrow(
      InvalidQueryError,
    );
    expect(() => buildQuery(FIELDS, { filters: { n: 1, n__eq: 1 } })).toThrow(
      InvalidQueryError,
    );
  });

  it("rejects a lone surrogate with InvalidQueryError, not a raw URIError", () => {
    const lone = "\uD800"; // e.g. an emoji truncated in half
    expect(() => buildQuery(FIELDS, { filters: { free: lone } })).toThrow(
      InvalidQueryError,
    );
    expect(() =>
      buildQuery(FIELDS, { filters: { free: `ok${lone}` } }),
    ).toThrow(InvalidQueryError);
    expect(() =>
      buildQuery([f("free", "enum", ["in"])], {
        filters: { free__in: ["a", lone] },
      }),
    ).toThrow(InvalidQueryError);
    expect(() => encodeParams([["bucket", lone]])).toThrow(InvalidQueryError);
    // A well-formed surrogate pair still encodes.
    expect(buildQuery(FIELDS, { filters: { free: "\u{1F600}" } })).toBe(
      "free=%F0%9F%98%80",
    );
  });
});
