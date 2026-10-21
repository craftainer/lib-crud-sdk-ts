/**
 * Typed models of the CRUD manifest (v1) and discovery via the api-catalog.
 * Members keep their wire names (`skip_param`, `max_age`, ...). Members this
 * version does not know are ignored, as the manifest spec requires.
 */
import { ManifestError } from "./errors.ts";

export const PROFILE = "https://craftainer.github.io/schemas/crud-manifest/v1";
export const CATALOG_PATH = "/.well-known/api-catalog";

/** A JSON object. */
export type JsonObject = Record<string, unknown>;

/** One filterable and sortable field. */
export interface FieldSpec {
  readonly name: string;
  readonly value_type: string;
  readonly filter_ops: readonly string[];
  readonly sortable: boolean;
  readonly choices: readonly string[] | null;
  readonly numeric: boolean;
  readonly categorical: boolean;
  readonly read_only: boolean;
  readonly required: boolean;
}

/** Offset paging parameters and bounds. */
export interface Pagination {
  readonly style: string;
  readonly skip_param: string;
  readonly limit_param: string;
  readonly sort_param: string;
  readonly default_limit: number;
  readonly max_limit: number;
  readonly total: boolean;
}

/** The SSE stream of a resource. */
export interface EventsSpec {
  readonly transport: string;
  readonly path: string;
  /** The server-side event label (not the manifest name). */
  readonly resource: string;
  readonly resume_param: string;
  readonly replay: string;
  readonly keepalive_seconds: number;
  readonly actions: readonly string[];
}

/** What the resource supports. */
export interface Capabilities {
  readonly bulk_update: boolean;
  readonly bulk_delete: boolean;
  readonly clone: boolean;
  readonly draft_publish: boolean;
  readonly archive_restore: boolean;
  readonly revisions: boolean;
  readonly events: EventsSpec | null;
  readonly stats: boolean;
  readonly predict: boolean;
  readonly conditional_requests: boolean;
  readonly owner_scoped: boolean;
  readonly schedulable: boolean;
}

/** Authentication scheme and roles. */
export interface AuthSpec {
  readonly scheme: string;
  readonly oidc_discovery_url: string | null;
  readonly public_read: boolean;
  readonly read_roles: readonly string[];
  readonly write_roles: readonly string[];
  readonly delete_roles: readonly string[];
}

/** The manifest `cache` hints of a resource. */
export interface CacheHints {
  readonly etag: boolean;
  readonly max_age: number;
  readonly stats_ttl: number | null;
  readonly stale_while_revalidate: number;
  readonly list_etag: string | null;
  readonly record_etag: string | null;
  readonly revalidate_only: boolean;
}

/** JSON Schemas of the record views (plain objects). */
export interface Schemas {
  readonly read: JsonObject;
  readonly create: JsonObject;
  readonly update: JsonObject;
  readonly draft: JsonObject | null;
}

/** One resource (`name` + `api_version`). */
export interface Resource {
  readonly name: string;
  readonly title: string;
  readonly api_version: string;
  readonly base_path: string;
  readonly formats: Readonly<Record<string, string>>;
  readonly id_field: string;
  readonly schemas: Schemas;
  readonly fields: readonly FieldSpec[];
  readonly pagination: Pagination;
  readonly capabilities: Capabilities;
  readonly paths: Readonly<Record<string, string>>;
  readonly bulk: { readonly max_matched: number };
  readonly auth: AuthSpec;
  readonly cache: CacheHints;
}

/** The manifest document, as filtered to the caller. */
export interface Manifest {
  readonly manifest_version: string;
  readonly service: { readonly name: string; readonly version: string };
  readonly resources: readonly Resource[];
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function bad(where: string, key: string, what: string): never {
  throw new ManifestError(`${where}.${key}: ${what}`);
}

function str(obj: JsonObject, key: string, where: string): string {
  const value = obj[key];
  return typeof value === "string"
    ? value
    : bad(where, key, "missing or not a string");
}

function bool(obj: JsonObject, key: string, where: string): boolean {
  const value = obj[key];
  return typeof value === "boolean"
    ? value
    : bad(where, key, "missing or not a boolean");
}

function num(obj: JsonObject, key: string, where: string): number {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : bad(where, key, "missing or not a number");
}

function int(obj: JsonObject, key: string, where: string): number {
  const value = num(obj, key, where);
  return Number.isInteger(value) ? value : bad(where, key, "not an integer");
}

function obj(parent: JsonObject, key: string, where: string): JsonObject {
  const value = parent[key];
  return isObject(value) ? value : bad(where, key, "missing or not an object");
}

function list(
  parent: JsonObject,
  key: string,
  where: string,
): readonly unknown[] {
  const value = parent[key];
  return Array.isArray(value)
    ? value
    : bad(where, key, "missing or not a list");
}

function strs(
  parent: JsonObject,
  key: string,
  where: string,
): readonly string[] {
  const items = list(parent, key, where);
  return items.every((item) => typeof item === "string")
    ? (items as readonly string[])
    : bad(where, key, "expected a list of strings");
}

/** A member that may be absent or `null`. */
function opt<T>(
  parent: JsonObject,
  key: string,
  where: string,
  read: (parent: JsonObject, key: string, where: string) => T,
): T | null {
  return parent[key] === undefined || parent[key] === null
    ? null
    : read(parent, key, where);
}

function stringMap(
  parent: JsonObject,
  key: string,
  where: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(parent, key, where))) {
    if (typeof v === "string") {
      out[k] = v;
    }
  }
  return out;
}

function objects(parent: JsonObject, key: string, where: string): JsonObject[] {
  return list(parent, key, where).map((item, i) =>
    isObject(item) ? item : bad(`${where}.${key}`, `[${i}]`, "not an object"),
  );
}

function parseField(o: JsonObject, w: string): FieldSpec {
  return {
    name: str(o, "name", w),
    value_type: str(o, "value_type", w),
    filter_ops: strs(o, "filter_ops", w),
    sortable: bool(o, "sortable", w),
    choices: opt(o, "choices", w, strs),
    numeric: bool(o, "numeric", w),
    categorical: bool(o, "categorical", w),
    read_only: bool(o, "read_only", w),
    required: bool(o, "required", w),
  };
}

function parseEvents(o: JsonObject, w: string): EventsSpec {
  return {
    transport: str(o, "transport", w),
    path: str(o, "path", w),
    resource: str(o, "resource", w),
    resume_param: str(o, "resume_param", w),
    replay: str(o, "replay", w),
    keepalive_seconds: num(o, "keepalive_seconds", w),
    actions: strs(o, "actions", w),
  };
}

function parseCapabilities(o: JsonObject, w: string): Capabilities {
  return {
    bulk_update: bool(o, "bulk_update", w),
    bulk_delete: bool(o, "bulk_delete", w),
    clone: bool(o, "clone", w),
    draft_publish: bool(o, "draft_publish", w),
    archive_restore: bool(o, "archive_restore", w),
    revisions: bool(o, "revisions", w),
    events: opt(o, "events", w, (p, k, ww) =>
      parseEvents(obj(p, k, ww), `${ww}.${k}`),
    ),
    stats: bool(o, "stats", w),
    predict: bool(o, "predict", w),
    conditional_requests: bool(o, "conditional_requests", w),
    owner_scoped: bool(o, "owner_scoped", w),
    schedulable: bool(o, "schedulable", w),
  };
}

function parseResource(o: JsonObject, w: string): Resource {
  const schemas = obj(o, "schemas", w);
  const pagination = obj(o, "pagination", w);
  const auth = obj(o, "auth", w);
  const cache = obj(o, "cache", w);
  const sw = `${w}.schemas`;
  return {
    name: str(o, "name", w),
    title: str(o, "title", w),
    api_version: str(o, "api_version", w),
    base_path: str(o, "base_path", w),
    formats: stringMap(o, "formats", w),
    id_field: str(o, "id_field", w),
    schemas: {
      read: obj(schemas, "read", sw),
      create: obj(schemas, "create", sw),
      update: obj(schemas, "update", sw),
      draft: opt(schemas, "draft", sw, obj),
    },
    fields: objects(o, "fields", w).map((f, i) =>
      parseField(f, `${w}.fields[${i}]`),
    ),
    pagination: {
      style: str(pagination, "style", w),
      skip_param: str(pagination, "skip_param", w),
      limit_param: str(pagination, "limit_param", w),
      sort_param: str(pagination, "sort_param", w),
      default_limit: int(pagination, "default_limit", w),
      max_limit: int(pagination, "max_limit", w),
      total: bool(pagination, "total", w),
    },
    capabilities: parseCapabilities(
      obj(o, "capabilities", w),
      `${w}.capabilities`,
    ),
    paths: stringMap(o, "paths", w),
    bulk: { max_matched: int(obj(o, "bulk", w), "max_matched", `${w}.bulk`) },
    auth: {
      scheme: str(auth, "scheme", w),
      oidc_discovery_url: opt(auth, "oidc_discovery_url", w, str),
      public_read: bool(auth, "public_read", w),
      read_roles: strs(auth, "read_roles", w),
      write_roles: strs(auth, "write_roles", w),
      delete_roles: strs(auth, "delete_roles", w),
    },
    cache: {
      etag: bool(cache, "etag", w),
      max_age: int(cache, "max_age", w),
      stats_ttl: opt(cache, "stats_ttl", w, int),
      stale_while_revalidate: int(cache, "stale_while_revalidate", w),
      list_etag: opt(cache, "list_etag", w, str),
      record_etag: opt(cache, "record_etag", w, str),
      revalidate_only: bool(cache, "revalidate_only", w),
    },
  };
}

/** Parses a manifest document; unknown members are ignored, unknown versions refused. */
export function parseManifest(document: unknown): Manifest {
  if (!isObject(document)) {
    throw new ManifestError("the manifest is not a JSON object");
  }
  const version = str(document, "manifest_version", "manifest");
  if (version !== "1") {
    throw new ManifestError(`unsupported manifest_version "${version}"`);
  }
  const service = obj(document, "service", "manifest");
  return {
    manifest_version: version,
    service: {
      name: str(service, "name", "manifest.service"),
      version: str(service, "version", "manifest.service"),
    },
    resources: objects(document, "resources", "manifest").map((r, i) =>
      parseResource(r, `resources[${i}]`),
    ),
  };
}

/**
 * The resource called `name`: the one with `apiVersion` when given, else the
 * highest `api_version` (`v2` beats `v1`); `undefined` when there is none.
 */
export function findResource(
  manifest: Manifest,
  name: string,
  apiVersion?: string,
): Resource | undefined {
  const rank = (r: Resource): number =>
    Number.parseInt(r.api_version.slice(1), 10) || 0;
  let best: Resource | undefined;
  for (const r of manifest.resources) {
    if (
      r.name === name &&
      (apiVersion === undefined || r.api_version === apiVersion)
    ) {
      if (best === undefined || rank(r) > rank(best)) {
        best = r;
      }
    }
  }
  return best;
}

/** The absolute manifest URL: the first `describedby` link with the manifest profile. */
export function manifestUrlFromCatalog(
  linkset: unknown,
  catalogUrl: string,
): string {
  const entries = isObject(linkset) ? linkset["linkset"] : undefined;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const links = isObject(entry) ? entry["describedby"] : undefined;
    for (const link of Array.isArray(links) ? links : []) {
      if (
        isObject(link) &&
        link["profile"] === PROFILE &&
        typeof link["href"] === "string"
      ) {
        const url = new URL(link["href"], catalogUrl);
        if (url.origin !== new URL(catalogUrl).origin) {
          // The client sends its bearer token to this URL: stay on the server's origin.
          throw new ManifestError(
            `the api-catalog points at another origin (${url.origin}); pass manifestUrl to use it`,
          );
        }
        return url.href;
      }
    }
  }
  throw new ManifestError(
    `the api-catalog has no describedby link with profile ${PROFILE}`,
  );
}

/** Fetches a JSON document; `catalog` marks the api-catalog request (kept out of the manifest cache). */
export type GetJson = (url: string, catalog: boolean) => Promise<unknown>;

/**
 * Loads and parses the manifest, via api-catalog discovery from `baseUrl` or
 * a direct `manifestUrl`.
 */
export async function loadManifest(
  getJson: GetJson,
  baseUrl: string,
  manifestUrl?: string,
): Promise<Manifest> {
  let url = manifestUrl;
  if (url === undefined) {
    const catalogUrl = new URL(CATALOG_PATH, baseUrl).href;
    url = manifestUrlFromCatalog(await getJson(catalogUrl, true), catalogUrl);
  }
  return parseManifest(await getJson(url, false));
}
