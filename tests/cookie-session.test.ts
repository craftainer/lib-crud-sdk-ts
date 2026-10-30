import { describe, expect, it, vi } from "vitest";
import { ClientError, Unauthorized, createClient } from "../src/index.ts";
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
    middleware: [csrf, ...(withCache ? [cache.middleware] : [])],
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
    const { client, seen } = setup({ user: "ada" }, { credentials: undefined });
    await (await client.resource("heroes")).list();
    expect(seen[0]?.request.credentials).toBe("same-origin"); // the Request default
  });

  it("passes other credentials modes through", async () => {
    const { client, seen } = setup({ user: "ada" }, { credentials: "include" });
    await (await client.resource("heroes")).list();
    expect(seen.at(-1)?.request.credentials).toBe("include");
  });
});

describe("cacheScope", () => {
  it("a string replaces the token scope and is what scope()/namespace() say", async () => {
    const { client } = setup({ user: "ada" }, { cacheScope: "sub-1" });
    expect(await client.scope()).toBe("sub-1");
    expect(await client.namespace()).toEqual({
      client: BASE,
      scope: "sub-1",
    });
  });

  it("a function (sync or async) is called each time", async () => {
    const scopes = ["a", "b"];
    const { client } = setup(
      { user: "x" },
      { cacheScope: () => scopes.shift() ?? "z" },
    );
    expect(await client.scope()).toBe("a");
    expect(await client.scope()).toBe("b");
    const asyncOne = setup({ user: "x" }, { cacheScope: async () => "later" });
    expect(await asyncOne.client.scope()).toBe("later");
  });

  it("replaces the token hash even when a tokenProvider is given, and the token still authenticates", async () => {
    const { client, seen } = setup(
      { user: "ada" },
      { cacheScope: "sub-1", tokenProvider: () => "tok" },
    );
    expect(await client.scope()).toBe("sub-1");
    await (await client.resource("heroes")).list();
    expect(seen.at(-1)?.headers.get("authorization")).toBe("Bearer tok");
  });

  it("does not call the tokenProvider for scope() when cacheScope is set", async () => {
    const tokenProvider = vi.fn(() => "tok");
    const { client } = setup({ user: "a" }, { cacheScope: "s", tokenProvider });
    await client.scope();
    expect(tokenProvider).not.toHaveBeenCalled();
  });

  it("rejects an empty scope", async () => {
    const { client } = setup({ user: "a" }, { cacheScope: "" });
    await expect(client.scope()).rejects.toBeInstanceOf(ClientError);
  });

  it("without the option the scope is still the token's", async () => {
    const { client } = setup({ user: "a" }, { credentials: undefined });
    expect(await client.scope()).toBe("anon");
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

  it("without cacheScope, cookie sessions share the anon scope (why the option exists)", async () => {
    const session = { user: "ada" };
    const { client, seen } = setup(session, { credentials: "same-origin" });
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
      middleware: [cache.middleware, cache.autoIfMatch],
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

  it("is not called for other statuses, and a throwing callback replaces the error", async () => {
    const onUnauthorized = vi.fn();
    const ok = setup({ user: "a" }, { onUnauthorized });
    await (await ok.client.resource("heroes")).list();
    expect(onUnauthorized).not.toHaveBeenCalled();

    const { fetch } = fakeFetch((r) =>
      r.url === `${BASE}/m` ? json(manifest) : unauthorized(),
    );
    const client = createClient({
      baseUrl: BASE,
      manifestUrl: `${BASE}/m`,
      fetch,
      onUnauthorized: () => {
        throw new Error("redirect failed");
      },
    });
    const heroes = await client.resource("heroes");
    await expect(heroes.list()).rejects.toThrow("redirect failed");
  });
});
