/** Wiring an event hub to a cache. */
import type { EventConnection, EventHub } from "../events.ts";
import { resetOnce } from "../reset-once.ts";
import type { Cache } from "./middleware.ts";

/** The subscriptions that currently see a connected stream, per cache and resource. */
const connected = new WeakMap<Cache, Map<string, Set<object>>>();

/**
 * Subscribe `cache` to `hub` for the manifest resource `resource`. Events
 * clear the spec's prefixes, a reconnect clears the resource, and fresh hits
 * are allowed only while the stream is connected. The cache is cleared once
 * per connection, whenever it subscribes: a subscription that joins an already
 * connected hub (or during the handshake) clears the resource first, unless
 * the cache was already cleared on that connection, and only then opens the
 * gate. Returns the unsubscribe (it also closes the freshness gate).
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
  let latest = 0; // a status change supersedes a gate-opening that awaits its reset
  const reset = (connection: EventConnection): Promise<void> =>
    resetOnce(connection, cache, resource, () => cache.clearResource(resource));
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
    onReset: (connection) =>
      connection === undefined
        ? cache.clearResource(resource)
        : reset(connection),
    onStatus: async (up, connection) => {
      latest += 1;
      const mine = latest;
      if (up && connection !== undefined) {
        await reset(connection); // a late joiner clears before the gate opens
        if (mine !== latest) {
          return;
        }
      }
      mark(up);
    },
  });
  return () => {
    latest += 1;
    try {
      unsubscribe();
    } finally {
      mark(false); // idempotent; the gate stays open while another subscription is connected
    }
  };
}
