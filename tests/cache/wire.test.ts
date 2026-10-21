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
    stopA();
    expect(cache.eventsActive("heroes")).toBe(true);
    stopB();
    expect(cache.eventsActive("heroes")).toBe(false);
  });
});
