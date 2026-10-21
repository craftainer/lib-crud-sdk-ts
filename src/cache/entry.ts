/** Turning responses into `CacheEntry` values and back. */
import type { CacheEntry } from "../interfaces.ts";

/** How the cache answered a read: see `cacheStatus`. */
export type CacheStatus = "hit" | "stale" | "revalidated" | "miss";

const statuses = new WeakMap<Response, CacheStatus>();

/**
 * How the cache answered `response`: `hit` (fresh, no network), `stale`
 * (inside the stale-while-revalidate window, refreshed in the background),
 * `revalidated` (a `304` rebuilt from the stored entry) or `miss`.
 * `undefined` when the cache did not handle the request.
 */
export function cacheStatus(response: Response): CacheStatus | undefined {
  return statuses.get(response);
}

/** Tag `response` with how the cache answered. */
export function tagStatus(response: Response, status: CacheStatus): Response {
  statuses.set(response, status);
  return response;
}

// Describe the transfer, not the representation: the stored body is decoded.
const TRANSFER_HEADERS: ReadonlySet<string> = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);
const VARY_OK: ReadonlySet<string> = new Set([
  "authorization",
  "accept",
  "accept-encoding",
]);

/** The lower-cased directive names of the `Cache-Control` header. */
export function cacheControl(headers: Headers): ReadonlySet<string> {
  const names = (headers.get("cache-control") ?? "")
    .split(",")
    .map((part) => (part.split("=", 1)[0] as string).trim().toLowerCase())
    .filter((name) => name !== "");
  return new Set(names);
}

/** Whether the media type is JSON (`application/json` or `+json`). */
export function isJson(response: Response): boolean {
  const media = (response.headers.get("content-type") ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  return media === "application/json" || media.endsWith("+json");
}

/** `Vary` may only name headers the key already accounts for; `*` never caches. */
export function varyAllowsCaching(response: Response): boolean {
  const names = (response.headers.get("vary") ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((name) => name !== "");
  return names.every((name) => VARY_OK.has(name));
}

function storableHeaders(headers: Headers): Array<readonly [string, string]> {
  const items: Array<readonly [string, string]> = [];
  for (const [name, value] of headers) {
    if (!TRANSFER_HEADERS.has(name)) {
      items.push([name, value]);
    }
  }
  return items;
}

export interface EntryTimes {
  readonly now: number;
  /** Milliseconds fresh. */
  readonly fresh: number;
  /** Milliseconds of stale-while-revalidate after `fresh`. */
  readonly stale: number;
}

/** Snapshot a read response whose body text was already read. */
export function buildEntry(
  response: Response,
  body: string,
  times: EntryTimes,
  keepEtag: boolean,
): CacheEntry {
  const etag = keepEtag ? response.headers.get("etag") : null;
  const base = {
    status: response.status,
    headers: storableHeaders(response.headers),
    body,
    storedAt: times.now,
    freshUntil: times.now + times.fresh,
    staleUntil: times.now + times.fresh + times.stale,
  };
  return etag === null ? base : { ...base, etag };
}

/** RFC 9111 4.3.4: headers of a `304` replace the stored ones of the same name. */
export function mergeHeaders(
  stored: CacheEntry["headers"],
  update: Headers,
): CacheEntry["headers"] {
  const fresh = storableHeaders(update);
  const replaced = new Set(fresh.map(([name]) => name));
  return [...stored.filter(([name]) => !replaced.has(name)), ...fresh];
}

/** Rebuild a response from an entry, tagged with how the cache produced it. */
export function toResponse(entry: CacheEntry, status: CacheStatus): Response {
  const headers = new Headers();
  for (const [name, value] of entry.headers) {
    headers.append(name, value);
  }
  return tagStatus(
    new Response(entry.body, { status: entry.status, headers }),
    status,
  );
}
