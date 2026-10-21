/**
 * Query-string builder with `crud_query` semantics, validated against the
 * manifest fields. Produces the same bytes as the Python SDK.
 */
import { InvalidQueryError } from "./errors.ts";
import type { FieldSpec } from "./manifest.ts";

const MAX_REGEX_LENGTH = 200;

/** The part of a manifest field the builder needs. */
export type QueryField = Pick<
  FieldSpec,
  "name" | "value_type" | "filter_ops" | "sortable" | "choices"
>;

/** Filter arguments: `field` (equality, emitted bare) or `field__op` -> value. */
export type Filters = Readonly<Record<string, unknown>>;

/** `"name,-other"` or `["name", "-other"]`. */
export type Sort = string | readonly string[];

/** Everything {@link buildQuery} takes beside the fields. */
export interface QueryParams {
  readonly recordId?: number | undefined;
  readonly filters?: Filters | undefined;
  readonly sort?: Sort | undefined;
  readonly skip?: number | undefined;
  readonly limit?: number | undefined;
  readonly maxLimit?: number | undefined;
  readonly skipParam?: string | undefined;
  readonly limitParam?: string | undefined;
  readonly sortParam?: string | undefined;
  readonly includeArchived?: boolean | undefined;
  readonly includeUnpublished?: boolean | undefined;
}

/** Percent-encodes everything but the RFC 3986 unreserved characters `A-Za-z0-9-._~`. */
export function quote(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Joins already-stringified pairs, encoding keys and values. */
export function encodeParams(
  pairs: readonly (readonly [string, string])[],
): string {
  return pairs.map(([k, v]) => `${quote(k)}=${quote(v)}`).join("&");
}

function formatDatetime(value: Date): string | undefined {
  if (Number.isNaN(value.getTime())) {
    return undefined;
  }
  const iso = value.toISOString();
  if (iso.length !== 24) {
    return undefined; // expanded years (outside 0000-9999)
  }
  const millis = iso.slice(20, 23).replace(/0+$/, "");
  return millis === ""
    ? `${iso.slice(0, 19)}Z`
    : `${iso.slice(0, 19)}.${millis}Z`;
}

function formatDate(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return undefined;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
    ? undefined
    : value;
}

function scalarText(kind: string, value: unknown): string | undefined {
  switch (kind) {
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : undefined;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : undefined;
    case "boolean":
      return typeof value === "boolean" ? String(value) : undefined;
    case "date":
      return typeof value === "string" ? formatDate(value) : undefined;
    case "datetime":
      return value instanceof Date ? formatDatetime(value) : undefined;
    default:
      return typeof value === "string" ? value : undefined;
  }
}

/**
 * Wire form of one value for `field`; throws `InvalidQueryError` on a type
 * mismatch. Dates are `YYYY-MM-DD` strings, datetimes `Date`s (UTC, with
 * millisecond precision, trailing zeros trimmed).
 */
export function formatScalar(field: QueryField, value: unknown): string {
  const text = scalarText(field.value_type, value);
  if (text === undefined) {
    throw new InvalidQueryError(
      `field "${field.name}" (${field.value_type}) cannot take ${String(value)}`,
    );
  }
  if (
    field.value_type === "enum" &&
    field.choices !== null &&
    !field.choices.includes(text)
  ) {
    throw new InvalidQueryError(
      `field "${field.name}" accepts only ${JSON.stringify(field.choices)}, not "${text}"`,
    );
  }
  return text;
}

function filterPair(
  field: QueryField,
  op: string,
  value: unknown,
): [string, string] {
  const key = op === "eq" ? field.name : `${field.name}__${op}`;
  if (op === "in") {
    if (!Array.isArray(value) || value.length === 0) {
      throw new InvalidQueryError(`"${key}" takes a non-empty array`);
    }
    const parts = value.map((item: unknown) => formatScalar(field, item));
    if (parts.some((part) => part.includes(","))) {
      throw new InvalidQueryError(
        `"${key}": a value contains a comma, which separates the list`,
      );
    }
    return [key, parts.map(quote).join(",")];
  }
  const text = formatScalar(field, value);
  if (op === "regex" && [...text].length > MAX_REGEX_LENGTH) {
    throw new InvalidQueryError(
      `"${key}": a regex is limited to ${MAX_REGEX_LENGTH} characters`,
    );
  }
  return [key, quote(text)];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function filterPairs(
  fields: ReadonlyMap<string, QueryField>,
  filters: Filters,
): [string, string][] {
  const parsed = new Map<
    string,
    { name: string; op: string; pair: [string, string] }
  >();
  for (const [rawKey, value] of Object.entries(filters)) {
    const at = rawKey.lastIndexOf("__");
    const name = at < 0 ? rawKey : rawKey.slice(0, at);
    const op = at < 0 ? "eq" : rawKey.slice(at + 2);
    const field = fields.get(name);
    if (field === undefined) {
      throw new InvalidQueryError(`unknown filter field "${name}"`);
    }
    if (!field.filter_ops.includes(op)) {
      throw new InvalidQueryError(
        `field "${name}" does not support the "${op}" operator`,
      );
    }
    if (name === "id" && op === "eq") {
      throw new InvalidQueryError(
        "filter on id with recordId, not an equality filter",
      );
    }
    const id = `${name}\u0000${op}`;
    if (parsed.has(id)) {
      throw new InvalidQueryError(`filter "${name}" "${op}" given twice`);
    }
    parsed.set(id, { name, op, pair: filterPair(field, op, value) });
  }
  return [...parsed.values()]
    .sort((a, b) => compare(a.name, b.name) || compare(a.op, b.op))
    .map((entry) => entry.pair);
}

function sortValue(
  fields: ReadonlyMap<string, QueryField>,
  sort: Sort,
): string {
  const parts = typeof sort === "string" ? sort.split(",") : sort;
  const out = parts.map((part) => {
    const name = part.startsWith("-") ? part.slice(1) : part;
    const field = fields.get(name);
    if (field === undefined || !field.sortable) {
      throw new InvalidQueryError(`cannot sort by "${name}"`);
    }
    return quote(part);
  });
  if (out.length === 0) {
    throw new InvalidQueryError("sort is empty");
  }
  return out.join(",");
}

function intArg(name: string, value: unknown, minimum: number): string {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new InvalidQueryError(`${name} must be an integer >= ${minimum}`);
  }
  return String(value);
}

/**
 * The query string (no leading `?`) for a list, get or bulk call. Order of
 * parameters: `id`, filters sorted by (field, operator), sort, skip, limit,
 * `include_archived`, `include_unpublished`. The sort/skip/limit names are
 * `sortParam`/`skipParam`/`limitParam` (the manifest's `pagination`); the
 * `id` parameter is always `id`. Flags are emitted whenever they are not
 * `undefined`.
 */
export function buildQuery(
  fields: readonly QueryField[],
  params: QueryParams = {},
): string {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const parts: string[] = [];
  if (params.recordId !== undefined) {
    parts.push(`id=${intArg("recordId", params.recordId, 0)}`);
  }
  for (const [key, value] of filterPairs(byName, params.filters ?? {})) {
    parts.push(`${quote(key)}=${value}`); // values arrive encoded; `in` keeps its commas
  }
  if (params.sort !== undefined) {
    parts.push(
      `${quote(params.sortParam ?? "sort")}=${sortValue(byName, params.sort)}`,
    );
  }
  if (params.skip !== undefined) {
    parts.push(
      `${quote(params.skipParam ?? "skip")}=${intArg("skip", params.skip, 0)}`,
    );
  }
  if (params.limit !== undefined) {
    const text = intArg("limit", params.limit, 1);
    if (params.maxLimit !== undefined && params.limit > params.maxLimit) {
      throw new InvalidQueryError(
        `limit ${params.limit} exceeds the server maximum ${params.maxLimit}`,
      );
    }
    parts.push(`${quote(params.limitParam ?? "limit")}=${text}`);
  }
  if (params.includeArchived !== undefined) {
    parts.push(`include_archived=${params.includeArchived}`);
  }
  if (params.includeUnpublished !== undefined) {
    parts.push(`include_unpublished=${params.includeUnpublished}`);
  }
  return parts.join("&");
}
