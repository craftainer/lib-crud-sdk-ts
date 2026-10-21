import { describe, expect, expectTypeOf, it } from "vitest";
import { composeMiddleware } from "../src/index.ts";
import type {
  CacheEntry,
  CacheStore,
  CrudEvent,
  Middleware,
  Next,
  RequestContext,
  TokenProvider,
} from "../src/index.ts";

const ctx: RequestContext = {
  request: new Request("https://api.test/heroes"),
  resource: "heroes",
  op: "list",
  recordId: undefined,
  scope: "anon",
  apiVersion: null,
  signal: undefined,
};

const ok: Next = () => Promise.resolve(new Response("ok"));

describe("composeMiddleware", () => {
  it("returns the terminal for an empty chain", async () => {
    const res = await composeMiddleware([], ok)(ctx);
    expect(await res.text()).toBe("ok");
  });

  it("runs the first middleware outermost", async () => {
    const log: string[] = [];
    const tag =
      (name: string): Middleware =>
      async (c, next) => {
        log.push(`${name} in`);
        const res = await next(c);
        log.push(`${name} out`);
        return res;
      };
    const terminal: Next = (c) => {
      log.push("fetch");
      return ok(c);
    };
    await composeMiddleware([tag("a"), tag("b")], terminal)(ctx);
    expect(log).toEqual(["a in", "b in", "fetch", "b out", "a out"]);
  });

  it("lets a middleware short-circuit without calling next", async () => {
    let reached = false;
    const hit: Middleware = () => Promise.resolve(new Response("cached"));
    const terminal: Next = (c) => {
      reached = true;
      return ok(c);
    };
    const res = await composeMiddleware([hit], terminal)(ctx);
    expect(await res.text()).toBe("cached");
    expect(reached).toBe(false);
  });

  it("passes a replaced context down the chain", async () => {
    const swap: Middleware = (c, next) =>
      next({ ...c, request: new Request("https://api.test/other") });
    let seen = "";
    const terminal: Next = (c) => {
      seen = c.request.url;
      return ok(c);
    };
    await composeMiddleware([swap], terminal)(ctx);
    expect(seen).toBe("https://api.test/other");
  });

  it("turns a throwing middleware into a rejection", async () => {
    const boom: Middleware = () => {
      throw new Error("boom");
    };
    await expect(composeMiddleware([boom], ok)(ctx)).rejects.toThrow("boom");
  });
});

describe("CacheStore contract", () => {
  const entry: CacheEntry = {
    status: 200,
    headers: [["etag", 'W/"1"']],
    body: "{}",
    storedAt: 1,
    freshUntil: 1,
    staleUntil: 2,
    etag: 'W/"1"',
  };

  // A trivial synchronous backend and an async one prove both shapes fit.
  const memory = (): CacheStore => {
    const map = new Map<string, CacheEntry>();
    return {
      get: (key) => map.get(key),
      set: (key, value) => {
        map.set(key, value);
      },
      delete: (key) => {
        map.delete(key);
      },
      clear: (prefix) => {
        for (const key of map.keys()) {
          if (prefix === undefined || key.startsWith(prefix)) {
            map.delete(key);
          }
        }
      },
    };
  };

  it("stores, reads, deletes and clears by prefix", async () => {
    const store = memory();
    await store.set("v1/heroes/_/list/_/anon/", entry, 1000);
    await store.set("v1/heroes/_/record/1/anon/", entry);
    await store.set("v1/other/_/list/_/anon/", entry);
    expect(await store.get("v1/heroes/_/list/_/anon/")).toBe(entry);
    await store.delete("v1/heroes/_/list/_/anon/");
    expect(await store.get("v1/heroes/_/list/_/anon/")).toBeUndefined();
    await store.clear("v1/heroes/");
    expect(await store.get("v1/heroes/_/record/1/anon/")).toBeUndefined();
    expect(await store.get("v1/other/_/list/_/anon/")).toBe(entry);
    await store.clear();
    expect(await store.get("v1/other/_/list/_/anon/")).toBeUndefined();
  });

  it("types", () => {
    expectTypeOf<CacheStore["get"]>().returns.toEqualTypeOf<
      CacheEntry | undefined | Promise<CacheEntry | undefined>
    >();
    expectTypeOf<RequestContext["apiVersion"]>().toEqualTypeOf<string | null>();
    expectTypeOf<RequestContext["recordId"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<Middleware>().toEqualTypeOf<
      (ctx: RequestContext, next: Next) => Promise<Response>
    >();
    expectTypeOf<CrudEvent["action"]>().toEqualTypeOf<
      "create" | "update" | "delete" | "restore"
    >();
    expectTypeOf<ReturnType<TokenProvider>>().toEqualTypeOf<
      string | null | undefined | Promise<string | null | undefined>
    >();
    expectTypeOf<CacheEntry["etag"]>().toEqualTypeOf<string | undefined>();
  });
});
