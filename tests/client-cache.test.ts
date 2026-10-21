import { describe, expect, it } from "vitest";
import { cacheScope, createClient } from "../src/index.ts";
import type { Middleware } from "../src/index.ts";
import {
  MemoryStore,
  cachePolicyFromManifest,
  createCache,
  credentialScope,
} from "../src/cache/index.ts";
import { tanstackApi } from "../src/tanstack/index.ts";
import { BASE, fakeFetch, fixture, json } from "./_support.ts";
import type { Seen } from "./_support.ts";

const manifest = fixture("hero-reader.manifest.json") as {
  resources: Array<{ cache: object }>;
};
const PATH = "/api/crud/v1/heroes/v2/json";
const HERO = { id: 7, name: "Ada" };

/** Client + cache + fake fetch; `tokens` is what the provider returns. */
function setup(tokens: { current: string | null }) {
  const store = new MemoryStore();
  const cache = createCache({
    store,
    policies: {
      heroes: cachePolicyFromManifest(manifest.resources[0] as never),
    },
  });
  const { fetch, seen } = fakeFetch((request: Seen) => {
    if (request.url === `${BASE}/m`) {
      return json(manifest);
    }
    if (request.method === "PATCH") {
      return json({ ...HERO, name: "Grace" }, { headers: { etag: '"2"' } });
    }
    return json(HERO, { headers: { etag: '"1"' } });
  });
  const client = createClient({
    baseUrl: BASE,
    manifestUrl: `${BASE}/m`,
    fetch,
    tokenProvider: () => tokens.current,
    middleware: [cache.middleware, cache.autoIfMatch],
  });
  return { client, seen, cache };
}

const patches = (seen: Seen[]): Seen[] =>
  seen.filter((entry) => entry.method === "PATCH");

describe("client + cache end to end", () => {
  it("update without ifMatch sends the cached ETag, scoped to the caller", async () => {
    const tokens = { current: "token-a" as string | null };
    const { client, seen } = setup(tokens);
    const heroes = await client.resource("heroes");

    await heroes.get(7); // caches the record with ETag "1"
    await heroes.update(7, { name: "Grace" });
    expect(patches(seen)[0]?.headers.get("if-match")).toBe('"1"');
    expect(patches(seen)[0]?.url).toBe(`${BASE}${PATH}?id=7`);

    // The PATCH response was written through with ETag "2".
    await heroes.update(7, { name: "Hedy" });
    expect(patches(seen)[1]?.headers.get("if-match")).toBe('"2"');

    // Another caller has no entry of its own: nothing is added.
    tokens.current = "token-b";
    await heroes.update(7, { name: "Alan" });
    expect(patches(seen)[2]?.headers.has("if-match")).toBe(false);

    // An explicit ifMatch always wins.
    await heroes.update(7, { name: "Alan" }, { ifMatch: '"x"' });
    expect(patches(seen)[3]?.headers.get("if-match")).toBe('"x"');

    // Anonymous: its own scope, no entry either.
    tokens.current = null;
    await heroes.delete(7);
    expect(seen.at(-1)?.headers.has("if-match")).toBe(false);
  });

  it("delete uses the cached ETag too", async () => {
    const { client, seen } = setup({ current: "token-a" });
    const heroes = await client.resource("heroes");
    await heroes.get(7);
    await heroes.delete(7);
    expect(seen.at(-1)?.method).toBe("DELETE");
    expect(seen.at(-1)?.headers.get("if-match")).toBe('"1"');
  });
});

describe("scope consistency", () => {
  it("client.scope() equals credentialScope of the header the client sends", async () => {
    for (const token of [
      "abc",
      "eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZG1pbiJ9.sig",
      "with spaces inside",
      "bearer-looking",
      "ünï",
    ]) {
      const { client, seen } = setup({ current: token });
      let header: string | null = null;
      client.use(async (ctx, next) => {
        header = ctx.request.headers.get("authorization");
        return next(ctx);
      });
      const heroes = await client.resource("heroes");
      await heroes.get(7).catch(() => undefined);
      void seen;
      if (header === null) {
        continue; // the platform refused the header value; nothing was sent
      }
      expect(
        await credentialScope(new Headers({ authorization: header })),
      ).toBe(await client.scope());
    }
  });

  it("agrees for ordinary tokens and for no token or an empty one", async () => {
    const sent = (token: string): Headers =>
      new Headers({ authorization: `Bearer ${token}` });
    expect(await credentialScope(sent("abc"))).toBe(await cacheScope("abc"));
    expect(await credentialScope(sent("a b"))).toBe(await cacheScope("a b"));
    expect(await credentialScope(new Headers())).toBe("anon");

    for (const empty of ["", null]) {
      const tokens = { current: empty };
      const { client } = setup(tokens);
      const seenHeaders: Array<string | null> = [];
      const spy: Middleware = (ctx, next) => {
        seenHeaders.push(ctx.request.headers.get("authorization"));
        return next(ctx);
      };
      client.use(spy);
      await client.manifest();
      expect(seenHeaders).toEqual([null]); // no header for an empty token
      expect(await client.scope()).toBe("anon");
    }
  });
});

describe("tanstackApi", () => {
  it("adapts a resource client to the factory slices", async () => {
    const { client, seen } = setup({ current: "t" });
    const heroes = await client.resource("heroes");
    const api = tanstackApi(client, heroes);
    const ctl = new AbortController();

    await api.list({ filters: { name__icontains: "ad" }, limit: 5 }, ctl);
    expect(seen.at(-1)?.url).toBe(`${BASE}${PATH}?name__icontains=ad&limit=5`);
    expect(seen.at(-1)?.request.signal.aborted).toBe(false);
    await api.list(undefined);
    expect(seen.at(-1)?.url).toBe(`${BASE}${PATH}`);
    await api.get(7, ctl);
    await api.stats({}, ctl);
    expect(seen.at(-1)?.url).toBe(`${BASE}${PATH}/stats`);
    await api.predict({ field: "power_level" }, ctl);
    expect(seen.at(-1)?.url).toContain("/predict");
    await api.revisions(7, ctl);
    expect(seen.at(-1)?.url).toContain("/revisions");
    expect((await api.manifest()).resources).toHaveLength(2);
    await api.create({ name: "Ada", powers: ["x"] });
    expect(seen.at(-1)?.method).toBe("POST");
    await api.update(7, { name: "Grace" }, { ifMatch: '"9"' });
    expect(seen.at(-1)?.headers.get("if-match")).toBe('"9"');
    await api.update(7, { name: "Grace" });
    await api.delete(7);
    expect(seen.at(-1)?.method).toBe("DELETE");

    // TanStack's signal reaches the request the client sends.
    await api.get(7, { signal: ctl.signal });
    expect(seen.at(-1)?.request.signal.aborted).toBe(false);
    ctl.abort();
    await api.get(7, { signal: ctl.signal });
    expect(seen.at(-1)?.request.signal.aborted).toBe(true);
  });
});
