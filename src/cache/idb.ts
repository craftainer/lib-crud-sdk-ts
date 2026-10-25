/**
 * IndexedDB cache store (one object store, out-of-line string keys, an
 * `expiresAt` index).
 *
 * Database version 2 adds the `expiresAt` index; upgrading from version 1
 * keeps every entry (the index is built over the stored values). Expired
 * entries are swept once when the database is opened, and `maxEntries` evicts
 * the entries closest to expiry on `set`.
 *
 * Every call is wrapped: a blocked database, private mode or a missing
 * `indexedDB` is a miss (or a no-op), never a failed request. `clear(prefix)`
 * is one `IDBKeyRange.bound(prefix, prefix + "\uffff")` delete.
 */
import { openDB } from "idb";
import type { IDBPDatabase } from "idb";
import type { CacheEntry, CacheStore } from "../interfaces.ts";
import { DEFAULT_TTL_MS } from "./memory.ts";

// The package compiles without the DOM lib; this is the one global it needs.
declare const IDBKeyRange: {
  bound(lower: string, upper: string): unknown;
  upperBound(upper: number): unknown;
};

const STORE = "entries";
const BY_EXPIRY = "expiresAt";
const VERSION = 2;

interface Stored {
  readonly expiresAt: number;
  readonly entry: CacheEntry;
}

/**
 * Observes `tx.done` up front: when an operation throws, the aborted
 * transaction's `done` rejects with nobody left to await it, which would be
 * an unhandled rejection.
 */
function guarded<T extends { readonly done: Promise<void> }>(tx: T): T {
  tx.done.catch(() => undefined);
  return tx;
}

export interface IndexedDbStoreOptions {
  /** Database name; default `craftainer-crud-cache`. */
  readonly name?: string;
  readonly defaultTtlMs?: number;
  /**
   * Upper bound on stored entries, a positive integer; default unbounded.
   * When a `set` leaves more than this many, the entries with the earliest
   * `expiresAt` are deleted until the cap holds (a just-written entry with a
   * short ttl can be among them). The cap is per database and per store
   * instance: two instances on one `name` with different caps each enforce
   * their own on their writes.
   */
  readonly maxEntries?: number;
  /** Epoch milliseconds; injectable for tests. */
  readonly now?: () => number;
}

export class IndexedDbStore implements CacheStore {
  private readonly name: string;
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number | undefined;
  private readonly now: () => number;
  private opening: Promise<IDBPDatabase> | undefined;

  constructor(options: IndexedDbStoreOptions = {}) {
    this.name = options.name ?? "craftainer-crud-cache";
    if (this.name === "") {
      // The name is the per-origin namespace of the store.
      throw new RangeError("IndexedDbStore: name must not be empty");
    }
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    if (
      options.maxEntries !== undefined &&
      !(Number.isInteger(options.maxEntries) && options.maxEntries >= 1)
    ) {
      throw new RangeError(
        "IndexedDbStore: maxEntries must be an integer >= 1",
      );
    }
    this.maxEntries = options.maxEntries;
    this.now = options.now ?? Date.now;
  }

  private open(): Promise<IDBPDatabase> {
    if (this.opening === undefined) {
      // A newer version wants to upgrade: let it, and reopen on the next call.
      const opening: Promise<IDBPDatabase> = this.openAndSweep(() => {
        if (this.opening === opening) {
          this.opening = undefined;
        }
      });
      this.opening = opening;
    }
    return this.opening;
  }

  private async openAndSweep(onBlocking: () => void): Promise<IDBPDatabase> {
    const db = await openDB(this.name, VERSION, {
      blocking() {
        db.close();
        onBlocking();
      },
      upgrade(upgrading, oldVersion, _newVersion, tx) {
        if (oldVersion < 1) {
          upgrading.createObjectStore(STORE);
        }
        // Version 1 had the store but no index; its values already carry expiresAt.
        tx.objectStore(STORE).createIndex(BY_EXPIRY, BY_EXPIRY);
      },
    });
    try {
      await this.sweep(db);
    } catch {
      // A failed sweep leaves the entries for `get` to expire one by one.
    }
    return db;
  }

  /** Deletes every entry that has expired (`expiresAt <= now`). */
  private async sweep(db: IDBPDatabase): Promise<void> {
    const tx = guarded(db.transaction(STORE, "readwrite"));
    let cursor = await tx.store
      .index(BY_EXPIRY)
      .openCursor(IDBKeyRange.upperBound(this.now()));
    while (cursor !== null) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  }

  /** Run `work` on the database; a failure drops the handle (so a later call retries) and yields `fallback`. */
  private async run<T>(
    fallback: T,
    work: (db: IDBPDatabase) => Promise<T>,
  ): Promise<T> {
    // The handle this call runs on: a concurrent call may already have replaced it.
    let used: Promise<IDBPDatabase> | undefined;
    try {
      used = this.open(); // may throw at once when indexedDB is unusable
      return await work(await used);
    } catch {
      // Drop only our own handle, and close it: an orphaned connection can
      // block an upgrade, while a newer handle belongs to other calls.
      if (this.opening === used) {
        this.opening = undefined;
      }
      try {
        (await used)?.close();
      } catch {
        // It never opened.
      }
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
      const tx = guarded(db.transaction(STORE, "readwrite"));
      await tx.store.put(stored, key);
      if (this.maxEntries !== undefined) {
        let excess = (await tx.store.count()) - this.maxEntries;
        let cursor =
          excess > 0 ? await tx.store.index(BY_EXPIRY).openCursor() : null;
        while (cursor !== null && excess > 0) {
          await cursor.delete();
          excess -= 1;
          cursor = await cursor.continue();
        }
      }
      await tx.done;
    });
  }

  delete(key: string): Promise<void> {
    return this.run(undefined, (db) => db.delete(STORE, key));
  }

  clear(prefix?: string): Promise<void> {
    return this.run(undefined, (db) =>
      prefix === undefined
        ? db.clear(STORE)
        : db.delete(STORE, IDBKeyRange.bound(prefix, `${prefix}\uffff`)),
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
