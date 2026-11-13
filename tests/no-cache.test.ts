import { describe, expect, it, vi } from "vitest";
import { ClientError, createClient } from "../src/index.ts";
import {
  MemoryStore,
  cachePolicyFromManifest,
  cacheStatus,
  createCache,
} from "../src/cache/index.ts";
import {
  infiniteListOptions,
  listOptions,
  recordOptions,
  statsOptions,
  tanstackApi,
} from "../src/tanstack/index.ts";
import { BASE, fakeFetch, fixture, json } from "./_support.ts";

const manifest = fixture("hero-reader.manifest.json");

/** A client over a max_age=60 cache whose events stream is "connected"; `server.name` is the live row. */
async function setup() {
  const cache = createCache({
    store: new MemoryStore(),
    policies: {
      heroes: cachePolicyFromManifest({
        cache: { max_age: 60, stale_while_revalidate: 60, etag: true },
      }),
    },
  });
  cache.setEventsActive("heroes", true);
  const server = { name: "Ada", etag: '"1"' };
  const { fetch, seen } = fakeFetch((request) => {
    if (request.url === `${BASE}/m`) {
      return json(manifest);
    }
    if (request.method !== "GET") {
      return json({ id: 7, name: server.name }, { headers: { etag: '"9"' } });
    }
    if (request.headers.get("if-none-match") === server.etag) {
      return new Response(null, {
        status: 304,
        headers: { etag: server.etag },
      });
    }
    const row = { id: 7, name: server.name };
    return json(/[?&]id=7/.test(request.url) ? row : [row], {
      headers: { etag: server.etag },
    });
  });
  const client = createClient({
    baseUrl: BASE,
    manifestUrl: `${BASE}/m`,
    fetch,
    tokenProvider: () => "tok",
    cache,
  });
  const heroes = await client.resource("heroes");
  return { client, heroes, seen, server };
}

describe('RequestOptions.cache: "no-cache"', () => {
  it("get hits the network and returns the changed body despite a fresh entry", async () => {
    const { heroes, seen, server } = await setup();
    expect(await heroes.get(7)).toEqual({ id: 7, name: "Ada" });
    expect(await heroes.get(7)).toEqual({ id: 7, name: "Ada" }); // fresh hit
    const before = seen.length;

    server.name = "Grace";
    server.etag = '"2"';
    expect(await heroes.get(7)).toEqual({ id: 7, name: "Ada" }); // the TOCTOU: stale by policy
    expect(seen.length).toBe(before);

    expect(await heroes.get(7, { cache: "no-cache" })).toEqual({
      id: 7,
      name: "Grace",
    });
    expect(seen.length).toBe(before + 1);
    expect(seen.at(-1)?.headers.get("if-none-match")).toBe('"1"'); // validator sent
    expect(seen.at(-1)?.request.cache).toBe("no-cache");
  });

  it("list does the same, and an unchanged server answers 304 from the store", async () => {
    const { heroes, seen, server } = await setup();
    await heroes.list();
    server.name = "Grace";
    server.etag = '"2"';
    expect(await heroes.list({ cache: "no-cache" })).toEqual([
      { id: 7, name: "Grace" },
    ]);
    const n = seen.length;
    expect(await heroes.list({ cache: "no-cache" })).toEqual([
      { id: 7, name: "Grace" },
    ]);
    expect(seen.length).toBe(n + 1);
    expect(seen.at(-1)?.headers.get("if-none-match")).toBe('"2"');
  });

  it('"default" and an absent mode leave the policy in charge', async () => {
    const { heroes, seen } = await setup();
    await heroes.get(7);
    const n = seen.length;
    await heroes.get(7, { cache: "default" });
    await heroes.get(7, {});
    expect(seen.length).toBe(n);
    expect(seen.at(-1)?.request.cache).toBe("default");
  });

  it("rejects an unknown mode before any request, and writes ignore the mode", async () => {
    const { heroes, seen } = await setup();
    const n = seen.length;
    await expect(
      heroes.get(7, { cache: "reload" as never }),
    ).rejects.toBeInstanceOf(ClientError);
    expect(seen.length).toBe(n);
    await heroes.update(7, { name: "X" }, { cache: "no-cache" });
    expect(seen.at(-1)?.method).toBe("PATCH");
    expect(seen.at(-1)?.request.cache).toBe("default");
  });

  it("the middleware reports the forced read as revalidated, never hit or stale", async () => {
    const { client, heroes } = await setup();
    await heroes.get(7);
    const statuses: Array<string | undefined> = [];
    client.use(async (ctx, next) => {
      const response = await next(ctx);
      statuses.push(cacheStatus(response));
      return response;
    });
    // The user middleware is outermost: it sees the cache's verdict.
    await heroes.get(7, { cache: "no-cache" });
    await heroes.get(7);
    expect(statuses).toEqual(["revalidated", "hit"]);
  });
});

describe("tanstack factories", () => {
  it("pass cache to the api only when set, for every read kind", async () => {
    const { client, heroes, server } = await setup();
    const api = tanstackApi(client, heroes);
    const ns = await client.namespace();
    const signal = new AbortController().signal;

    await recordOptions(ns, "heroes", api, 7).queryFn({ signal });
    await listOptions(ns, "heroes", api).queryFn({ signal });
    server.name = "Grace";
    server.etag = '"2"';

    const opts = { cache: "no-cache" } as const;
    expect(
      await recordOptions(ns, "heroes", api, 7, opts).queryFn({ signal }),
    ).toEqual({ id: 7, name: "Grace" });
    expect(
      await listOptions(ns, "heroes", api, undefined, opts).queryFn({
        signal,
      }),
    ).toEqual([{ id: 7, name: "Grace" }]);
    await infiniteListOptions(ns, "heroes", api, {}, opts).queryFn({
      signal,
      pageParam: 0,
    });
    const spy = vi.fn(async () => ({}));
    const plain = {
      stats: spy,
      predict: spy,
      revisions: spy as never,
      manifest: spy as never,
    };
    await statsOptions(ns, "heroes", plain, undefined, opts).queryFn({
      signal,
    });
    expect(spy).toHaveBeenLastCalledWith(undefined, {
      signal,
      cache: "no-cache",
    });
    await statsOptions(ns, "heroes", plain).queryFn({ signal });
    expect(spy).toHaveBeenLastCalledWith(undefined, { signal });
    // the key does not carry the mode
    expect(recordOptions(ns, "heroes", api, 7, opts).queryKey).toEqual(
      recordOptions(ns, "heroes", api, 7).queryKey,
    );
  });
});
