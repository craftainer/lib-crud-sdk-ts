# @craftainer/crud-sdk

> [!NOTE]
> This repository is vibe coded with [Claude](https://claude.com/product/claude-code).

Typed `fetch` client for craftainer CRUD APIs (the TypeScript twin of the
Python `crud-sdk`): manifest-driven resources, a query builder, RFC 9457
problem-details errors, an opt-in cache with SSE invalidation, and TanStack
Query helpers. ESM only. Created from
[`template-npm-package`](https://github.com/craftainer/template-npm-package);
the shared conventions are in [`docs/TEMPLATE.md`](docs/TEMPLATE.md).

## Entry points

| Import                          | Source                  | Contents                                                                                                                                                         |
| ------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@craftainer/crud-sdk`          | `src/index.ts`          | The client core and the shared contracts in `src/interfaces.ts` (`CacheStore`, `Middleware`, `RequestContext`, `TokenProvider`, `CrudEvent`). Zero dependencies. |
| `@craftainer/crud-sdk/cache`    | `src/cache/index.ts`    | Cache middleware, memory and IndexedDB stores, SSE invalidation.                                                                                                 |
| `@craftainer/crud-sdk/tanstack` | `src/tanstack/index.ts` | `queryOptions` factories, key factory, invalidation bridge.                                                                                                      |
| `crud-sdk-codegen` (bin)        | `src/codegen/cli.ts`    | Writes TypeScript types from a manifest.                                                                                                                         |

The package has no `dependencies`. `idb` and `eventsource-parser` are dev
dependencies that `tsdown` inlines (`noExternal`). `@tanstack/query-core`
(for `./tanstack`) and `json-schema-to-typescript` (for the codegen bin) are
optional peer dependencies.

Add or remove an entry point in `package.json`'s `exports`/`bin` and
`tsdown.config.ts`'s `entry` together.

## Client

```ts
import { createClient } from "@craftainer/crud-sdk";

const client = createClient({
  baseUrl: "https://api.example.com",
  tokenProvider: ({ refresh }) => getToken({ refresh }), // optional
  // fetch, middleware, manifestUrl are optional too
});
const heroes = await client.resource("heroes"); // highest api_version, or ("heroes", "v1")
const page = await heroes.list({
  filters: { power_level__min: 3, name__icontains: "ada" },
  sort: "-power_level",
  limit: 50,
});
for await (const hero of heroes.iterAll({ filters: { is_locked: false } })) {
  // pages with skip += limit until a short page
}
await heroes.update(1, { name: "Ada" }, { ifMatch: etag }); // 412 -> PreconditionFailed
```

- **Discovery.** The manifest loads on first use through
  `/.well-known/api-catalog` (the `describedby` link with the manifest
  profile), or from `manifestUrl`. `client.manifest({ refresh: true })`
  reloads it; if the reload fails the error is thrown and the last good
  manifest stays cached. Manifest types keep the wire member names
  (`skip_param`, `max_age`, ...) and ignore unknown members.
- **Same origin.** The client sends the token to every URL it builds, so a
  manifest `base_path`, `paths.*` or `events.path` that resolves to another
  origin than `baseUrl`'s (an absolute URL or a protocol-relative `//host`)
  is refused with a `ManifestError`. For a split-origin deployment, list the
  extra origins: `createClient({ baseUrl, allowedOrigins: ["https://files.example"] })`
  (exact origins: scheme, host and port; an entry that is not an http(s)
  origin throws at `createClient`). The same rule already applies to the
  api-catalog's manifest link.
- **Plain http.** A request that carries an `Authorization` header is
  refused with `InsecureTransportError` (a `ClientError`, thrown before
  anything is sent) when its URL is `http:` and the host is not loopback
  (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`, judged on the parsed
  hostname). The check runs on the request as it is sent, so a middleware that
  rewrites the URL or sets its own `Authorization` is covered. Anonymous
  requests over http are unaffected. To allow it on a trusted network, pass
  `createClient({ baseUrl, allowInsecureHttp: true })`; the codegen CLI has
  `--allow-insecure-http` for `CRUD_SDK_TOKEN`. On a redirect, `fetch` drops
  `Authorization` when the target origin differs (scheme, host or port: so an
  `https:` to `http:` downgrade drops it too, per the WHATWG Fetch
  "HTTP-redirect fetch" step); this relies on the `fetch` you pass behaving
  to spec. `events` streams use the `fetch` you hand to `getEventHub`, which
  the SDK does not wrap: make that `fetch` the client's authenticated one.
- **Operations** (each gated on the manifest's capabilities and `paths`,
  else `CapabilityError`): `list`, `iterAll`, `get`, `create`, `update`,
  `updateMany`, `delete`, `deleteMany`, `restore({ id } | { filters })`,
  `clone`, `createDraft`, `publish`, `filters`, `stats`, `predict`,
  `revisions`, `eventsUrl()`. Every call takes `{ signal }`. A call that is
  invalid for the manifest (unknown field or operator, wrong value type, bad
  sort or paging) rejects with `InvalidQueryError` before any request.
- **Query strings** are byte for byte those of the Python SDK (a shared
  table, `tests/fixtures/url-parity.json`, checks both): parameters in the
  order `id`, filters sorted by (field, operator), sort, skip, limit,
  `include_archived`, `include_unpublished`; everything but `A-Za-z0-9-._~`
  percent-encoded; datetimes are `Date`s sent as UTC with milliseconds
  trimmed; `date` fields take `YYYY-MM-DD` strings. `only_archived` is
  emitted right after `include_archived`, and only when `true`.
- **Archived rows.** `list` and `iterAll` take `includeArchived` and
  `onlyArchived`. `onlyArchived: true` returns only rows with `archived_at`
  set (the server's reserved `only_archived` list parameter; it implies
  `include_archived` and combines with filters, sort and paging). It is not
  sent when `false` or absent. Combined with `includeArchived: false` it
  rejects with `InvalidQueryError` before any request (the server would
  answer `422`). It is a list option only (not on `stats`, writes, `restore`
  or `get`); a non-archivable resource ignores it. The wire query is part of
  the HTTP cache key, and in the TanStack layer put it in the list query (`listOptions(ns, "heroes", api, { onlyArchived: true })`), so
  archived-only and normal lists never share a cache entry.
- **Bulk delete and unpublished rows.** `deleteMany(filters, { includeUnpublished })`
  sends `include_unpublished=<true|false>` only when the option is given;
  `false` leaves not-yet/no-longer-published rows alone. It requires
  lib-crud-py with BD1 (`include_unpublished` on bulk `DELETE`); an older
  server ignores it and still deletes unpublished rows, so do not rely on
  `false` against one.
- **Errors.** `ProblemError` (RFC 9457) with subclasses `BadRequest`,
  `Unauthorized`, `Forbidden`, `NotFound`, `PreconditionFailed`,
  `ValidationFailed` (`errors`), `Locked`, `RateLimited` (`retryAfter`),
  `ServerError`; `ConnectionFailed` for transport failures (an abort passes
  through unchanged). All extend `CrudError`.
- **Auth.** The token provider is called per request; after a `401` it is
  called once with `{ refresh: true }` and the request is retried only if
  the token changed. The cache scope is `"anon"` or the first 32 hex of the
  SHA-256 of the whole token (never decoded).
- **Middleware.** `createClient({ middleware })` or `client.use(mw)` (added
  innermost). Each request carries a `RequestContext` (`resource`, `op`,
  `recordId`, `scope`, `apiVersion`, `signal`).
- **Response shape.** A call that expects an object or array and gets a `204`,
  an empty body or JSON of the wrong shape throws `ResponseError`, as a body
  that is not JSON does. `client.resource("heroes")` picks the highest
  `api_version` by its number (`v<N>`); a value that does not match `v<N>`
  ranks lowest.
- **Typed records.** `client.resource<Read, Create, Update>("heroes")` takes
  the interfaces written by the codegen below (not checked at runtime).

## Codegen

```sh
CRUD_SDK_TOKEN=... crud-sdk-codegen --manifest https://api.example.com --out src/crud-types.ts
crud-sdk-codegen --manifest ./manifest.json --out src/crud-types.ts
```

Writes `<Name><Version>Read|Create|Update` (and `Draft`) interfaces per
resource from the manifest's JSON Schemas. `--manifest` is a manifest URL, a
server origin (discovers through the api-catalog) or a file; the optional
peer `json-schema-to-typescript` must be installed. The header names the
source without credentials, query or fragment. Two resources whose names
map to the same type name (`hero-x` and `hero_x`, same version), or a name
that is not a valid identifier (a leading digit), fail with a `CrudError`
naming them.

## Caching / TanStack

`createCache({ store, policies })` (from `./cache`) returns two `Middleware`:
`cache.middleware` and `cache.autoIfMatch`. Put both **innermost**, after
whatever sets `Authorization`: the cache scope is `anon` without an
Authorization header, else the first 32 hex characters of the SHA-256 of the
whole credential, taken from the request as it is sent. `policies` maps
manifest resource names to `cachePolicyFromManifest(resource)` (plain I1
objects, snake_case members).

- Every read revalidates (`If-None-Match`, `304` rebuilt from the store).
  `max_age`/`stale_while_revalidate` freshness applies only while the
  resource's SSE stream is connected, never with `cache.revalidate_only`.
  A stale-while-revalidate background request inherits the caller's `fetch`
  init except `cache`, which it forces to `"no-store"` (an inherited
  `force-cache` or `only-if-cached` would skip the server).
  Every connection clears the resource once per cache, including for a
  subscription that joins an already connected stream, which clears before
  its gate opens.
- A write clears what it touches when it succeeds. A write whose outcome is
  unknown (the request threw, or the answer was `5xx`) clears the same, since
  the server may have applied it; a refused write (any other status below `500`) clears
  nothing, except `412`, `404` and `410`, which evict the record's cached reads
  (its entry and its revisions): the server says the record changed or is gone,
  as a read answered `404`/`410` does. A bulk write of unknown outcome clears
  the whole resource, as its ids are not known. A write aborted before it
  was sent clears nothing.
- Wire the stream with `invalidateOnEvents(cache, getEventHub({ fetch, url,
events }), "heroes")`; `fetch` must be authenticated. Events invalidate and
  never apply snapshots. `subscribeEvents` is the lower-level entry.
- One hub serves every subscriber of the same `(fetch, url)`, and the first
  subscriber's `events` options win. A later subscriber's differing
  `resource`, `resume_param`, `replay` or `keepalive_seconds` is ignored; in
  development (`process.env.NODE_ENV !== "production"`, or when there is no
  `process`) it gets a `console.warn` naming the URL and the fields. Pass the
  same manifest `events` object to every subscriber of one stream.
- A `keepalive_seconds` that is zero, negative or not finite is treated as
  unset: the 15 s default applies (a stream silent for three intervals is dead).
- Stores: `MemoryStore` (LRU) and `IndexedDbStore` (store failures are a miss).
  `IndexedDbStore` keeps an `expiresAt` index (database version 2; a version 1
  database upgrades in place and keeps its entries), deletes every expired
  entry once when it opens the database, and takes an optional
  `maxEntries` (a positive integer, default unbounded): a `set` that leaves
  more entries than that deletes the ones with the earliest `expiresAt` until
  the cap holds, a just-written short-ttl entry included. Without
  `maxEntries` nothing but the open-time sweep and per-read expiry removes
  entries. An older release of the package cannot open a version 2 database
  (the browser refuses to downgrade); give the new release a fresh `name` if
  both must coexist.
  `clearMany(prefixes)` is optional on a custom `CacheStore`.
- `cacheStatus(response)` says `hit`, `stale`, `revalidated` or `miss`;
  `cache.close()` stops background refreshes.

`./tanstack` has no runtime dependency on `@tanstack/query-core`: `crudKeys`,
`listOptions`/`recordOptions`/`statsOptions`/`predictOptions`/
`revisionsOptions`/`manifestOptions`, `infiniteListOptions`, the
`create`/`update`/`deleteMutationOptions`, `invalidateResource`/
`invalidateCollections`/`invalidateRecord` (each takes `{ client, resource }`)
and `bridgeEvents(queryClient, hub, { client, resource })`, where `client` is
the id string (`client.id`) and `resource` the same string the keys use. Use
`tanstackCachePolicy` so the SDK cache only revalidates and TanStack's
`staleTime` owns freshness. The factories take structural slices (`list(query, { signal })`, ...), which
the client's options-object methods do not match for `list`, `stats`,
`predict` and the manifest. `tanstackApi(client, resource)` (from
`./tanstack`) binds one `ResourceClient` to all of them; a query is the
client's `ListOptions` (`{ filters, sort, skip, limit, ... }`) without
`signal`, which TanStack's `signal` fills in.

**Query keys** are namespaced by client and caller scope, so clients or
callers sharing one `QueryClient` never see each other's data:

```
["crud", client, resource, scope, kind, ...rest]   kind: list | record | stats | predict | revisions
["crud", client, "_manifest", scope]
```

`client` is `CrudClient.id` (`createClient({ id })`, default `baseUrl`; keep it
stable across reloads of a persisted cache). `scope` is `client.scope()`.
`await client.namespace()` returns the `{ client, scope }` that every factory
takes as its first argument (`listOptions(ns, resource, api, query)`,
`createMutationOptions(queryClient, ns, resource, api)`). `resource` is the
manifest name, or `name@apiVersion` for a pinned version (a different
string is a different resource: pass the same one to the invalidate helpers
and `bridgeEvents`; `_manifest` is reserved). The namespace is a snapshot: a
token change (login, logout, refresh to another identity) changes the scope,
so resolve it again then, for example in a provider keyed on the token.
Clients that share a `baseUrl` but differ in anything else need distinct ids.

Because `resource` precedes `scope`, "everything of resource X on client C" is
one prefix (`crudKeys.resource(c, x)`, or `invalidateResource(queryClient, c,
x)`), and `crudKeys.client(c)` clears a whole client. Narrowing by scope, kind
or record id uses `crudKeys.filter({ client, resource?, scope?, kinds?, id? })`,
which returns `{ queryKey }` or `{ predicate }` to spread into
`invalidateQueries`/`removeQueries`. Mutations and `bridgeEvents` invalidate
every scope of the client's resource, since a write changes what every caller sees.

The `create`/`update`/`deleteMutationOptions` follow TanStack's "always
refetch after error or success": `onSettled` invalidates collections (lists,
stats, predict) and revisions on both outcomes, so a write that failed with a
`5xx` or a dropped connection (and may have been applied) is refetched too. A
failed update or delete also invalidates the record's own query. `onSuccess`
only does `setQueryData` (update) or `removeQueries` (delete), so nothing is
invalidated twice. If you spread the options into `useMutation` and add your own
`onSettled`, call the factory's first.

```ts
import { createClient } from "@craftainer/crud-sdk";
import {
  createCache,
  MemoryStore,
  cachePolicyFromManifest,
} from "@craftainer/crud-sdk/cache";
import { listOptions, tanstackApi } from "@craftainer/crud-sdk/tanstack";

const cache = createCache({
  store: new MemoryStore(),
  policies: { heroes: cachePolicyFromManifest(heroesManifestEntry) },
});
const client = createClient({
  baseUrl,
  middleware: [cache.middleware, cache.autoIfMatch],
});
const api = tanstackApi(client, await client.resource("heroes"));
useQuery(listOptions(await client.namespace(), "heroes", api, { limit: 50 }));
```

Cache keys carry no server origin, so a store shared between servers needs a
per-origin namespace: give each server its own `MemoryStore` or its own
`IndexedDbStore({ name })` (the IndexedDB database name). The key format does
not change.

`policies` is keyed by `name@apiVersion` (built from that version's manifest
entry) or by plain `name` for every version; the event stream and the
freshness gate are per resource name, and the gate stays open while at least
one subscription for that resource is connected. `filters` entries are never
served fresh.

The cache scope is the same on both sides: `client.scope()` equals
`credentialScope` of the `Authorization` header the client sends (an empty
token sends no header and is `anon`). `cache.autoIfMatch` reads `recordId`,
the resource and `apiVersion` from the client's request context, so
`update`/`delete` without `ifMatch` send the ETag cached for that caller.

See
[`docs/adrs/0002-cache-freshness-and-event-invalidation.md`](docs/adrs/0002-cache-freshness-and-event-invalidation.md).

## Development

Open the repository in the devcontainer, then run
`prek run --all-files --hook-stage manual`.

## License

Licensed under the [GNU General Public License v3.0](LICENSE).
