import { describe, expect, it, vi } from "vitest";
import {
  ClientError,
  InsecureTransportError,
  Unauthorized,
  createClient,
} from "../src/index.ts";
import type { ClientOptions, Middleware } from "../src/index.ts";
import {
  MemoryStore,
  cachePolicyFromManifest,
  createCache,
} from "../src/cache/index.ts";
import { BASE, fakeFetch, fixture, json } from "./_support.ts";
import type { Seen } from "./_support.ts";

const manifest = fixture("hero-reader.manifest.json") as {
  resources: Array<{ cache: object }>;
};

/** A BFF-like server: the body names the caller behind the (fake) session cookie. */
function setup(
  session: { user: string },
  options: Partial<ClientOptions> = {},
  withCache = true,
) {
  const cache = createCache({
    store: new MemoryStore(),
    policies: {
      heroes: cachePolicyFromManifest(manifest.resources[0] as never),
    },
  });
  const { fetch, seen } = fakeFetch((request: Seen) =>
    request.url === `${BASE}/m`
      ? json(manifest)
      : json([{ id: 1, name: session.user }], {
          headers: { etag: `"${session.user}"` },
        }),
  );
  const csrf: Middleware = (ctx, next) => {
    const headers = new Headers(ctx.request.headers);
    headers.set("X-CSRF", "1");
    return next({ ...ctx, request: new Request(ctx.request, { headers }) });
  };
  const client = createClient({
    baseUrl: BASE,
    manifestUrl: `${BASE}/m`,
    fetch,
    credentials: "same-origin",
    middleware: [csrf],
    ...(withCache ? { cache } : {}),
    ...options,
  });
  return { client, seen, cache };
}

const names = (rows: unknown): unknown =>
  (rows as Array<{ name: string }>).map((row) => row.name);

describe("cookie session: credentials and a static header", () => {
  it("sends credentials and the middleware's X-CSRF on every request", async () => {
    const { client, seen } = setup({ user: "ada" }, { cacheScope: "ada" });
    await (await client.resource("heroes")).list();
    expect(seen.length).toBeGreaterThanOrEqual(2); // manifest + list
    for (const entry of seen) {
      expect(entry.request.credentials).toBe("same-origin");
      expect(entry.headers.get("x-csrf")).toBe("1");
      expect(entry.headers.has("authorization")).toBe(false);
    }
  });

  it("leaves credentials to the platform when not set", async () => {
    const { client, seen } = setup(
      { user: "ada" },
      { credentials: undefined },
      false,
    );
    await (await client.resource("heroes")).list();
    expect(seen[0]?.request.credentials).toBe("same-origin"); // the Request default
  });

  it("passes other credentials modes through", async () => {
    const { client, seen } = setup(
      { user: "ada" },
      { credentials: "include" },
      false,
    );
    await (await client.resource("heroes")).list();
    expect(seen.at(-1)?.request.credentials).toBe("include");
  });
});

describe("cacheScope", () => {
  it("a string replaces the token scope and is what scope()/namespace() say", async () => {
    const { client } = setup({ user: "ada" }, { cacheScope: "sub-1" });
    expect(await client.scope()).toBe("s:sub-1");
    expect(await client.namespace()).toEqual({
      client: BASE,
      scope: "s:sub-1",
    });
  });

  it("a function (sync or async) is called each time", async () => {
    const scopes = ["a", "b"];
    const { client } = setup(
      { user: "x" },
      { cacheScope: () => scopes.shift() ?? "z" },
    );
    expect(await client.scope()).toBe("s:a");
    expect(await client.scope()).toBe("s:b");
    const asyncOne = setup({ user: "x" }, { cacheScope: async () => "later" });
    expect(await asyncOne.client.scope()).toBe("s:later");
  });

  it("replaces the token hash even when a tokenProvider is given, and the token still authenticates", async () => {
    const { client, seen } = setup(
      { user: "ada" },
      { cacheScope: "sub-1", tokenProvider: () => "tok" },
    );
    expect(await client.scope()).toBe("s:sub-1");
    await (await client.resource("heroes")).list();
    expect(seen.at(-1)?.headers.get("authorization")).toBe("Bearer tok");
  });

  it("does not call the tokenProvider for scope() when cacheScope is set", async () => {
    const tokenProvider = vi.fn(() => "tok");
    const { client } = setup({ user: "a" }, { cacheScope: "s", tokenProvider });
    await client.scope();
    expect(tokenProvider).not.toHaveBeenCalled();
  });

  it("rejects anything but a non-empty string", async () => {
    for (const bad of ["", () => "", () => undefined, () => 42]) {
      const { client } = setup(
        { user: "a" },
        { cacheScope: bad as unknown as string },
      );
      await expect(client.scope()).rejects.toBeInstanceOf(ClientError);
    }
  });

  it("never equals anon or a token hash, and encodes what it is given", async () => {
    const anon = setup({ user: "a" }, { cacheScope: "anon" });
    expect(await anon.client.scope()).toBe("s:anon");
    const slash = setup({ user: "a" }, { cacheScope: "https://idp/a b" });
    expect(await slash.client.scope()).toBe("s:https%3A%2F%2Fidp%2Fa%20b");
  });

  it("evaluates the function once per dispatch and reuses it on the 401 retry", async () => {
    let evaluations = 0;
    let n = 0;
    const scopesSeen: Array<string | undefined> = [];
    const spy: Middleware = (ctx, next) => {
      scopesSeen.push(ctx.cacheScope);
      return next(ctx);
    };
    const { fetch } = fakeFetch((r) =>
      r.url === `${BASE}/m`
        ? json(manifest)
        : n++ === 0
          ? new Response(null, { status: 401 })
          : json([]),
    );
    const client = createClient({
      baseUrl: BASE,
      manifestUrl: `${BASE}/m`,
      fetch,
      cacheScope: () => `v${++evaluations}`,
      tokenProvider: ({ refresh }) => (refresh ? "t2" : "t1"),
      middleware: [spy],
    });
    const heroes = await client.resource("heroes");
    await heroes.list();
    // v1 is the manifest-cache key lookup; then one per manifest request, and one shared by both list attempts
    expect(scopesSeen).toEqual(["s:v2", "s:v3", "s:v3"]);
  });

  it("sets ctx.cacheScope only when the option is used", async () => {
    const seenScopes: Array<string | undefined> = [];
    const { client } = setup(
      { user: "a" },
      {
        credentials: undefined,
        middleware: [
          (ctx, next) => {
            seenScopes.push(ctx.cacheScope);
            return next(ctx);
          },
        ],
      },
      false,
    );
    await client.manifest();
    expect(seenScopes).toEqual([undefined]);
  });

  it("without the option the scope is still the token's", async () => {
    const { client } = setup({ user: "a" }, { credentials: undefined }, false);
    expect(await client.scope()).toBe("anon");
  });
});

describe("cleartext guard for cookies", () => {
  const plain = (
    url: string,
    options: Partial<ClientOptions>,
  ): ReturnType<typeof createClient> =>
    createClient({
      baseUrl: url,
      manifestUrl: `${url}/m`,
      fetch: fakeFetch(() => json(manifest)).fetch,
      ...options,
    });

  it("refuses credentials include over plain http to a remote host", async () => {
    const client = plain("http://api.example", { credentials: "include" });
    await expect(client.manifest()).rejects.toBeInstanceOf(
      InsecureTransportError,
    );
  });

  it("allows omit, unset, loopback, https and the explicit opt-in", async () => {
    await plain("http://api.example", { credentials: "omit" }).manifest();
    await plain("http://api.example", {
      credentials: "same-origin",
    }).manifest();
    await plain("http://api.example", {}).manifest();
    await plain("http://localhost:8080", { credentials: "include" }).manifest();
    await plain("http://127.0.0.1", { credentials: "same-origin" }).manifest();
    await plain("https://api.example", { credentials: "include" }).manifest();
    await plain("http://api.example", {
      credentials: "include",
      allowInsecureHttp: true,
    }).manifest();
  });
});

describe("HTTP cache isolation under cookie sessions", () => {
  it("two scopes never see each other's entries, and switching back hits again", async () => {
    const session = { user: "ada" };
    let scope = "sub-ada";
    const { client, seen } = setup(session, { cacheScope: () => scope });
    const heroes = await client.resource("heroes");
    const reads = (): number =>
      seen.filter((e) => e.url.includes("/json")).length;

    expect(names(await heroes.list())).toEqual(["ada"]);
    expect(reads()).toBe(1);

    // Logout / login as someone else: the server answers for the new session.
    session.user = "grace";
    scope = "sub-grace";
    expect(names(await heroes.list())).toEqual(["grace"]);
    // A cached "ada" entry would have been revalidated with ada's ETag.
    expect(seen.at(-1)?.headers.has("if-none-match")).toBe(false);

    // Back to ada: her own entry is there (revalidation carries her ETag).
    session.user = "ada";
    scope = "sub-ada";
    await heroes.list();
    expect(seen.at(-1)?.headers.get("if-none-match")).toBe('"ada"');
  });

  it('cacheScope: "shared" is the explicit opt-out: callers share entries', async () => {
    const session = { user: "ada" };
    const { client, seen } = setup(session, { cacheScope: "shared" });
    const heroes = await client.resource("heroes");
    await heroes.list();
    session.user = "grace";
    await heroes.list();
    expect(seen.at(-1)?.headers.get("if-none-match")).toBe('"ada"');
  });

  it("the manifest is cached per scope too", async () => {
    let scope = "a";
    const { client, seen } = setup({ user: "x" }, { cacheScope: () => scope });
    await client.manifest();
    scope = "b";
    await client.manifest({ refresh: true });
    expect(seen.filter((e) => e.url === `${BASE}/m`).length).toBe(2);
  });

  it("a scope with slashes cannot collide with another scope's keys", async () => {
    const session = { user: "ada" };
    let scope = "https://idp/a";
    const { client, seen } = setup(session, { cacheScope: () => scope });
    const heroes = await client.resource("heroes");
    await heroes.list();
    scope = "https://idp";
    session.user = "grace";
    await heroes.list();
    expect(seen.at(-1)?.headers.has("if-none-match")).toBe(false);
  });

  it("autoIfMatch uses the explicit scope: another scope gets no If-Match", async () => {
    const session = { user: "ada" };
    let scope = "ada";
    const store = new MemoryStore();
    const cache = createCache({
      store,
      policies: {
        heroes: cachePolicyFromManifest(manifest.resources[0] as never),
      },
    });
    const { fetch, seen } = fakeFetch((request) =>
      request.url === `${BASE}/m`
        ? json(manifest)
        : json({ id: 7, name: session.user }, { headers: { etag: '"1"' } }),
    );
    const client = createClient({
      baseUrl: BASE,
      manifestUrl: `${BASE}/m`,
      fetch,
      cacheScope: () => scope,
      cache,
    });
    const heroes = await client.resource("heroes");
    await heroes.get(7);
    await heroes.update(7, { name: "x" });
    expect(seen.at(-1)?.headers.get("if-match")).toBe('"1"');
    scope = "grace";
    await heroes.update(7, { name: "y" });
    expect(seen.at(-1)?.headers.has("if-match")).toBe(false);
  });
});

describe("onUnauthorized", () => {
  const unauthorized = (): Response =>
    json(
      { title: "no" },
      { status: 401, headers: { "www-authenticate": "x" } },
    );

  it("is awaited on a final 401 and the call still rejects with Unauthorized", async () => {
    const calls: string[] = [];
    const { fetch } = fakeFetch((r) =>
      r.url === `${BASE}/m` ? json(manifest) : unauthorized(),
    );
    const failing = createClient({
      baseUrl: BASE,
      manifestUrl: `${BASE}/m`,
      fetch,
      onUnauthorized: async (response) => {
        await Promise.resolve();
        calls.push(`${response.status}:${(await response.text()).length > 0}`);
      },
    });
    const heroes = await failing.resource("heroes");
    await expect(heroes.list()).rejects.toBeInstanceOf(Unauthorized);
    expect(calls).toEqual(["401:true"]);
  });

  it("fires for a 401 on the manifest or discovery too, once per call", async () => {
    const onUnauthorized = vi.fn();
    const { fetch } = fakeFetch(() => unauthorized());
    const client = createClient({
      baseUrl: BASE,
      fetch,
      onUnauthorized,
    });
    await expect(client.resource("heroes")).rejects.toBeInstanceOf(
      Unauthorized,
    );
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("runs after the token refresh retry, once", async () => {
    let n = 0;
    const onUnauthorized = vi.fn();
    let token = "t1";
    const { fetch } = fakeFetch((r) =>
      r.url === `${BASE}/m` ? json(manifest) : (n++, unauthorized()),
    );
    const client = createClient({
      baseUrl: BASE,
      manifestUrl: `${BASE}/m`,
      fetch,
      tokenProvider: ({ refresh }) => {
        if (refresh) {
          token = "t2";
        }
        return token;
      },
      onUnauthorized,
    });
    const heroes = await client.resource("heroes");
    await expect(heroes.list()).rejects.toBeInstanceOf(Unauthorized);
    expect(n).toBe(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("passes { attempt, url } and suppresses repeats for the client's lifetime", async () => {
    const onUnauthorized = vi.fn();
    const { fetch } = fakeFetch((r) =>
      r.url === `${BASE}/m` ? json(manifest) : unauthorized(),
    );
    const client = createClient({
      baseUrl: BASE,
      manifestUrl: `${BASE}/m`,
      fetch,
      onUnauthorized,
    });
    const heroes = await client.resource("heroes");
    await heroes.list().catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledWith(expect.any(Response), {
      attempt: 1,
      url: expect.stringContaining(BASE),
    });
    // A suppressed 401 still rejects (fail closed); only the callback is skipped.
    const again = await heroes.get(1).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(Unauthorized);
    await heroes.list().catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("suppresses concurrent 401s too and strips the query from url", async () => {
    const onUnauthorized = vi.fn();
    const { fetch } = fakeFetch((r) =>
      r.url === `${BASE}/m` ? json(manifest) : unauthorized(),
    );
    const client = createClient({
      baseUrl: BASE,
      manifestUrl: `${BASE}/m`,
      fetch,
      onUnauthorized,
    });
    const heroes = await client.resource("heroes");
    const results = await Promise.allSettled([
      heroes.list({ limit: 5 }),
      heroes.get(1),
      heroes.get(2),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    const info = onUnauthorized.mock.calls[0]?.[1] as { url: string };
    expect(info.url).not.toContain("?");
  });

  it("re-arms on the next 2xx; attempt counts invocations across re-arms", async () => {
    const onUnauthorized = vi.fn();
    let status = 401;
    const { fetch } = fakeFetch((r) =>
      r.url === `${BASE}/m`
        ? json(manifest)
        : status === 401
          ? unauthorized()
          : json([{ id: 1 }]),
    );
    const client = createClient({
      baseUrl: BASE,
      manifestUrl: `${BASE}/m`,
      fetch,
      onUnauthorized,
    });
    const heroes = await client.resource("heroes"); // manifest 2xx
    await heroes.list().catch(() => undefined);
    await heroes.list().catch(() => undefined); // loop: no 2xx in between
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    status = 200; // re-login
    await heroes.list();
    status = 401; // the session expires again
    await heroes.list().catch(() => undefined);
    await heroes.list().catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(2);
    expect(onUnauthorized.mock.calls.map((call) => call[1].attempt)).toEqual([
      1, 2,
    ]);
  });

  it("a separate client has its own count", async () => {
    const onUnauthorized = vi.fn();
    const { fetch } = fakeFetch((r) =>
      r.url === `${BASE}/m` ? json(manifest) : unauthorized(),
    );
    for (let i = 0; i < 2; i += 1) {
      const heroes = await createClient({
        baseUrl: BASE,
        manifestUrl: `${BASE}/m`,
        fetch,
        onUnauthorized,
      }).resource("heroes");
      await heroes.list().catch(() => undefined);
    }
    expect(onUnauthorized).toHaveBeenCalledTimes(2);
  });

  it("is not called for other statuses; a throwing callback becomes the cause of Unauthorized", async () => {
    const onUnauthorized = vi.fn();
    const ok = setup({ user: "a" }, { onUnauthorized, cacheScope: "a" });
    await (await ok.client.resource("heroes")).list();
    expect(onUnauthorized).not.toHaveBeenCalled();

    const boom = new Error("redirect failed");
    const { fetch } = fakeFetch((r) =>
      r.url === `${BASE}/m` ? json(manifest) : unauthorized(),
    );
    const client = createClient({
      baseUrl: BASE,
      manifestUrl: `${BASE}/m`,
      fetch,
      onUnauthorized: () => {
        throw boom;
      },
    });
    const heroes = await client.resource("heroes");
    const error = await heroes.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Unauthorized);
    expect((error as Unauthorized).cause).toBe(boom);
  });
});

describe("tokenProvider-only clients are unchanged", () => {
  const T1 = "628b49d96dcde97a430dd4f597705899"; // sha256("t1")[0..32]
  const T2 = "c44474038d459e40e4714afefa7bf8da"; // sha256("t2")[0..32]

  it("keeps scope(), ctx.scope, ctx.cacheScope and cache keys across a 401 refresh retry", async () => {
    const keys: string[] = [];
    const inner = new MemoryStore();
    const store = {
      get: (key: string) => inner.get(key),
      set: (key: string, entry: never, ttl?: number) => {
        keys.push(key);
        return inner.set(key, entry, ttl);
      },
      delete: (key: string) => inner.delete(key),
      clear: (prefix?: string) => inner.clear(prefix),
    };
    const cache = createCache({
      store,
      policies: {
        heroes: cachePolicyFromManifest(manifest.resources[0] as never),
      },
    });
    const contexts: Array<{ scope: string; has: boolean }> = [];
    const spy: Middleware = (ctx, next) => {
      contexts.push({ scope: ctx.scope, has: "cacheScope" in ctx });
      return next(ctx);
    };
    let token = "t1";
    let n = 0;
    const { fetch } = fakeFetch((r) =>
      r.url === `${BASE}/m`
        ? json(manifest)
        : n++ === 0
          ? new Response(null, { status: 401 })
          : json([{ id: 1 }], { headers: { etag: '"1"' } }),
    );
    const client = createClient({
      baseUrl: BASE,
      manifestUrl: `${BASE}/m`,
      fetch,
      tokenProvider: ({ refresh }) => {
        if (refresh) {
          token = "t2";
        }
        return token;
      },
      middleware: [spy],
      cache,
    });
    expect(await client.scope()).toBe(T1);
    const heroes = await client.resource("heroes");
    await heroes.list();
    expect(await client.scope()).toBe(T2);
    // manifest (t1), list with t1 (401), list retried with t2
    expect(contexts).toEqual([
      { scope: T1, has: false },
      { scope: T1, has: false },
      { scope: T2, has: false },
    ]);
    expect(keys).toEqual([`v1/heroes/list/_/v2/${T2}/`]);
  });
});

describe("cache option: cookie clients need a cache scope", () => {
  const cacheOf = () =>
    createCache({
      store: new MemoryStore(),
      policies: {
        heroes: cachePolicyFromManifest(manifest.resources[0] as never),
      },
    });
  const make = (options: Partial<ClientOptions>) =>
    createClient({ baseUrl: BASE, cache: cacheOf(), ...options });

  it.each<[string, Partial<ClientOptions>]>([
    [
      "credentials same-origin with a token",
      { credentials: "same-origin" as const, tokenProvider: () => "t" },
    ],
    [
      "credentials include with a token",
      { credentials: "include" as const, tokenProvider: () => "t" },
    ],
    ["no tokenProvider", {}],
  ])("throws ClientError naming shared for %s", (_name, options) => {
    expect(() => make(options)).toThrow(ClientError);
    expect(() => make(options)).toThrow(/cacheScope: "shared"/);
  });

  it("is accepted with cacheScope (incl. shared), or for a token client", () => {
    expect(() => make({ cacheScope: "shared" })).not.toThrow();
    expect(() => make({ cacheScope: () => "sub" })).not.toThrow();
    expect(() =>
      make({ tokenProvider: () => "t", credentials: "omit" }),
    ).not.toThrow();
    expect(() => make({ tokenProvider: () => "t" })).not.toThrow();
  });

  it("does not apply without a cache", () => {
    expect(() => createClient({ baseUrl: BASE })).not.toThrow();
  });

  it("rejects the cache middleware in middleware and use()", () => {
    const cache = cacheOf();
    expect(() =>
      createClient({ baseUrl: BASE, middleware: [cache.middleware] }),
    ).toThrow(/createClient\(\{ cache \}\)/);
    expect(() =>
      createClient({ baseUrl: BASE }).use(cache.autoIfMatch),
    ).toThrow(ClientError);
  });

  it("wires the cache innermost: a use() middleware does not see its If-None-Match", async () => {
    const { client, seen } = setup({ user: "ada" }, { cacheScope: "ada" });
    const outer: Array<string | null> = [];
    client.use((ctx, next) => {
      outer.push(ctx.request.headers.get("if-none-match"));
      return next(ctx);
    });
    const heroes = await client.resource("heroes");
    await heroes.list();
    await heroes.list();
    expect(seen.at(-1)?.headers.get("if-none-match")).toBe('"ada"'); // cache is wired
    expect(outer.every((value) => value === null)).toBe(true); // and sits inside
  });
});
