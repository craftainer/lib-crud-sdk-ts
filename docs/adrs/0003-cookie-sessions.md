# 0003. Support cookie sessions with cacheScope, credentials and onUnauthorized

## Status

Accepted

## Context

The client authenticated with a bearer `tokenProvider`, and the cache scope
(`ctx.scope`, TanStack keys, `./cache` keys) was derived from that token:
`"anon"` without one, else the SHA-256 prefix of the token. `credentials` was
never set. The cache middleware ignored `ctx.scope` and re-derived the scope
from the `Authorization` header.

The craftainer BFF keeps the token server-side and gives the browser a cookie
session. The browser sends no `Authorization` header, so every user would map
to `"anon"` and share cached entries (a cross-user leak in a shared
`MemoryStore` or IndexedDB). The scope must come from elsewhere, for example
the `sub` of `GET /bff/user`. The app also needs `credentials` for the cookie,
a static `X-CSRF: 1` header, and a reaction to `401` (navigate to login).

## Decision

We add three optional `ClientOptions`, backwards compatible (minor release):

- `cacheScope?: string | (() => string | Promise<string>)`. When set it
  replaces the token-hash / `"anon"` scope entirely, including when a
  `tokenProvider` is also given (the token still authenticates). It must
  resolve to a non-empty string, else `ClientError`. The client namespaces it
  internally (`s:` + `encodeURIComponent(value)`, so it never equals `anon`
  or a token hash and adds no key segments), evaluates a function per request
  (reused across that request's 401 retry, plus once per `scope()` call), and sets it as `ctx.scope` and as the
  new optional public `RequestContext.cacheScope`. The cache middleware keys
  by `ctx.cacheScope` when present, otherwise by `credentialScope(headers)` as
  before, so a middleware that sets its own `Authorization` stays covered for
  existing users.
- `credentials?: RequestInit["credentials"]`, passed to every request.
  `"include"` over plain `http:` to a non-loopback host is refused with
  `InsecureTransportError`, the same rule as for `Authorization`
  (`allowInsecureHttp` opts in). `"same-origin"` is not guarded: it can only
  target the page's own origin, like the unguarded platform default.
- `onUnauthorized?: (response: Response) => void | Promise<void>`, awaited on
  each final `401` response, after the refresh retry (manifest and discovery
  included: under a BFF those also mean "not logged in"). A call that makes
  several requests can fire it more than once, so it should be idempotent
  (navigation). The call still rejects with `Unauthorized`, following the
  SDK's error model; if the callback throws, its error becomes the
  `Unauthorized`'s `cause` (or a non-enumerable `onUnauthorizedError` when a
  `cause` is already set).

We do not add a `headers` option. Static headers such as `X-CSRF` go through
the existing middleware chain, which already covers every request including
the manifest, so a second mechanism would be redundant public API.

## Consequences

- Token users see no change; cookie-session users get per-user cache isolation
  in the client, the TanStack keys and the HTTP cache.
- The scope travels in a typed context field, so it fails closed only as long
  as middleware carry context fields through: a middleware that builds a
  context without spreading `ctx` drops `cacheScope` and the cache falls back
  to the header scope (`anon` for cookie sessions). Spreading
  (`{ ...ctx, request }`) is the documented way to pass a changed request.
- The caller owns scope correctness: it must change when the user changes, and
  stay stable for one user. A function is evaluated per request, so it should
  be cheap.
- `onUnauthorized` gets a clone, so reading its body does not break error
  parsing.
