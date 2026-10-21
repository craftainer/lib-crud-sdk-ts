/** Wiring an event hub to a cache. */
import type { EventHub } from "../events.ts";
import type { Cache } from "./middleware.ts";

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
    cache.setEventsActive(resource, false);
  };
}
