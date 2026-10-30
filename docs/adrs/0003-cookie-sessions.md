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
  `tokenProvider` is also given (the token still authenticates). The client
  marks the `RequestContext` (an internal symbol-keyed property that survives
  `{ ...ctx }`), and the cache middleware keys by `ctx.scope` only when marked,
  otherwise by `credentialScope(headers)` as before, so a middleware that sets
  its own `Authorization` stays covered for existing users. The scope is
  percent-encoded in cache keys, which are slash-separated. An empty scope is
  a `ClientError`.
- `credentials?: RequestCredentials`, passed to every request.
- `onUnauthorized?: (response: Response) => void | Promise<void>`, awaited on a
  final `401` after the refresh retry. The call still rejects with
  `Unauthorized`, following the SDK's error model (errors are thrown, never
  swallowed); callers can both navigate and surface the error.

We do not add a `headers` option. Static headers such as `X-CSRF` go through
the existing middleware chain, which already covers every request including
the manifest, so a second mechanism would be redundant public API.

## Consequences

- Token users see no change; cookie-session users get per-user cache isolation
  in the client, the TanStack keys and the HTTP cache.
- The marker is not in `interfaces.ts` (fixed contract I3), so a custom
  middleware that rebuilds a context without spreading it loses the marker and
  falls back to the header scope. Spreading (`{ ...ctx }`) is the documented
  way to pass a changed request.
- The caller owns scope correctness: it must change when the user changes, and
  stay stable for one user. A function is evaluated per request, so it should
  be cheap.
- `onUnauthorized` gets a clone, so reading its body does not break error
  parsing; a throwing callback replaces `Unauthorized`.
