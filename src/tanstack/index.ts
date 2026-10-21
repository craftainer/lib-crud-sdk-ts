// Entry point `./tanstack`: `queryOptions` factories, key factory and the
// invalidation bridge (TS2). Needs the optional peer `@tanstack/query-core`
// (types only: nothing here imports it at runtime). query-core has no
// `queryOptions`, so the factories return plain `{ queryKey, queryFn,
// staleTime }` objects with `queryKey` tagged through `DataTag`; the React
// wrappers live in lib-crud-views-ts.
import type { DataTag, InfiniteData, QueryClient } from "@tanstack/query-core";
import type { EventHub } from "../events.ts";

export { tanstackApi } from "./adapter.ts";
export type { TanstackApi } from "./adapter.ts";
export { tanstackCachePolicy } from "../cache/policy.ts";
export type { CachePolicy, ManifestCacheHints } from "../cache/policy.ts";
export { getEventHub, subscribeEvents } from "../events.ts";
export type {
  EventHandlers,
  EventHub,
  EventHubOptions,
  EventsConfig,
  SubscribeEventsOptions,
} from "../events.ts";
export type { CrudEvent } from "../interfaces.ts";

/** A query object as the client's query builder takes it. */
export type CrudQuery = Readonly<Record<string, unknown>>;

type Key = readonly unknown[];

/** The key factory type. */
export interface CrudKeys {
  readonly all: readonly ["crud"];
  /** Everything of one resource. */
  resource(resource: string): readonly ["crud", string];
  /** All lists of one resource, plain and infinite. */
  lists(resource: string): readonly ["crud", string, "list"];
  list(resource: string, query?: CrudQuery): Key;
  infiniteList(resource: string, query: CrudQuery, limit: number): Key;
  /** All record queries of one resource. */
  records(resource: string): readonly ["crud", string, "record"];
  record(
    resource: string,
    id: number,
  ): readonly ["crud", string, "record", number];
  stats(resource: string, query?: CrudQuery): Key;
  predict(resource: string, query?: CrudQuery): Key;
  revisions(
    resource: string,
    id: number,
  ): readonly ["crud", string, "revisions", number];
  /** The manifest, optionally of one caller scope. */
  manifest(scope?: string): Key;
}

/** The key factory. Every key starts with `["crud", resource, ...]`, so prefixes invalidate by resource, kind or record. */
export const crudKeys: CrudKeys = {
  all: ["crud"],
  resource: (resource) => ["crud", resource],
  lists: (resource) => ["crud", resource, "list"],
  list: (resource, query) =>
    query === undefined
      ? crudKeys.lists(resource)
      : [...crudKeys.lists(resource), query],
  infiniteList: (resource, query, limit) => [
    ...crudKeys.lists(resource),
    "infinite",
    query,
    limit,
  ],
  records: (resource) => ["crud", resource, "record"],
  record: (resource, id) => ["crud", resource, "record", id],
  stats: (resource, query) =>
    query === undefined
      ? ["crud", resource, "stats"]
      : ["crud", resource, "stats", query],
  predict: (resource, query) =>
    query === undefined
      ? ["crud", resource, "predict"]
      : ["crud", resource, "predict", query],
  revisions: (resource, id) => ["crud", resource, "revisions", id],
  manifest: (scope) =>
    scope === undefined ? ["crud", "_manifest"] : ["crud", "_manifest", scope],
};

/** What a query function receives from TanStack Query (a subset). */
export interface QueryContext {
  readonly signal: AbortSignal;
}

export interface QueryOptionsInit {
  /** TanStack's `staleTime` in milliseconds. Default 0 (the SDK cache revalidates for free). */
  readonly staleTime?: number;
}

/** Plain query options with a typed key; spread into `useQuery`/`fetchQuery`. */
export interface CrudQueryOptions<T> {
  readonly queryKey: DataTag<Key, T, Error>;
  readonly queryFn: (context: QueryContext) => Promise<T>;
  readonly staleTime: number;
}

export interface CrudInfiniteQueryOptions<T> {
  readonly queryKey: DataTag<
    Key,
    { pages: T[][]; pageParams: number[] },
    Error
  >;
  readonly queryFn: (
    context: QueryContext & { pageParam: number },
  ) => Promise<T[]>;
  readonly initialPageParam: number;
  /** `skip + limit` unless the page was short. */
  readonly getNextPageParam: (
    lastPage: T[],
    allPages: T[][],
    lastPageParam: number,
  ) => number | undefined;
  readonly staleTime: number;
}

/** The slices of a resource API the factories call (structural: TS1's resource client fits). */
export interface ListApi<T> {
  list(
    query: CrudQuery | undefined,
    init?: { signal?: AbortSignal },
  ): Promise<T[]>;
}
export interface RecordApi<T> {
  get(id: number, init?: { signal?: AbortSignal }): Promise<T>;
}
export interface StatsApi<S> {
  stats(
    query: CrudQuery | undefined,
    init?: { signal?: AbortSignal },
  ): Promise<S>;
}
export interface PredictApi<P> {
  predict(
    query: CrudQuery | undefined,
    init?: { signal?: AbortSignal },
  ): Promise<P>;
}
export interface RevisionsApi<R> {
  revisions(id: number, init?: { signal?: AbortSignal }): Promise<R[]>;
}
export interface ManifestApi<M> {
  manifest(init?: { signal?: AbortSignal }): Promise<M>;
}
export interface CreateApi<T, C> {
  create(body: C): Promise<T>;
}
export interface UpdateApi<T, P> {
  update(id: number, patch: P, init?: { ifMatch?: string }): Promise<T>;
}
export interface DeleteApi {
  delete(id: number): Promise<unknown>;
}

function tag<T>(key: Key): DataTag<Key, T, Error> {
  return key as DataTag<Key, T, Error>;
}

export function listOptions<T>(
  resource: string,
  api: ListApi<T>,
  query?: CrudQuery,
  init: QueryOptionsInit = {},
): CrudQueryOptions<T[]> {
  return {
    queryKey: tag(crudKeys.list(resource, query)),
    queryFn: ({ signal }) => api.list(query, { signal }),
    staleTime: init.staleTime ?? 0,
  };
}

export function recordOptions<T>(
  resource: string,
  api: RecordApi<T>,
  id: number,
  init: QueryOptionsInit = {},
): CrudQueryOptions<T> {
  return {
    queryKey: tag(crudKeys.record(resource, id)),
    queryFn: ({ signal }) => api.get(id, { signal }),
    staleTime: init.staleTime ?? 0,
  };
}

export function statsOptions<S>(
  resource: string,
  api: StatsApi<S>,
  query?: CrudQuery,
  init: QueryOptionsInit = {},
): CrudQueryOptions<S> {
  return {
    queryKey: tag(crudKeys.stats(resource, query)),
    queryFn: ({ signal }) => api.stats(query, { signal }),
    staleTime: init.staleTime ?? 0,
  };
}

export function predictOptions<P>(
  resource: string,
  api: PredictApi<P>,
  query?: CrudQuery,
  init: QueryOptionsInit = {},
): CrudQueryOptions<P> {
  return {
    queryKey: tag(crudKeys.predict(resource, query)),
    queryFn: ({ signal }) => api.predict(query, { signal }),
    staleTime: init.staleTime ?? 0,
  };
}

export function revisionsOptions<R>(
  resource: string,
  api: RevisionsApi<R>,
  id: number,
  init: QueryOptionsInit = {},
): CrudQueryOptions<R[]> {
  return {
    queryKey: tag(crudKeys.revisions(resource, id)),
    queryFn: ({ signal }) => api.revisions(id, { signal }),
    staleTime: init.staleTime ?? 0,
  };
}

export function manifestOptions<M>(
  api: ManifestApi<M>,
  scope?: string,
  init: QueryOptionsInit = {},
): CrudQueryOptions<M> {
  return {
    queryKey: tag(crudKeys.manifest(scope)),
    queryFn: ({ signal }) => api.manifest({ signal }),
    staleTime: init.staleTime ?? 0,
  };
}

export interface InfiniteListInit extends QueryOptionsInit {
  /** Page size; default 100 (the server's default). */
  readonly limit?: number;
  /**
   * Keys of the paging parameters in the query object handed to `api.list`.
   * Default `skip`/`limit`, which is what `tanstackApi` (the client's
   * `ListOptions`) reads; change them only for a hand-written `ListApi`. The
   * client maps them to the manifest's `skip_param`/`limit_param` itself.
   */
  readonly skipKey?: string;
  readonly limitKey?: string;
}

/** Offset paging: the next page starts at `skip + limit`, unless the last page was short. */
export function infiniteListOptions<T>(
  resource: string,
  api: ListApi<T>,
  query: CrudQuery = {},
  init: InfiniteListInit = {},
): CrudInfiniteQueryOptions<T> {
  const limit = init.limit ?? 100;
  const skipKey = init.skipKey ?? "skip";
  const limitKey = init.limitKey ?? "limit";
  return {
    queryKey: tag<InfiniteData<T[], number>>(
      crudKeys.infiniteList(resource, query, limit),
    ),
    queryFn: ({ signal, pageParam }) =>
      api.list(
        { ...query, [skipKey]: pageParam, [limitKey]: limit },
        { signal },
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage, _all, lastPageParam) =>
      lastPage.length < limit ? undefined : lastPageParam + limit,
    staleTime: init.staleTime ?? 0,
  };
}

export type Invalidator = Pick<
  QueryClient,
  "invalidateQueries" | "removeQueries" | "setQueryData"
>;

async function invalidateCollections(
  client: Invalidator,
  resource: string,
): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: crudKeys.lists(resource) }),
    client.invalidateQueries({ queryKey: crudKeys.stats(resource) }),
    client.invalidateQueries({ queryKey: crudKeys.predict(resource) }),
  ]);
}

export interface CreateMutationOptions<T, C> {
  readonly mutationKey: readonly ["crud", string, "create"];
  readonly mutationFn: (body: C) => Promise<T>;
  readonly onSuccess: () => Promise<void>;
}

export interface UpdateMutationOptions<T, P> {
  readonly mutationKey: readonly ["crud", string, "update"];
  readonly mutationFn: (variables: UpdateVariables<P>) => Promise<T>;
  readonly onSuccess: (
    record: T,
    variables: UpdateVariables<P>,
  ) => Promise<void>;
}

export interface DeleteMutationOptions {
  readonly mutationKey: readonly ["crud", string, "delete"];
  readonly mutationFn: (id: number) => Promise<unknown>;
  readonly onSuccess: (result: unknown, id: number) => Promise<void>;
}

/** Create: invalidate lists, stats and predict. */
export function createMutationOptions<T, C>(
  client: Invalidator,
  resource: string,
  api: CreateApi<T, C>,
): CreateMutationOptions<T, C> {
  return {
    mutationKey: ["crud", resource, "create"],
    mutationFn: (body: C) => api.create(body),
    onSuccess: () => invalidateCollections(client, resource),
  };
}

export interface UpdateVariables<P> {
  readonly id: number;
  readonly patch: P;
  /** Sent as `If-Match`; a stale one fails with 412. */
  readonly ifMatch?: string;
}

/** Update: `setQueryData` from the PATCH response, invalidate lists, stats, predict and revisions. */
export function updateMutationOptions<T, P>(
  client: Invalidator,
  resource: string,
  api: UpdateApi<T, P>,
): UpdateMutationOptions<T, P> {
  return {
    mutationKey: ["crud", resource, "update"],
    mutationFn: ({ id, patch, ifMatch }: UpdateVariables<P>) =>
      api.update(id, patch, ifMatch === undefined ? {} : { ifMatch }),
    onSuccess: async (record: T, { id }: UpdateVariables<P>) => {
      client.setQueryData(crudKeys.record(resource, id), record);
      await Promise.all([
        invalidateCollections(client, resource),
        client.invalidateQueries({
          queryKey: crudKeys.revisions(resource, id),
        }),
      ]);
    },
  };
}

/** Delete: drop the record query, invalidate lists, stats, predict and revisions. */
export function deleteMutationOptions(
  client: Invalidator,
  resource: string,
  api: DeleteApi,
): DeleteMutationOptions {
  return {
    mutationKey: ["crud", resource, "delete"],
    mutationFn: (id: number) => api.delete(id),
    onSuccess: async (_result: unknown, id: number) => {
      client.removeQueries({ queryKey: crudKeys.record(resource, id) });
      await Promise.all([
        invalidateCollections(client, resource),
        client.invalidateQueries({
          queryKey: crudKeys.revisions(resource, id),
        }),
      ]);
    },
  };
}

/**
 * Invalidate TanStack queries from the resource's event stream. Events
 * invalidate and never apply snapshots: `create` invalidates lists, stats and
 * predict; `update`/`delete`/`restore` also the record and its revisions; a
 * reconnect (or an event with no usable record id) invalidates the resource.
 * Returns the unsubscribe.
 */
export function bridgeEvents(
  client: Pick<QueryClient, "invalidateQueries">,
  hub: EventHub,
  resource: string,
): () => void {
  return hub.subscribe({
    onEvent: async (event) => {
      const pending = [
        client.invalidateQueries({ queryKey: crudKeys.lists(resource) }),
        client.invalidateQueries({ queryKey: crudKeys.stats(resource) }),
        client.invalidateQueries({ queryKey: crudKeys.predict(resource) }),
      ];
      if (event.action !== "create") {
        pending.push(
          client.invalidateQueries({
            queryKey: crudKeys.record(resource, event.recordId),
          }),
          client.invalidateQueries({
            queryKey: crudKeys.revisions(resource, event.recordId),
          }),
        );
      }
      await Promise.all(pending);
    },
    onReset: () =>
      client.invalidateQueries({ queryKey: crudKeys.resource(resource) }),
  });
}
