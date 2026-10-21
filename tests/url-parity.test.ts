import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.ts";
import type { ResourceClient } from "../src/index.ts";
import { clientFor, fixture, json } from "./_support.ts";

interface ParityCase {
  readonly name: string;
  readonly manifest: string;
  readonly resource: string;
  readonly apiVersion: string;
  readonly call: string;
  readonly args: Record<string, unknown>;
  readonly expect: { method: string; url: string } | { error: string };
}

const table = fixture("url-parity.json") as {
  baseUrl: string;
  cases: ParityCase[];
};

function revive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(revive);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    const [key, text] = entries[0] ?? [];
    if (entries.length === 1 && key === "$date") {
      return text;
    }
    if (entries.length === 1 && key === "$datetime") {
      // No offset means UTC.
      return new Date(
        /(Z|[+-]\d\d:\d\d)$/.test(text as string)
          ? (text as string)
          : `${text}Z`,
      );
    }
    return Object.fromEntries(entries.map(([k, v]) => [k, revive(v)]));
  }
  return value;
}

type Args = Record<string, any>;

const CALLS: Record<string, (r: ResourceClient, a: Args) => unknown> = {
  list: (r, a) => r.list(a),
  get: (r, a) => r.get(a["id"]),
  create: (r, a) => r.create(a["data"]),
  update: (r, a) => r.update(a["id"], a["data"], { ifMatch: a["ifMatch"] }),
  updateMany: (r, a) => r.updateMany(a["filters"], a["data"]),
  delete: (r, a) => r.delete(a["id"]),
  deleteMany: (r, a) => r.deleteMany(a["filters"]),
  restore: (r, a) => r.restore(a),
  stats: (r, a) => r.stats(a),
  predict: (r, a) => r.predict(a),
  clone: (r, a) => r.clone(a["id"]),
  createDraft: (r, a) => r.createDraft(a["data"]),
  publish: (r, a) => r.publish(a["id"]),
  filters: (r) => r.filters(),
  revisions: (r, a) => r.revisions(a["id"]),
  eventsUrl: (r) => r.eventsUrl(),
};

describe("URL parity with the Python SDK", () => {
  it("has the table", () => {
    expect(table.cases.length).toBeGreaterThan(150);
    expect(new Set(Object.keys(CALLS))).toEqual(
      new Set(table.cases.map((c) => c.call)),
    );
  });

  it.each(table.cases)("$name", async (c) => {
    const { client, seen } = clientFor(fixture(c.manifest), () =>
      c.call === "delete" ? new Response(null, { status: 204 }) : json({}),
    );
    const resource = await client.resource(c.resource, c.apiVersion);
    const before = seen.length;
    const outcome = (async () =>
      CALLS[c.call]!(resource, revive(c.args) as Args))();
    if ("error" in c.expect) {
      const cls = (sdk as unknown as Record<string, new () => Error>)[
        c.expect.error
      ]!;
      await expect(outcome).rejects.toBeInstanceOf(cls);
      expect(seen.length).toBe(before);
    } else if (c.call === "eventsUrl") {
      expect(await outcome).toBe(c.expect.url);
    } else {
      await outcome;
      const request = seen.at(-1)!;
      expect(request.method).toBe(c.expect.method);
      expect(request.url).toBe(c.expect.url);
    }
  });
});
