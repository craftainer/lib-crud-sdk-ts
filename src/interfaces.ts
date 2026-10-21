/**
 * Contracts shared by the client core (TS1) and the cache layer (TS2).
 * Fixed in TS0 (plan interface I3): change them only through the plan.
 */

/** A value or a promise of it. */
export type MaybePromise<T> = T | Promise<T>;

/** What a request does, as classified by the client. */
export type Op =
  | "manifest"
  | "list"
  | "record"
  | "filters"
  | "stats"
  | "predict"
  | "revisions"
  | "create"
  | "update"
  | "delete"
  | "bulk_update"
  | "bulk_delete"
  | "clone"
  | "draft"
  | "publish"
  | "restore"
  | "events";

/**
 * One stored `200` response. Times are epoch milliseconds (`Date.now()`).
 * Structured-clone safe, so IndexedDB can store it as is.
 */
export interface CacheEntry {
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  /** JSON text; the SDK only caches JSON. */
  readonly body: string;
  readonly storedAt: number;
  /** `<= storedAt` means "always revalidate". */
  readonly freshUntil: number;
  /** End of the stale-while-revalidate window (`>= freshUntil`). */
  readonly staleUntil: number;
  readonly etag?: string;
}

/**
 * Cache backend. Keys are opaque, slash-separated strings built by
 * `./cache`'s `cacheKey` (`v1/{resource}/{api_version}/{kind}/...`).
 * `ttlMs` is how long the backend may keep the entry (undefined = backend
 * default); freshness lives in `CacheEntry`. `clear(prefix)` removes every
 * key starting with `prefix`; `clear()` removes everything the store owns.
 * Methods may be sync or async. They must not reject for a missing key
 * (`get` resolves `undefined`), and a failing backend must not fail the
 * request: the cache layer swallows store errors and treats them as a miss.
 */
export interface CacheStore {
  get(key: string): MaybePromise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry, ttlMs?: number): MaybePromise<void>;
  delete(key: string): MaybePromise<void>;
  clear(prefix?: string): MaybePromise<void>;
}

/**
 * What the client knows about a request that a bare `Request` does not. The
 * client builds it for every call; middleware read it, so they never parse
 * URLs or read Authorization.
 */
export interface RequestContext {
  /** The request about to be sent; replace it by passing a new context to `next`. */
  readonly request: Request;
  /** Manifest name; `undefined` for the manifest document itself. */
  readonly resource: string | undefined;
  readonly op: Op;
  /** The record the request targets, when it targets one. */
  readonly recordId: number | undefined;
  /** "anon", or the first 32 hex characters of the SHA-256 of the whole bearer token. */
  readonly scope: string;
  /**
   * The resource's `api_version` from the manifest, or `null` when it has
   * none. Part of the cache key, so versions never share entries (the cache
   * layer renders `null` as `_`).
   */
  readonly apiVersion: string | null;
  readonly signal: AbortSignal | undefined;
}

/** Calls the next middleware, or the network when none is left. */
export type Next = (ctx: RequestContext) => Promise<Response>;

/**
 * Onion middleware. In `chain = [a, b]`, `a` is outermost: the request runs
 * a -> b -> fetch and the response returns fetch -> b -> a. A middleware may
 * replace `ctx.request` (pass `{ ...ctx, request }` to `next`), return
 * without calling `next` (short-circuit, e.g. a fresh cache hit), or replace
 * the response (e.g. a `304` rebuilt from the cache). It must not consume
 * `response.body` unless it returns a different `Response`; use
 * `response.clone()` to read it.
 */
export type Middleware = (ctx: RequestContext, next: Next) => Promise<Response>;

/**
 * Returns the bearer token, or `null`/`undefined` for an anonymous call.
 * `refresh: true` is passed once after a `401`, to force a new token.
 */
export type TokenProvider = (opts: {
  readonly refresh: boolean;
}) => MaybePromise<string | null | undefined>;

/** One record-mutation event from `GET {basePath}/events` (the server's event envelope). */
export interface CrudEvent {
  /** The server's event label (e.g. "hero"), not the manifest name. */
  readonly resource: string;
  readonly recordId: number;
  readonly action: "create" | "update" | "delete" | "restore";
  /** The read view of the record after the change. */
  readonly snapshot: Readonly<Record<string, unknown>>;
  /** ISO 8601, UTC. */
  readonly timestamp: string;
}

/**
 * Folds `chain` (outermost first) around `terminal`, usually the network
 * `fetch`, into one `Next`. Each middleware's `next` is the rest of the
 * chain; an empty chain is `terminal`. A throwing middleware yields a
 * rejected promise.
 */
export function composeMiddleware(
  chain: readonly Middleware[],
  terminal: Next,
): Next {
  const dispatch = async (
    index: number,
    ctx: RequestContext,
  ): Promise<Response> => {
    const middleware = chain[index];
    if (middleware === undefined) {
      return terminal(ctx);
    }
    return middleware(ctx, (next) => dispatch(index + 1, next));
  };
  return (ctx) => dispatch(0, ctx);
}
