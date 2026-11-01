import { describe, expect, it, vi } from "vitest";
import {
  MemoryStore,
  cachePolicyFromManifest,
  cacheStatus,
  createCache,
} from "../../src/cache/index.ts";
import type { RequestContext } from "../../src/interfaces.ts";
import { ctxFor, deferred, fakeNet, json } from "./helpers.ts";

const ETAG1 = 'W/"1"';
const ETAG2 = 'W/"2"';
const NO_STORE = { "cache-control": "no-store" };
const REC = { recordId: 5, query: "?id=5" };

function setup() {
  const store = new MemoryStore();
  const cache = createCache({
    store,
    policies: { heroes: cachePolicyFromManifest({ cache: { max_age: 60 } }) },
  });
  const net = fakeNet();
  const run = (ctx: RequestContext) =>
    cache.autoIfMatch(ctx, (next) => cache.middleware(next, net.next));
  return { store, cache, net, run };
}

const read = (scope?: string) => {
  const ctx = ctxFor("record", REC);
  return scope === undefined ? ctx : { ...ctx, cacheScope: scope };
};
const patch = (scope?: string, headers: Record<string, string> = {}) => {
  const ctx = ctxFor("update", { method: "PATCH", ...REC, headers });
  return scope === undefined ? ctx : { ...ctx, cacheScope: scope };
};
const lastIfMatch = (net: ReturnType<typeof fakeNet>) =>
  net.sent.at(-1)?.headers.get("if-match");

describe("validators of no-store responses", () => {
  it("sends If-Match on a PATCH after a no-store GET", async () => {
    const s = setup();
    s.net.push(json({ id: 5 }, { headers: { etag: ETAG1, ...NO_STORE } }));
    await s.run(read());
    expect(s.store.size).toBe(0);
    expect(await s.cache.cachedEtag("heroes", 5, "anon", null)).toBe(ETAG1);
    s.net.push(json({ id: 5 }, { headers: { etag: ETAG2, ...NO_STORE } }));
    await s.run(patch());
    expect(lastIfMatch(s.net)).toBe(ETAG1);
  });

  it("never serves a read from the remembered validator", async () => {
    const s = setup();
    s.cache.setEventsActive("heroes", true);
    s.net.push(
      json({ id: 5 }, { headers: { etag: ETAG1, ...NO_STORE } }),
      json({ id: 5, v: 2 }, { headers: { etag: ETAG2, ...NO_STORE } }),
    );
    await s.run(read());
    const second = await s.run(read());
    expect(s.net.sent).toHaveLength(2);
    expect(s.net.sent[1]?.headers.has("if-none-match")).toBe(false);
    expect(cacheStatus(second)).not.toBe("hit");
    expect(await second.json()).toEqual({ id: 5, v: 2 });
    expect(s.store.size).toBe(0);
  });

  it("replaces the validator after a write returns a new ETag", async () => {
    const s = setup();
    s.net.push(
      json({ id: 5 }, { headers: { etag: ETAG1, ...NO_STORE } }),
      json({ id: 5 }, { headers: { etag: ETAG2, ...NO_STORE } }),
      json({ id: 5 }, { headers: { etag: ETAG2, ...NO_STORE } }),
    );
    await s.run(read());
    await s.run(patch());
    expect(await s.cache.cachedEtag("heroes", 5, "anon", null)).toBe(ETAG2);
    await s.run(patch());
    expect(lastIfMatch(s.net)).toBe(ETAG2);
  });

  it("forgets the validator when a write returns none", async () => {
    const s = setup();
    s.net.push(
      json({ id: 5 }, { headers: { etag: ETAG1, ...NO_STORE } }),
      json({ id: 5 }, { headers: NO_STORE }),
    );
    await s.run(read());
    await s.run(patch());
    expect(await s.cache.cachedEtag("heroes", 5, "anon", null)).toBeUndefined();
  });

  it("clears the validator on a 412", async () => {
    const s = setup();
    s.net.push(
      json({ id: 5 }, { headers: { etag: ETAG1, ...NO_STORE } }),
      json({ title: "Precondition Failed" }, { status: 412 }),
    );
    await s.run(read());
    const res = await s.run(patch());
    expect(res.status).toBe(412);
    expect(await s.cache.cachedEtag("heroes", 5, "anon", null)).toBeUndefined();
  });

  it("clears the validator on DELETE", async () => {
    const s = setup();
    s.net.push(
      json({ id: 5 }, { headers: { etag: ETAG1, ...NO_STORE } }),
      new Response(null, { status: 204 }),
    );
    await s.run(read());
    await s.run(ctxFor("delete", { method: "DELETE", ...REC }));
    expect(await s.cache.cachedEtag("heroes", 5, "anon", null)).toBeUndefined();
  });

  it("clears the validator on a 404 read, an SSE invalidation and clear()", async () => {
    const s = setup();
    s.net.push(
      json({ id: 5 }, { headers: { etag: ETAG1, ...NO_STORE } }),
      json({ title: "Not Found" }, { status: 404 }),
      json({ id: 5 }, { headers: { etag: ETAG1, ...NO_STORE } }),
      json({ id: 5 }, { headers: { etag: ETAG1, ...NO_STORE } }),
    );
    const etag = () => s.cache.cachedEtag("heroes", 5, "anon", null);
    await s.run(read());
    await s.run(read());
    expect(await etag()).toBeUndefined();
    await s.run(read());
    await s.cache.invalidateEvent("heroes", "update", 5);
    expect(await etag()).toBeUndefined();
    await s.run(read());
    await s.cache.clear();
    expect(await etag()).toBeUndefined();
  });

  it("ignores a read that began before a write landed", async () => {
    const s = setup();
    const gate = deferred<Response>();
    s.net.push(
      () => gate.promise,
      json({ id: 5 }, { headers: { etag: ETAG2, ...NO_STORE } }),
    );
    const slow = s.run(read());
    await vi.waitFor(() => expect(s.net.sent).toHaveLength(1));
    await s.run(patch());
    expect(await s.cache.cachedEtag("heroes", 5, "anon", null)).toBe(ETAG2);
    gate.resolve(json({ id: 5 }, { headers: { etag: ETAG1, ...NO_STORE } }));
    await slow;
    expect(await s.cache.cachedEtag("heroes", 5, "anon", null)).toBe(ETAG2);
  });

  it("does not leak validators across a cacheScope switch", async () => {
    const s = setup();
    s.net.push(
      json({ id: 5 }, { headers: { etag: ETAG1, ...NO_STORE } }),
      json({ id: 5 }, { headers: NO_STORE }),
      json({ id: 5 }, { headers: NO_STORE }),
    );
    await s.run(read("s:alice"));
    await s.run(patch("s:bob"));
    expect(lastIfMatch(s.net)).toBeNull();
    // Bob's write did not touch or read alice's validator.
    expect(
      await s.cache.cachedEtag("heroes", 5, "s:bob", null),
    ).toBeUndefined();
  });

  it("finds the validator after a queried record read", async () => {
    const s = setup();
    s.net.push(
      json({ id: 5 }, { headers: { etag: ETAG1, ...NO_STORE } }),
      json({ id: 5 }, { headers: NO_STORE }),
    );
    await s.run(
      ctxFor("record", { recordId: 5, query: "?id=5&expand=powers" }),
    );
    expect(await s.cache.cachedEtag("heroes", 5, "anon", null)).toBe(ETAG1);
    await s.run(patch());
    expect(lastIfMatch(s.net)).toBe(ETAG1);
  });

  it("keeps each scope's validator when scopes alternate", async () => {
    const s = setup();
    s.net.push(
      json({ id: 5 }, { headers: { etag: ETAG1, ...NO_STORE } }),
      json({ id: 5 }, { headers: { etag: ETAG2, ...NO_STORE } }),
      json({ id: 5 }, { headers: NO_STORE }),
      json({ id: 5 }, { headers: NO_STORE }),
    );
    await s.run(read("s:alice"));
    await s.run(read("s:bob"));
    expect(await s.cache.cachedEtag("heroes", 5, "s:alice", null)).toBe(ETAG1);
    expect(await s.cache.cachedEtag("heroes", 5, "s:bob", null)).toBe(ETAG2);
    await s.run(patch("s:alice"));
    expect(lastIfMatch(s.net)).toBe(ETAG1);
  });

  it("keeps the footprint bounded", async () => {
    const s = setup();
    for (let id = 1; id <= 1030; id += 1) {
      s.net.push(json({ id }, { headers: { etag: ETAG1, ...NO_STORE } }));
      await s.run({
        ...ctxFor("record", { recordId: id, query: `?id=${id}` }),
      });
    }
    expect(await s.cache.cachedEtag("heroes", 1, "anon", null)).toBeUndefined();
    expect(await s.cache.cachedEtag("heroes", 1030, "anon", null)).toBe(ETAG1);
  });

  it("leaves cacheable responses unchanged", async () => {
    const s = setup();
    s.net.push(
      json({ id: 5 }, { headers: { etag: ETAG1 } }),
      new Response(null, { status: 304, headers: { etag: ETAG2 } }),
    );
    await s.run(read());
    expect(s.store.size).toBe(1);
    const again = await s.run(read());
    expect(s.net.sent[1]?.headers.get("if-none-match")).toBe(ETAG1);
    expect(cacheStatus(again)).toBe("revalidated");
    expect(await s.cache.cachedEtag("heroes", 5, "anon", null)).toBe(ETAG2);
  });
});

describe("validators with etag disabled", () => {
  it("remembers nothing when the policy has no etag", async () => {
    const cache = createCache({
      store: new MemoryStore(),
      policies: {
        heroes: cachePolicyFromManifest({ cache: { etag: false } }),
      },
    });
    const net = fakeNet();
    net.push(json({ id: 5 }, { headers: { etag: ETAG1, ...NO_STORE } }));
    await cache.middleware(read(), net.next);
    expect(await cache.cachedEtag("heroes", 5, "anon", null)).toBeUndefined();
  });
});
