# 0002. Grant cache freshness only under SSE invalidation, scoped by the sent credential

## Status

Accepted

## Context

The SDK can cache `GET` responses client-side (`./cache`) and can sit under
TanStack Query (`./tanstack`), which has its own cache. A fresh hit that skips
the network is only safe if something can end the fresh window early when the
data changes; the server offers that through a per-resource SSE stream. Other
forces:

- A shared store (IndexedDB across tabs) holds entries of several callers.
  Keying on an unverified claim, or on a token the request is not actually
  sent with, would let one caller read another's fresh entries.
- A response can be in flight when an invalidation for its resource lands;
  storing it fresh would resurrect stale data.
- `EventSource` cannot send an Authorization header, and the stream requires
  the bearer token.
- The Python SDK implements the same behaviour; the two must agree.

## Decision

We will:

- Revalidate every read with `If-None-Match` by default. A fresh window
  (`max_age`) and stale-while-revalidate are granted only while that
  resource's SSE stream is connected, never when the manifest says
  `cache.revalidate_only`. `stats`/`predict` are bounded by `stats_ttl`.
- Treat events as invalidations only, never as data (no snapshot is applied),
  clearing the spec's prefixes in one `clearMany` pass; every connect (the first included, since a persisted store may predate it) clears the
  resource. A per-resource generation counter stops responses that predate an
  invalidation from being stored fresh.
- Derive the cache scope from the `Authorization` header on the request the
  cache middleware sees: `anon` without one, else the first 32 hex characters
  of the SHA-256 of the whole credential. The cache and the automatic
  `If-Match` lookup use the same function, and both must be the innermost
  middleware so they see what is sent.
- Read the stream with fetch streaming and an inlined `eventsource-parser`,
  through an authenticated `fetch` the caller passes in, resuming explicitly
  with `?{resume_param}=<subscriber_id>`.
- Under TanStack, default the SDK cache to revalidate-only
  (`tanstackCachePolicy`): TanStack's `staleTime` owns freshness.

## Consequences

- Cached data is never served without a live way to invalidate it, at the
  price of a conditional request on every read while the stream is down.
- Entries do not survive a token refresh (a new credential is a new scope).
- Both middleware must be ordered after anything that sets Authorization;
  a mis-ordered chain caches under `anon`. This is documented in the README.
- `clearMany` is an optional store method; a custom store without it gets one
  `clear` per prefix.

## Addendum (2026-10-21, spec amendment)

- `filters` entries are never fresh: events never clear them, so they always
  revalidate.
- The freshness gate is per resource name and open while at least one
  subscription (across hubs) is connected; one unsubscribing never closes it
  for the others.
- Policies are looked up by `name@apiVersion`, then by `name`; the event
  stream and gate are per name.
- Keys carry no origin. A store shared between servers needs a per-origin
  namespace (the IndexedDB database name; a separate `MemoryStore`). The key
  format is unchanged.
- Stale-while-revalidate is granted only while the resource's stream is up,
  for every kind (`stats`/`predict` included; their `stats_ttl` fresh window is
  unchanged). The first handshake of a hub clears the resource like a
  reconnect, since a persisted store may hold older entries.
- Only `POST`, `PATCH`, `PUT` and `DELETE` clear; an empty IndexedDB database
  name is rejected; a malformed 2xx JSON body is a `ResponseError`.
