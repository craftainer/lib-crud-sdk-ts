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

/**
 * Who a query belongs to: the client's stable identity and the caller scope
 * (`await client.namespace()`). Two clients, or two callers, that share one
 * `QueryClient` never see each other's cached data.
 */
export interface CrudNamespace {
  readonly client: string;
  readonly scope: string;
}

/** The kinds that sit at `key[4]`. */
export type CrudKind = "list" | "record" | "stats" | "predict" | "revisions";

/** Which queries a {@link CrudKeys.filter} matches; every member narrows. */
export interface CrudKeyFilter {
  readonly client: string;
  /** Omit for every resource of the client (including manifests). */
  readonly resource?: string;
  /** Omit for every caller scope. */
  readonly scope?: string;
  /** Skips this caller scope (every other scope matches). */
  readonly exceptScope?: string;
  /** Omit for every kind. */
  readonly kinds?: readonly CrudKind[];
  /** A record id; matches only the `record` and `revisions` keys of that record. */
  readonly id?: number;
}

/** Spread into `invalidateQueries`, `removeQueries` or `cancelQueries`. */
export type CrudKeyMatcher =
  | { readonly queryKey: readonly unknown[] }
  | {
      readonly predicate: (query: {
        readonly queryKey: readonly unknown[];
      }) => boolean;
    };

/** The key factory type. */
export interface CrudKeys {
  readonly all: readonly ["crud"];
  /** Everything of one client. */
  client(client: string): readonly ["crud", string];
  /** Everything of one resource on one client, every scope and kind. */
  resource(client: string, resource: string): readonly ["crud", string, string];
  /** All lists of one resource and scope, plain and infinite. */
  lists(
    ns: CrudNamespace,
    resource: string,
  ): readonly ["crud", string, string, string, "list"];
  list(ns: CrudNamespace, resource: string, query?: CrudQuery): Key;
  infiniteList(
    ns: CrudNamespace,
    resource: string,
    query: CrudQuery,
    limit: number,
  ): Key;
  /** All record queries of one resource and scope. */
  records(
    ns: CrudNamespace,
    resource: string,
  ): readonly ["crud", string, string, string, "record"];
  record(
    ns: CrudNamespace,
    resource: string,
    id: number,
  ): readonly ["crud", string, string, string, "record", number];
  stats(ns: CrudNamespace, resource: string, query?: CrudQuery): Key;
  predict(ns: CrudNamespace, resource: string, query?: CrudQuery): Key;
  revisions(
    ns: CrudNamespace,
    resource: string,
    id: number,
  ): readonly ["crud", string, string, string, "revisions", number];
  /** The manifest of one caller scope. */
  manifest(ns: CrudNamespace): readonly ["crud", string, "_manifest", string];
  /**
   * A matcher for `invalidateQueries({ ...crudKeys.filter(f) })`. A client
   * or resource filter is one key prefix; narrowing by scope, kind or id
   * (which sit after the resource) uses a predicate.
   */
  filter(filter: CrudKeyFilter): CrudKeyMatcher;
}

/**
 * The key factory. Keys are
 * `["crud", client, resource, scope, kind, ...]` (the manifest is
 * `["crud", client, "_manifest", scope]`), so a prefix invalidates by client
 * or by resource on one client; `resource` is the manifest name, or
 * `name@apiVersion` for a pinned version (a different string is a different
 * resource: pass the same one to the invalidate helpers). `_manifest` is
 * reserved; a scope-only filter also matches the scope's manifest.
 */
export const crudKeys: CrudKeys = {
  all: ["crud"],
  client: (client) => ["crud", client],
  resource: (client, resource) => ["crud", client, resource],
  lists: (ns, resource) => ["crud", ns.client, resource, ns.scope, "list"],
  list: (ns, resource, query) =>
    query === undefined
      ? crudKeys.lists(ns, resource)
      : [...crudKeys.lists(ns, resource), query],
  infiniteList: (ns, resource, query, limit) => [
    ...crudKeys.lists(ns, resource),
    "infinite",
    query,
    limit,
  ],
  records: (ns, resource) => ["crud", ns.client, resource, ns.scope, "record"],
  record: (ns, resource, id) => [...crudKeys.records(ns, resource), id],
  stats: (ns, resource, query) =>
    query === undefined
      ? ["crud", ns.client, resource, ns.scope, "stats"]
      : ["crud", ns.client, resource, ns.scope, "stats", query],
  predict: (ns, resource, query) =>
    query === undefined
      ? ["crud", ns.client, resource, ns.scope, "predict"]
      : ["crud", ns.client, resource, ns.scope, "predict", query],
  revisions: (ns, resource, id) => [
    "crud",
    ns.client,
    resource,
    ns.scope,
    "revisions",
    id,
  ],
  manifest: (ns) => ["crud", ns.client, "_manifest", ns.scope],
  filter: (filter) => {
    const { client, resource, scope, exceptScope, kinds, id } = filter;
    if (
      scope === undefined &&
      exceptScope === undefined &&
      kinds === undefined &&
      id === undefined
    ) {
      return {
        queryKey:
          resource === undefined
            ? crudKeys.client(client)
            : crudKeys.resource(client, resource),
      };
    }
    return {
      predicate: ({ queryKey: key }) =>
        key[0] === "crud" &&
        key[1] === client &&
        (resource === undefined || key[2] === resource) &&
        (scope === undefined || key[3] === scope) &&
        (exceptScope === undefined || key[3] !== exceptScope) &&
        (kinds === undefined || kinds.includes(key[4] as CrudKind)) &&
        (id === undefined ||
          ((key[4] === "record" || key[4] === "revisions") && key[5] === id)),
    };
  },
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
  ns: CrudNamespace,
  resource: string,
  api: ListApi<T>,
  query?: CrudQuery,
  init: QueryOptionsInit = {},
): CrudQueryOptions<T[]> {
  return {
    queryKey: tag(crudKeys.list(ns, resource, query)),
    queryFn: ({ signal }) => api.list(query, { signal }),
    staleTime: init.staleTime ?? 0,
  };
}

export function recordOptions<T>(
  ns: CrudNamespace,
  resource: string,
  api: RecordApi<T>,
  id: number,
  init: QueryOptionsInit = {},
): CrudQueryOptions<T> {
  return {
    queryKey: tag(crudKeys.record(ns, resource, id)),
    queryFn: ({ signal }) => api.get(id, { signal }),
    staleTime: init.staleTime ?? 0,
  };
}

export function statsOptions<S>(
  ns: CrudNamespace,
  resource: string,
  api: StatsApi<S>,
  query?: CrudQuery,
  init: QueryOptionsInit = {},
): CrudQueryOptions<S> {
  return {
    queryKey: tag(crudKeys.stats(ns, resource, query)),
    queryFn: ({ signal }) => api.stats(query, { signal }),
    staleTime: init.staleTime ?? 0,
  };
}

export function predictOptions<P>(
  ns: CrudNamespace,
  resource: string,
  api: PredictApi<P>,
  query?: CrudQuery,
  init: QueryOptionsInit = {},
): CrudQueryOptions<P> {
  return {
    queryKey: tag(crudKeys.predict(ns, resource, query)),
    queryFn: ({ signal }) => api.predict(query, { signal }),
    staleTime: init.staleTime ?? 0,
  };
}

export function revisionsOptions<R>(
  ns: CrudNamespace,
  resource: string,
  api: RevisionsApi<R>,
  id: number,
  init: QueryOptionsInit = {},
): CrudQueryOptions<R[]> {
  return {
    queryKey: tag(crudKeys.revisions(ns, resource, id)),
    queryFn: ({ signal }) => api.revisions(id, { signal }),
    staleTime: init.staleTime ?? 0,
  };
}

export function manifestOptions<M>(
  ns: CrudNamespace,
  api: ManifestApi<M>,
  init: QueryOptionsInit = {},
): CrudQueryOptions<M> {
  return {
    queryKey: tag(crudKeys.manifest(ns)),
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
  ns: CrudNamespace,
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
      crudKeys.infiniteList(ns, resource, query, limit),
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

const COLLECTION_KINDS = ["list", "stats", "predict"] as const;

/** One resource of one client; `resource` is the string used in its keys. */
export interface CrudTarget {
  readonly client: string;
  readonly resource: string;
}

/**
 * Invalidates the list, stats and predict queries of `resource` on `client`,
 * for every caller scope (a write changes what every caller sees).
 */
export function invalidateCollections(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  { client, resource }: CrudTarget,
): Promise<void> {
  return queryClient.invalidateQueries(
    crudKeys.filter({ client, resource, kinds: COLLECTION_KINDS }),
  );
}

/** Invalidates everything cached for `resource` on `client`: one key prefix. */
export function invalidateResource(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  { client, resource }: CrudTarget,
): Promise<void> {
  return queryClient.invalidateQueries(crudKeys.filter({ client, resource }));
}

/** Invalidates one record's `record` and `revisions` queries, for every scope. */
export function invalidateRecord(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  { client, resource }: CrudTarget,
  id: number,
): Promise<void> {
  return queryClient.invalidateQueries(
    crudKeys.filter({
      client,
      resource,
      kinds: ["record", "revisions"],
      id,
    }),
  );
}

export interface CreateMutationOptions<T, C> {
  readonly mutationKey: readonly ["crud", string, string, string, "create"];
  readonly mutationFn: (body: C) => Promise<T>;
  readonly onSuccess: () => Promise<void>;
}

export interface UpdateMutationOptions<T, P> {
  readonly mutationKey: readonly ["crud", string, string, string, "update"];
  readonly mutationFn: (variables: UpdateVariables<P>) => Promise<T>;
  readonly onSuccess: (
    record: T,
    variables: UpdateVariables<P>,
  ) => Promise<void>;
}

export interface DeleteMutationOptions {
  readonly mutationKey: readonly ["crud", string, string, string, "delete"];
  readonly mutationFn: (id: number) => Promise<unknown>;
  readonly onSuccess: (result: unknown, id: number) => Promise<void>;
}

/** Create: invalidate lists, stats and predict. */
export function createMutationOptions<T, C>(
  queryClient: Invalidator,
  ns: CrudNamespace,
  resource: string,
  api: CreateApi<T, C>,
): CreateMutationOptions<T, C> {
  return {
    mutationKey: ["crud", ns.client, resource, ns.scope, "create"],
    mutationFn: (body: C) => api.create(body),
    onSuccess: () =>
      invalidateCollections(queryClient, { client: ns.client, resource }),
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
  queryClient: Invalidator,
  ns: CrudNamespace,
  resource: string,
  api: UpdateApi<T, P>,
): UpdateMutationOptions<T, P> {
  return {
    mutationKey: ["crud", ns.client, resource, ns.scope, "update"],
    mutationFn: ({ id, patch, ifMatch }: UpdateVariables<P>) =>
      api.update(id, patch, ifMatch === undefined ? {} : { ifMatch }),
    onSuccess: async (record: T, { id }: UpdateVariables<P>) => {
      queryClient.setQueryData(crudKeys.record(ns, resource, id), record);
      await Promise.all([
        invalidateCollections(queryClient, { client: ns.client, resource }),
        // The caller's own record was just set; other scopes' are stale.
        queryClient.invalidateQueries(
          crudKeys.filter({
            client: ns.client,
            resource,
            exceptScope: ns.scope,
            kinds: ["record"],
            id,
          }),
        ),
        queryClient.invalidateQueries(
          crudKeys.filter({
            client: ns.client,
            resource,
            kinds: ["revisions"],
            id,
          }),
        ),
      ]);
    },
  };
}

/** Delete: drop the record query, invalidate lists, stats, predict and revisions. */
export function deleteMutationOptions(
  queryClient: Invalidator,
  ns: CrudNamespace,
  resource: string,
  api: DeleteApi,
): DeleteMutationOptions {
  return {
    mutationKey: ["crud", ns.client, resource, ns.scope, "delete"],
    mutationFn: (id: number) => api.delete(id),
    onSuccess: async (_result: unknown, id: number) => {
      queryClient.removeQueries(
        crudKeys.filter({
          client: ns.client,
          resource,
          kinds: ["record"],
          id,
        }),
      );
      await Promise.all([
        invalidateCollections(queryClient, { client: ns.client, resource }),
        queryClient.invalidateQueries(
          crudKeys.filter({
            client: ns.client,
            resource,
            kinds: ["revisions"],
            id,
          }),
        ),
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
  queryClient: Pick<QueryClient, "invalidateQueries">,
  hub: EventHub,
  target: CrudTarget,
): () => void {
  return hub.subscribe({
    onEvent: async (event) => {
      const pending = [invalidateCollections(queryClient, target)];
      if (event.action !== "create") {
        pending.push(invalidateRecord(queryClient, target, event.recordId));
      }
      await Promise.all(pending);
    },
    onReset: () => invalidateResource(queryClient, target),
  });
}
