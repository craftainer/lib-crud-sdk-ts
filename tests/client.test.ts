import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CapabilityError,
  ConnectionFailed,
  CrudClient,
  InvalidQueryError,
  ManifestError,
  NotFound,
  RateLimited,
  ServerError,
  Unauthorized,
  UnknownResourceError,
  cacheScope,
  createClient,
} from "../src/index.ts";
import type { Middleware, RequestContext } from "../src/index.ts";
import {
  BASE,
  bareClient,
  clientFor,
  fakeFetch,
  fixture,
  json,
} from "./_support.ts";

const admin = fixture("admin.manifest.json");
const heroes = "/api/crud/v1/heroes/v2/json";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("discovery", () => {
  it("follows the api-catalog and loads the manifest once", async () => {
    const { fetch, seen } = fakeFetch((r) =>
      r.url.endsWith("/.well-known/api-catalog")
        ? json({
            linkset: [
              {
                describedby: [
                  {
                    href: "/api/_crud/manifest",
                    profile:
                      "https://craftainer.github.io/schemas/crud-manifest/v1",
                  },
                ],
              },
            ],
          })
        : json(admin),
    );
    const client = createClient({ baseUrl: `${BASE}/ignored/path`, fetch });
    const [a, b] = await Promise.all([
      client.resource("heroes"),
      client.resource("quests"),
    ]);
    expect(a.resource.api_version).toBe("v2");
    expect(b.resource.name).toBe("quests");
    await client.resource("heroes", "v1");
    expect(seen.map((s) => s.url)).toEqual([
      `${BASE}/.well-known/api-catalog`,
      `${BASE}/api/_crud/manifest`,
    ]);
    expect(seen[0]!.headers.get("cache-control")).toBe("no-store");
    expect(seen[1]!.headers.get("cache-control")).toBeNull();
    expect(seen[1]!.headers.get("accept")).toBe("application/json");
  });

  it("uses a direct manifest URL and reloads on refresh", async () => {
    const { client, seen } = clientFor(admin);
    await client.manifest();
    await client.manifest();
    expect(seen).toHaveLength(1);
    await client.manifest({ refresh: true });
    expect(seen).toHaveLength(2);
    await client.manifest({ refresh: false });
    expect(seen).toHaveLength(2);
  });

  it("does not cache a failed load", async () => {
    let fail = true;
    const { fetch } = fakeFetch(() =>
      fail ? json({}, { status: 503 }) : json(admin),
    );
    const client = createClient({
      baseUrl: BASE,
      manifestUrl: `${BASE}/m`,
      fetch,
    });
    await expect(client.manifest()).rejects.toBeInstanceOf(ServerError);
    fail = false;
    expect((await client.manifest()).service.name).toBe("heroes-api");
  });

  it("keeps a newer load when an older one fails late", async () => {
    let reject: (e: Error) => void = () => {};
    let calls = 0;
    const { fetch } = fakeFetch(() => {
      calls += 1;
      return calls === 1
        ? new Promise<Response>((_, r) => {
            reject = r;
          })
        : Promise.resolve(json(admin));
    });
    const client = createClient({
      baseUrl: BASE,
      manifestUrl: `${BASE}/m`,
      fetch,
    });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const first = client.manifest();
    await tick();
    const second = client.manifest({ refresh: true });
    await tick();
    reject(new Error("late"));
    await expect(first).rejects.toBeInstanceOf(ConnectionFailed);
    await second;
    await client.manifest();
    expect(calls).toBe(2);
  });

  it("rejects a manifest that is not JSON or not a manifest", async () => {
    const text = clientFor(admin, undefined, {}).client;
    expect(text).toBeInstanceOf(CrudClient);
    const { fetch } = fakeFetch(() => new Response("<html>", { status: 200 }));
    const client = createClient({
      baseUrl: BASE,
      manifestUrl: `${BASE}/m`,
      fetch,
    });
    await expect(client.manifest()).rejects.toBeInstanceOf(ManifestError);
    const wrong = clientFor({ manifest_version: "9" }).client;
    await expect(wrong.manifest()).rejects.toBeInstanceOf(ManifestError);
  });

  it("raises UnknownResourceError", async () => {
    const { client } = clientFor(admin);
    await expect(client.resource("nope")).rejects.toThrow(UnknownResourceError);
    await expect(client.resource("heroes", "v9")).rejects.toThrow(
      '"heroes" v9',
    );
  });
});

describe("request context and middleware", () => {
  it("gives every request its RequestContext", async () => {
    const contexts: RequestContext[] = [];
    const spy: Middleware = (ctx, next) => {
      contexts.push(ctx);
      return next(ctx);
    };
    const controller = new AbortController();
    const { client } = clientFor(admin, () => json({}), {
      middleware: [spy],
      tokenProvider: () => "tok",
    });
    const r = await client.resource("heroes");
    await r.get(5, { signal: controller.signal });
    await r.list();
    await r.updateMany({ name: "x" }, {});
    await r.restore({ id: 2 });
    expect(
      contexts.map((c) => [c.resource, c.op, c.recordId, c.apiVersion]),
    ).toEqual([
      [undefined, "manifest", undefined, null],
      ["heroes", "record", 5, "v2"],
      ["heroes", "list", undefined, "v2"],
      ["heroes", "bulk_update", undefined, "v2"],
      ["heroes", "restore", 2, "v2"],
    ]);
    const scope = await cacheScope("tok");
    expect(contexts.every((c) => c.scope === scope)).toBe(true);
    expect(contexts[1]!.signal).toBe(controller.signal);
    expect(contexts[2]!.signal).toBeUndefined();
    expect(contexts[1]!.request.url).toBe(`${BASE}${heroes}?id=5`);
  });

  it("composes constructor middleware outermost first and `use` innermost", async () => {
    const log: string[] = [];
    const tag =
      (name: string): Middleware =>
      async (ctx, next) => {
        log.push(`${name} in`);
        const res = await next(ctx);
        log.push(`${name} out`);
        return res;
      };
    const { client } = clientFor(admin, () => json([]), {
      middleware: [tag("a")],
    });
    expect(client.use(tag("b"))).toBe(client);
    const r = await client.resource("heroes");
    log.length = 0;
    await r.list();
    expect(log).toEqual(["a in", "b in", "b out", "a out"]);
  });

  it("lets a middleware short-circuit or replace the request", async () => {
    const { client, seen } = clientFor(admin, () => json([{ id: 1 }]));
    const r = await client.resource("heroes");
    client.use((ctx, next) =>
      ctx.op === "list"
        ? Promise.resolve(json([{ id: 99 }]))
        : next({
            ...ctx,
            request: new Request(`${BASE}/other`, { method: "GET" }),
          }),
    );
    expect(await r.list()).toEqual([{ id: 99 }]);
    await r.get(1);
    expect(seen.at(-1)!.url).toBe(`${BASE}/other`);
  });
});

describe("auth", () => {
  const unauthorized = () =>
    json(
      { title: "no" },
      { status: 401, headers: { "www-authenticate": "Bearer" } },
    );

  it("sends the bearer token and stays anonymous without one", async () => {
    const { client, seen } = clientFor(admin, undefined, {
      tokenProvider: () => "tok",
    });
    await (await client.resource("heroes")).list();
    expect(seen.map((s) => s.headers.get("authorization"))).toEqual([
      "Bearer tok",
      "Bearer tok",
    ]);
    const anon = clientFor(admin, undefined, {
      tokenProvider: async () => undefined,
    });
    await (await anon.client.resource("heroes")).list();
    expect(
      anon.seen.every((s) => s.headers.get("authorization") === null),
    ).toBe(true);
    expect(await anon.client.token()).toBeNull();
    expect(await anon.client.scope()).toBe("anon");
    expect(await client.scope()).toBe(await cacheScope("tok"));
    expect(await client.namespace()).toEqual({
      client: client.baseUrl,
      scope: await cacheScope("tok"),
    });
  });

  it("identifies itself by id, defaulting to baseUrl", () => {
    expect(clientFor(admin, undefined, { id: "main" }).client.id).toBe("main");
  });

  it("refreshes once after a 401 and retries with the new scope", async () => {
    let token = "old";
    const refreshes: boolean[] = [];
    const contexts: RequestContext[] = [];
    const { client, seen } = clientFor(
      admin,
      (r) =>
        r.headers.get("authorization") === "Bearer old"
          ? unauthorized()
          : json([1]),
      {
        tokenProvider: ({ refresh }) => {
          refreshes.push(refresh);
          if (refresh) {
            token = "new";
          }
          return token;
        },
        middleware: [(ctx, next) => (contexts.push(ctx), next(ctx))],
      },
    );
    const r = await client.resource("heroes");
    contexts.length = 0;
    refreshes.length = 0;
    expect(await r.list()).toEqual([1]);
    expect(refreshes).toEqual([false, true]);
    expect(seen.slice(-2).map((s) => s.headers.get("authorization"))).toEqual([
      "Bearer old",
      "Bearer new",
    ]);
    expect(contexts.map((c) => c.scope)).toEqual([
      await cacheScope("old"),
      await cacheScope("new"),
    ]);
  });

  it("retries a request with a body intact", async () => {
    let token = "old";
    const { client, seen } = clientFor(
      admin,
      (r) =>
        r.headers.get("authorization") === "Bearer old"
          ? unauthorized()
          : json({ id: 1 }),
      { tokenProvider: ({ refresh }) => (refresh ? (token = "new") : token) },
    );
    await (await client.resource("heroes")).create({ name: "a" });
    expect(seen.slice(-2).map((s) => s.body)).toEqual([
      '{"name":"a"}',
      '{"name":"a"}',
    ]);
  });

  it("does not retry when the token did not change, or there is none", async () => {
    for (const provider of [() => "same", () => null, undefined]) {
      const { client, seen } = bareClient(unauthorized, {
        tokenProvider: provider,
      });
      await expect(client.manifest()).rejects.toBeInstanceOf(Unauthorized);
      expect(seen).toHaveLength(1);
    }
  });

  it("throws the second 401 without a third try", async () => {
    let token = "a";
    const { client, seen } = bareClient(unauthorized, {
      tokenProvider: ({ refresh }) => (refresh ? (token = "b") : token),
    });
    const error = await client.manifest().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Unauthorized);
    expect((error as Unauthorized).wwwAuthenticate).toBe("Bearer");
    expect(seen).toHaveLength(2);
  });

  it("drops the first 401 response body, even when it has none", async () => {
    let token = "a";
    let n = 0;
    const { client } = clientFor(
      admin,
      () => (n++ === 0 ? new Response(null, { status: 401 }) : json([])),
      { tokenProvider: ({ refresh }) => (refresh ? (token = "b") : token) },
    );
    const r = await client.resource("heroes");
    n = 0;
    expect(await r.list()).toEqual([]);
  });
});

describe("operations", () => {
  it("sends JSON bodies, If-Match and decodes responses", async () => {
    const { client, seen } = clientFor(admin, (r) =>
      r.method === "DELETE"
        ? new Response(null, { status: 204 })
        : json({ id: 1, name: "x" }),
    );
    const r = await client.resource("heroes");
    expect(await r.create({ name: "x" })).toEqual({ id: 1, name: "x" });
    expect(seen.at(-1)!.headers.get("content-type")).toBe("application/json");
    expect(seen.at(-1)!.body).toBe('{"name":"x"}');
    await r.update(1, { name: "y" }, { ifMatch: 'W/"3"' });
    expect(seen.at(-1)!.method).toBe("PATCH");
    expect(seen.at(-1)!.headers.get("if-match")).toBe('W/"3"');
    await r.update(1, {});
    expect(seen.at(-1)!.headers.get("if-match")).toBeNull();
    await r.get(1);
    expect(seen.at(-1)!.headers.get("content-type")).toBeNull();
    expect(await r.delete(1, { ifMatch: "e" })).toBeUndefined();
    expect(seen.at(-1)!.headers.get("if-match")).toBe("e");
    expect(await r.delete(2)).toBeUndefined();
  });

  it("decodes a 204 on a JSON call as undefined", async () => {
    const { client } = clientFor(
      admin,
      () => new Response(null, { status: 204 }),
    );
    const r = await client.resource("heroes");
    expect(await r.get(1)).toBeUndefined();
  });

  it("reaches every capability-gated endpoint", async () => {
    const { client, seen } = clientFor(admin, () =>
      json({ matched: 0, ids: [] }),
    );
    const r = await client.resource("heroes");
    await r.stats({ bucket: "day" });
    await r.predict({ field: "power_level" });
    await r.clone(1);
    await r.createDraft({ name: "d" });
    await r.publish(1);
    await r.revisions(1);
    await r.filters();
    await r.deleteMany({ name: "x" });
    await r.restore({ filters: { name: "x" } });
    expect(
      seen
        .slice(1)
        .map((s) => `${s.method} ${s.url.slice(BASE.length + heroes.length)}`),
    ).toEqual([
      "GET /stats?bucket=day",
      "GET /predict?field=power_level",
      "POST /clone?id=1",
      "POST /draft",
      "POST /publish?id=1",
      "GET /revisions?id=1",
      "GET /filters",
      "DELETE ?name=x",
      "POST /restore?name=x",
    ]);
    expect(r.eventsUrl()).toBe(`${BASE}${heroes}/events`);
  });

  it("pages through iterAll until a short page", async () => {
    const pages = [[1, 2], [3, 4], [5]];
    const { client, seen } = clientFor(admin, (r) => {
      const skip = Number(new URL(r.url).searchParams.get("skip"));
      return json(pages[skip / 2]);
    });
    const r = await client.resource("heroes");
    const out: unknown[] = [];
    for await (const record of r.iterAll({
      limit: 2,
      filters: { name: "a" },
    })) {
      out.push(record);
    }
    expect(out).toEqual([1, 2, 3, 4, 5]);
    expect(
      seen.slice(1).map((s) => s.url.slice(BASE.length + heroes.length)),
    ).toEqual([
      "?name=a&skip=0&limit=2",
      "?name=a&skip=2&limit=2",
      "?name=a&skip=4&limit=2",
    ]);
  });

  it("uses the manifest page size and a given skip in iterAll", async () => {
    const { client, seen } = clientFor(admin, () => json([]));
    const r = await client.resource("heroes");
    const out = [];
    for await (const record of r.iterAll({ skip: 7 })) {
      out.push(record);
    }
    expect(out).toEqual([]);
    expect(seen.at(-1)!.url).toBe(`${BASE}${heroes}?skip=7&limit=100`);
  });

  it("sends only_archived=true on list and iterAll, and throws before a request on a conflict", async () => {
    const { client, seen } = clientFor(admin, () => json([]));
    const r = await client.resource("heroes");
    await r.list({ onlyArchived: true, filters: { name: "a" }, limit: 3 });
    expect(seen.at(-1)!.url).toBe(
      `${BASE}${heroes}?name=a&limit=3&only_archived=true`,
    );
    await r.list({ onlyArchived: false });
    expect(seen.at(-1)!.url).toBe(`${BASE}${heroes}`);
    for await (const _ of r.iterAll({ onlyArchived: true })) {
      // empty page ends it
    }
    expect(seen.at(-1)!.url).toBe(
      `${BASE}${heroes}?skip=0&limit=100&only_archived=true`,
    );
    const count = seen.length;
    await expect(
      r.list({ onlyArchived: true, includeArchived: false }),
    ).rejects.toThrow(InvalidQueryError);
    expect(seen).toHaveLength(count);
  });
});

describe("capability gates", () => {
  it("refuses bulk calls the manifest does not offer", async () => {
    const doc = structuredClone(admin) as any;
    doc.resources[1].capabilities.bulk_update = false;
    doc.resources[1].capabilities.bulk_delete = false;
    const { client, seen } = clientFor(doc);
    const r = await client.resource("heroes");
    await expect(r.updateMany({ name: "a" }, {})).rejects.toThrow(
      CapabilityError,
    );
    await expect(r.deleteMany({ name: "a" })).rejects.toThrow("bulk_delete");
    expect(seen).toHaveLength(1);
  });
});

describe("errors", () => {
  it("raises problem errors for >= 400 and parses their bodies", async () => {
    const { client } = clientFor(admin, (r) =>
      r.method === "GET" && r.url.includes("id=404")
        ? json({ title: "Gone", detail: "no such hero" }, { status: 404 })
        : json({}, { status: 429, headers: { "retry-after": "7" } }),
    );
    const r = await client.resource("heroes");
    await expect(r.get(404)).rejects.toBeInstanceOf(NotFound);
    const limited = await r.list().catch((e: unknown) => e);
    expect((limited as RateLimited).retryAfter).toBe(7);
  });

  it("wraps transport failures in ConnectionFailed", async () => {
    const boom = new TypeError("fetch failed");
    const { client } = clientFor(admin, () => {
      throw boom;
    });
    const r = await client.resource("heroes");
    const error = await r.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionFailed);
    expect((error as ConnectionFailed).cause).toBe(boom);
    expect((error as ConnectionFailed).message).toBe("fetch failed");
    const odd = clientFor(admin, () => Promise.reject("text" as never));
    const r2 = await odd.client.resource("heroes");
    await expect(r2.list()).rejects.toThrow("text");
  });

  it("passes an abort through unchanged", async () => {
    const controller = new AbortController();
    const { client } = clientFor(admin, (r) => {
      controller.abort();
      throw r.request.signal.reason;
    });
    const r = await client.resource("heroes");
    const error = await r
      .list({ signal: controller.signal })
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ConnectionFailed);
    expect((error as DOMException).name).toBe("AbortError");
  });

  it("uses globalThis.fetch by default", async () => {
    const stub = vi.fn((request: Request) =>
      Promise.resolve(request.url.endsWith("/m") ? json(admin) : json([])),
    );
    vi.stubGlobal("fetch", stub);
    const client = createClient({ baseUrl: BASE, manifestUrl: `${BASE}/m` });
    expect(await (await client.resource("heroes")).list()).toEqual([]);
    expect(stub).toHaveBeenCalledTimes(2);
  });
});
