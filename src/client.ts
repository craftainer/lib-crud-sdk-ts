/** Fetch client: manifest-driven resource handles over a middleware chain. */
import { cacheScope as tokenScope, isInsecureRemote } from "./auth.ts";
import {
  CapabilityError,
  ClientError,
  ConnectionFailed,
  InsecureTransportError,
  InvalidQueryError,
  ManifestError,
  ResponseError,
  UnknownResourceError,
  problemFromResponse,
} from "./errors.ts";
import { composeMiddleware } from "./interfaces.ts";
import type { Middleware, Op, TokenProvider } from "./interfaces.ts";
import { findResource, loadManifest } from "./manifest.ts";
import type { JsonObject, Manifest, Resource } from "./manifest.ts";
import { buildQuery, encodeParams } from "./query.ts";
import type { Filters, QueryParams, Sort } from "./query.ts";

/** Per-call options. */
export interface RequestOptions {
  readonly signal?: AbortSignal | undefined;
}

/**
 * Options of `list` and `iterAll`. `onlyArchived: true` returns only archived
 * rows (it implies `includeArchived`; with `includeArchived: false` the call
 * throws `InvalidQueryError` before any request). Non-archivable resources
 * ignore it.
 */
export interface ListOptions extends RequestOptions {
  readonly filters?: Filters | undefined;
  readonly sort?: Sort | undefined;
  readonly skip?: number | undefined;
  readonly limit?: number | undefined;
  readonly includeArchived?: boolean | undefined;
  readonly onlyArchived?: boolean | undefined;
  readonly includeUnpublished?: boolean | undefined;
}

/** Options of `update` and `delete`: `ifMatch` is an ETag (`412` when stale). */
export interface WriteOptions extends RequestOptions {
  readonly ifMatch?: string | undefined;
}

/** Options of `deleteMany`. */
export interface DeleteManyOptions extends RequestOptions {
  readonly includeUnpublished?: boolean | undefined;
}

/** Options of `stats`. There is no `onlyArchived` (the server rejects it on `/stats`). */
export interface StatsOptions extends RequestOptions {
  readonly bucket?: string | undefined;
  readonly includeArchived?: boolean | undefined;
  readonly includeUnpublished?: boolean | undefined;
}

/** Options of `predict`. */
export interface PredictOptions extends RequestOptions {
  readonly field?: string | undefined;
  readonly periods?: number | undefined;
  readonly bucket?: string | undefined;
}

/** Options of `restore`: exactly one of `id` and `filters`. */
export interface RestoreOptions extends RequestOptions {
  readonly id?: number | undefined;
  readonly filters?: Filters | undefined;
}

/** The result of a bulk call. */
export interface BulkResult {
  readonly matched: number;
  readonly ids: readonly number[];
}

export interface Call {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly url: string;
  readonly op: Op;
  readonly resource: string | undefined;
  readonly recordId: number | undefined;
  readonly apiVersion: string | null;
  readonly json?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** What a {@link ResourceClient} needs from its client. */
export interface Transport {
  json(call: Call, signal: AbortSignal | undefined): Promise<unknown>;
  none(call: Call, signal: AbortSignal | undefined): Promise<void>;
}

/**
 * The origins of `allowedOrigins`, normalised (`https://a.example:443` and
 * `https://a.example` are one). Anything that is not an http(s) origin is a
 * configuration error.
 */
function normalizeOrigins(origins: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const value of origins) {
    let origin: string | undefined;
    try {
      const url = new URL(value);
      origin =
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.origin !== "null"
          ? url.origin
          : undefined;
    } catch {
      origin = undefined;
    }
    if (origin === undefined) {
      throw new ClientError(
        `allowedOrigins entry "${value}" is not an http(s) origin`,
      );
    }
    out.add(origin);
  }
  return out;
}

/** Builds the requests of one resource. */
class Plan {
  readonly #baseUrl: string;
  readonly #origins: ReadonlySet<string>;
  readonly resource: Resource;

  constructor(
    baseUrl: string,
    resource: Resource,
    allowedOrigins: ReadonlySet<string>,
  ) {
    this.#baseUrl = baseUrl;
    this.#origins = new Set([...allowedOrigins, new URL(baseUrl).origin]);
    this.resource = resource;
  }

  /**
   * Resolves a manifest-supplied path against `baseUrl`. The client sends its
   * bearer token there, so a path that leaves baseUrl's origin (an absolute
   * URL or a protocol-relative `//host`) is refused unless the client lists
   * that origin in `allowedOrigins`.
   */
  #url(path: string): string {
    const url = new URL(path, this.#baseUrl);
    if (!this.#origins.has(url.origin)) {
      throw new ManifestError(
        `resource "${this.resource.name}": the manifest path "${path}" points at another origin (${url.origin}), ` +
          "where the token would follow; pass allowedOrigins to the client to allow it",
      );
    }
    return url.href;
  }

  #call(
    method: Call["method"],
    op: Op,
    path: string,
    query = "",
    extra: {
      recordId?: number | undefined;
      json?: unknown;
      ifMatch?: string | undefined;
    } = {},
  ): Call {
    const url = this.#url(path) + (query === "" ? "" : `?${query}`);
    return {
      method,
      url,
      op,
      resource: this.resource.name,
      recordId: extra.recordId,
      apiVersion: this.resource.api_version,
      ...(extra.json === undefined ? {} : { json: extra.json }),
      ...(extra.ifMatch === undefined
        ? {}
        : { headers: { "If-Match": extra.ifMatch } }),
    };
  }

  #query(params: QueryParams = {}): string {
    const paging = this.resource.pagination;
    return buildQuery(this.resource.fields, {
      maxLimit: paging.max_limit,
      skipParam: paging.skip_param,
      limitParam: paging.limit_param,
      sortParam: paging.sort_param,
      ...params,
    });
  }

  #subPath(key: string, supported: boolean): string {
    const path = this.resource.paths[key];
    if (!supported || path === undefined) {
      throw new CapabilityError(
        `resource "${this.resource.name}" does not support ${key}`,
      );
    }
    return path;
  }

  #need(supported: boolean, what: string): void {
    if (!supported) {
      throw new CapabilityError(
        `resource "${this.resource.name}" does not support ${what}`,
      );
    }
  }

  #bulkFilters(
    filters: Filters,
    includeUnpublished?: boolean | undefined,
  ): string {
    if (Object.keys(filters).length === 0) {
      throw new InvalidQueryError("a bulk operation needs at least one filter");
    }
    return this.#query({ filters, includeUnpublished });
  }

  get #base(): string {
    return this.resource.base_path;
  }

  eventsUrl(): string {
    const events = this.resource.capabilities.events;
    if (events === null) {
      throw new CapabilityError(
        `resource "${this.resource.name}" does not support events`,
      );
    }
    return this.#url(events.path);
  }

  list(o: ListOptions): Call {
    const query = this.#query({
      filters: o.filters,
      sort: o.sort,
      skip: o.skip,
      limit: o.limit,
      includeArchived: o.includeArchived,
      onlyArchived: o.onlyArchived,
      includeUnpublished: o.includeUnpublished,
    });
    return this.#call("GET", "list", this.#base, query);
  }

  get(id: number): Call {
    return this.#call(
      "GET",
      "record",
      this.#base,
      this.#query({ recordId: id }),
      {
        recordId: id,
      },
    );
  }

  create(data: unknown): Call {
    return this.#call("POST", "create", this.#base, "", { json: data });
  }

  update(id: number, data: unknown, ifMatch: string | undefined): Call {
    return this.#call(
      "PATCH",
      "update",
      this.#base,
      this.#query({ recordId: id }),
      {
        recordId: id,
        json: data,
        ifMatch,
      },
    );
  }

  updateMany(filters: Filters, data: unknown): Call {
    this.#need(this.resource.capabilities.bulk_update, "bulk_update");
    return this.#call(
      "PATCH",
      "bulk_update",
      this.#base,
      this.#bulkFilters(filters),
      {
        json: data,
      },
    );
  }

  delete(id: number, ifMatch: string | undefined): Call {
    return this.#call(
      "DELETE",
      "delete",
      this.#base,
      this.#query({ recordId: id }),
      {
        recordId: id,
        ifMatch,
      },
    );
  }

  deleteMany(filters: Filters, includeUnpublished?: boolean | undefined): Call {
    this.#need(this.resource.capabilities.bulk_delete, "bulk_delete");
    return this.#call(
      "DELETE",
      "bulk_delete",
      this.#base,
      this.#bulkFilters(filters, includeUnpublished),
    );
  }

  restore(id: number | undefined, filters: Filters | undefined): Call {
    const path = this.#subPath(
      "restore",
      this.resource.capabilities.archive_restore,
    );
    if ((id === undefined) === (filters === undefined)) {
      throw new InvalidQueryError(
        "restore takes exactly one of id and filters",
      );
    }
    const query =
      filters === undefined
        ? this.#query({ recordId: id })
        : this.#bulkFilters(filters);
    return this.#call("POST", "restore", path, query, { recordId: id });
  }

  stats(o: StatsOptions): Call {
    const path = this.#subPath("stats", this.resource.capabilities.stats);
    const pairs: [string, string][] =
      o.bucket === undefined ? [] : [["bucket", o.bucket]];
    if (o.includeArchived !== undefined) {
      pairs.push(["include_archived", String(o.includeArchived)]);
    }
    if (o.includeUnpublished !== undefined) {
      pairs.push(["include_unpublished", String(o.includeUnpublished)]);
    }
    return this.#call("GET", "stats", path, encodeParams(pairs));
  }

  predict(o: PredictOptions): Call {
    const path = this.#subPath("predict", this.resource.capabilities.predict);
    const pairs: [string, string][] = [];
    if (o.field !== undefined) {
      const spec = this.resource.fields.find((f) => f.name === o.field);
      if (spec === undefined || !spec.numeric) {
        throw new InvalidQueryError(
          `cannot predict "${o.field}": not a numeric field`,
        );
      }
      pairs.push(["field", o.field]);
    }
    if (o.periods !== undefined) {
      if (!Number.isSafeInteger(o.periods) || o.periods < 1) {
        throw new InvalidQueryError("periods must be an integer >= 1");
      }
      pairs.push(["periods", String(o.periods)]);
    }
    if (o.bucket !== undefined) {
      pairs.push(["bucket", o.bucket]);
    }
    return this.#call("GET", "predict", path, encodeParams(pairs));
  }

  clone(id: number): Call {
    const path = this.#subPath("clone", this.resource.capabilities.clone);
    return this.#call("POST", "clone", path, this.#query({ recordId: id }), {
      recordId: id,
    });
  }

  draft(data: unknown): Call {
    const path = this.#subPath(
      "draft",
      this.resource.capabilities.draft_publish,
    );
    return this.#call("POST", "draft", path, "", { json: data });
  }

  publish(id: number): Call {
    const path = this.#subPath(
      "publish",
      this.resource.capabilities.draft_publish,
    );
    return this.#call("POST", "publish", path, this.#query({ recordId: id }), {
      recordId: id,
    });
  }

  filters(): Call {
    return this.#call("GET", "filters", this.#subPath("filters", true));
  }

  revisions(id: number): Call {
    const path = this.#subPath(
      "revisions",
      this.resource.capabilities.revisions,
    );
    return this.#call("GET", "revisions", path, this.#query({ recordId: id }), {
      recordId: id,
    });
  }
}

/**
 * Operations on one resource. The type parameters are the record views;
 * `crud-sdk-codegen` writes interfaces to pass for them (they are not
 * checked against the manifest at runtime).
 */
export class ResourceClient<
  Read extends object = JsonObject,
  Create extends object = JsonObject,
  Update extends object = JsonObject,
> {
  /** The manifest entry this handle is bound to. */
  readonly resource: Resource;
  readonly #plan: Plan;
  readonly #transport: Transport;

  /** Use `CrudClient.resource`. */
  constructor(
    baseUrl: string,
    resource: Resource,
    transport: Transport,
    allowedOrigins: readonly string[] = [],
  ) {
    this.resource = resource;
    this.#plan = new Plan(baseUrl, resource, normalizeOrigins(allowedOrigins));
    this.#transport = transport;
  }

  async #one<T>(call: Call, options: RequestOptions): Promise<T> {
    const body = await this.#transport.json(call, options.signal);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new ResponseError(
        `${call.method} ${call.url}: expected a JSON object, got ${shapeOf(body)}`,
      );
    }
    return body as T;
  }

  async #many<T>(call: Call, options: RequestOptions): Promise<T[]> {
    const body = await this.#transport.json(call, options.signal);
    if (!Array.isArray(body)) {
      throw new ResponseError(
        `${call.method} ${call.url}: expected a JSON array, got ${shapeOf(body)}`,
      );
    }
    return body as T[];
  }

  /** One page of records. */
  async list(options: ListOptions = {}): Promise<Read[]> {
    return this.#many(this.#plan.list(options), options);
  }

  /** Every record, paging with `skip += limit` until a page shorter than `limit`. */
  async *iterAll(
    options: ListOptions = {},
  ): AsyncGenerator<Read, void, undefined> {
    const { default_limit: fallback, max_limit: cap } =
      this.resource.pagination;
    const size = options.limit ?? Math.min(fallback, cap);
    let skip = options.skip ?? 0;
    for (;;) {
      const page = await this.list({ ...options, skip, limit: size });
      yield* page;
      if (page.length < size) {
        return;
      }
      skip += size;
    }
  }

  /** One record. */
  async get(id: number, options: RequestOptions = {}): Promise<Read> {
    return this.#one(this.#plan.get(id), options);
  }

  /** Creates a record. */
  async create(data: Create, options: RequestOptions = {}): Promise<Read> {
    return this.#one(this.#plan.create(data), options);
  }

  /** Patches one record; `ifMatch` is an ETag (`412` when stale). */
  async update(
    id: number,
    data: Update,
    options: WriteOptions = {},
  ): Promise<Read> {
    return this.#one(this.#plan.update(id, data, options.ifMatch), options);
  }

  /** Patches every record matching `filters`. */
  async updateMany(
    filters: Filters,
    data: Update,
    options: RequestOptions = {},
  ): Promise<BulkResult> {
    return this.#one(this.#plan.updateMany(filters, data), options);
  }

  /** Deletes one record; `ifMatch` as for `update`. */
  async delete(id: number, options: WriteOptions = {}): Promise<void> {
    await this.#transport.none(
      this.#plan.delete(id, options.ifMatch),
      options.signal,
    );
  }

  /**
   * Deletes every record matching `filters`. `includeUnpublished: false`
   * leaves not-yet/no-longer-published rows alone; it is sent only when
   * given (needs a server with the BD1 bulk-delete support, older ones ignore it).
   */
  async deleteMany(
    filters: Filters,
    options: DeleteManyOptions = {},
  ): Promise<BulkResult> {
    return this.#one(
      this.#plan.deleteMany(filters, options.includeUnpublished),
      options,
    );
  }

  /** Restores archived records, by `id` or by `filters`. */
  async restore(options: RestoreOptions): Promise<BulkResult> {
    return this.#one(this.#plan.restore(options.id, options.filters), options);
  }

  /** Aggregates over the resource. */
  async stats(options: StatsOptions = {}): Promise<JsonObject> {
    return this.#one(this.#plan.stats(options), options);
  }

  /** A forecast. */
  async predict(options: PredictOptions = {}): Promise<JsonObject> {
    return this.#one(this.#plan.predict(options), options);
  }

  /** Copies a record; returns the copy. */
  async clone(id: number, options: RequestOptions = {}): Promise<Read> {
    return this.#one(this.#plan.clone(id), options);
  }

  /** Creates a draft (needs `draft_publish`). */
  async createDraft(data: Create, options: RequestOptions = {}): Promise<Read> {
    return this.#one(this.#plan.draft(data), options);
  }

  /** Publishes a draft (needs `draft_publish`). */
  async publish(id: number, options: RequestOptions = {}): Promise<Read> {
    return this.#one(this.#plan.publish(id), options);
  }

  /** The server's filter metadata (`kind` instead of `value_type`). */
  async filters(options: RequestOptions = {}): Promise<JsonObject[]> {
    return this.#many(this.#plan.filters(), options);
  }

  /** Revisions of one record, newest first. */
  async revisions(
    id: number,
    options: RequestOptions = {},
  ): Promise<JsonObject[]> {
    return this.#many(this.#plan.revisions(id), options);
  }

  /** Absolute URL of the resource's SSE stream. */
  eventsUrl(): string {
    return this.#plan.eventsUrl();
  }
}

/** Options of {@link createClient}. */
export interface ClientOptions {
  /** The server origin (or any URL on it). */
  readonly baseUrl: string;
  /** The network `fetch`; defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch | undefined;
  /** Returns the bearer token; called again with `refresh: true` once after a `401`. */
  readonly tokenProvider?: TokenProvider | undefined;
  /**
   * The cache scope of the caller, for sessions that carry no bearer token
   * (a cookie session behind a BFF). A string, or a function (sync or async)
   * called on every request and `scope()`; return the same value for the same
   * caller (for example the OIDC `sub`). It must be non-empty. When given it
   * REPLACES the token-hash / `"anon"` scope, even if a `tokenProvider` is also
   * set (the token still authenticates; it no longer selects the scope), and
   * the `./cache` middleware keys by it instead of the Authorization header.
   * Change what it returns on login or logout and nothing cached for the
   * previous caller is visible.
   */
  readonly cacheScope?: string | (() => string | Promise<string>) | undefined;
  /**
   * Passed to every `fetch` as `RequestInit.credentials` (`"same-origin"`
   * sends the session cookie to a same-origin `baseUrl`). Default: the
   * platform's (`"same-origin"`).
   */
  readonly credentials?: NonNullable<RequestInit["credentials"]> | undefined;
  /**
   * Called (and awaited) when a request is finally answered `401`, after the
   * `tokenProvider` refresh retry (if any) has failed to help. It gets a clone
   * of the response, so its body may be read. The call still rejects with
   * `Unauthorized` afterwards; if the callback throws, that error is the
   * `cause` of the `Unauthorized`. Fires for any request of the call
   * (manifest and discovery included), at most once per client call. Typical
   * use: navigate to the login page.
   */
  readonly onUnauthorized?:
    ((response: Response) => void | Promise<void>) | undefined;
  /** Outermost first; see `composeMiddleware`. */
  readonly middleware?: readonly Middleware[] | undefined;
  /** Skips api-catalog discovery. */
  readonly manifestUrl?: string | undefined;
  /**
   * Stable identity of this client in TanStack query keys. Defaults to
   * `baseUrl`; set it when two clients share a `baseUrl` but must not share
   * cached data, and keep it constant across reloads of a persisted cache.
   */
  readonly id?: string | undefined;
  /**
   * Exact origins (`https://files.example`) that manifest-supplied
   * `base_path`, `paths.*` and `events.path` may resolve to besides
   * `baseUrl`'s own. By default such a URL (absolute or protocol-relative) is
   * refused with a `ManifestError`, because the token would follow it. For
   * split-origin deployments only.
   */
  readonly allowedOrigins?: readonly string[] | undefined;
  /**
   * Allow sending an `Authorization` header (the bearer token), or cookies
   * (`credentials: "include"` or `"same-origin"`), over plain `http:` to a
   * host that is not loopback. Default `false`: such a request is refused
   * with {@link InsecureTransportError} before it is sent.
   * Loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`) and
   * anonymous requests without credentials are always allowed. Opt in only for a trusted
   * network, as the token is readable on the wire.
   */
  readonly allowInsecureHttp?: boolean | undefined;
}

function shapeOf(body: unknown): string {
  if (body === undefined) {
    return "no body";
  }
  return body === null
    ? "null"
    : Array.isArray(body)
      ? "an array"
      : typeof body;
}

/** Discovers the manifest and hands out {@link ResourceClient}s. */
export class CrudClient {
  readonly baseUrl: string;
  /** Stable identity in TanStack query keys (`ClientOptions.id`, else `baseUrl`). */
  readonly id: string;
  readonly #fetch: typeof fetch | undefined;
  readonly #tokenProvider: TokenProvider | undefined;
  readonly #cacheScope: ClientOptions["cacheScope"];
  readonly #credentials: NonNullable<RequestInit["credentials"]> | undefined;
  readonly #onUnauthorized: ClientOptions["onUnauthorized"];
  readonly #middleware: Middleware[];
  readonly #manifestUrl: string | undefined;
  readonly #allowedOrigins: readonly string[];
  readonly #allowInsecureHttp: boolean;
  readonly #manifests = new Map<string, Promise<Manifest>>();
  /** The newest `refresh: true` load per scope, until it settles. */
  readonly #refreshes = new Map<string, Promise<Manifest>>();
  readonly #transport: Transport;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl;
    this.id = options.id ?? options.baseUrl;
    this.#fetch = options.fetch;
    this.#tokenProvider = options.tokenProvider;
    this.#cacheScope = options.cacheScope;
    this.#credentials = options.credentials;
    this.#onUnauthorized = options.onUnauthorized;
    this.#middleware = [...(options.middleware ?? [])];
    this.#manifestUrl = options.manifestUrl;
    this.#allowedOrigins = [...(options.allowedOrigins ?? [])];
    this.#allowInsecureHttp = options.allowInsecureHttp ?? false;
    normalizeOrigins(this.#allowedOrigins); // fail at createClient, not at the first call
    this.#transport = {
      json: async (call, signal) => {
        const response = await this.#send(call, signal);
        if (response.status === 204) {
          return undefined;
        }
        try {
          return (await response.json()) as unknown;
        } catch (error) {
          throw new ResponseError(
            `${call.method} ${call.url}: the ${response.status} response body is not valid JSON`,
            { cause: error },
          );
        }
      },
      none: async (call, signal) => {
        await (await this.#send(call, signal)).body?.cancel();
      },
    };
  }

  /** Adds middleware after the existing ones (innermost); it sees every later request. */
  use(middleware: Middleware): this {
    this.#middleware.push(middleware);
    return this;
  }

  async #token(refresh: boolean): Promise<string | null> {
    // An empty token sends no header, so it is anonymous for the scope too.
    return (await this.#tokenProvider?.({ refresh })) || null;
  }

  /** The current bearer token, or `null` when anonymous. */
  token(refresh = false): Promise<string | null> {
    return this.#token(refresh);
  }

  /**
   * The `cacheScope` option, evaluated once, validated and namespaced
   * (`s:` + the percent-encoded value, so it can never equal `anon` or a token
   * hash and adds no key segments); `undefined` when the option is not used.
   * The prefix is internal.
   */
  async #explicitScope(): Promise<string | undefined> {
    if (this.#cacheScope === undefined) {
      return undefined;
    }
    const value: unknown =
      typeof this.#cacheScope === "function"
        ? await this.#cacheScope()
        : this.#cacheScope;
    if (typeof value !== "string" || value === "") {
      throw new ClientError("cacheScope must resolve to a non-empty string");
    }
    return `s:${encodeURIComponent(value)}`;
  }

  /**
   * The cache scope of the current caller: the `cacheScope` option (opaque,
   * namespaced; the `tokenProvider` is not called), else `"anon"` or a hash of
   * the token.
   */
  async scope(): Promise<string> {
    return (
      (await this.#explicitScope()) ?? tokenScope(await this.#token(false))
    );
  }

  /** The `{ client, scope }` namespace the `./tanstack` key factory takes. */
  async namespace(): Promise<{
    readonly client: string;
    readonly scope: string;
  }> {
    return { client: this.id, scope: await this.scope() };
  }

  async #dispatch(
    call: Call,
    token: string | null,
    explicit: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const headers = new Headers({
      Accept: "application/json",
      ...call.headers,
    });
    if (token !== null) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    const init: RequestInit = {
      method: call.method,
      headers,
      signal: signal ?? null,
      ...(this.#credentials === undefined
        ? {}
        : { credentials: this.#credentials }),
    };
    if (call.json !== undefined) {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(call.json);
    }
    const request = new Request(call.url, init);
    const terminal = async (ctx: {
      readonly request: Request;
    }): Promise<Response> => {
      // Judged on the request as it is sent, so a middleware that rewrites the
      // URL or sets its own Authorization is covered too.
      if (
        !this.#allowInsecureHttp &&
        (ctx.request.headers.has("Authorization") ||
          this.#credentials === "include" ||
          this.#credentials === "same-origin") &&
        isInsecureRemote(ctx.request.url)
      ) {
        throw new InsecureTransportError(
          `refusing to send credentials (an Authorization header or cookies) over plain http to ${new URL(ctx.request.url).origin}; ` +
            "use https, or pass allowInsecureHttp: true to createClient to allow it",
        );
      }
      try {
        return await (this.#fetch ?? globalThis.fetch)(ctx.request);
      } catch (error) {
        if (ctx.request.signal.aborted) {
          throw error;
        }
        throw new ConnectionFailed(
          error instanceof Error ? error.message : String(error),
          {
            cause: error,
          },
        );
      }
    };
    return composeMiddleware(
      this.#middleware,
      terminal,
    )({
      request,
      resource: call.resource,
      op: call.op,
      recordId: call.recordId,
      scope: explicit ?? (await tokenScope(token)),
      ...(explicit === undefined ? {} : { cacheScope: explicit }),
      apiVersion: call.apiVersion,
      signal,
    });
  }

  /** Sends `call`, retrying once with a refreshed token after a `401`; throws on `>= 400`. */
  async #send(call: Call, signal: AbortSignal | undefined): Promise<Response> {
    const explicit = await this.#explicitScope(); // once per call, reused on the retry
    const token = await this.#token(false);
    let response = await this.#dispatch(call, token, explicit, signal);
    if (response.status === 401 && this.#tokenProvider !== undefined) {
      const fresh = await this.#token(true);
      if (fresh !== null && fresh !== token) {
        await response.body?.cancel();
        response = await this.#dispatch(call, fresh, explicit, signal);
      }
    }
    let callbackError: unknown;
    let callbackFailed = false;
    if (response.status === 401 && this.#onUnauthorized !== undefined) {
      try {
        await this.#onUnauthorized(response.clone());
      } catch (error) {
        callbackFailed = true;
        callbackError = error;
      }
    }
    if (response.status >= 400) {
      const problem = await problemFromResponse(response);
      if (callbackFailed) {
        problem.cause = callbackError;
      }
      throw problem;
    }
    return response;
  }

  async #getJson(url: string, catalog: boolean): Promise<unknown> {
    const call: Call = {
      method: "GET",
      url,
      op: "manifest",
      resource: undefined,
      recordId: undefined,
      apiVersion: null,
      // The catalog shares the "manifest" op; no-store keeps it out of the manifest cache entry.
      ...(catalog ? { headers: { "Cache-Control": "no-store" } } : {}),
    };
    const response = await this.#send(call, undefined);
    try {
      return (await response.json()) as unknown;
    } catch (error) {
      throw new ManifestError(`${url} is not JSON`, { cause: error });
    }
  }

  /** The manifest for this caller, loaded once per caller scope (`refresh: true` reloads). */
  async manifest(
    options: { readonly refresh?: boolean } = {},
  ): Promise<Manifest> {
    const scope = await this.scope(); // the manifest is filtered per caller
    const current = this.#manifests.get(scope);
    if (current !== undefined && options.refresh !== true) {
      return current;
    }
    const started = loadManifest(
      (url, catalog) => this.#getJson(url, catalog),
      this.baseUrl,
      this.#manifestUrl,
    );
    if (current === undefined) {
      this.#manifests.clear(); // rotated tokens must not pile up manifests
      this.#manifests.set(scope, started);
      started.catch(() => {
        if (this.#manifests.get(scope) === started) {
          this.#manifests.delete(scope);
        }
      });
    } else {
      // A refresh replaces the cached manifest only once it loaded, and only
      // if no newer refresh was started: a failed one rejects here and leaves
      // the last good manifest to everyone else.
      this.#refreshes.set(scope, started);
      const settle = (loaded?: Manifest): void => {
        if (this.#refreshes.get(scope) === started) {
          this.#refreshes.delete(scope);
          // Not for a scope the rotation eviction already dropped.
          if (
            loaded !== undefined &&
            (this.#manifests.has(scope) || this.#manifests.size === 0)
          ) {
            this.#manifests.set(scope, Promise.resolve(loaded));
          }
        }
      };
      started.then(settle, () => {
        settle();
      });
    }
    return started;
  }

  /** A handle for `name` (the highest `api_version` unless given). */
  async resource<
    Read extends object = JsonObject,
    Create extends object = JsonObject,
    Update extends object = JsonObject,
  >(
    name: string,
    apiVersion?: string,
  ): Promise<ResourceClient<Read, Create, Update>> {
    const resource = findResource(await this.manifest(), name, apiVersion);
    if (resource === undefined) {
      throw new UnknownResourceError(
        `the manifest has no resource "${name}"${apiVersion === undefined ? "" : ` ${apiVersion}`} for this caller`,
      );
    }
    return new ResourceClient<Read, Create, Update>(
      this.baseUrl,
      resource,
      this.#transport,
      this.#allowedOrigins,
    );
  }
}

/** Creates a client; the manifest loads on first use. */
export function createClient(options: ClientOptions): CrudClient {
  return new CrudClient(options);
}
