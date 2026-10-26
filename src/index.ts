// Entry point `.`: the zero-dependency fetch client and the shared contracts
// (`interfaces.ts`, I3).
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
export { ANON, cacheScope, staticToken } from "./auth.ts";
export { CrudClient, ResourceClient, createClient } from "./client.ts";
export type {
  BulkResult,
  ClientOptions,
  DeleteManyOptions,
  ListOptions,
  PredictOptions,
  RequestOptions,
  RestoreOptions,
  StatsOptions,
  WriteOptions,
} from "./client.ts";
export {
  BadRequest,
  CapabilityError,
  ClientError,
  ConnectionFailed,
  CrudError,
  Forbidden,
  InsecureTransportError,
  InvalidQueryError,
  Locked,
  ManifestError,
  NotFound,
  PreconditionFailed,
  ProblemError,
  RateLimited,
  ResponseError,
  ServerError,
  Unauthorized,
  UnknownResourceError,
  ValidationFailed,
  problemFromResponse,
} from "./errors.ts";
export type { ProblemDetail, ProblemInit } from "./errors.ts";
export {
  CATALOG_PATH,
  PROFILE,
  findResource,
  loadManifest,
  manifestUrlFromCatalog,
  parseManifest,
} from "./manifest.ts";
export type {
  AuthSpec,
  CacheHints,
  Capabilities,
  EventsSpec,
  FieldSpec,
  GetJson,
  JsonObject,
  Manifest,
  Pagination,
  Resource,
  Schemas,
} from "./manifest.ts";
export { buildQuery, encodeParams, formatScalar, quote } from "./query.ts";
export type { Filters, QueryField, QueryParams, Sort } from "./query.ts";
