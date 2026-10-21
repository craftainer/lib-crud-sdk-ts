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

## Development

Open the repository in the devcontainer, then run
`prek run --all-files --hook-stage manual`.

## License

Licensed under the [GNU General Public License v3.0](LICENSE).
