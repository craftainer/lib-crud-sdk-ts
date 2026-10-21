// Entry point `.`: the zero-dependency fetch client. TS1 adds the client,
// query builder, errors and auth; the shared contracts (I3) live in
// `interfaces.ts`.
export type {
  CacheEntry,
  CacheStore,
  CrudEvent,
  MaybePromise,
  Middleware,
  Next,
  Op,
  RequestContext,
  TokenProvider,
} from "./interfaces.ts";
export { composeMiddleware } from "./interfaces.ts";
