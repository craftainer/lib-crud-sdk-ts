// Entry point `./cache`: cache middleware, memory and IndexedDB stores and
// SSE invalidation (TS2). Implements `CacheStore` from `../interfaces.ts`.
export { createCache } from "./middleware.ts";
export type { Cache, CacheOptions, CacheStoreMany } from "./middleware.ts";
export { credentialScope } from "./scope.ts";
export { cacheStatus } from "./entry.ts";
export type { CacheStatus } from "./entry.ts";
export { cachePolicyFromManifest, tanstackCachePolicy } from "./policy.ts";
export type { CachePolicy, ManifestCacheHints } from "./policy.ts";
export { MemoryStore } from "./memory.ts";
export type { MemoryStoreOptions } from "./memory.ts";
export { IndexedDbStore } from "./idb.ts";
export type { IndexedDbStoreOptions } from "./idb.ts";
export {
  buildKey,
  canonicalQuery,
  eventPrefixes,
  manifestKey,
  recordPrefix,
  resourcePrefixes,
} from "./keys.ts";
export type { CacheKind, KeyParts } from "./keys.ts";
export { invalidateOnEvents } from "./wire.ts";
export { getEventHub, subscribeEvents } from "../events.ts";
export type {
  EventHandlers,
  EventHub,
  EventHubOptions,
  EventsConfig,
  SubscribeEventsOptions,
} from "../events.ts";
export type { CacheEntry, CacheStore, CrudEvent } from "../interfaces.ts";
