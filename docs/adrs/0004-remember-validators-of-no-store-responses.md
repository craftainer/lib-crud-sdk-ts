# 0004. Remember the ETag of no-store responses for If-Match only

## Status

Accepted (implemented in 0.8.0)

## Context

Behind `@craftainer/bff`, `/api/*` responses carry `Cache-Control: no-store`.
The cache middleware does not store such a response (`isStorable`), so no
`CacheEntry` and no `CacheEntry.etag` exist. `cachedEtag` and `autoIfMatch`
read the ETag from the stored record entry, so they found nothing and a
client such as template-react could not build `If-Match`: inline edit refused
to save. RFC 9111 forbids a cache to _store_ a `no-store` response; it does
not forbid the client from reading the response's validator for optimistic
concurrency.

## Decision

We keep a second, small map in `createCache`: the last `ETag` seen per record
key (the record cache key, so it includes resource, record id, API version
and caller scope) from any successful `200` record read or `2xx` `PATCH`
response, `no-store` included.

- It is used only by `cachedEtag` / `autoIfMatch` for `If-Match`. It never
  serves a body and is never sent as `If-None-Match`; the response body of a
  `no-store` response stays out of every store.
- A newer response replaces it. It is dropped by every clear that drops the
  record entry (a write, `412`, `404`/`410`, `DELETE`, an SSE event,
  `clearResource`, `clear`) and by a `200` or write answer without an `ETag`.
  A change of caller scope does not wipe it: the key carries the scope, so a
  validator is only ever read back under the scope that stored it (an earlier
  revision dropped the whole map on a scope change; that wipe was removed).
  Entries of an earlier scope stay until LRU eviction or `cache.clear()`, so
  an app that switches user calls `cache.clear()` (see the README).
- It is an LRU of 1024 entries, the `MemoryStore` default.
- No new export and no option: it is active whenever the resource's policy has
  `etag` on, as the stored ETag already was.

## Consequences

- `If-Match` works behind a `no-store` BFF without weakening `no-store`: no
  body is retained.
- A validator is a few bytes per record, held in memory for the life of the
  cache object (not persisted, unlike IndexedDB entries), so a reload loses it
  until the record is read again.
- A scope switch keeps the validators of the other scope under their own
  keys, so alternating scopes do not cost a `PATCH` its `If-Match`. They are
  not served across scopes, but they stay in memory until eviction or
  `cache.clear()`.
- Weak ETags are sent as stored, as before.
