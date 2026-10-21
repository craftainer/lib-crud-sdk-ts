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
- Wire the stream with `invalidateOnEvents(cache, getEventHub({ fetch, url,
events }), "heroes")`; `fetch` must be authenticated. Events invalidate and
  never apply snapshots. `subscribeEvents` is the lower-level entry.
- Stores: `MemoryStore` (LRU) and `IndexedDbStore` (store failures are a miss).
  `clearMany(prefixes)` is optional on a custom `CacheStore`.
- `cacheStatus(response)` says `hit`, `stale`, `revalidated` or `miss`;
  `cache.close()` stops background refreshes.

`./tanstack` has no runtime dependency on `@tanstack/query-core`: `crudKeys`,
`listOptions`/`recordOptions`/`statsOptions`/`predictOptions`/
`revisionsOptions`/`manifestOptions`, `infiniteListOptions`, the
`create`/`update`/`deleteMutationOptions` and `bridgeEvents(queryClient, hub,
resource)`. Use `tanstackCachePolicy` so the SDK cache only revalidates and
TanStack's `staleTime` owns freshness. See
[`docs/adrs/0002-cache-freshness-and-event-invalidation.md`](docs/adrs/0002-cache-freshness-and-event-invalidation.md).

## Development

Open the repository in the devcontainer, then run
`prek run --all-files --hook-stage manual`.

## License

Licensed under the [GNU General Public License v3.0](LICENSE).
