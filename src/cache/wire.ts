/** Wiring an event hub to a cache. */
import type { EventHub } from "../events.ts";
import type { Cache } from "./middleware.ts";

/** Live `invalidateOnEvents` subscriptions per cache and resource. */
const subscribers = new WeakMap<Cache, Map<string, number>>();

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
  const counts = subscribers.get(cache) ?? new Map<string, number>();
  subscribers.set(cache, counts);
  counts.set(resource, (counts.get(resource) ?? 0) + 1);
  const unsubscribe = hub.subscribe({
    onEvent: (event) =>
      cache.invalidateEvent(resource, event.action, event.recordId),
    onReset: () => cache.clearResource(resource),
    onStatus: (connected) => {
      cache.setEventsActive(resource, connected);
    },
  });
  return () => {
    unsubscribe();
    const left = (counts.get(resource) as number) - 1;
    counts.set(resource, left);
    if (left === 0) {
      cache.setEventsActive(resource, false); // the last one out closes the gate
    }
  };
}
