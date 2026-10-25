import { describe, expect, it, vi } from "vitest";
import {
  MemoryStore,
  cachePolicyFromManifest,
  cacheStatus,
  createCache,
  invalidateOnEvents,
} from "../../src/cache/index.ts";
import type { EventHandlers, EventHub } from "../../src/events.ts";
import type { CrudEvent } from "../../src/interfaces.ts";
import { ctxFor, fakeNet, json } from "./helpers.ts";

/** A hub the test drives by hand. */
function manualHub() {
  const handlers: EventHandlers[] = [];
  const unsubscribed = vi.fn();
  const hub: EventHub = {
    subscribe(h) {
      handlers.push(h);
      return unsubscribed;
    },
  };
  return { hub, handlers, unsubscribed };
}

const event = (action: CrudEvent["action"], recordId: number): CrudEvent => ({
  resource: "hero",
  recordId,
  action,
  snapshot: {},
  timestamp: "",
});

describe("invalidateOnEvents", () => {
  it("opens the freshness gate with the stream, invalidates on events, and closes on unsubscribe", async () => {
    const store = new MemoryStore();
    const cache = createCache({
      store,
      policies: {
        heroes: cachePolicyFromManifest({ cache: { max_age: 60 } }),
      },
    });
    const net = fakeNet();
    const { hub, handlers, unsubscribed } = manualHub();
    const stop = invalidateOnEvents(cache, hub, "heroes");
    const h = handlers[0] as Required<EventHandlers>;

    expect(cache.eventsActive("heroes")).toBe(false);
    await h.onStatus(true);
    expect(cache.eventsActive("heroes")).toBe(true);

    net.push(json([1], { headers: { etag: 'W/"1"' } }));
    await cache.middleware(ctxFor("list"), net.next);
    expect(cacheStatus(await cache.middleware(ctxFor("list"), net.next))).toBe(
      "hit",
    );

    await h.onEvent(event("update", 5)); // invalidates the lists
    net.push(json([1], { headers: { etag: 'W/"1"' } }));
    expect(cacheStatus(await cache.middleware(ctxFor("list"), net.next))).toBe(
      "miss",
    );

    await h.onReset(); // a reconnect clears the resource
    expect(store.size).toBe(0);

    await h.onStatus(false);
    expect(cache.eventsActive("heroes")).toBe(false);

    await h.onStatus(true);
    stop();
    expect(unsubscribed).toHaveBeenCalledOnce();
    expect(cache.eventsActive("heroes")).toBe(false);
  });
});

describe("invalidateOnEvents with several subscribers", () => {
  it("closes the freshness gate only when the last one leaves", () => {
    const cache = createCache({
      store: new MemoryStore(),
      policies: { heroes: cachePolicyFromManifest({}) },
    });
    const a = manualHub();
    const b = manualHub();
    const stopA = invalidateOnEvents(cache, a.hub, "heroes");
    const stopB = invalidateOnEvents(cache, b.hub, "heroes");
    cache.setEventsActive("heroes", true);
    a.handlers[0]!.onStatus?.(true);
    b.handlers[0]!.onStatus?.(true);
    stopA();
    stopA(); // idempotent
    expect(cache.eventsActive("heroes")).toBe(true);
    stopB();
    expect(cache.eventsActive("heroes")).toBe(false);
  });
});

describe("invalidateOnEvents with a late joiner (ADR 0002)", () => {
  const newCache = () =>
    createCache({
      store: new MemoryStore(),
      policies: { heroes: cachePolicyFromManifest({ cache: { max_age: 60 } }) },
    });
  const connection = () => ({});

  it("clears a cache that joins a connected hub before opening the gate", async () => {
    const cache = newCache();
    let finish!: () => void;
    const clearing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const clear = vi
      .spyOn(cache, "clearResource")
      .mockImplementation(() => clearing);
    const { hub, handlers } = manualHub();
    invalidateOnEvents(cache, hub, "heroes");
    // The hub tells a late joiner "up" with the live connection and no reset.
    const up = Promise.resolve(handlers[0]!.onStatus?.(true, connection()));
    expect(clear).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledWith("heroes");
    expect(cache.eventsActive("heroes")).toBe(false); // the reset is not done
    finish();
    await up;
    expect(cache.eventsActive("heroes")).toBe(true);
  });

  it("does not reset twice on one connection, even for a remount with the same cache", async () => {
    const cache = newCache();
    const clear = vi.spyOn(cache, "clearResource");
    const conn = connection();
    const a = manualHub();
    invalidateOnEvents(cache, a.hub, "heroes");
    await a.handlers[0]!.onReset?.(conn); // the connect reset
    await a.handlers[0]!.onStatus?.(true, conn);
    expect(clear).toHaveBeenCalledTimes(1);

    const b = manualHub(); // a second subscription, same cache and connection
    invalidateOnEvents(cache, b.hub, "heroes");
    await b.handlers[0]!.onStatus?.(true, conn);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(cache.eventsActive("heroes")).toBe(true);

    await b.handlers[0]!.onStatus?.(true, connection()); // a new connection resets again
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight reset between two late joiners of the same cache", async () => {
    const cache = newCache();
    let finish!: () => void;
    const clearing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const clear = vi
      .spyOn(cache, "clearResource")
      .mockImplementation(() => clearing);
    const conn = connection();
    const a = manualHub();
    const b = manualHub();
    invalidateOnEvents(cache, a.hub, "heroes");
    invalidateOnEvents(cache, b.hub, "heroes");
    const upA = Promise.resolve(a.handlers[0]!.onStatus?.(true, conn));
    const upB = Promise.resolve(b.handlers[0]!.onStatus?.(true, conn));
    expect(cache.eventsActive("heroes")).toBe(false); // B waits for A's reset
    finish();
    await Promise.all([upA, upB]);
    expect(clear).toHaveBeenCalledOnce();
    expect(cache.eventsActive("heroes")).toBe(true);
  });

  it("resets each cache and each resource separately", async () => {
    const one = newCache();
    const two = newCache();
    const clearOne = vi.spyOn(one, "clearResource");
    const clearTwo = vi.spyOn(two, "clearResource");
    const conn = connection();
    for (const [cache, name] of [
      [one, "heroes"],
      [two, "heroes"],
      [one, "ships"],
    ] as const) {
      const { hub, handlers } = manualHub();
      invalidateOnEvents(cache, hub, name);
      await handlers[0]!.onStatus?.(true, conn);
    }
    expect(clearOne.mock.calls).toEqual([["heroes"], ["ships"]]);
    expect(clearTwo.mock.calls).toEqual([["heroes"]]);
  });

  it("keeps the gate shut when the reset fails, and a later joiner retries", async () => {
    const cache = newCache();
    const clear = vi
      .spyOn(cache, "clearResource")
      .mockRejectedValueOnce(new Error("store down"));
    const conn = connection();
    const { hub, handlers } = manualHub();
    invalidateOnEvents(cache, hub, "heroes");
    await expect(handlers[0]!.onStatus?.(true, conn)).rejects.toThrow(
      "store down",
    );
    expect(cache.eventsActive("heroes")).toBe(false);
    await handlers[0]!.onStatus?.(true, conn);
    expect(clear).toHaveBeenCalledTimes(2);
    expect(cache.eventsActive("heroes")).toBe(true);
  });

  it("does not open the gate when the stream drops or the subscription ends during the reset", async () => {
    const cache = newCache();
    const finishers: Array<() => void> = [];
    vi.spyOn(cache, "clearResource").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishers.push(resolve);
        }),
    );
    const { hub, handlers } = manualHub();
    const stop = invalidateOnEvents(cache, hub, "heroes");
    const up = Promise.resolve(handlers[0]!.onStatus?.(true, connection()));
    await handlers[0]!.onStatus?.(false); // lost while resetting
    finishers[0]!();
    await up;
    expect(cache.eventsActive("heroes")).toBe(false);

    const up2 = Promise.resolve(handlers[0]!.onStatus?.(true, connection()));
    stop(); // unsubscribed while resetting
    finishers[1]!();
    await up2;
    expect(cache.eventsActive("heroes")).toBe(false);
  });

  it("still clears on an event with no usable record id, without a connection", async () => {
    const cache = newCache();
    const clear = vi.spyOn(cache, "clearResource");
    const { hub, handlers } = manualHub();
    invalidateOnEvents(cache, hub, "heroes");
    await handlers[0]!.onReset?.();
    await handlers[0]!.onReset?.();
    expect(clear).toHaveBeenCalledTimes(2);
  });
});
