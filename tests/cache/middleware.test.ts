import { describe, expect, it, vi } from "vitest";
import {
  MemoryStore,
  cachePolicyFromManifest,
  cacheStatus,
  createCache,
  credentialScope,
} from "../../src/cache/index.ts";
import type { CachePolicy } from "../../src/cache/index.ts";
import type { CacheEntry, CacheStore } from "../../src/interfaces.ts";
import { ctxFor, deferred, fakeNet, json } from "./helpers.ts";

const ETAG1 = 'W/"1"';
const ETAG2 = 'W/"2"';
const LIST = "v1/heroes/list/_/_/anon/";
const REC5 = "v1/heroes/record/5/_/anon/";

function policy(
  hints: Record<string, unknown> = {},
  overrides: Partial<CachePolicy> = {},
): CachePolicy {
  return cachePolicyFromManifest({ cache: hints }, overrides);
}

function setup(
  hints: Record<string, unknown> = {},
  overrides: Partial<CachePolicy> = {},
  extra: { store?: CacheStore; cacheManifest?: boolean } = {},
) {
  const clock = { t: 1_000_000 };
  const store = new MemoryStore({ now: () => clock.t });
  const cache = createCache({
    store: extra.store ?? store,
    policies: { heroes: policy(hints, overrides) },
    now: () => clock.t,
    ...(extra.cacheManifest === undefined
      ? {}
      : { cacheManifest: extra.cacheManifest }),
  });
  const net = fakeNet();
  return {
    clock,
    store,
    cache,
    net,
    call: (ctx: ReturnType<typeof ctxFor>) => cache.middleware(ctx, net.next),
  };
}

const list = (body: unknown = [{ id: 5 }], etag: string | null = ETAG1) =>
  json(body, etag === null ? {} : { headers: { etag } });
const notModified = (headers: Record<string, string> = {}) =>
  new Response(null, { status: 304, headers });

describe("revalidation", () => {
  it("stores, then revalidates with If-None-Match and rebuilds a 304 with merged headers", async () => {
    const { net, call, store } = setup();
    net.push(
      json([{ id: 5 }], {
        headers: {
          etag: ETAG1,
          "x-keep": "1",
          "x-old": "a",
          "content-length": "11",
        },
      }),
    );
    const first = await call(ctxFor("list"));
    expect(cacheStatus(first)).toBe("miss");
    expect(await first.json()).toEqual([{ id: 5 }]);
    const stored = store.get(LIST) as CacheEntry;
    expect(stored.etag).toBe(ETAG1);
    expect(stored.headers.map(([n]) => n)).not.toContain("content-length");

    net.push(notModified({ etag: ETAG2, "x-old": "b" }));
    const second = await call(ctxFor("list"));
    expect(net.sent[1]?.headers.get("if-none-match")).toBe(ETAG1);
    expect(cacheStatus(second)).toBe("revalidated");
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual([{ id: 5 }]);
    expect(second.headers.get("x-keep")).toBe("1");
    expect(second.headers.get("x-old")).toBe("b");
    expect(second.headers.get("etag")).toBe(ETAG2);
    expect(store.get(LIST)?.etag).toBe(ETAG2);
  });

  it("keeps the stored etag when the 304 omits it", async () => {
    const { net, call, store } = setup();
    net.push(list());
    await call(ctxFor("list"));
    net.push(notModified());
    await call(ctxFor("list"));
    expect(store.get(LIST)?.etag).toBe(ETAG1);
  });

  it("replaces the entry on a 200 after validating", async () => {
    const { net, call, store } = setup();
    net.push(list([{ id: 5 }]));
    await call(ctxFor("list"));
    net.push(list([{ id: 6 }], ETAG2));
    const res = await call(ctxFor("list"));
    expect(cacheStatus(res)).toBe("miss");
    expect(store.get(LIST)?.body).toBe('[{"id":6}]');
  });

  it("canonicalises the query into the key and keeps scopes and versions apart", async () => {
    const { net, call, store } = setup();
    net.push(list(), list(), list());
    await call(ctxFor("list", { query: "?skip=0&limit=5" }));
    await call(
      ctxFor("list", {
        query: "?limit=5&skip=0",
        headers: { authorization: "Bearer tok" },
      }),
    );
    const s2 = await credentialScope(
      new Headers({ authorization: "Bearer tok" }),
    );
    await call(ctxFor("list", { query: "?limit=5&skip=0", apiVersion: "v2" }));
    expect(store.get("v1/heroes/list/_/_/anon/limit=5&skip=0")).toBeDefined();
    expect(store.get(`v1/heroes/list/_/_/${s2}/limit=5&skip=0`)).toBeDefined();
    expect(store.get("v1/heroes/list/_/v2/anon/limit=5&skip=0")).toBeDefined();
  });

  it("sends no validator when the entry has none, or when the policy drops etags", async () => {
    const { net, call } = setup({ etag: false });
    net.push(list([1], ETAG1));
    await call(ctxFor("list"));
    net.push(list([2], ETAG1));
    await call(ctxFor("list"));
    expect(net.sent[1]?.headers.has("if-none-match")).toBe(false);
  });
});

describe("fresh hits", () => {
  it("serve from the store with no request, only while the SSE stream is up", async () => {
    const { net, call, cache, clock } = setup({ max_age: 60 });
    net.push(list(), notModified(), notModified(), notModified());

    // Stream down: stored with no fresh window, so every read revalidates.
    await call(ctxFor("list"));
    const down = await call(ctxFor("list"));
    expect(cacheStatus(down)).toBe("revalidated");
    expect(net.sent).toHaveLength(2);

    cache.setEventsActive("heroes", true);
    expect(cache.eventsActive("heroes")).toBe(true);
    const warm = await call(ctxFor("list")); // revalidates and stores a fresh window
    expect(cacheStatus(warm)).toBe("revalidated");
    const hit = await call(ctxFor("list"));
    expect(cacheStatus(hit)).toBe("hit");
    expect(await hit.json()).toEqual([{ id: 5 }]);
    expect(net.sent).toHaveLength(3);

    clock.t += 59_999;
    expect(cacheStatus(await call(ctxFor("list")))).toBe("hit");
    clock.t += 1;
    expect(cacheStatus(await call(ctxFor("list")))).toBe("revalidated");
    expect(net.sent).toHaveLength(4);

    // The stream drops: the gate closes at once.
    cache.setEventsActive("heroes", false);
    expect(cache.eventsActive("heroes")).toBe(false);
    net.push(notModified());
    expect(cacheStatus(await call(ctxFor("list")))).toBe("revalidated");
  });

  it("are never granted to a revalidate_only resource, nor is stale-while-revalidate", async () => {
    const { net, call, cache, store } = setup({
      max_age: 60,
      stale_while_revalidate: 60,
      revalidate_only: true,
    });
    cache.setEventsActive("heroes", true);
    net.push(list(), notModified());
    await call(ctxFor("list"));
    expect(store.get(LIST)?.freshUntil).toBe(store.get(LIST)?.storedAt);
    expect(store.get(LIST)?.staleUntil).toBe(store.get(LIST)?.storedAt);
    expect(cacheStatus(await call(ctxFor("list")))).toBe("revalidated");
  });

  it("are bypassed by a request no-cache directive", async () => {
    const { net, call, cache } = setup({ max_age: 60 });
    cache.setEventsActive("heroes", true);
    net.push(list(), notModified());
    await call(ctxFor("list"));
    const res = await call(
      ctxFor("list", { headers: { "cache-control": "max-age=0, No-Cache" } }),
    );
    expect(cacheStatus(res)).toBe("revalidated");
  });

  it("let stats and predict live for stats_ttl without a stream", async () => {
    const { net, call, clock } = setup({ stats_ttl: 30 });
    net.push(list({ n: 1 }), list({ n: 2 }));
    await call(ctxFor("stats"));
    const hit = await call(ctxFor("predict")); // different kind: its own miss
    expect(cacheStatus(hit)).toBe("miss");
    expect(cacheStatus(await call(ctxFor("stats")))).toBe("hit");
    expect(cacheStatus(await call(ctxFor("predict")))).toBe("hit");
    clock.t += 30_000;
    net.push(notModified());
    expect(cacheStatus(await call(ctxFor("stats")))).toBe("revalidated");
  });

  it("does not let stats_ttl outlive revalidate_only", async () => {
    const { net, call } = setup({ stats_ttl: 30, revalidate_only: true });
    net.push(list({ n: 1 }), notModified());
    await call(ctxFor("stats"));
    expect(cacheStatus(await call(ctxFor("stats")))).toBe("revalidated");
  });
});

describe("what is cached", () => {
  it("never stores Cache-Control: no-store, and drops the old entry", async () => {
    const { net, call, store } = setup();
    net.push(list());
    await call(ctxFor("list"));
    net.push(
      json([1], {
        headers: { etag: ETAG2, "cache-control": "private, No-Store" },
      }),
    );
    await call(ctxFor("list"));
    expect(store.get(LIST)).toBeUndefined();
  });

  it("bypasses entirely when the request says no-store", async () => {
    const { net, call, store } = setup();
    const get = vi.spyOn(store, "get");
    net.push(list());
    const res = await call(
      ctxFor("list", { headers: { "cache-control": "no-store" } }),
    );
    expect(cacheStatus(res)).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it("leaves a caller-managed If-None-Match alone", async () => {
    const { net, call, store } = setup();
    net.push(notModified());
    const res = await call(
      ctxFor("record", {
        recordId: 5,
        query: "?id=5",
        headers: { "if-none-match": '"x"' },
      }),
    );
    expect(res.status).toBe(304);
    expect(store.size).toBe(0);
  });

  it("skips non-JSON bodies and Vary on anything but Authorization/Accept/Accept-Encoding", async () => {
    const { net, call, store } = setup();
    net.push(
      new Response("text", {
        headers: { "content-type": "text/plain", etag: ETAG1 },
      }),
      json([1], { headers: { etag: ETAG1, vary: "*" } }),
      json([1], { headers: { etag: ETAG1, vary: "Accept, Cookie" } }),
    );
    for (let i = 0; i < 3; i++) {
      await call(ctxFor("list"));
    }
    expect(store.size).toBe(0);
    net.push(
      json([1], {
        headers: {
          etag: ETAG1,
          vary: "Accept-Encoding, authorization",
          "content-type": "application/problem+json",
        },
      }),
    );
    await call(ctxFor("list"));
    expect(store.get(LIST)).toBeDefined();
  });

  it("does not store a response without a content type", async () => {
    const { net, call, store } = setup();
    net.push(new Response(null, { headers: { etag: ETAG1 } }));
    await call(ctxFor("list"));
    expect(store.size).toBe(0);
  });

  it("drops the old entry for a 200 without an ETag and without a fresh window", async () => {
    const { net, call, store } = setup();
    net.push(list());
    await call(ctxFor("list"));
    net.push(list([2], null));
    await call(ctxFor("list"));
    expect(store.get(LIST)).toBeUndefined();
  });

  it("stores a 200 without an ETag when it is fresh, and refetches it plainly after", async () => {
    const { net, call, store, cache, clock } = setup({ max_age: 10 });
    cache.setEventsActive("heroes", true);
    net.push(list([1], null), list([2], null));
    await call(ctxFor("list"));
    expect(store.get(LIST)?.etag).toBeUndefined();
    expect(cacheStatus(await call(ctxFor("list")))).toBe("hit");
    clock.t += 10_000;
    const res = await call(ctxFor("list"));
    expect(net.sent[1]?.headers.has("if-none-match")).toBe(false);
    expect(await res.json()).toEqual([2]);
  });

  it("evicts on 404/410 and keeps the entry on other errors", async () => {
    const { net, call, store } = setup();
    net.push(list());
    await call(ctxFor("list"));
    net.push(json({ title: "boom" }, { status: 500 }));
    expect((await call(ctxFor("list"))).status).toBe(500);
    expect(store.get(LIST)).toBeDefined();
    net.push(json({ title: "gone" }, { status: 410 }));
    await call(ctxFor("list"));
    expect(store.get(LIST)).toBeUndefined();
    net.push(list(), json({}, { status: 404 }));
    await call(ctxFor("list"));
    await call(ctxFor("list"));
    expect(store.get(LIST)).toBeUndefined();
  });

  it("passes through what it does not cache", async () => {
    const { net, call, store } = setup();
    net.push(list(), list(), list(), list(), list());
    await call(ctxFor("events"));
    await call(ctxFor("list", { resource: "ghosts" }));
    await call(ctxFor("list", { resource: undefined }));
    await call(ctxFor("create", { resource: "ghosts", method: "POST" }));
    await call(ctxFor("create", { resource: undefined, method: "POST" }));
    expect(net.sent).toHaveLength(5);
    expect(store.size).toBe(0);
  });

  it("does not cache a resource whose policy is disabled", async () => {
    const { net, call, store } = setup({}, { enabled: false });
    net.push(list(), json({}));
    await call(ctxFor("list"));
    await call(ctxFor("create", { method: "POST" }));
    expect(store.size).toBe(0);
  });
});

describe("invalidation by events", () => {
  async function seeded() {
    const s = setup();
    s.net.push(
      list(),
      json({ id: 5 }, { headers: { etag: ETAG1 } }),
      json([], { headers: { etag: ETAG1 } }),
      json({ n: 1 }, { headers: { etag: ETAG1 } }),
      json({ n: 1 }, { headers: { etag: ETAG1 } }),
      json([], { headers: { etag: ETAG1 } }),
      json({ id: 6 }, { headers: { etag: ETAG1 } }),
    );
    await s.call(ctxFor("list"));
    await s.call(ctxFor("record", { recordId: 5, query: "?id=5" }));
    await s.call(ctxFor("revisions", { recordId: 5 }));
    await s.call(ctxFor("stats"));
    await s.call(ctxFor("predict"));
    await s.call(ctxFor("filters"));
    await s.call(
      ctxFor("record", { recordId: 6, query: "?id=6", apiVersion: "v2" }),
    );
    return s;
  }
  const keys = (s: Awaited<ReturnType<typeof seeded>>) =>
    [
      LIST,
      REC5,
      "v1/heroes/revisions/5/_/anon/",
      "v1/heroes/stats/_/_/anon/",
      "v1/heroes/predict/_/_/anon/",
      "v1/heroes/filters/_/_/anon/",
      "v1/heroes/record/6/v2/anon/",
    ].map((k) => (s.store.get(k) === undefined ? 0 : 1));

  it("create clears list, stats and predict only", async () => {
    const s = await seeded();
    expect(keys(s)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    await s.cache.invalidateEvent("heroes", "create", 9);
    expect(keys(s)).toEqual([0, 1, 1, 0, 0, 1, 1]);
  });

  it("update, delete and restore also clear the record in every version, and its revisions", async () => {
    for (const action of ["update", "delete", "restore"]) {
      const s = await seeded();
      await s.cache.invalidateEvent("heroes", action, 5);
      expect(keys(s)).toEqual([0, 0, 0, 0, 0, 1, 1]);
      await s.cache.invalidateEvent("heroes", action, 6);
      expect(keys(s)).toEqual([0, 0, 0, 0, 0, 1, 0]);
    }
  });

  it("an unknown action, a missing id and a reconnect clear everything but filters", async () => {
    for (const run of [
      (c: ReturnType<typeof createCache>) =>
        c.invalidateEvent("heroes", "explode", 5),
      (c: ReturnType<typeof createCache>) =>
        c.invalidateEvent("heroes", "update", undefined),
      (c: ReturnType<typeof createCache>) => c.clearResource("heroes"),
    ]) {
      const s = await seeded();
      await run(s.cache);
      expect(keys(s)).toEqual([0, 0, 0, 0, 0, 1, 0]);
    }
  });

  it("clear(prefix) and clear() reach the store", async () => {
    const s = await seeded();
    await s.cache.clear("v1/heroes/list/");
    expect(keys(s)[0]).toBe(0);
    await s.cache.clear();
    expect(s.store.size).toBe(0);
  });
});

describe("write-through", () => {
  it("PATCH ?id= stores the response as the record entry and clears the rest", async () => {
    const s = setup();
    s.net.push(
      list(),
      json({ id: 5 }, { headers: { etag: ETAG1 } }),
      json([], { headers: { etag: ETAG1 } }),
      json({ id: 5, name: "new" }, { headers: { etag: ETAG2 } }),
    );
    await s.call(ctxFor("list"));
    await s.call(ctxFor("record", { recordId: 5, query: "?id=5" }));
    await s.call(ctxFor("revisions", { recordId: 5 }));
    const patched = await s.call(
      ctxFor("update", { method: "PATCH", recordId: 5, query: "?id=5" }),
    );
    expect(await patched.json()).toEqual({ id: 5, name: "new" });
    expect(s.store.get(LIST)).toBeUndefined();
    expect(s.store.get("v1/heroes/revisions/5/_/anon/")).toBeUndefined();
    expect(s.store.get(REC5)?.body).toBe('{"id":5,"name":"new"}');
    expect(s.store.get(REC5)?.etag).toBe(ETAG2);

    // The next read validates with the new ETag.
    s.net.push(notModified());
    const read = await s.call(
      ctxFor("record", { recordId: 5, query: "?id=5" }),
    );
    expect(s.net.sent.at(-1)?.headers.get("if-none-match")).toBe(ETAG2);
    expect(await read.json()).toEqual({ id: 5, name: "new" });
  });

  it("serves the written record fresh when the stream is up", async () => {
    const s = setup({ max_age: 60 });
    s.cache.setEventsActive("heroes", true);
    s.net.push(json({ id: 5, v: 2 }, { headers: { etag: ETAG2 } }));
    await s.call(
      ctxFor("update", { method: "PATCH", recordId: 5, query: "?id=5" }),
    );
    const hit = await s.call(ctxFor("record", { recordId: 5, query: "?id=5" }));
    expect(cacheStatus(hit)).toBe("hit");
    expect(await hit.json()).toEqual({ id: 5, v: 2 });
  });

  it("does not write through a PATCH response that has no ETag and no fresh window, or is not storable", async () => {
    const s = setup();
    s.net.push(
      json({ id: 5 }),
      json(
        { id: 5 },
        { headers: { etag: ETAG1, "cache-control": "no-store" } },
      ),
    );
    await s.call(
      ctxFor("update", { method: "PATCH", recordId: 5, query: "?id=5" }),
    );
    await s.call(
      ctxFor("update", { method: "PATCH", recordId: 5, query: "?id=5" }),
    );
    expect(s.store.get(REC5)).toBeUndefined();
  });

  it("single DELETE removes the record and clears the collections", async () => {
    const s = setup();
    s.net.push(
      list(),
      json({ id: 5 }, { headers: { etag: ETAG1 } }),
      new Response(null, { status: 204 }),
    );
    await s.call(ctxFor("list"));
    await s.call(ctxFor("record", { recordId: 5, query: "?id=5" }));
    await s.call(
      ctxFor("delete", { method: "DELETE", recordId: 5, query: "?id=5" }),
    );
    expect(s.store.size).toBe(0);
  });

  it("create, clone and draft clear list, stats and predict only", async () => {
    for (const op of ["create", "clone", "draft"] as const) {
      const s = setup();
      s.net.push(
        list(),
        json({ id: 5 }, { headers: { etag: ETAG1 } }),
        json({ id: 9 }, { status: 201 }),
      );
      await s.call(ctxFor("list"));
      await s.call(ctxFor("record", { recordId: 5, query: "?id=5" }));
      await s.call(ctxFor(op, { method: "POST" }));
      expect(s.store.get(LIST)).toBeUndefined();
      expect(s.store.get(REC5)).toBeDefined();
    }
  });

  it("bulk PATCH and DELETE clear the collections and each id's record and revisions", async () => {
    for (const op of ["bulk_update", "bulk_delete"] as const) {
      const s = setup();
      s.net.push(
        list(),
        json({ id: 5 }, { headers: { etag: ETAG1 } }),
        json({ id: 6 }, { headers: { etag: ETAG1 } }),
        json({ id: 7 }, { headers: { etag: ETAG1 } }),
        json({ matched: 2, ids: [5, 6] }),
      );
      await s.call(ctxFor("list"));
      for (const id of [5, 6, 7]) {
        await s.call(ctxFor("record", { recordId: id, query: `?id=${id}` }));
      }
      await s.call(
        ctxFor(op, {
          method: op === "bulk_delete" ? "DELETE" : "PATCH",
          query: "?a=1",
        }),
      );
      expect(s.store.get(LIST)).toBeUndefined();
      expect(s.store.get(REC5)).toBeUndefined();
      expect(s.store.get("v1/heroes/record/6/_/anon/")).toBeUndefined();
      expect(s.store.get("v1/heroes/record/7/_/anon/")).toBeDefined();
    }
  });

  it("a bulk or restore response it cannot read clears the resource", async () => {
    const bodies: Array<Response> = [
      json({ matched: 1 }),
      new Response("not json", { status: 200 }),
      json({ ids: [1, "x"] }),
      new Response(null, { status: 204 }),
    ];
    for (const body of bodies) {
      const s = setup();
      s.net.push(list(), json({ id: 5 }, { headers: { etag: ETAG1 } }), body);
      await s.call(ctxFor("list"));
      await s.call(ctxFor("record", { recordId: 5, query: "?id=5" }));
      await s.call(ctxFor("restore", { method: "POST", query: "?a=1" }));
      expect(s.store.size).toBe(0);
    }
  });

  it("a bulk restore with ids clears those records", async () => {
    const s = setup();
    s.net.push(
      json({ id: 5 }, { headers: { etag: ETAG1 } }),
      json({ matched: 1, ids: [5] }),
    );
    await s.call(ctxFor("record", { recordId: 5, query: "?id=5" }));
    await s.call(ctxFor("restore", { method: "POST", query: "?a=1" }));
    expect(s.store.size).toBe(0);
  });

  it("restore, publish and delete with an id clear that record", async () => {
    for (const op of ["restore", "publish", "delete"] as const) {
      const s = setup();
      s.net.push(
        json({ id: 5 }, { headers: { etag: ETAG1 } }),
        json({ id: 5 }),
      );
      await s.call(ctxFor("record", { recordId: 5, query: "?id=5" }));
      await s.call(ctxFor(op, { method: "POST", recordId: 5, query: "?id=5" }));
      expect(s.store.size).toBe(0);
    }
  });

  it("an update without an id clears the resource; failed writes clear nothing", async () => {
    const s = setup();
    s.net.push(
      list(),
      json({ id: 5 }),
      list(),
      json({ title: "bad" }, { status: 422 }),
      json({ title: "bad" }, { status: 412 }),
    );
    await s.call(ctxFor("list"));
    await s.call(ctxFor("update", { method: "PATCH" }));
    expect(s.store.size).toBe(0);
    await s.call(ctxFor("list"));
    await s.call(
      ctxFor("update", { method: "PATCH", recordId: 5, query: "?id=5" }),
    );
    expect(s.store.get(LIST)).toBeDefined();
    // 412 without a record id has nothing to evict.
    await s.call(ctxFor("bulk_update", { method: "PATCH", query: "?a=1" }));
    expect(s.store.get(LIST)).toBeDefined();
  });

  it("a write that throws or gets a 5xx may have been applied: it clears what a success would", async () => {
    const outcomes: Array<[string, () => Response | Promise<Response>]> = [
      [
        "throws",
        () => {
          throw new Error("socket closed");
        },
      ],
      ["500", () => json({ detail: "boom" }, { status: 500 })],
      ["504", () => json({ detail: "late" }, { status: 504 })],
    ];
    for (const [, outcome] of outcomes) {
      const s = setup();
      s.net.push(
        list(),
        json({ id: 5 }, { headers: { etag: ETAG1 } }),
        outcome,
      );
      await s.call(ctxFor("list"));
      await s.call(ctxFor("record", { recordId: 5, query: "?id=5" }));
      expect(s.store.size).toBe(2);
      const write = s.call(
        ctxFor("update", {
          method: "PATCH",
          recordId: 5,
          query: "?id=5",
        }),
      );
      if (outcome === outcomes[0]![1]) {
        await expect(write).rejects.toThrow("socket closed");
      } else {
        await write;
      }
      expect(s.store.size).toBe(0);
    }
  });

  it("a write aborted before it was sent clears nothing and rethrows its own error", async () => {
    const s = setup();
    s.net.push(list(), () => {
      throw new DOMException("aborted", "AbortError");
    });
    await s.call(ctxFor("list"));
    const controller = new AbortController();
    controller.abort();
    await expect(
      s.call(ctxFor("create", { method: "POST", signal: controller.signal })),
    ).rejects.toThrow("aborted");
    expect(s.store.size).toBe(1);
  });

  it("a write aborted mid-flight may have been applied and clears", async () => {
    const s = setup();
    const controller = new AbortController();
    s.net.push(list(), () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await s.call(ctxFor("list"));
    await expect(
      s.call(ctxFor("create", { method: "POST", signal: controller.signal })),
    ).rejects.toThrow("aborted");
    expect(s.store.size).toBe(0);
  });

  it("an unknown write outcome clears a create's collections and a bulk op's whole resource", async () => {
    const create = setup();
    create.net.push(list(), () => {
      throw new Error("reset");
    });
    await create.call(ctxFor("list"));
    await expect(
      create.call(ctxFor("create", { method: "POST" })),
    ).rejects.toThrow("reset");
    expect(create.store.size).toBe(0);
    const bulk = setup();
    bulk.net.push(list(), json({}, { status: 502 }));
    await bulk.call(ctxFor("list"));
    await bulk.call(ctxFor("bulk_delete", { method: "DELETE", query: "?a=1" }));
    expect(bulk.store.size).toBe(0);
  });
});

describe("412 on a stale If-Match", () => {
  it("evicts the record entry and exposes the cached ETag for auto_if_match", async () => {
    const s = setup();
    s.net.push(
      json({ id: 5 }, { headers: { etag: ETAG1 } }),
      json({ title: "Precondition Failed" }, { status: 412 }),
    );
    await s.call(ctxFor("record", { recordId: 5, query: "?id=5" }));
    expect(await s.cache.cachedEtag("heroes", 5, "anon", null)).toBe(ETAG1);
    expect(await s.cache.cachedEtag("heroes", 5, "anon", "v2")).toBeUndefined();
    const res = await s.call(
      ctxFor("update", {
        method: "PATCH",
        recordId: 5,
        query: "?id=5",
        headers: { "if-match": ETAG2 },
      }),
    );
    expect(res.status).toBe(412);
    expect(s.store.get(REC5)).toBeUndefined();
    expect(await s.cache.cachedEtag("heroes", 5, "anon", null)).toBeUndefined();
  });
});

describe("races", () => {
  it("does not store fresh a response that was in flight when an invalidation landed", async () => {
    const s = setup({ max_age: 60 });
    s.cache.setEventsActive("heroes", true);
    const gate = deferred<Response>();
    s.net.push(() => gate.promise, notModified());
    const pending = s.call(ctxFor("list"));
    await vi.waitFor(() => expect(s.net.sent).toHaveLength(1));
    await s.cache.invalidateEvent("heroes", "update", 5);
    gate.resolve(list());
    await pending;
    const stored = s.store.get(LIST) as CacheEntry;
    expect(stored.freshUntil).toBe(stored.storedAt); // revalidate-only
    expect(cacheStatus(await s.call(ctxFor("list")))).toBe("revalidated");
  });

  it("does not store fresh a response that was in flight when cache.clear ran", async () => {
    const s = setup({ max_age: 60 });
    s.cache.setEventsActive("heroes", true);
    const gate = deferred<Response>();
    s.net.push(() => gate.promise, notModified());
    const pending = s.call(ctxFor("list"));
    await vi.waitFor(() => expect(s.net.sent).toHaveLength(1));
    await s.cache.clear("v1/heroes/");
    gate.resolve(list());
    await pending;
    const stored = s.store.get(LIST) as CacheEntry;
    expect(stored.freshUntil).toBe(stored.storedAt);
  });

  it("applies to a write-through too, and to a write that landed meanwhile", async () => {
    const s = setup({ max_age: 60 });
    s.cache.setEventsActive("heroes", true);
    const gate = deferred<Response>();
    s.net.push(() => gate.promise);
    const pending = s.call(
      ctxFor("update", { method: "PATCH", recordId: 5, query: "?id=5" }),
    );
    await vi.waitFor(() => expect(s.net.sent).toHaveLength(1));
    await s.cache.clearResource("heroes");
    gate.resolve(json({ id: 5 }, { headers: { etag: ETAG1 } }));
    await pending;
    const stored = s.store.get(REC5) as CacheEntry;
    expect(stored.freshUntil).toBe(stored.storedAt);

    const gate2 = deferred<Response>();
    s.net.push(() => gate2.promise, json({ id: 9 }, { status: 201 }));
    const read = s.call(ctxFor("list"));
    await vi.waitFor(() => expect(s.net.sent).toHaveLength(2));
    await s.call(ctxFor("create", { method: "POST" })); // a write invalidates the resource
    gate2.resolve(list());
    await read;
    const listed = s.store.get(LIST) as CacheEntry;
    expect(listed.freshUntil).toBe(listed.storedAt);
  });

  it("deletes what it just stored if an invalidation lands while the store call is pending", async () => {
    const inner = new MemoryStore();
    const hold = deferred();
    const slow: CacheStore = {
      get: (key) => inner.get(key),
      delete: (key) => inner.delete(key),
      clear: (prefix) => inner.clear(prefix),
      set: async (key, entry, ttl) => {
        await hold.promise;
        inner.set(key, entry, ttl);
      },
    };
    const cache = createCache({ store: slow, policies: { heroes: policy() } });
    const net = fakeNet();
    net.push(list());
    const pending = cache.middleware(ctxFor("list"), net.next);
    await vi.waitFor(() => expect(net.sent).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await cache.invalidateEvent("heroes", "update", 5); // lands before set() resolves
    hold.resolve();
    await pending;
    expect(inner.get(LIST)).toBeUndefined();
  });

  it("does not trust a 304 for the freshness window either", async () => {
    const s = setup({ max_age: 60 });
    s.cache.setEventsActive("heroes", true);
    s.net.push(list());
    await s.call(ctxFor("list"));
    const gate = deferred<Response>();
    s.net.push(() => gate.promise);
    // Not fresh yet: the first entry was stored while... it was fresh; age it out.
    s.clock.t += 61_000;
    const pending = s.call(ctxFor("list"));
    await vi.waitFor(() => expect(s.net.sent).toHaveLength(2));
    await s.cache.invalidateEvent("heroes", "update", 5);
    gate.resolve(notModified());
    await pending;
    const stored = s.store.get(LIST) as CacheEntry;
    expect(stored.freshUntil).toBe(stored.storedAt);
  });
});

describe("stale-while-revalidate", () => {
  async function warm() {
    const s = setup({ max_age: 10, stale_while_revalidate: 30 });
    s.cache.setEventsActive("heroes", true);
    s.net.push(list([1]));
    await s.call(ctxFor("list"));
    return s;
  }

  it("answers from the stale entry and refreshes in the background, once", async () => {
    const s = await warm();
    expect(s.store.get(LIST)?.staleUntil).toBe(s.clock.t + 40_000);
    s.clock.t += 10_000;
    const gate = deferred<Response>();
    s.net.push(() => gate.promise);
    const a = await s.call(ctxFor("list"));
    const b = await s.call(ctxFor("list")); // a refresh is already in flight
    expect(cacheStatus(a)).toBe("stale");
    expect(cacheStatus(b)).toBe("stale");
    expect(await a.json()).toEqual([1]);
    await vi.waitFor(() => expect(s.net.sent).toHaveLength(2));
    expect(s.net.sent[1]?.headers.get("if-none-match")).toBe(ETAG1);
    gate.resolve(list([2], ETAG2));
    await s.cache.close();
    expect(s.store.get(LIST)?.body).toBe("[2]");
    expect(s.net.sent).toHaveLength(2);
    // After the window it revalidates in the foreground.
    s.clock.t += 40_000;
    s.net.push(notModified());
    expect(cacheStatus(await s.call(ctxFor("list")))).toBe("revalidated");
  });

  it("refreshes an entry without a validator plainly, through a detached request", async () => {
    const s = setup({ max_age: 10, stale_while_revalidate: 30 });
    s.cache.setEventsActive("heroes", true);
    s.net.push(list([1], null), list([2], null));
    const ac = new AbortController();
    await s.call(
      ctxFor("list", { headers: { "x-trace": "t" }, signal: ac.signal }),
    );
    s.clock.t += 10_000;
    await s.call(
      ctxFor("list", { headers: { "x-trace": "t" }, signal: ac.signal }),
    );
    ac.abort(); // the caller going away must not cancel the refresh
    await s.cache.close();
    expect(s.net.sent[1]?.headers.has("if-none-match")).toBe(false);
    expect(s.net.sent[1]?.headers.get("x-trace")).toBe("t");
    expect(s.store.get(LIST)?.body).toBe("[2]");
  });

  it("keeps the original request's init (credentials, redirect, ...) on the refresh", async () => {
    const s = setup({ max_age: 10, stale_while_revalidate: 30 });
    s.cache.setEventsActive("heroes", true);
    s.net.push(list([1], null), list([2], null));
    const original = new Request(ctxFor("list").request.url, {
      credentials: "include",
      redirect: "manual",
      cache: "force-cache",
      headers: { "x-trace": "t" },
    });
    const ctx = { ...ctxFor("list"), request: original };
    await s.call(ctx);
    s.clock.t += 10_000;
    await s.call({ ...ctx, request: new Request(original) });
    await s.cache.close();
    const refresh = s.net.sent[1];
    expect(refresh?.credentials).toBe("include");
    expect(refresh?.redirect).toBe("manual");
    expect(refresh?.cache).toBe("no-store"); // never answered from the HTTP cache
    expect(refresh?.headers.get("x-trace")).toBe("t");
  });

  it("swallows a failed refresh and allows the next one", async () => {
    const s = await warm();
    s.clock.t += 10_000;
    s.net.push(() => Promise.reject(new TypeError("offline")), notModified());
    expect(cacheStatus(await s.call(ctxFor("list")))).toBe("stale");
    await s.cache.close();
    expect(s.net.sent).toHaveLength(2);
    expect(s.store.get(LIST)?.body).toBe("[1]");
    // The slot was released.
    const again = createCache({
      store: s.store,
      policies: { heroes: policy({ max_age: 10, stale_while_revalidate: 30 }) },
      now: () => s.clock.t,
    });
    again.setEventsActive("heroes", true);
    expect(again.eventsActive("heroes")).toBe(true);
  });

  it("does not store the refresh fresh if an invalidation lands meanwhile", async () => {
    const s = await warm();
    s.clock.t += 10_000;
    const gate = deferred<Response>();
    s.net.push(() => gate.promise);
    await s.call(ctxFor("list"));
    await vi.waitFor(() => expect(s.net.sent).toHaveLength(2));
    s.store.set(LIST, s.store.get(LIST) as CacheEntry); // still there
    await s.cache.invalidateEvent("heroes", "create", 1);
    expect(s.store.get(LIST)).toBeUndefined();
    gate.resolve(list([2], ETAG2));
    await s.cache.close();
    const stored = s.store.get(LIST) as CacheEntry;
    expect(stored.freshUntil).toBe(stored.storedAt);
  });

  it("is off for forced revalidation and when the stream is down", async () => {
    const s = await warm();
    s.clock.t += 10_000;
    s.net.push(notModified(), notModified());
    expect(
      cacheStatus(
        await s.call(
          ctxFor("list", { headers: { "cache-control": "no-cache" } }),
        ),
      ),
    ).toBe("revalidated");
    s.cache.setEventsActive("heroes", false);
    expect(cacheStatus(await s.call(ctxFor("list")))).toBe("revalidated");
  });
});

describe("store failures count as a miss", () => {
  const boom = () => {
    throw new Error("indexeddb blocked");
  };
  const broken: CacheStore = {
    get: boom,
    set: () => Promise.reject(new Error("quota")),
    delete: boom,
    clear: boom,
  };

  it("never fails a read, a write, an event or a lookup", async () => {
    const s = setup({}, {}, { store: broken });
    s.net.push(
      list(),
      list(),
      json({ id: 5 }),
      json({ id: 5 }, { headers: { etag: ETAG1 } }),
    );
    expect(await (await s.call(ctxFor("list"))).json()).toEqual([{ id: 5 }]);
    expect(cacheStatus(await s.call(ctxFor("list")))).toBe("miss");
    expect(
      (
        await s.call(
          ctxFor("delete", { method: "DELETE", recordId: 5, query: "?id=5" }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await s.call(
          ctxFor("update", { method: "PATCH", recordId: 5, query: "?id=5" }),
        )
      ).status,
    ).toBe(200);
    await expect(
      s.cache.invalidateEvent("heroes", "update", 5),
    ).resolves.toBeUndefined();
    await expect(s.cache.clearResource("heroes")).resolves.toBeUndefined();
    await expect(s.cache.clear("v1/")).resolves.toBeUndefined();
    await expect(
      s.cache.cachedEtag("heroes", 5, "anon", null),
    ).resolves.toBeUndefined();
  });
});

describe("the manifest", () => {
  const manifest = (names: string[]) => ({
    resources: names.map((name) => ({ name })),
  });

  it("is cached per scope and revalidated", async () => {
    const s = setup();
    s.net.push(
      json(manifest(["heroes"]), { headers: { etag: ETAG1 } }),
      notModified(),
    );
    const first = await s.call(
      ctxFor("manifest", {
        url: "https://api.test/manifest",
        resource: undefined,
      }),
    );
    expect(cacheStatus(first)).toBe("miss");
    expect(s.store.get("v1/_manifest/anon")?.etag).toBe(ETAG1);
    const second = await s.call(
      ctxFor("manifest", {
        url: "https://api.test/manifest",
        resource: undefined,
      }),
    );
    expect(s.net.sent[1]?.headers.get("if-none-match")).toBe(ETAG1);
    expect(cacheStatus(second)).toBe("revalidated");
  });

  it("is never served fresh, even with a stream up", async () => {
    const s = setup({ max_age: 60 });
    s.cache.setEventsActive("heroes", true);
    s.net.push(json(manifest([]), { headers: { etag: ETAG1 } }), notModified());
    const ctx = () =>
      ctxFor("manifest", {
        url: "https://api.test/manifest",
        resource: undefined,
      });
    await s.call(ctx());
    expect(cacheStatus(await s.call(ctx()))).toBe("revalidated");
  });

  it("clears filters of every known resource when its ETag changes", async () => {
    const s = setup();
    const ctx = () =>
      ctxFor("manifest", {
        url: "https://api.test/manifest",
        resource: undefined,
      });
    s.net.push(
      json(manifest(["heroes", "ships"]), { headers: { etag: ETAG1 } }),
      json(manifest(["heroes", "planets"]), { headers: { etag: ETAG2 } }),
      json(manifest([]), { headers: { etag: ETAG2 } }),
      json(manifest([]), { headers: { etag: ETAG1 } }),
    );
    await s.call(ctx());
    for (const name of ["heroes", "ships", "planets"]) {
      s.store.set(`v1/${name}/filters/_/_/anon/`, {
        status: 200,
        headers: [],
        body: "{}",
        storedAt: 0,
        freshUntil: 0,
        staleUntil: 0,
      });
    }
    s.store.set(LIST, {
      status: 200,
      headers: [],
      body: "[]",
      storedAt: 0,
      freshUntil: 0,
      staleUntil: 0,
    });
    await s.call(ctx()); // changed
    expect(s.store.get("v1/heroes/filters/_/_/anon/")).toBeUndefined();
    expect(s.store.get("v1/ships/filters/_/_/anon/")).toBeUndefined();
    expect(s.store.get("v1/planets/filters/_/_/anon/")).toBeUndefined();
    expect(s.store.get(LIST)).toBeDefined();
    // An unchanged ETag clears nothing.
    s.store.set("v1/heroes/filters/_/_/anon/", {
      status: 200,
      headers: [],
      body: "{}",
      storedAt: 0,
      freshUntil: 0,
      staleUntil: 0,
    });
    await s.call(ctx());
    expect(s.store.get("v1/heroes/filters/_/_/anon/")).toBeDefined();
    await s.call(ctx()); // changed back
    expect(s.store.get("v1/heroes/filters/_/_/anon/")).toBeUndefined();
  });

  it("copes with unreadable manifest bodies and with no previous ETag", async () => {
    const s = setup();
    const ctx = () =>
      ctxFor("manifest", {
        url: "https://api.test/manifest",
        resource: undefined,
      });
    s.net.push(
      new Response("{not json", {
        headers: { "content-type": "application/json", etag: ETAG1 },
      }),
      json({ resources: "nope" }, { headers: { etag: ETAG2 } }),
      json(
        { resources: [{ name: 1 }, { name: "x" }] },
        { headers: { etag: ETAG1 } },
      ),
      json({ resources: [] }),
      json({ resources: [] }),
    );
    for (let i = 0; i < 5; i++) {
      await s.call(ctx());
    }
    expect(s.store.get("v1/_manifest/anon")).toBeUndefined(); // no ETag, never fresh: dropped
  });

  it("can be left uncached", async () => {
    const s = setup({}, {}, { cacheManifest: false });
    s.net.push(json(manifest([]), { headers: { etag: ETAG1 } }));
    await s.call(
      ctxFor("manifest", {
        url: "https://api.test/manifest",
        resource: undefined,
      }),
    );
    expect(s.store.size).toBe(0);
  });
});

describe("scope comes from the Authorization header actually sent", () => {
  const withAuth = (value: string | null, scopeInCtx = "anon") =>
    ctxFor("list", {
      scope: scopeInCtx,
      headers: value === null ? {} : { authorization: value },
    });

  it("hashes the whole credential: 32 hex, no raw token, Bearer prefix dropped, any scheme hashed", async () => {
    const bearer = await credentialScope(
      new Headers({ authorization: "Bearer abc" }),
    );
    expect(bearer).toMatch(/^[0-9a-f]{32}$/);
    expect(bearer).not.toContain("abc");
    expect(
      await credentialScope(new Headers({ authorization: "bearer   abc" })),
    ).toBe(bearer);
    const basic = await credentialScope(
      new Headers({ authorization: "Basic abc" }),
    );
    expect(basic).toMatch(/^[0-9a-f]{32}$/);
    expect(basic).not.toBe(bearer);
    expect(await credentialScope(new Headers({ authorization: "abc" }))).toBe(
      bearer,
    );
    expect(await credentialScope(new Headers({ authorization: "" }))).not.toBe(
      "anon",
    );
    // Nothing but a missing header is anonymous.
    expect(await credentialScope(new Headers())).toBe("anon");
  });

  it("separates users even when the context says anon (Authorization set by a middleware)", async () => {
    const s = setup();
    const setAuth =
      (token: string) =>
      (
        ctx: ReturnType<typeof ctxFor>,
        next: (c: ReturnType<typeof ctxFor>) => Promise<Response>,
      ) => {
        const headers = new Headers(ctx.request.headers);
        headers.set("authorization", `Bearer ${token}`);
        return next({ ...ctx, request: new Request(ctx.request, { headers }) });
      };
    s.net.push(list([1]), list([2]), notModified());
    const run = (token: string) =>
      setAuth(token)(ctxFor("list"), (c) => s.cache.middleware(c, s.net.next));
    expect(await (await run("alice")).json()).toEqual([1]);
    expect(await (await run("bob")).json()).toEqual([2]); // not alice's entry
    expect(s.store.size).toBe(2);
    expect(s.net.sent[1]?.headers.has("if-none-match")).toBe(false);
    expect(cacheStatus(await run("alice"))).toBe("revalidated");
    expect(s.store.get(LIST)).toBeUndefined(); // nothing under "anon"
  });

  it("keeps a context scope that disagrees out of the key", async () => {
    const s = setup();
    s.net.push(list());
    await s.call(withAuth(null, "someone-else"));
    expect(s.store.get(LIST)).toBeDefined();
  });

  it("scopes the manifest and a write-through the same way", async () => {
    const s = setup();
    const scope = await credentialScope(
      new Headers({ authorization: "Bearer t" }),
    );
    s.net.push(
      json({ resources: [] }, { headers: { etag: ETAG1 } }),
      json({ id: 5 }, { headers: { etag: ETAG1 } }),
    );
    await s.call(
      ctxFor("manifest", {
        url: "https://api.test/manifest",
        resource: undefined,
        headers: { authorization: "Bearer t" },
      }),
    );
    await s.call(
      ctxFor("update", {
        method: "PATCH",
        recordId: 5,
        query: "?id=5",
        headers: { authorization: "Bearer t" },
      }),
    );
    expect(s.store.get(`v1/_manifest/${scope}`)).toBeDefined();
    expect(s.store.get(`v1/heroes/record/5/_/${scope}/`)).toBeDefined();
  });
});

describe("auto If-Match", () => {
  const patch = (headers: Record<string, string> = {}, extra = {}) =>
    ctxFor("update", {
      method: "PATCH",
      recordId: 5,
      query: "?id=5",
      headers,
      ...extra,
    });
  const run = (s: ReturnType<typeof setup>, ctx: ReturnType<typeof ctxFor>) =>
    s.cache.autoIfMatch(ctx, (c) => s.cache.middleware(c, s.net.next));

  async function seeded(auth: Record<string, string> = {}) {
    const s = setup();
    s.net.push(json({ id: 5 }, { headers: { etag: ETAG1 } }));
    await s.call(
      ctxFor("record", { recordId: 5, query: "?id=5", headers: auth }),
    );
    return s;
  }

  it("adds the cached record ETag to PATCH and DELETE, keeping the body", async () => {
    const s = await seeded();
    s.net.push(json({ id: 5 }, { headers: { etag: ETAG2 } }));
    const req = new Request(`${"https://api.test/heroes"}?id=5`, {
      method: "PATCH",
      body: JSON.stringify({ name: "x" }),
      headers: { "content-type": "application/json" },
    });
    await run(s, { ...patch(), request: req });
    expect(s.net.sent.at(-1)?.headers.get("if-match")).toBe(ETAG1);
    expect(await s.net.sent.at(-1)?.text()).toBe('{"name":"x"}');

    const s2 = await seeded();
    s2.net.push(new Response(null, { status: 204 }));
    await run(
      s2,
      ctxFor("delete", { method: "DELETE", recordId: 5, query: "?id=5" }),
    );
    expect(s2.net.sent.at(-1)?.headers.get("if-match")).toBe(ETAG1);
  });

  it("looks up the scope of the request's own Authorization, not another caller's", async () => {
    const alice = { authorization: "Bearer alice" };
    const s = await seeded(alice);
    s.net.push(json({ id: 5 }), json({ id: 5 }));
    await run(s, patch(alice));
    expect(s.net.sent.at(-1)?.headers.get("if-match")).toBe(ETAG1);
    await run(s, patch({ authorization: "Bearer bob" }));
    expect(s.net.sent.at(-1)?.headers.has("if-match")).toBe(false);
  });

  it("leaves an explicit If-Match, a missing entry, other ops and uncached resources alone", async () => {
    const s = await seeded();
    s.net.push(
      json({}),
      json({}),
      json({}),
      json({}),
      json({}),
      json({}),
      json({}),
    );
    await run(s, patch({ "if-match": '"mine"' }));
    expect(s.net.sent.at(-1)?.headers.get("if-match")).toBe('"mine"');
    await run(
      s,
      ctxFor("update", { method: "PATCH", recordId: 6, query: "?id=6" }),
    );
    await run(s, ctxFor("bulk_update", { method: "PATCH", query: "?a=1" }));
    await run(s, ctxFor("update", { method: "PATCH", query: "?a=1" }));
    await run(s, patch({}, { resource: "ghosts" }));
    await run(s, patch({}, { resource: undefined }));
    await run(s, ctxFor("record", { recordId: 5, query: "?id=5" }));
    for (const req of s.net.sent.slice(2)) {
      expect(req.headers.has("if-match")).toBe(false);
    }
  });

  it("is a miss when the store fails", async () => {
    const boom = () => {
      throw new Error("blocked");
    };
    const s = setup(
      {},
      {},
      { store: { get: boom, set: boom, delete: boom, clear: boom } },
    );
    s.net.push(json({}));
    await run(s, patch());
    expect(s.net.sent[0]?.headers.has("if-match")).toBe(false);
  });
});

describe("clearing several prefixes in one pass", () => {
  it("uses the store's clearMany once per event, reset and bulk write", async () => {
    const s = setup();
    const many = vi.spyOn(s.store, "clearMany");
    const one = vi.spyOn(s.store, "clear");
    await s.cache.invalidateEvent("heroes", "update", 5);
    await s.cache.clearResource("heroes");
    expect(many).toHaveBeenCalledTimes(2);
    expect(many.mock.calls[0]?.[0]).toHaveLength(5);
    s.net.push(json({ matched: 3, ids: [1, 2, 3] }));
    await s.call(ctxFor("bulk_delete", { method: "DELETE", query: "?a=1" }));
    expect(many).toHaveBeenCalledTimes(3);
    expect(many.mock.calls[2]?.[0]).toHaveLength(3 + 6);
    expect(one).not.toHaveBeenCalled();
  });

  it("falls back to one clear per prefix for a store without it, and survives failures", async () => {
    const cleared: string[] = [];
    const plain: CacheStore = {
      get: () => undefined,
      set: () => undefined,
      delete: () => undefined,
      clear: (prefix) => {
        cleared.push(prefix ?? "");
      },
    };
    const cache = createCache({ store: plain, policies: { heroes: policy() } });
    await cache.invalidateEvent("heroes", "create", 1);
    expect(cleared).toEqual([
      "v1/heroes/list/",
      "v1/heroes/stats/",
      "v1/heroes/predict/",
    ]);
    const failing = createCache({
      store: { ...plain, clearMany: () => Promise.reject(new Error("x")) },
      policies: {},
    });
    await expect(failing.clearResource("heroes")).resolves.toBeUndefined();
  });
});

describe("close", () => {
  it("schedules no background revalidation afterwards", async () => {
    const s = setup({ max_age: 10, stale_while_revalidate: 30 });
    s.cache.setEventsActive("heroes", true);
    s.net.push(list([1]));
    await s.call(ctxFor("list"));
    s.clock.t += 10_000;
    await s.cache.close();
    const res = await s.call(ctxFor("list"));
    expect(cacheStatus(res)).toBe("stale"); // still answered from the stale entry
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(s.net.sent).toHaveLength(1); // but nothing was scheduled
  });
});

describe("spec amendments of 2026-10-21", () => {
  it("never serves filters fresh, even with the stream up", async () => {
    const s = setup({ max_age: 60 });
    s.cache.setEventsActive("heroes", true);
    s.net.push(list([{ field: "x" }]), notModified());
    await s.call(ctxFor("filters"));
    const key = "v1/heroes/filters/_/_/anon/";
    const stored = s.store.get(key) as CacheEntry;
    expect(stored.freshUntil).toBe(stored.storedAt);
    expect(cacheStatus(await s.call(ctxFor("filters")))).toBe("revalidated");
    expect(s.net.sent).toHaveLength(2);
  });

  it("builds a policy per name and api version, falling back to the name", async () => {
    const clock = { t: 1_000_000 };
    const cache = createCache({
      store: new MemoryStore({ now: () => clock.t }),
      policies: {
        "heroes@v2": policy({ max_age: 60 }),
        heroes: policy({ max_age: 0 }),
        "ships@v1": policy({ max_age: 60 }),
      },
      now: () => clock.t,
    });
    cache.setEventsActive("heroes", true); // one gate per name, shared by versions
    const net = fakeNet();
    const call = (version: string | null) =>
      cache.middleware(ctxFor("list", { apiVersion: version }), net.next);
    net.push(list([1]), list([1]), notModified());
    await call("v2");
    expect(cacheStatus(await call("v2"))).toBe("hit"); // heroes@v2: max_age 60
    await call("v1"); // heroes: no fresh window
    expect(cacheStatus(await call("v1"))).toBe("revalidated");
    // A resource that only has a versioned policy is not cached at other versions.
    net.push(list([2]));
    await cache.middleware(
      ctxFor("list", { resource: "ships", apiVersion: "v9" }),
      net.next,
    );
    expect(net.sent.at(-1)?.headers.has("if-none-match")).toBe(false);
    await cache.close();
  });

  it("plans a background refresh with the generation the read was planned with", async () => {
    const clock = { t: 1_000_000 };
    const inner = new MemoryStore({ now: () => clock.t });
    const hold = deferred<void>();
    const waiting = deferred<void>();
    let slow = false;
    const store: CacheStore = {
      get: async (key) => {
        if (slow) {
          waiting.resolve();
          await hold.promise;
        }
        return inner.get(key);
      },
      set: (key, entry, ttl) => inner.set(key, entry, ttl),
      delete: (key) => inner.delete(key),
      clear: (prefix) => inner.clear(prefix),
    };
    const cache = createCache({
      store,
      policies: { heroes: policy({ max_age: 10, stale_while_revalidate: 30 }) },
      now: () => clock.t,
    });
    cache.setEventsActive("heroes", true);
    const net = fakeNet();
    const call = () => cache.middleware(ctxFor("list"), net.next);
    net.push(list([1]));
    await call();
    clock.t += 10_000; // stale now
    slow = true;
    net.push(list([2], ETAG2));
    const read = call(); // planned (generation read) before the invalidation
    await waiting.promise; // planned: the store read is pending
    await cache.clear("v1/other/"); // bumps the generation, keeps this entry
    hold.resolve();
    expect(cacheStatus(await read)).toBe("stale");
    await vi.waitFor(() => expect(net.sent).toHaveLength(2));
    await cache.close();
    const stored = inner.get(LIST) as CacheEntry;
    expect(stored.body).toBe("[2]");
    expect(stored.freshUntil).toBe(stored.storedAt); // not stored fresh
  });
});

describe("spec amendments (final review)", () => {
  it("grants stale-while-revalidate only with the stream up, stats and predict included", async () => {
    const s = setup({ stats_ttl: 10, stale_while_revalidate: 30 });
    const stats = () => ctxFor("stats");
    s.net.push(list([1]), list([2], ETAG2), list([3], 'W/"3"'));
    await s.call(stats()); // no stream
    const key = "v1/heroes/stats/_/_/anon/";
    const stored = s.store.get(key) as CacheEntry;
    expect(stored.freshUntil - stored.storedAt).toBe(10_000); // stats_ttl as before
    expect(stored.staleUntil).toBe(stored.freshUntil); // but no stale window
    s.clock.t += 10_000;
    expect(cacheStatus(await s.call(stats()))).toBe("miss"); // not served stale
    s.cache.setEventsActive("heroes", true);
    s.clock.t += 20_000;
    await s.call(stats());
    const withStream = s.store.get(key) as CacheEntry;
    expect(withStream.staleUntil - withStream.freshUntil).toBe(30_000);
  });

  it("only write methods clear: HEAD and OPTIONS do not", async () => {
    const s = setup();
    s.net.push(list([1]), new Response(null, { status: 200 }));
    await s.call(ctxFor("list"));
    for (const method of ["HEAD", "OPTIONS"]) {
      s.net.push(new Response(null, { status: 200 }));
      await s.call(ctxFor("update", { method, recordId: 5, query: "?id=5" }));
    }
    expect(s.store.get(LIST)).toBeDefined();
  });
});
