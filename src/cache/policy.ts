/** Per-resource cache policy, defaulted from the manifest `cache` hints. */

/**
 * How one resource is cached. Times are seconds. `maxAge` and
 * `staleWhileRevalidate` only take effect while the resource's SSE stream is
 * running; without it every read revalidates. `statsTtl` bounds the staleness
 * of `stats`/`predict` on its own, as the server caches those bodies for the
 * same time. `revalidateOnly` means no fresh window and no
 * stale-while-revalidate.
 */
export interface CachePolicy {
  readonly enabled: boolean;
  readonly maxAge: number;
  readonly statsTtl: number;
  readonly staleWhileRevalidate: number;
  readonly etag: boolean;
  readonly revalidateOnly: boolean;
}

/** The manifest resource members a policy reads (I1); everything else is ignored. */
export interface ManifestCacheHints {
  readonly cache?: {
    readonly max_age?: unknown;
    readonly stats_ttl?: unknown;
    readonly stale_while_revalidate?: unknown;
    readonly etag?: unknown;
    readonly revalidate_only?: unknown;
  } | null;
}

function seconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(value, 0)
    : 0;
}

/** Build a policy from a manifest resource object; `overrides` win over the hints. */
export function cachePolicyFromManifest(
  resource: ManifestCacheHints,
  overrides: Partial<CachePolicy> = {},
): CachePolicy {
  const hints = resource.cache ?? {};
  return {
    enabled: overrides.enabled ?? true,
    maxAge: overrides.maxAge ?? seconds(hints.max_age),
    statsTtl: overrides.statsTtl ?? seconds(hints.stats_ttl),
    staleWhileRevalidate:
      overrides.staleWhileRevalidate ?? seconds(hints.stale_while_revalidate),
    etag: overrides.etag ?? hints.etag !== false,
    revalidateOnly: overrides.revalidateOnly ?? hints.revalidate_only === true,
  };
}

/**
 * The policy to use under TanStack Query: its `staleTime` decides freshness,
 * so the SDK cache only revalidates (ETag/304) unless told otherwise.
 */
export function tanstackCachePolicy(
  resource: ManifestCacheHints,
  overrides: Partial<CachePolicy> = {},
): CachePolicy {
  return cachePolicyFromManifest(resource, {
    revalidateOnly: true,
    ...overrides,
  });
}
