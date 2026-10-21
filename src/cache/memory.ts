/** In-memory cache store: LRU with a per-entry TTL. */
import type { CacheEntry, CacheStore } from "../interfaces.ts";

/** How long a store keeps an entry when the caller gives no ttl (the spec's retention floor). */
export const DEFAULT_TTL_MS = 3_600_000;

export interface MemoryStoreOptions {
  /** Default 1024. */
  readonly maxEntries?: number;
  readonly defaultTtlMs?: number;
  /** Epoch milliseconds; injectable for tests. */
  readonly now?: () => number;
}

/** LRU store (default 1024 entries) that also honours each entry's ttl. */
export class MemoryStore implements CacheStore {
  private readonly data = new Map<
    string,
    { readonly expiresAt: number; readonly entry: CacheEntry }
  >();
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;
  private readonly now: () => number;

  constructor(options: MemoryStoreOptions = {}) {
    const maxEntries = options.maxEntries ?? 1024;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be an integer of at least 1");
    }
    this.maxEntries = maxEntries;
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Number of stored entries (expired ones included until touched). */
  get size(): number {
    return this.data.size;
  }

  get(key: string): CacheEntry | undefined {
    const item = this.data.get(key);
    if (item === undefined) {
      return undefined;
    }
    if (item.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    this.data.delete(key); // re-insert: Map order is the recency order
    this.data.set(key, item);
    return item.entry;
  }

  set(key: string, entry: CacheEntry, ttlMs?: number): void {
    this.data.delete(key);
    this.data.set(key, {
      expiresAt: this.now() + (ttlMs ?? this.defaultTtlMs),
      entry,
    });
    while (this.data.size > this.maxEntries) {
      // The first key is the least recently used.
      this.data.delete(this.data.keys().next().value as string);
    }
  }

  delete(key: string): void {
    this.data.delete(key);
  }

  /** Remove every key under any of `prefixes` in one walk. */
  clearMany(prefixes: readonly string[]): void {
    for (const key of this.data.keys()) {
      if (prefixes.some((prefix) => key.startsWith(prefix))) {
        this.data.delete(key);
      }
    }
  }

  clear(prefix?: string): void {
    for (const key of this.data.keys()) {
      if (prefix === undefined || key.startsWith(prefix)) {
        this.data.delete(key);
      }
    }
  }
}
