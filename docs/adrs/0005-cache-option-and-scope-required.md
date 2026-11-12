# 0005. Wire the cache through a `cache` option and require a scope for cookie clients

## Status

Accepted

## Context

[ADR 0003](0003-cookie-sessions.md) added `cacheScope` for cookie sessions, but
left it optional. A cookie client (no per-user `Authorization` header) that
uses the cache and forgets `cacheScope` silently falls back to the `anon`
scope, so every user shares cached entries. The client could not notice,
because the cache was only an opaque `Middleware` in the `middleware` list.

Separately, `onUnauthorized` fired on every final `401`. A user who is signed
in but not authorised makes a redirect-to-login callback loop forever.

## Decision

- `createClient({ cache })` takes the `Cache` from `createCache`. The client
  wires `cache.middleware` and `cache.autoIfMatch` itself, innermost, after
  `middleware` and `use()` additions.
- A client with a cache that is a cookie client, meaning `credentials` is
  `"include"` or `"same-origin"` or there is no `tokenProvider`, and has no
  `cacheScope`, throws `ClientError` at construction. `cacheScope: "shared"`
  is the explicit opt-out; it is an ordinary scope value, so it needs no
  special case. Either signal is enough, because a cookie client may rely on
  the platform default for `credentials`, and an anonymous client has no
  per-caller header either.
- `createCache` tags its two middleware with a `Symbol.for` marker.
  `middleware` and `use()` reject tagged functions with `ClientError`. We
  considered keeping a late `use(cache.middleware)` working with a deprecation
  warning, but a cache added after construction escapes the check, which
  defeats the guarantee. Rejecting keeps the guarantee and the fix is mechanical. The check is by marker, so a wrapped or rebuilt copy of the cache middleware (a lambda calling `cache.middleware`, `.bind`, `composeMiddleware`) is not detected; that is documented misuse, not covered.
- `onUnauthorized(response, { attempt, url })`: `attempt` is the 1-based count
  of final `401`s the client has seen, `url` the request URL without query or
  fragment. Only the first `401` calls the callback; later and concurrent ones
  are suppressed for the client's lifetime ("one page load" is the
  module/client lifetime in the browser). A suppressed `401` still rejects
  with `Unauthorized`. Existing one-argument callbacks keep working.

## Consequences

- Breaking in a 0.x minor: `middleware: [cache.middleware]` and cache-using
  clients without a scope (cookie or anonymous) must migrate; see the README.
  An anonymous client moving to `cacheScope: "shared"` changes its key prefix
  (`anon` to `s:shared`), so a persisted cache starts cold once.
- A client with no `tokenProvider` that sets `Authorization` in its own middleware must still pass `cacheScope`; use the caller's identity, not `"shared"`, there.
- A `tokenProvider` that returns `null` for a cookie-authenticated user, with `credentials` unset, is not detected as a cookie client.
- `onUnauthorized` is not re-armed after a successful re-login; an app that must react again after a login without a reload needs its own handling.
- The scope check covers the common mistake, not every one: a host can still
  pass a constant `cacheScope` for a multi-user app.
- Because suppression is per client, `attempt` seen by the callback is 1; the
  counter is still exposed so a host can log it and so the contract can grow
  (for example a reset) without a signature change. A host that needs a
  longer-lived guard (surviving reloads) keeps its own, for example in
  `sessionStorage`.
