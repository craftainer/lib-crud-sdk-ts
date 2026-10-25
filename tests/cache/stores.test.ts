import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedDbStore, MemoryStore } from "../../src/cache/index.ts";
import type { CacheEntry, CacheStore } from "../../src/interfaces.ts";

const entry = (body: string): CacheEntry => ({
  status: 200,
  headers: [["etag", 'W/"1"']],
  body,
  storedAt: 1,
  freshUntil: 1,
  staleUntil: 2,
  etag: 'W/"1"',
});

describe("MemoryStore", () => {
  it("round-trips, deletes and clears by prefix or entirely", () => {
    const store = new MemoryStore();
    store.set("v1/a/list/", entry("a"));
    store.set("v1/a/record/", entry("b"));
    store.set("v1/b/list/", entry("c"));
    expect(store.get("v1/a/list/")?.body).toBe("a");
    expect(store.get("nope")).toBeUndefined();
    store.delete("v1/a/list/");
    store.delete("v1/a/list/");
    expect(store.get("v1/a/list/")).toBeUndefined();
    store.clear("v1/a/");
    expect(store.size).toBe(1);
    store.clear();
    expect(store.size).toBe(0);
  });

  it("clears several prefixes in one walk", () => {
    const store = new MemoryStore();
    for (const key of [
      "v1/a/list/1",
      "v1/a/stats/1",
      "v1/b/list/1",
      "v1/c/list/1",
    ]) {
      store.set(key, entry(key));
    }
    store.clearMany(["v1/a/list/", "v1/b/"]);
    expect(store.get("v1/a/list/1")).toBeUndefined();
    expect(store.get("v1/b/list/1")).toBeUndefined();
    expect(store.get("v1/a/stats/1")).toBeDefined();
    expect(store.get("v1/c/list/1")).toBeDefined();
    store.clearMany([]);
    expect(store.size).toBe(2);
  });

  it("evicts the least recently used entry", () => {
    const store = new MemoryStore({ maxEntries: 2 });
    store.set("a", entry("a"));
    store.set("b", entry("b"));
    store.get("a"); // b is now the oldest
    store.set("c", entry("c"));
    expect(store.get("b")).toBeUndefined();
    expect(store.get("a")?.body).toBe("a");
    store.set("a", entry("a2")); // replacing keeps the size
    expect(store.size).toBe(2);
    expect(store.get("a")?.body).toBe("a2");
  });

  it("honours the ttl and the default ttl", () => {
    let t = 1000;
    const store = new MemoryStore({ now: () => t, defaultTtlMs: 500 });
    store.set("short", entry("s"), 10);
    store.set("default", entry("d"));
    t += 10;
    expect(store.get("short")).toBeUndefined();
    expect(store.size).toBe(1);
    t += 489;
    expect(store.get("default")?.body).toBe("d");
    t += 1;
    expect(store.get("default")).toBeUndefined();
  });

  it("rejects a capacity below one", () => {
    expect(() => new MemoryStore({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => new MemoryStore({ maxEntries: 1.5 })).toThrow(RangeError);
  });

  it("defaults to the wall clock", () => {
    const store = new MemoryStore();
    store.set("a", entry("a"));
    expect(store.get("a")).toBeDefined();
  });
});

// The package compiles without the DOM lib, so reach the fake's global by hand.
const fakeIdb = (
  globalThis as unknown as { indexedDB: { open: () => unknown } }
).indexedDB;

describe("IndexedDbStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips, deletes and clears by prefix with a key range", async () => {
    const store = new IndexedDbStore({ name: "t1" });
    await store.set("v1/a/list/x", entry("a"));
    await store.set("v1/a/record/1", entry("b"));
    await store.set("v1/ab/list/x", entry("c"));
    expect(await store.get("v1/a/list/x")).toEqual(entry("a"));
    expect(await store.get("missing")).toBeUndefined();
    await store.delete("v1/a/list/x");
    expect(await store.get("v1/a/list/x")).toBeUndefined();
    await store.clear("v1/a/");
    expect(await store.get("v1/a/record/1")).toBeUndefined();
    expect(await store.get("v1/ab/list/x")).toBeDefined(); // another resource
    await store.clear();
    expect(await store.get("v1/ab/list/x")).toBeUndefined();
    await store.close();
  });

  it("clears several prefixes in one transaction", async () => {
    const store = new IndexedDbStore({ name: "t7" });
    for (const key of [
      "v1/a/list/1",
      "v1/a/stats/1",
      "v1/b/list/1",
      "v1/c/list/1",
    ]) {
      await store.set(key, entry(key));
    }
    await store.clearMany(["v1/a/list/", "v1/b/"]);
    expect(await store.get("v1/a/list/1")).toBeUndefined();
    expect(await store.get("v1/b/list/1")).toBeUndefined();
    expect(await store.get("v1/a/stats/1")).toBeDefined();
    expect(await store.get("v1/c/list/1")).toBeDefined();
    await store.clearMany([]);
    expect(await store.get("v1/c/list/1")).toBeDefined();
    await store.close();
  });

  it("expires entries by ttl", async () => {
    let t = 1000;
    const store = new IndexedDbStore({
      name: "t2",
      now: () => t,
      defaultTtlMs: 100,
    });
    await store.set("short", entry("s"), 10);
    await store.set("default", entry("d"));
    t += 10;
    expect(await store.get("short")).toBeUndefined();
    expect(await store.get("default")).toBeDefined();
    t += 90;
    expect(await store.get("default")).toBeUndefined();
    await store.close();
  });

  it("rejects an empty database name", () => {
    expect(() => new IndexedDbStore({ name: "" })).toThrow(RangeError);
  });

  it("defaults the name and the clock", async () => {
    const store = new IndexedDbStore();
    await store.set("k", entry("a"));
    expect(await store.get("k")).toBeDefined();
    await store.clear();
    await store.close();
  });

  it("closes the handle of a failed operation and reopens on the next call", async () => {
    const store = new IndexedDbStore({ name: "t-failed-op" });
    await store.set("ok", entry("a"));
    const bad = { ...entry("b"), headers: (() => 1) as never }; // not cloneable
    await expect(store.set("bad", bad)).resolves.toBeUndefined();
    expect((await store.get("ok"))?.body).toBe("a");
    await store.close();
  });

  it("a failure only drops the handle it ran on, not a newer healthy one", async () => {
    const open = vi.spyOn(fakeIdb, "open");
    const store = new IndexedDbStore({ name: "t-stale-handle" });
    await store.set("warm", entry("a")); // handle 1
    // Fails on handle 1 (not cloneable); the call has already captured it.
    const bad = { ...entry("b"), headers: (() => 1) as never };
    const failing = store.set("bad", bad);
    // Meanwhile handle 1 was dropped elsewhere and a concurrent call opened handle 2.
    (store as unknown as { opening: undefined }).opening = undefined;
    const concurrent = store.set("kept", entry("c"));
    await failing;
    await concurrent;
    expect((await store.get("kept"))?.body).toBe("c");
    expect(open).toHaveBeenCalledTimes(2); // handle 2 survived the failure on handle 1
    await store.close();
  });

  it("counts a failing database as a miss and retries later", async () => {
    const open = vi.spyOn(fakeIdb, "open").mockImplementation(() => {
      throw new Error("blocked");
    });
    const store: CacheStore = new IndexedDbStore({ name: "t3" });
    await expect(store.set("k", entry("a"))).resolves.toBeUndefined();
    await expect(store.get("k")).resolves.toBeUndefined();
    await expect(store.delete("k")).resolves.toBeUndefined();
    await expect(store.clear("p")).resolves.toBeUndefined();
    await expect(store.clear()).resolves.toBeUndefined();
    await expect(
      (store as IndexedDbStore).clearMany(["p"]),
    ).resolves.toBeUndefined();
    expect(open).toHaveBeenCalledTimes(6); // every call tries again
    open.mockRestore();
    await store.set("k", entry("a"));
    expect(await store.get("k")).toBeDefined();
    await (store as IndexedDbStore).close();
  });

  it("closes safely when it never opened or failed to open", async () => {
    const store = new IndexedDbStore({ name: "t4" });
    await store.close();
    vi.spyOn(fakeIdb, "open").mockImplementation(() => {
      throw new Error("blocked");
    });
    const failing = new IndexedDbStore({ name: "t5" });
    await failing.get("k"); // the failed handle is dropped
    await failing.close();
  });

  it("closes a handle whose open rejected", async () => {
    const failing = new IndexedDbStore({ name: "t6" });
    (failing as unknown as { opening: Promise<never> }).opening =
      Promise.reject(new Error("never opened"));
    await failing.close();
  });
});
