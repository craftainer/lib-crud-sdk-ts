/** Wiring an event hub to a cache. */
import type { EventHub } from "../events.ts";
import type { Cache } from "./middleware.ts";

/** The subscriptions that currently see a connected stream, per cache and resource. */
const connected = new WeakMap<Cache, Map<string, Set<object>>>();

/**
 * Subscribe `cache` to `hub` for the manifest resource `resource`. Events
 * clear the spec's prefixes, a reconnect clears the resource, and fresh hits
 * are allowed only while the stream is connected. Returns the unsubscribe
 * (it also closes the freshness gate).
 */
export function invalidateOnEvents(
  cache: Cache,
  hub: EventHub,
  resource: string,
): () => void {
  const byResource = connected.get(cache) ?? new Map<string, Set<object>>();
  connected.set(cache, byResource);
  const live = byResource.get(resource) ?? new Set<object>();
  byResource.set(resource, live);
  const self = {}; // this subscription's identity
  // The gate is open while any subscription sees a connected stream.
  const mark = (up: boolean): void => {
    if (up) {
      live.add(self);
    } else {
      live.delete(self);
    }
    cache.setEventsActive(resource, live.size > 0);
  };
  const unsubscribe = hub.subscribe({
    onEvent: (event) =>
      cache.invalidateEvent(resource, event.action, event.recordId),
    onReset: () => cache.clearResource(resource),
    onStatus: mark,
  });
  return () => {
    unsubscribe();
    mark(false); // idempotent: the last one out closes the gate
  };
}
