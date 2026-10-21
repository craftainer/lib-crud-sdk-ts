/**
 * IndexedDB cache store (one object store, out-of-line string keys).
 *
 * Every call is wrapped: a blocked database, private mode or a missing
 * `indexedDB` is a miss (or a no-op), never a failed request. `clear(prefix)`
 * is one `IDBKeyRange.bound(prefix, prefix + "￿")` delete.
 */
import { openDB } from "idb";
import type { IDBPDatabase } from "idb";
import type { CacheEntry, CacheStore } from "../interfaces.ts";
import { DEFAULT_TTL_MS } from "./memory.ts";

// The package compiles without the DOM lib; this is the one global it needs.
declare const IDBKeyRange: {
  bound(lower: string, upper: string): unknown;
};

const STORE = "entries";

interface Stored {
  readonly expiresAt: number;
  readonly entry: CacheEntry;
}

export interface IndexedDbStoreOptions {
  /** Database name; default `craftainer-crud-cache`. */
  readonly name?: string;
  readonly defaultTtlMs?: number;
  /** Epoch milliseconds; injectable for tests. */
  readonly now?: () => number;
}

export class IndexedDbStore implements CacheStore {
  private readonly name: string;
  private readonly defaultTtlMs: number;
  private readonly now: () => number;
  private opening: Promise<IDBPDatabase> | undefined;

  constructor(options: IndexedDbStoreOptions = {}) {
    this.name = options.name ?? "craftainer-crud-cache";
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  private open(): Promise<IDBPDatabase> {
    this.opening ??= openDB(this.name, 1, {
      upgrade(db) {
        db.createObjectStore(STORE);
      },
    });
    return this.opening;
  }

  /** Run `work` on the database; a failure drops the handle (so a later call retries) and yields `fallback`. */
  private async run<T>(
    fallback: T,
    work: (db: IDBPDatabase) => Promise<T>,
  ): Promise<T> {
    try {
      return await work(await this.open());
    } catch {
      this.opening = undefined;
      return fallback;
    }
  }

  get(key: string): Promise<CacheEntry | undefined> {
    return this.run<CacheEntry | undefined>(undefined, async (db) => {
      const stored = (await db.get(STORE, key)) as Stored | undefined;
      if (stored === undefined) {
        return undefined;
      }
      if (stored.expiresAt <= this.now()) {
        await db.delete(STORE, key);
        return undefined;
      }
      return stored.entry;
    });
  }

  set(key: string, entry: CacheEntry, ttlMs?: number): Promise<void> {
    return this.run(undefined, async (db) => {
      const stored: Stored = {
        expiresAt: this.now() + (ttlMs ?? this.defaultTtlMs),
        entry,
      };
      await db.put(STORE, stored, key);
    });
  }

  delete(key: string): Promise<void> {
    return this.run(undefined, (db) => db.delete(STORE, key));
  }

  clear(prefix?: string): Promise<void> {
    return this.run(undefined, (db) =>
      prefix === undefined
        ? db.clear(STORE)
        : db.delete(STORE, IDBKeyRange.bound(prefix, `${prefix}￿`)),
    );
  }

  /** Clear several prefixes in one transaction (one bound range each). */
  clearMany(prefixes: readonly string[]): Promise<void> {
    return this.run(undefined, async (db) => {
      const tx = db.transaction(STORE, "readwrite");
      await Promise.all([
        ...prefixes.map((prefix) =>
          tx.store.delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`)),
        ),
        tx.done,
      ]);
    });
  }

  /** Close the database handle; a later call reopens it. */
  async close(): Promise<void> {
    const opening = this.opening;
    this.opening = undefined;
    try {
      (await opening)?.close();
    } catch {
      // Never opened.
    }
  }
}
