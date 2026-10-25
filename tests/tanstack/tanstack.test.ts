import {
  InfiniteQueryObserver,
  MutationObserver,
  QueryClient,
} from "@tanstack/query-core";
import type { DataTag } from "@tanstack/query-core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  bridgeEvents,
  createMutationOptions,
  crudKeys,
  deleteMutationOptions,
  infiniteListOptions,
  listOptions,
  manifestOptions,
  predictOptions,
  recordOptions,
  revisionsOptions,
  statsOptions,
  updateMutationOptions,
} from "../../src/tanstack/index.ts";
import type { EventHandlers, EventHub } from "../../src/tanstack/index.ts";
import type { CrudEvent } from "../../src/interfaces.ts";

interface Hero {
  id: number;
  name: string;
}

const signal = new AbortController().signal;
const ns = { client: "c1", scope: "s1" };
const other = { client: "c1", scope: "s2" };

describe("crudKeys", () => {
  it("nests by resource, kind and record so prefixes invalidate", () => {
    expect(crudKeys.all).toEqual(["crud"]);
    expect(crudKeys.client("c1")).toEqual(["crud", "c1"]);
    expect(crudKeys.resource("c1", "heroes")).toEqual(["crud", "c1", "heroes"]);
    expect(crudKeys.lists(ns, "heroes")).toEqual([
      "crud",
      "c1",
      "heroes",
      "s1",
      "list",
    ]);
    expect(crudKeys.list(ns, "heroes")).toEqual(crudKeys.lists(ns, "heroes"));
    expect(crudKeys.list(ns, "heroes", { a: 1 })).toEqual([
      "crud",
      "c1",
      "heroes",
      "s1",
      "list",
      { a: 1 },
    ]);
    expect(crudKeys.infiniteList(ns, "heroes", { a: 1 }, 10)).toEqual([
      "crud",
      "c1",
      "heroes",
      "s1",
      "list",
      "infinite",
      { a: 1 },
      10,
    ]);
    expect(crudKeys.records(ns, "heroes")).toEqual([
      "crud",
      "c1",
      "heroes",
      "s1",
      "record",
    ]);
    expect(crudKeys.record(ns, "heroes", 5)).toEqual([
      "crud",
      "c1",
      "heroes",
      "s1",
      "record",
      5,
    ]);
    expect(crudKeys.stats(ns, "heroes")).toEqual([
      "crud",
      "c1",
      "heroes",
      "s1",
      "stats",
    ]);
    expect(crudKeys.stats(ns, "heroes", { b: 2 })).toEqual([
      "crud",
      "c1",
      "heroes",
      "s1",
      "stats",
      { b: 2 },
    ]);
    expect(crudKeys.predict(ns, "heroes")).toEqual([
      "crud",
      "c1",
      "heroes",
      "s1",
      "predict",
    ]);
    expect(crudKeys.predict(ns, "heroes", { b: 2 })).toEqual([
      "crud",
      "c1",
      "heroes",
      "s1",
      "predict",
      { b: 2 },
    ]);
    expect(crudKeys.revisions(ns, "heroes", 5)).toEqual([
      "crud",
      "c1",
      "heroes",
      "s1",
      "revisions",
      5,
    ]);
    expect(crudKeys.manifest(ns)).toEqual(["crud", "c1", "_manifest", "s1"]);
  });

  it("keeps archived-only and normal lists apart", async () => {
    const queryClient = new QueryClient();
    const api = { list: vi.fn(async () => [{ id: 1, name: "a" }]) };
    const normal = listOptions<Hero>(ns, "heroes", api, { limit: 5 });
    const archived = listOptions<Hero>(ns, "heroes", api, {
      limit: 5,
      onlyArchived: true,
    });
    expect(archived.queryKey).toEqual([
      ...crudKeys.lists(ns, "heroes"),
      { limit: 5, onlyArchived: true },
    ]);
    queryClient.setQueryData(normal.queryKey, [{ id: 2, name: "b" }]);
    queryClient.setQueryData(archived.queryKey, [{ id: 3, name: "c" }]);
    expect(queryClient.getQueryData(normal.queryKey)).toEqual([
      { id: 2, name: "b" },
    ]);
    expect(queryClient.getQueryData(archived.queryKey)).toEqual([
      { id: 3, name: "c" },
    ]);
    await archived.queryFn({ signal });
    expect(api.list).toHaveBeenCalledWith(
      { limit: 5, onlyArchived: true },
      { signal },
    );
    const paged = infiniteListOptions<Hero>(ns, "heroes", api, {
      onlyArchived: true,
    });
    expect(paged.queryKey).not.toEqual(
      infiniteListOptions<Hero>(ns, "heroes", api, {}).queryKey,
    );
    await paged.queryFn({ signal, pageParam: 0 });
    expect(api.list).toHaveBeenLastCalledWith(
      { onlyArchived: true, skip: 0, limit: 100 },
      { signal },
    );
    queryClient.clear();
  });

  it("separates clients and scopes sharing one QueryClient", () => {
    const queryClient = new QueryClient();
    const keys = [
      crudKeys.list(ns, "heroes"),
      crudKeys.list(other, "heroes"),
      crudKeys.list({ client: "c2", scope: "s1" }, "heroes"),
    ];
    keys.forEach((key, i) => queryClient.setQueryData(key, [i]));
    expect(keys.map((key) => queryClient.getQueryData(key))).toEqual([
      [0],
      [1],
      [2],
    ]);
    queryClient.clear();
  });

  it("filter: a client or resource is one prefix; scope, kind and id use a predicate", () => {
    expect(crudKeys.filter({ client: "c1" })).toEqual({
      queryKey: ["crud", "c1"],
    });
    expect(crudKeys.filter({ client: "c1", resource: "heroes" })).toEqual({
      queryKey: ["crud", "c1", "heroes"],
    });
    const keys = {
      list: crudKeys.list(ns, "heroes"),
      otherScope: crudKeys.list(other, "heroes"),
      otherClient: crudKeys.list({ client: "c2", scope: "s1" }, "heroes"),
      ships: crudKeys.list(ns, "ships"),
      rec5: crudKeys.record(ns, "heroes", 5),
      rev5: crudKeys.revisions(ns, "heroes", 5),
      rec6: crudKeys.record(ns, "heroes", 6),
      manifest: crudKeys.manifest(ns),
      foreign: ["other", "c1", "heroes"],
    };
    const match = (f: Parameters<typeof crudKeys.filter>[0]) => {
      const m = crudKeys.filter(f);
      if (!("predicate" in m)) throw new Error("expected a predicate");
      return Object.entries(keys)
        .filter(([, queryKey]) => m.predicate({ queryKey }))
        .map(([name]) => name);
    };
    expect(
      match({ client: "c1", resource: "heroes", kinds: ["list"] }),
    ).toEqual(["list", "otherScope"]);
    expect(match({ client: "c1", scope: "s1", kinds: ["list"] })).toEqual([
      "list",
      "ships",
    ]);
    expect(
      match({
        client: "c1",
        resource: "heroes",
        kinds: ["record", "revisions"],
        id: 5,
      }),
    ).toEqual(["rec5", "rev5"]);
    expect(match({ client: "c1", resource: "heroes", id: 5 })).toEqual([
      "rec5",
      "rev5",
    ]);
    expect(
      match({
        client: "c1",
        resource: "heroes",
        exceptScope: "s1",
        kinds: ["list"],
      }),
    ).toEqual(["otherScope"]);
    expect(match({ client: "c1", scope: "s1" })).toEqual([
      "list",
      "ships",
      "rec5",
      "rev5",
      "rec6",
      "manifest",
    ]);
  });
});

describe("option factories", () => {
  const hero: Hero = { id: 5, name: "a" };

  it("return plain, typed options whose queryFn calls the API", async () => {
    const api = {
      list: vi.fn(async () => [hero]),
      get: vi.fn(async () => hero),
      stats: vi.fn(async () => ({ n: 1 })),
      predict: vi.fn(async () => ({ p: 2 })),
      revisions: vi.fn(async () => [{ rev: 1 }]),
      manifest: vi.fn(async () => ({ resources: [] })),
    };

    const list = listOptions<Hero>(
      ns,
      "heroes",
      api,
      { sort: "name" },
      { staleTime: 5 },
    );
    expect(list.queryKey).toEqual([
      "crud",
      "c1",
      "heroes",
      "s1",
      "list",
      { sort: "name" },
    ]);
    expect(list.staleTime).toBe(5);
    expect(await list.queryFn({ signal })).toEqual([hero]);
    expect(api.list).toHaveBeenCalledWith({ sort: "name" }, { signal });
    expectTypeOf(list.queryKey).toEqualTypeOf<
      DataTag<readonly unknown[], Hero[], Error>
    >();

    const record = recordOptions<Hero>(ns, "heroes", api, 5);
    expect(record.queryKey).toEqual([
      "crud",
      "c1",
      "heroes",
      "s1",
      "record",
      5,
    ]);
    expect(record.staleTime).toBe(0);
    expect(await record.queryFn({ signal })).toEqual(hero);
    expect(api.get).toHaveBeenCalledWith(5, { signal });

    const stats = statsOptions(ns, "heroes", api, { by: "x" });
    expect(await stats.queryFn({ signal })).toEqual({ n: 1 });
    expect(api.stats).toHaveBeenCalledWith({ by: "x" }, { signal });
    expect(stats.queryKey).toEqual([
      "crud",
      "c1",
      "heroes",
      "s1",
      "stats",
      { by: "x" },
    ]);

    const predict = predictOptions(ns, "heroes", api);
    expect(await predict.queryFn({ signal })).toEqual({ p: 2 });
    expect(api.predict).toHaveBeenCalledWith(undefined, { signal });
    expect(predict.queryKey).toEqual(["crud", "c1", "heroes", "s1", "predict"]);

    const revisions = revisionsOptions(ns, "heroes", api, 5);
    expect(await revisions.queryFn({ signal })).toEqual([{ rev: 1 }]);
    expect(revisions.queryKey).toEqual([
      "crud",
      "c1",
      "heroes",
      "s1",
      "revisions",
      5,
    ]);

    const manifest = manifestOptions(ns, api, { staleTime: 1000 });
    expect(await manifest.queryFn({ signal })).toEqual({ resources: [] });
    expect(manifest.queryKey).toEqual(["crud", "c1", "_manifest", "s1"]);
    expect(manifest.staleTime).toBe(1000);
    expect(manifestOptions(ns, api).staleTime).toBe(0);
  });

  it("work with a real QueryClient", async () => {
    const queryClient = new QueryClient();
    const api = { list: vi.fn(async () => [hero]) };
    const options = listOptions<Hero>(ns, "heroes", api);
    expect(await queryClient.fetchQuery(options)).toEqual([hero]);
    expect(queryClient.getQueryData(options.queryKey)).toEqual([hero]);
    queryClient.clear();
  });
});

describe("infiniteListOptions", () => {
  it("pages by skip + limit until a short page", async () => {
    const pages = [[1, 2], [3, 4], [5]];
    const api = {
      list: vi.fn(
        async (query: Record<string, unknown> | undefined) =>
          pages[(query?.["skip"] as number) / 2]!,
      ),
    };
    const options = infiniteListOptions(
      ns,
      "heroes",
      api,
      { sort: "id" },
      { limit: 2 },
    );
    expect(options.queryKey).toEqual([
      "crud",
      "c1",
      "heroes",
      "s1",
      "list",
      "infinite",
      { sort: "id" },
      2,
    ]);
    expect(options.initialPageParam).toBe(0);
    expect(options.getNextPageParam([1, 2], [], 0)).toBe(2);
    expect(options.getNextPageParam([1], [], 4)).toBeUndefined();
    expect(await options.queryFn({ signal, pageParam: 2 })).toEqual([3, 4]);
    expect(api.list).toHaveBeenCalledWith(
      { sort: "id", skip: 2, limit: 2 },
      { signal },
    );

    // Through a real observer: all three pages load.
    const queryClient = new QueryClient();
    const observer = new InfiniteQueryObserver(queryClient, options);
    let result = await observer.fetchNextPage();
    result = await observer.fetchNextPage();
    result = await observer.fetchNextPage();
    expect(result.data?.pages).toEqual(pages);
    expect(result.hasNextPage).toBe(false);
    queryClient.clear();
  });

  it("takes defaults and manifest-named paging parameters", async () => {
    const api = { list: vi.fn(async () => [] as number[]) };
    const options = infiniteListOptions(ns, "heroes", api, undefined, {
      skipKey: "offset",
      limitKey: "count",
      staleTime: 7,
    });
    expect(options.staleTime).toBe(7);
    await options.queryFn({ signal, pageParam: 100 });
    expect(api.list).toHaveBeenCalledWith(
      { offset: 100, count: 100 },
      { signal },
    );
    expect(infiniteListOptions(ns, "heroes", api).staleTime).toBe(0);
    expect(infiniteListOptions(ns, "heroes", api).queryKey).toEqual([
      "crud",
      "c1",
      "heroes",
      "s1",
      "list",
      "infinite",
      {},
      100,
    ]);
  });
});

describe("mutation option factories", () => {
  function seeded() {
    const queryClient = new QueryClient();
    queryClient.setQueryData(crudKeys.list(ns, "heroes", { a: 1 }), [1]);
    queryClient.setQueryData(crudKeys.infiniteList(ns, "heroes", {}, 10), {
      pages: [],
      pageParams: [],
    });
    queryClient.setQueryData(crudKeys.stats(ns, "heroes"), 1);
    queryClient.setQueryData(crudKeys.predict(ns, "heroes", { a: 1 }), 1);
    queryClient.setQueryData(crudKeys.record(ns, "heroes", 5), {
      id: 5,
      name: "old",
    });
    queryClient.setQueryData(crudKeys.record(ns, "heroes", 6), {
      id: 6,
      name: "six",
    });
    queryClient.setQueryData(crudKeys.record(other, "heroes", 5), {
      id: 5,
      name: "old",
    });
    queryClient.setQueryData(crudKeys.revisions(ns, "heroes", 5), []);
    queryClient.setQueryData(crudKeys.list(ns, "ships"), [1]);
    queryClient.setQueryData(crudKeys.list(other, "heroes"), [1]);
    queryClient.setQueryData(
      crudKeys.list({ client: "c2", scope: "s1" }, "heroes"),
      [1],
    );
    return queryClient;
  }
  const stale = (queryClient: QueryClient, key: readonly unknown[]) =>
    queryClient.getQueryState(key)?.isInvalidated;

  it("create invalidates lists, stats and predict", async () => {
    const queryClient = seeded();
    const api = {
      create: vi.fn(async (body: { name: string }) => ({ id: 9, ...body })),
    };
    const options = createMutationOptions(queryClient, ns, "heroes", api);
    expect(options.mutationKey).toEqual([
      "crud",
      "c1",
      "heroes",
      "s1",
      "create",
    ]);
    expect(await options.mutationFn({ name: "n" })).toEqual({
      id: 9,
      name: "n",
    });
    expect("onSuccess" in options).toBe(false); // the invalidation is in onSettled
    await options.onSettled({ id: 9, name: "n" }, null);
    expect(stale(queryClient, crudKeys.list(ns, "heroes", { a: 1 }))).toBe(
      true,
    );
    expect(
      stale(queryClient, crudKeys.infiniteList(ns, "heroes", {}, 10)),
    ).toBe(true);
    expect(stale(queryClient, crudKeys.stats(ns, "heroes"))).toBe(true);
    expect(stale(queryClient, crudKeys.predict(ns, "heroes", { a: 1 }))).toBe(
      true,
    );
    expect(stale(queryClient, crudKeys.record(ns, "heroes", 5))).toBe(false);
    expect(stale(queryClient, crudKeys.list(ns, "ships"))).toBe(false);
    // Every scope of this client is stale; another client's data is not.
    expect(stale(queryClient, crudKeys.list(other, "heroes"))).toBe(true);
    expect(
      stale(
        queryClient,
        crudKeys.list({ client: "c2", scope: "s1" }, "heroes"),
      ),
    ).toBe(false);
    queryClient.clear();
  });

  it("update sets the record from the PATCH response and invalidates the rest", async () => {
    const queryClient = seeded();
    const api = {
      update: vi.fn(async (id: number, patch: Partial<Hero>) => ({
        id,
        name: "new",
        ...patch,
      })),
    };
    const options = updateMutationOptions(queryClient, ns, "heroes", api);
    expect(options.mutationKey).toEqual([
      "crud",
      "c1",
      "heroes",
      "s1",
      "update",
    ]);
    const record = await options.mutationFn({ id: 5, patch: {} });
    expect(api.update).toHaveBeenLastCalledWith(5, {}, {});
    await options.mutationFn({ id: 5, patch: {}, ifMatch: 'W/"1"' });
    expect(api.update).toHaveBeenLastCalledWith(5, {}, { ifMatch: 'W/"1"' });
    await options.onSuccess(record, { id: 5, patch: {} });
    expect(queryClient.getQueryData(crudKeys.record(ns, "heroes", 5))).toEqual({
      id: 5,
      name: "new",
    });
    expect(stale(queryClient, crudKeys.list(ns, "heroes", { a: 1 }))).toBe(
      false,
    ); // onSuccess only sets the record
    await options.onSettled(record, null, { id: 5, patch: {} });
    expect(stale(queryClient, crudKeys.record(ns, "heroes", 5))).toBe(false);
    expect(stale(queryClient, crudKeys.list(ns, "heroes", { a: 1 }))).toBe(
      true,
    );
    expect(stale(queryClient, crudKeys.stats(ns, "heroes"))).toBe(true);
    expect(stale(queryClient, crudKeys.predict(ns, "heroes", { a: 1 }))).toBe(
      true,
    );
    expect(stale(queryClient, crudKeys.revisions(ns, "heroes", 5))).toBe(true);
    expect(stale(queryClient, crudKeys.record(ns, "heroes", 6))).toBe(false);
    // Another scope's copy of the updated record is stale.
    expect(stale(queryClient, crudKeys.record(other, "heroes", 5))).toBe(true);
    queryClient.clear();
  });

  it("delete drops the record and invalidates lists, stats, predict and revisions", async () => {
    const queryClient = seeded();
    const api = { delete: vi.fn(async () => undefined) };
    const options = deleteMutationOptions(queryClient, ns, "heroes", api);
    expect(options.mutationKey).toEqual([
      "crud",
      "c1",
      "heroes",
      "s1",
      "delete",
    ]);
    await options.mutationFn(5);
    expect(api.delete).toHaveBeenCalledWith(5);
    await options.onSuccess(undefined, 5);
    expect(stale(queryClient, crudKeys.list(ns, "heroes", { a: 1 }))).toBe(
      false,
    ); // onSuccess only drops the record
    await options.onSettled(undefined, null, 5);
    expect(
      queryClient.getQueryData(crudKeys.record(ns, "heroes", 5)),
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(crudKeys.record(ns, "heroes", 6)),
    ).toBeDefined();
    expect(stale(queryClient, crudKeys.list(ns, "heroes", { a: 1 }))).toBe(
      true,
    );
    expect(stale(queryClient, crudKeys.revisions(ns, "heroes", 5))).toBe(true);
    queryClient.clear();
  });
});

describe("mutation option factories settle on any outcome", () => {
  const seed = () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(crudKeys.list(ns, "heroes"), [1]);
    queryClient.setQueryData(crudKeys.stats(ns, "heroes"), 1);
    queryClient.setQueryData(crudKeys.record(ns, "heroes", 5), { id: 5 });
    queryClient.setQueryData(crudKeys.record(other, "heroes", 5), { id: 5 });
    queryClient.setQueryData(crudKeys.revisions(ns, "heroes", 5), []);
    return queryClient;
  };
  const stale = (queryClient: QueryClient, key: readonly unknown[]) =>
    queryClient.getQueryState(key)?.isInvalidated;
  const collections = (queryClient: QueryClient) => [
    stale(queryClient, crudKeys.list(ns, "heroes")),
    stale(queryClient, crudKeys.stats(ns, "heroes")),
  ];
  const failures = {
    "a 4xx": new Error("412"),
    "a 5xx": Object.assign(new Error("503"), { status: 503 }),
    "a thrown transport error": new TypeError("fetch failed"),
  };

  it.each(Object.entries(failures))(
    "create invalidates collections after %s",
    async (_name, failure) => {
      const queryClient = seed();
      const options = createMutationOptions(queryClient, ns, "heroes", {
        create: () => Promise.reject(failure),
      });
      await new MutationObserver(queryClient, options)
        .mutate({})
        .catch(() => undefined);
      expect(collections(queryClient)).toEqual([true, true]);
      queryClient.clear();
    },
  );

  it("create invalidates collections once on success", async () => {
    const queryClient = seed();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const options = createMutationOptions(queryClient, ns, "heroes", {
      create: () => Promise.resolve({ id: 1 }),
    });
    await new MutationObserver(queryClient, options).mutate({});
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(collections(queryClient)).toEqual([true, true]);
    queryClient.clear();
  });

  it("update invalidates once on success and keeps the caller's own record fresh", async () => {
    const queryClient = seed();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const options = updateMutationOptions(queryClient, ns, "heroes", {
      update: (id: number) => Promise.resolve({ id, name: "new" }),
    });
    await new MutationObserver(queryClient, options).mutate({
      id: 5,
      patch: {},
    });
    expect(invalidate).toHaveBeenCalledTimes(3); // collections (once), other scopes' records, revisions
    expect(collections(queryClient)).toEqual([true, true]);
    expect(stale(queryClient, crudKeys.record(ns, "heroes", 5))).toBe(false);
    expect(stale(queryClient, crudKeys.record(other, "heroes", 5))).toBe(true);
    expect(stale(queryClient, crudKeys.revisions(ns, "heroes", 5))).toBe(true);
    queryClient.clear();
  });

  it.each(Object.entries(failures))(
    "update invalidates everything of the record after %s, and sets nothing",
    async (_name, failure) => {
      const queryClient = seed();
      const options = updateMutationOptions(queryClient, ns, "heroes", {
        update: () => Promise.reject(failure),
      });
      await new MutationObserver(queryClient, options)
        .mutate({ id: 5, patch: {} })
        .catch(() => undefined);
      expect(
        queryClient.getQueryData(crudKeys.record(ns, "heroes", 5)),
      ).toEqual({ id: 5 });
      expect(collections(queryClient)).toEqual([true, true]);
      expect(stale(queryClient, crudKeys.record(ns, "heroes", 5))).toBe(true);
      expect(stale(queryClient, crudKeys.record(other, "heroes", 5))).toBe(
        true,
      );
      expect(stale(queryClient, crudKeys.revisions(ns, "heroes", 5))).toBe(
        true,
      );
      queryClient.clear();
    },
  );

  it("delete removes the record and invalidates the rest on success", async () => {
    const queryClient = seed();
    const options = deleteMutationOptions(queryClient, ns, "heroes", {
      delete: () => Promise.resolve(undefined),
    });
    await new MutationObserver(queryClient, options).mutate(5);
    expect(
      queryClient.getQueryData(crudKeys.record(ns, "heroes", 5)),
    ).toBeUndefined();
    expect(collections(queryClient)).toEqual([true, true]);
    expect(stale(queryClient, crudKeys.revisions(ns, "heroes", 5))).toBe(true);
    queryClient.clear();
  });

  it.each(Object.entries(failures))(
    "delete keeps the record but invalidates it and the collections after %s",
    async (_name, failure) => {
      const queryClient = seed();
      const options = deleteMutationOptions(queryClient, ns, "heroes", {
        delete: () => Promise.reject(failure),
      });
      await new MutationObserver(queryClient, options)
        .mutate(5)
        .catch(() => undefined);
      expect(
        queryClient.getQueryData(crudKeys.record(ns, "heroes", 5)),
      ).toEqual({ id: 5 });
      expect(collections(queryClient)).toEqual([true, true]);
      expect(stale(queryClient, crudKeys.record(ns, "heroes", 5))).toBe(true);
      expect(stale(queryClient, crudKeys.revisions(ns, "heroes", 5))).toBe(
        true,
      );
      queryClient.clear();
    },
  );
});

describe("bridgeEvents", () => {
  function setup() {
    const queryClient = seeded();
    const handlers: EventHandlers[] = [];
    const unsubscribe = vi.fn();
    const hub: EventHub = {
      subscribe(h) {
        handlers.push(h);
        return unsubscribe;
      },
    };
    const stop = bridgeEvents(queryClient, hub, {
      client: ns.client,
      resource: "heroes",
    });
    return { queryClient, handlers, unsubscribe, stop };
  }
  function seeded() {
    const queryClient = new QueryClient();
    queryClient.setQueryData(crudKeys.list(ns, "heroes"), [1]);
    queryClient.setQueryData(crudKeys.stats(ns, "heroes"), 1);
    queryClient.setQueryData(crudKeys.predict(ns, "heroes"), 1);
    queryClient.setQueryData(crudKeys.record(ns, "heroes", 5), 1);
    queryClient.setQueryData(crudKeys.record(ns, "heroes", 6), 1);
    queryClient.setQueryData(crudKeys.revisions(ns, "heroes", 5), 1);
    queryClient.setQueryData(crudKeys.list(ns, "ships"), [1]);
    queryClient.setQueryData(
      crudKeys.list({ client: "c2", scope: "s1" }, "heroes"),
      [1],
    );
    return queryClient;
  }
  const event = (action: CrudEvent["action"], recordId: number): CrudEvent => ({
    resource: "hero",
    recordId,
    action,
    snapshot: { id: recordId, name: "never applied" },
    timestamp: "",
  });
  const invalidated = (queryClient: QueryClient) =>
    [
      crudKeys.list(ns, "heroes"),
      crudKeys.stats(ns, "heroes"),
      crudKeys.predict(ns, "heroes"),
      crudKeys.record(ns, "heroes", 5),
      crudKeys.record(ns, "heroes", 6),
      crudKeys.revisions(ns, "heroes", 5),
      crudKeys.list(ns, "ships"),
    ].map((key) => queryClient.getQueryState(key)?.isInvalidated === true);

  it("create invalidates lists, stats and predict, and never applies the snapshot", async () => {
    const { queryClient, handlers } = setup();
    await handlers[0]!.onEvent(event("create", 5));
    expect(invalidated(queryClient)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(queryClient.getQueryData(crudKeys.record(ns, "heroes", 5))).toBe(1);
    queryClient.clear();
  });

  it("update, delete and restore also invalidate the record and its revisions", async () => {
    for (const action of ["update", "delete", "restore"] as const) {
      const { queryClient, handlers } = setup();
      await handlers[0]!.onEvent(event(action, 5));
      expect(invalidated(queryClient)).toEqual([
        true,
        true,
        true,
        true,
        false,
        true,
        false,
      ]);
      queryClient.clear();
    }
  });

  it("a reset invalidates the whole resource; stop unsubscribes", async () => {
    const { queryClient, handlers, unsubscribe, stop } = setup();
    await handlers[0]!.onReset!();
    expect(invalidated(queryClient)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(
      queryClient.getQueryState(
        crudKeys.list({ client: "c2", scope: "s1" }, "heroes"),
      )?.isInvalidated,
    ).toBe(false);
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
    queryClient.clear();
  });
});

describe("bridgeEvents with a late joiner (ADR 0002)", () => {
  const target = { client: ns.client, resource: "heroes" };
  const hubOf = () => {
    const handlers: EventHandlers[] = [];
    const hub: EventHub = {
      subscribe(h) {
        handlers.push(h);
        return () => undefined;
      },
    };
    return { hub, handlers };
  };
  const listInvalidated = (queryClient: QueryClient) =>
    queryClient.getQueryState(crudKeys.list(ns, "heroes"))?.isInvalidated ===
    true;
  const seed = () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(crudKeys.list(ns, "heroes"), [1]);
    return queryClient;
  };

  it("invalidates the resource of a QueryClient that joins a connected hub", async () => {
    const queryClient = seed();
    const { hub, handlers } = hubOf();
    bridgeEvents(queryClient, hub, target);
    expect(listInvalidated(queryClient)).toBe(false);
    await handlers[0]!.onStatus?.(true, {}); // the late joiner: up, no reset
    expect(listInvalidated(queryClient)).toBe(true);
    queryClient.clear();
  });

  it("skips a QueryClient already reset on the connection, but not a new connection", async () => {
    const queryClient = seed();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const conn = {};
    const a = hubOf();
    bridgeEvents(queryClient, a.hub, target);
    await a.handlers[0]!.onReset?.(conn);
    await a.handlers[0]!.onStatus?.(true, conn);
    const remount = hubOf(); // same QueryClient, same connection
    bridgeEvents(queryClient, remount.hub, target);
    await remount.handlers[0]!.onStatus?.(true, conn);
    expect(spy).toHaveBeenCalledTimes(1);
    await remount.handlers[0]!.onStatus?.(true, {});
    expect(spy).toHaveBeenCalledTimes(2);
    queryClient.clear();
  });

  it("ignores a status without a live connection", async () => {
    const queryClient = seed();
    const { hub, handlers } = hubOf();
    bridgeEvents(queryClient, hub, target);
    await handlers[0]!.onStatus?.(false);
    await handlers[0]!.onStatus?.(true);
    expect(listInvalidated(queryClient)).toBe(false);
    queryClient.clear();
  });

  it("resets each QueryClient and each resource separately, and a plain reset always", async () => {
    const one = seed();
    const two = seed();
    const spyOne = vi.spyOn(one, "invalidateQueries");
    const spyTwo = vi.spyOn(two, "invalidateQueries");
    const conn = {};
    for (const [queryClient, resource] of [
      [one, "heroes"],
      [two, "heroes"],
      [one, "ships"],
    ] as const) {
      const { hub, handlers } = hubOf();
      bridgeEvents(queryClient, hub, { client: ns.client, resource });
      await handlers[0]!.onStatus?.(true, conn);
    }
    expect(spyOne).toHaveBeenCalledTimes(2);
    expect(spyTwo).toHaveBeenCalledTimes(1);
    const { hub, handlers } = hubOf();
    bridgeEvents(one, hub, target);
    await handlers[0]!.onReset?.();
    await handlers[0]!.onReset?.();
    expect(spyOne).toHaveBeenCalledTimes(4);
    one.clear();
    two.clear();
  });
});
