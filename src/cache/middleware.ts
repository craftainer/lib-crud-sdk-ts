/**
 * The caching middleware (`createCache`): an I3 `Middleware` plus the control
 * surface that events and the client use.
 *
 * It reads the resource, op, record id, API version and caller scope from
 * `RequestContext` and never touches the Authorization header. A read is
 * answered in one of four ways, see `cacheStatus`: `hit` (fresh, no
 * network), `stale` (inside the stale-while-revalidate window, refreshed in
 * the background), `revalidated` (a `304` rebuilt from the stored entry with
 * merged headers) or `miss`.
 *
 * Freshness beyond "revalidate every time" is granted only while the
 * resource's SSE stream is up (`setEventsActive`): events are the only thing
 * that can end a fresh window early. `stats` and `predict` are bounded by
 * `statsTtl` instead, as the server caches those bodies the same way. A
 * per-resource generation counter stops a response that was in flight when
 * an invalidation landed from being stored fresh.
 */
import type {
  CacheEntry,
  MaybePromise,
  CacheStore,
  Middleware,
  Next,
  RequestContext,
} from "../interfaces.ts";
import {
  buildEntry,
  cacheControl,
  isJson,
  mergeHeaders,
  tagStatus,
  toResponse,
  varyAllowsCaching,
} from "./entry.ts";
import {
  buildKey,
  collectionPrefixes,
  eventPrefixes,
  isCacheKind,
  isStatsKind,
  kindPrefix,
  manifestKey,
  recordPrefix,
  resourcePrefixes,
  revisionsPrefix,
} from "./keys.ts";
import type { CacheKind } from "./keys.ts";
import { cachePolicyFromManifest } from "./policy.ts";
import { credentialScope } from "./scope.ts";
import type { CachePolicy } from "./policy.ts";

/**
 * A store may clear several prefixes in one pass (one walk, one transaction);
 * the cache uses it when present and falls back to `clear` per prefix.
 */
export interface CacheStoreMany extends CacheStore {
  clearMany?(prefixes: readonly string[]): MaybePromise<void>;
}

export interface CacheOptions {
  readonly store: CacheStoreMany;
  /**
   * Policy per manifest resource: `name@apiVersion` (built from that version's
   * manifest entry) or, for every version, plain `name`. A resource without
   * one is not cached. The event stream and the freshness gate are per name.
   */
  readonly policies: Readonly<Record<string, CachePolicy>>;
  /** Cache the manifest document per caller scope. Default `true`. */
  readonly cacheManifest?: boolean;
  /** Epoch milliseconds; injectable for tests. */
  readonly now?: () => number;
}

export interface Cache {
  /** Put it in the client's middleware chain. */
  readonly middleware: Middleware;
  /** Record whether the SSE stream of `resource` is connected (gates fresh hits). */
  setEventsActive(resource: string, active: boolean): void;
  eventsActive(resource: string): boolean;
  /** Clear what an SSE event makes stale, in every API version. */
  invalidateEvent(
    resource: string,
    action: string,
    recordId: number | undefined,
  ): Promise<void>;
  /** Clear everything cached for `resource` except `filters` (after a reconnect). */
  clearResource(resource: string): Promise<void>;
  /** Clear keys under `prefix` (everything the store owns when omitted). */
  clear(prefix?: string): Promise<void>;
  /**
   * Adds `If-Match` from the cached record ETag to `PATCH`/`DELETE ?id=` that
   * have none. Put it innermost, next to `middleware`, so it sees the same
   * Authorization (and so scope) the request is sent with.
   */
  readonly autoIfMatch: Middleware;
  /** The stored ETag of a record of one API version, for `auto_if_match`. */
  cachedEtag(
    resource: string,
    recordId: number,
    scope: string,
    apiVersion: string | null,
  ): Promise<string | undefined>;
  /** Abort background revalidations and wait for them. */
  close(): Promise<void>;
}

type Kind = CacheKind | "manifest";
type Decision = "hit" | "stale" | "revalidate" | "miss";
type StoreOp =
  | { readonly type: "clear"; readonly prefixes: readonly string[] }
  | {
      readonly type: "set";
      readonly key: string;
      readonly entry: CacheEntry;
      readonly ttlMs: number;
    }
  | { readonly type: "delete"; readonly key: string };

/** What `begin` learned about one request. */
interface State {
  readonly ctx: RequestContext;
  readonly policy: CachePolicy;
  /** The cache kind of a read; `undefined` for a write. */
  readonly kind: Kind | undefined;
  readonly key: string | undefined;
  /** The resource's invalidation count when the request was made. */
  readonly generation: number;
  /** From the Authorization header of the request as the cache sees it. */
  readonly scope: string;
  readonly forceRevalidate: boolean;
  entry?: CacheEntry | undefined;
  /** Whether we put `If-None-Match` on the request. */
  validated?: boolean;
}

const MIN_RETENTION_MS = 3_600_000;
const MANIFEST_POLICY: CachePolicy = cachePolicyFromManifest({});
const WRITE_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PATCH",
  "PUT",
  "DELETE",
]);
const BULK_OPS: ReadonlySet<string> = new Set(["bulk_update", "bulk_delete"]);
const RECORD_WRITES: ReadonlySet<string> = new Set([
  "delete",
  "publish",
  "restore",
]);
const CREATES: ReadonlySet<string> = new Set(["create", "clone", "draft"]);

function isStorable(response: Response): boolean {
  return (
    isJson(response) &&
    !cacheControl(response.headers).has("no-store") &&
    varyAllowsCaching(response)
  );
}

function retentionMs(freshMs: number, staleMs: number): number {
  return Math.max(freshMs + staleMs, MIN_RETENTION_MS);
}

/** The ids of a bulk response (`{matched, ids}`), or `undefined` if unreadable. */
function idsFromBody(body: string): number[] | undefined {
  try {
    const ids = (JSON.parse(body) as { ids?: unknown }).ids;
    return Array.isArray(ids) && ids.every((id) => Number.isInteger(id))
      ? (ids as number[])
      : undefined;
  } catch {
    return undefined;
  }
}

/** The resource names in a manifest document, or none if unreadable. */
function manifestResources(body: string): string[] {
  try {
    const resources = (JSON.parse(body) as { resources?: unknown }).resources;
    return Array.isArray(resources)
      ? resources
          .map((item: { name?: unknown }) => item.name)
          .filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
}

async function safe<T>(call: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await call();
  } catch {
    return undefined; // a failing store is a miss, never a failed request
  }
}

export function createCache(options: CacheOptions): Cache {
  const { store } = options;
  const policies = new Map(Object.entries(options.policies));
  const policyFor = (
    resource: string | undefined,
    apiVersion: string | null,
  ): CachePolicy | undefined =>
    resource === undefined
      ? undefined
      : (policies.get(`${resource}@${apiVersion}`) ?? policies.get(resource));
  const cacheManifest = options.cacheManifest ?? true;
  const now = options.now ?? Date.now;
  const eventsActive = new Set<string>();
  const generations = new Map<string, number>();
  const inflight = new Set<string>();
  const tasks = new Set<Promise<void>>();
  const background = new AbortController();

  let globalGeneration = 0; // bumped by `clear`, which may span resources
  const generation = (resource: string | undefined): number =>
    (generations.get(resource ?? "") ?? 0) + globalGeneration;
  const bump = (resource: string): void => {
    generations.set(resource, generation(resource) + 1);
  };

  // -- freshness ---------------------------------------------------------------

  /**
   * Whether an entry of `kind` may be served without the network right now:
   * only while the stream is up, except `stats`/`predict`, which `stats_ttl`
   * bounds on its own. Never `filters` (events never clear them) or the manifest.
   */
  const gateOpen = (
    policy: CachePolicy,
    resource: string | undefined,
    kind: Kind,
  ): boolean =>
    !policy.revalidateOnly &&
    kind !== "manifest" &&
    kind !== "filters" &&
    (isStatsKind(kind) || eventsActive.has(resource as string));

  /** Stale-while-revalidate needs the stream for every kind, stats and predict included. */
  const staleOpen = (
    policy: CachePolicy,
    resource: string | undefined,
    kind: Kind,
  ): boolean =>
    gateOpen(policy, resource, kind) && eventsActive.has(resource as string);

  /** Milliseconds fresh and of stale-while-revalidate for a new entry; none if the response may predate an invalidation. */
  const entryTimes = (
    state: State,
    kind: Kind,
  ): { fresh: number; stale: number } => {
    const resource = state.ctx.resource;
    if (
      generation(resource) !== state.generation ||
      !gateOpen(state.policy, resource, kind)
    ) {
      return { fresh: 0, stale: 0 };
    }
    const fresh = isStatsKind(kind)
      ? state.policy.statsTtl
      : state.policy.maxAge;
    return {
      fresh: fresh * 1000,
      stale: staleOpen(state.policy, resource, kind)
        ? state.policy.staleWhileRevalidate * 1000
        : 0,
    };
  };

  const decide = (state: State, entry: CacheEntry | undefined): Decision => {
    if (entry === undefined) {
      return "miss";
    }
    if (
      !state.forceRevalidate &&
      gateOpen(state.policy, state.ctx.resource, state.kind as Kind)
    ) {
      const at = now();
      if (at < entry.freshUntil) {
        return "hit";
      }
      if (
        at < entry.staleUntil &&
        staleOpen(state.policy, state.ctx.resource, state.kind as Kind)
      ) {
        return "stale";
      }
    }
    return entry.etag !== undefined && state.policy.etag
      ? "revalidate"
      : "miss";
  };

  // -- request side ------------------------------------------------------------

  const begin = async (ctx: RequestContext): Promise<State | undefined> => {
    const { request, resource } = ctx;
    const scope = await credentialScope(request.headers);
    const generationNow = generation(resource);
    if (request.method !== "GET") {
      if (!WRITE_METHODS.has(request.method)) {
        return undefined; // HEAD, OPTIONS and the like change nothing
      }
      const policy = policyFor(resource, ctx.apiVersion);
      return policy?.enabled === true
        ? {
            ctx,
            policy,
            kind: undefined,
            key: undefined,
            generation: generationNow,
            scope,
            forceRevalidate: false,
          }
        : undefined;
    }
    let policy: CachePolicy | undefined;
    let kind: Kind;
    let key: string;
    if (ctx.op === "manifest") {
      if (!cacheManifest) {
        return undefined;
      }
      policy = MANIFEST_POLICY;
      kind = "manifest";
      key = manifestKey(scope);
    } else {
      policy = policyFor(resource, ctx.apiVersion);
      if (
        resource === undefined ||
        policy?.enabled !== true ||
        !isCacheKind(ctx.op)
      ) {
        return undefined;
      }
      kind = ctx.op;
      key = buildKey({
        resource,
        kind,
        recordId: ctx.recordId,
        scope,
        query: new URL(request.url).search,
        apiVersion: ctx.apiVersion,
      });
    }
    const control = cacheControl(request.headers);
    if (control.has("no-store") || request.headers.has("if-none-match")) {
      return undefined; // the caller forbids storing or manages validators itself
    }
    return {
      ctx,
      policy,
      kind,
      key,
      generation: generationNow,
      scope,
      forceRevalidate: control.has("no-cache"),
    };
  };

  /** A copy of `ctx` whose request carries our validator (a `GET` has no body to lose). */
  const withValidator = (ctx: RequestContext, etag: string): RequestContext => {
    const headers = new Headers(ctx.request.headers);
    headers.set("if-none-match", etag);
    return { ...ctx, request: new Request(ctx.request, { headers }) };
  };

  // -- response side -----------------------------------------------------------

  const readBody = async (
    state: State,
    response: Response,
  ): Promise<string | undefined> => {
    const { status } = response;
    const { op, recordId } = state.ctx;
    let wanted: boolean;
    if (state.kind !== undefined) {
      wanted = status === 200 && isStorable(response);
    } else if (op === "update") {
      wanted = status === 200 && recordId !== undefined && isStorable(response);
    } else {
      wanted =
        status >= 200 &&
        status < 300 &&
        (BULK_OPS.has(op) || (op === "restore" && recordId === undefined));
    }
    return wanted ? response.clone().text() : undefined;
  };

  /** One clear op for all `prefixes`: the store clears them in a single pass. */
  const clears = (prefixes: readonly string[]): StoreOp[] => [
    { type: "clear", prefixes },
  ];

  const manifestOps = (
    old: CacheEntry | undefined,
    entry: CacheEntry,
  ): StoreOp[] => {
    if (
      old === undefined ||
      (old.etag !== undefined && old.etag === entry.etag)
    ) {
      return [];
    }
    const names = new Set([
      ...[...policies.keys()].map((key) => key.replace(/@[^@]*$/, "")),
      ...manifestResources(old.body),
      ...manifestResources(entry.body),
    ]);
    return clears([...names].sort().map((name) => kindPrefix(name, "filters")));
  };

  const readPlan = (
    state: State,
    response: Response,
    body: string | undefined,
  ): { result: Response; ops: StoreOp[] } => {
    const key = state.key as string;
    const kind = state.kind as Kind;
    const { status } = response;
    const at = now();
    const { fresh, stale } = entryTimes(state, kind);
    const old = state.entry;
    if (status === 304 && state.validated === true && old !== undefined) {
      // `validated` means the request carried `old.etag`.
      const updated: CacheEntry = {
        ...old,
        headers: mergeHeaders(old.headers, response.headers),
        storedAt: at,
        freshUntil: at + fresh,
        staleUntil: at + fresh + stale,
        etag: response.headers.get("etag") ?? (old.etag as string),
      };
      return {
        result: toResponse(updated, "revalidated"),
        ops: [
          {
            type: "set",
            key,
            entry: updated,
            ttlMs: retentionMs(fresh, stale),
          },
        ],
      };
    }
    if (status === 200 && body !== undefined) {
      tagStatus(response, "miss");
      const entry = buildEntry(
        response,
        body,
        { now: at, fresh, stale },
        state.policy.etag,
      );
      if (entry.etag === undefined && fresh <= 0) {
        // No validator and never fresh: drop the old entry.
        return { result: response, ops: [{ type: "delete", key }] };
      }
      const ops: StoreOp[] = [
        { type: "set", key, entry, ttlMs: retentionMs(fresh, stale) },
      ];
      if (kind === "manifest") {
        ops.push(...manifestOps(old, entry));
      }
      return { result: response, ops };
    }
    if (status === 200 || status === 404 || status === 410) {
      return { result: response, ops: [{ type: "delete", key }] };
    }
    return { result: response, ops: [] };
  };

  /** Store the PATCH response as the record's entry (it is the read view plus ETag). */
  const writeThrough = (
    state: State,
    response: Response,
    body: string | undefined,
    resource: string,
    recordId: number,
  ): StoreOp[] => {
    if (body === undefined) {
      return [];
    }
    const { fresh, stale } = entryTimes(state, "record");
    const entry = buildEntry(
      response,
      body,
      { now: now(), fresh, stale },
      state.policy.etag,
    );
    if (entry.etag === undefined && fresh <= 0) {
      return [];
    }
    const key = buildKey({
      resource,
      kind: "record",
      recordId,
      scope: state.scope,
      apiVersion: state.ctx.apiVersion,
    });
    return [{ type: "set", key, entry, ttlMs: retentionMs(fresh, stale) }];
  };

  /**
   * The store changes a write calls for. `response` is `undefined` when the
   * request threw: like a `5xx`, the outcome is unknown (the server may have
   * applied the write before the failure), so it clears what a success would
   * have, minus the write-through, and for a bulk op the whole resource (the
   * ids are unknown). Other failures changed nothing.
   */
  const writeOps = (
    state: State,
    response: Response | undefined,
    body: string | undefined,
  ): StoreOp[] => {
    const { op, recordId } = state.ctx;
    const resource = state.ctx.resource as string;
    const status = response?.status;
    if (status === 412) {
      return recordId === undefined
        ? []
        : clears([recordPrefix(resource, recordId)]);
    }
    const ok = status !== undefined && status >= 200 && status < 300;
    if (!ok && status !== undefined && status < 500) {
      return []; // refused: nothing changed
    }
    const collections = collectionPrefixes(resource);
    if (CREATES.has(op)) {
      return clears(collections);
    }
    if (recordId !== undefined && (RECORD_WRITES.has(op) || op === "update")) {
      return [
        ...clears([
          ...collections,
          revisionsPrefix(resource, recordId),
          recordPrefix(resource, recordId),
        ]),
        ...(op === "update" && response !== undefined && ok
          ? writeThrough(state, response, body, resource, recordId)
          : []),
      ];
    }
    if (ok && (BULK_OPS.has(op) || op === "restore")) {
      // Bulk ops and a bulk restore always have their body read (see `readBody`).
      const ids = idsFromBody(body as string);
      if (ids !== undefined) {
        return clears([
          ...collections,
          ...ids.flatMap((id) => [
            recordPrefix(resource, id),
            revisionsPrefix(resource, id),
          ]),
        ]);
      }
    }
    return clears(resourcePrefixes(resource));
  };

  /** One pass when the store can, else one `clear` per prefix; a failure is a miss. */
  const clearPrefixes = async (prefixes: readonly string[]): Promise<void> => {
    if (store.clearMany !== undefined) {
      await safe(() => store.clearMany?.(prefixes));
      return;
    }
    for (const prefix of prefixes) {
      await safe(() => store.clear(prefix));
    }
  };

  const apply = async (op: StoreOp): Promise<void> => {
    await safe(() =>
      op.type === "clear"
        ? clearPrefixes(op.prefixes)
        : op.type === "set"
          ? store.set(op.key, op.entry, op.ttlMs)
          : store.delete(op.key),
    );
  };

  /** Plan, then apply, the store changes a response calls for. */
  const finish = async (
    state: State,
    response: Response,
  ): Promise<Response> => {
    const body = await readBody(state, response);
    const { result, ops } =
      state.kind === undefined
        ? { result: response, ops: writeOps(state, response, body) }
        : readPlan(state, response, body);
    await applyOps(state, ops);
    return result;
  };

  /** Apply `ops`, guarding against an invalidation that lands meanwhile. */
  const applyOps = async (
    state: State,
    ops: readonly StoreOp[],
  ): Promise<void> => {
    if (state.kind === undefined && ops.some((op) => op.type === "clear")) {
      bump(state.ctx.resource as string); // before applying: reads now in flight must not store fresh
    }
    const expected = generation(state.ctx.resource);
    for (const op of ops) {
      await apply(op);
    }
    if (generation(state.ctx.resource) !== expected) {
      // An invalidation landed while storing: drop what was just stored.
      for (const op of ops.filter((candidate) => candidate.type === "set")) {
        await apply({ type: "delete", key: op.key });
      }
    }
  };

  // -- stale-while-revalidate --------------------------------------------------

  const schedule = (state: State, next: Next): void => {
    const key = state.key as string;
    if (background.signal.aborted || inflight.has(key)) {
      return;
    }
    inflight.add(key);
    const entry = state.entry as CacheEntry;
    const task = (async (): Promise<void> => {
      try {
        const signal = background.signal;
        const headers = new Headers(state.ctx.request.headers);
        if (entry.etag !== undefined) {
          headers.set("if-none-match", entry.etag);
        }
        // Detached from the caller's signal: this outlives their request.
        const request = new Request(state.ctx.request.url, {
          method: "GET",
          headers,
          signal,
        });
        const fresh: State = {
          ...state,
          validated: entry.etag !== undefined,
        };
        const response = await next({ ...state.ctx, request, signal });
        const result = await finish(fresh, response);
        await result.body?.cancel();
      } catch {
        // Nothing to report to: the caller already has the stale answer.
      } finally {
        inflight.delete(key);
      }
    })();
    tasks.add(task);
    void task.then(() => tasks.delete(task));
  };

  // -- the middleware ----------------------------------------------------------

  const middleware: Middleware = async (ctx, next) => {
    const state = await begin(ctx);
    if (state === undefined) {
      return next(ctx);
    }
    if (state.kind === undefined) {
      const unsent = ctx.request.signal.aborted; // aborted mid-flight is unknown, not unsent
      let response: Response;
      try {
        response = await next(ctx);
      } catch (error) {
        // The write may have been applied before it failed: forget what it
        // touches, unless it was aborted before it could be sent. The
        // caller still gets the original error.
        if (!unsent) {
          await safe(() =>
            applyOps(state, writeOps(state, undefined, undefined)),
          );
        }
        throw error;
      }
      return finish(state, response);
    }
    state.entry = await safe(() => store.get(state.key as string));
    const decision = decide(state, state.entry);
    const entry = state.entry as CacheEntry;
    if (decision === "hit") {
      return toResponse(entry, "hit");
    }
    if (decision === "stale") {
      schedule(state, next);
      return toResponse(entry, "stale");
    }
    let sent = ctx;
    if (decision === "revalidate") {
      sent = withValidator(ctx, entry.etag as string);
      state.validated = true;
    }
    return finish(state, await next(sent));
  };

  // -- control surface ---------------------------------------------------------

  const autoIfMatch: Middleware = async (ctx, next) => {
    const { request, resource, recordId } = ctx;
    if (
      (ctx.op === "update" || ctx.op === "delete") &&
      recordId !== undefined &&
      resource !== undefined &&
      policyFor(resource, ctx.apiVersion)?.enabled === true &&
      !request.headers.has("if-match")
    ) {
      const etag = await lookupEtag(
        resource,
        recordId,
        await credentialScope(request.headers),
        ctx.apiVersion,
      );
      if (etag !== undefined) {
        const headers = new Headers(request.headers);
        headers.set("if-match", etag);
        return next({ ...ctx, request: new Request(request, { headers }) });
      }
    }
    return next(ctx);
  };

  const lookupEtag = async (
    resource: string,
    recordId: number,
    scope: string,
    apiVersion: string | null,
  ): Promise<string | undefined> => {
    const entry = await safe(() =>
      store.get(
        buildKey({ resource, kind: "record", recordId, scope, apiVersion }),
      ),
    );
    return entry?.etag;
  };

  return {
    middleware,
    autoIfMatch,
    setEventsActive(resource, active) {
      if (active) {
        eventsActive.add(resource);
      } else {
        eventsActive.delete(resource);
      }
    },
    eventsActive: (resource) => eventsActive.has(resource),
    async invalidateEvent(resource, action, recordId) {
      bump(resource);
      await clearPrefixes(eventPrefixes(resource, action, recordId));
    },
    async clearResource(resource) {
      bump(resource);
      await clearPrefixes(resourcePrefixes(resource));
    },
    async clear(prefix) {
      globalGeneration += 1; // reads in flight must not store fresh over the clear
      await safe(() => store.clear(prefix));
    },
    cachedEtag: lookupEtag,
    async close() {
      background.abort();
      await Promise.allSettled(tasks);
    },
  };
}
