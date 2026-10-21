/**
 * Cache keys and the invalidation prefixes.
 *
 * Keys are slash-separated:
 * `v1/{resource}/{kind}/{subject}/{apiVersion}/{scope}/{canonicalQuery}`.
 * Versions of one resource never share an entry, but they share one event
 * stream; because the version comes after kind and subject, one prefix such
 * as `v1/{resource}/record/{id}/` clears an entry in every version and for
 * every caller at once.
 */
import type { Op } from "../interfaces.ts";

/** The ops that read and are cached (`manifest` has its own key). */
export type CacheKind =
  "list" | "record" | "stats" | "predict" | "revisions" | "filters";

const KINDS: ReadonlySet<string> = new Set<CacheKind>([
  "list",
  "record",
  "stats",
  "predict",
  "revisions",
  "filters",
]);
const STATS_KINDS: ReadonlySet<string> = new Set(["stats", "predict"]);
const COLLECTION_KINDS = ["list", "stats", "predict"] as const;
const PER_RECORD_KINDS = ["record", "revisions"] as const;

/** `true` when the op is a cacheable read kind. */
export function isCacheKind(op: Op): op is CacheKind {
  return KINDS.has(op);
}

/** `true` for `stats` and `predict`, which `stats_ttl` bounds. */
export function isStatsKind(kind: string): boolean {
  return STATS_KINDS.has(kind);
}

/**
 * Sorts the query pairs the client sent and drops `id` (it is the subject).
 * Values are kept verbatim: the client already emits canonical,
 * percent-encoded text, so nothing is decoded or re-encoded here.
 */
export function canonicalQuery(query: string): string {
  const text = query.startsWith("?") ? query.slice(1) : query;
  const pairs = text
    .split("&")
    .filter((part) => part !== "" && part.split("=", 1)[0] !== "id")
    .map((part) => {
      const at = part.indexOf("=");
      return at < 0
        ? ([part, ""] as const)
        : ([part.slice(0, at), part.slice(at)] as const);
    });
  pairs.sort(([an, av], [bn, bv]) =>
    an === bn ? (av < bv ? -1 : av > bv ? 1 : 0) : an < bn ? -1 : 1,
  );
  return pairs.map(([name, rest]) => name + rest).join("&");
}

export interface KeyParts {
  readonly resource: string;
  readonly kind: CacheKind;
  readonly recordId?: number | undefined;
  readonly scope: string;
  readonly query?: string;
  /** `null` (no version) renders as `_`. */
  readonly apiVersion: string | null;
}

/** The key of one cached response. */
export function buildKey(parts: KeyParts): string {
  const subject =
    (parts.kind === "record" || parts.kind === "revisions") &&
    parts.recordId !== undefined
      ? String(parts.recordId)
      : "_";
  const version = parts.apiVersion ?? "_";
  return `v1/${parts.resource}/${parts.kind}/${subject}/${version}/${parts.scope}/${canonicalQuery(parts.query ?? "")}`;
}

/** Key of the manifest document for one caller scope. */
export function manifestKey(scope: string): string {
  return `v1/_manifest/${scope}`;
}

/** Prefix of all entries of one kind for `resource` (every scope and subject). */
export function kindPrefix(resource: string, kind: CacheKind): string {
  return `v1/${resource}/${kind}/`;
}

/** Prefix of the `record` entries of one record (every version, scope, query). */
export function recordPrefix(resource: string, recordId: number): string {
  return `v1/${resource}/record/${recordId}/`;
}

/** Prefix of the `revisions` entries of one record. */
export function revisionsPrefix(resource: string, recordId: number): string {
  return `v1/${resource}/revisions/${recordId}/`;
}

/** The list, stats and predict prefixes of `resource`. */
export function collectionPrefixes(resource: string): string[] {
  return COLLECTION_KINDS.map((kind) => kindPrefix(resource, kind));
}

/** Everything cached for `resource` except `filters` (a reconnect or an unknown change). */
export function resourcePrefixes(resource: string): string[] {
  return [...COLLECTION_KINDS, ...PER_RECORD_KINDS].map((kind) =>
    kindPrefix(resource, kind),
  );
}

/**
 * Prefixes an SSE event clears, per the spec's table: `create` clears the
 * collection kinds; `update`/`delete`/`restore` also clear the record and its
 * revisions; an unknown action or a missing record id clears the resource.
 */
export function eventPrefixes(
  resource: string,
  action: string,
  recordId: number | undefined,
): string[] {
  if (action === "create") {
    return collectionPrefixes(resource);
  }
  if (
    (action === "update" || action === "delete" || action === "restore") &&
    recordId !== undefined
  ) {
    return [
      ...collectionPrefixes(resource),
      recordPrefix(resource, recordId),
      revisionsPrefix(resource, recordId),
    ];
  }
  return resourcePrefixes(resource);
}
