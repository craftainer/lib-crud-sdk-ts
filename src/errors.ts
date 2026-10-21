/**
 * Error hierarchy: client-side errors and RFC 9457 problem details (ADR-0004).
 * Mirrors the Python SDK class for class.
 */

/** Base class of every error this package throws on purpose. */
export class CrudError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The call was refused before any request was sent. */
export class ClientError extends CrudError {}

/** The resource does not support the operation (manifest capability or path missing). */
export class CapabilityError extends ClientError {}

/** A filter, sort or paging argument is not valid for the resource. */
export class InvalidQueryError extends ClientError {}

/** The discovery document or the manifest is missing, unusable or of an unknown version. */
export class ManifestError extends ClientError {}

/** The manifest lists no such resource for this caller. */
export class UnknownResourceError extends ClientError {}

/** The request never produced a response; `cause` holds the transport error. */
export class ConnectionFailed extends CrudError {}

/** One normalized validation error (`422`). */
export interface ProblemDetail {
  readonly loc: readonly (string | number)[];
  readonly msg: string;
  readonly type: string;
}

/** Members of a {@link ProblemError}. */
export interface ProblemInit {
  readonly status: number;
  readonly title: string;
  readonly detail?: string | undefined;
  readonly type?: string | undefined;
  readonly instance?: string | undefined;
  readonly errors?: readonly ProblemDetail[] | undefined;
  readonly headers?: Headers | undefined;
  readonly response?: Response | undefined;
}

const NO_TYPE = "about:blank";

/** An error response, as RFC 9457 problem details. */
export class ProblemError extends CrudError {
  readonly status: number;
  readonly title: string;
  readonly detail: string | undefined;
  readonly type: string;
  readonly instance: string | undefined;
  readonly errors: readonly ProblemDetail[];
  readonly headers: Headers;
  readonly response: Response | undefined;

  constructor(init: ProblemInit) {
    const errors = init.errors ?? [];
    let message = `${init.status} ${init.title}`;
    if (init.detail) {
      message += `: ${init.detail}`;
    } else if (errors.length > 0) {
      message += `: ${errors.map((e) => `${e.loc.join(".")}: ${e.msg}`).join("; ")}`;
    }
    super(message);
    this.status = init.status;
    this.title = init.title;
    this.detail = init.detail;
    this.type = init.type ?? NO_TYPE;
    this.instance = init.instance;
    this.errors = errors;
    this.headers = init.headers ?? new Headers();
    this.response = init.response;
  }
}

/** 400. */
export class BadRequest extends ProblemError {}

/** 401; `wwwAuthenticate` keeps the challenge. */
export class Unauthorized extends ProblemError {
  get wwwAuthenticate(): string | undefined {
    return this.headers.get("www-authenticate") ?? undefined;
  }
}

/** 403. */
export class Forbidden extends ProblemError {}

/** 404. */
export class NotFound extends ProblemError {}

/** 412: a stale `If-Match`. */
export class PreconditionFailed extends ProblemError {}

/** 422; `errors` holds normalized `{loc, msg, type}` entries. */
export class ValidationFailed extends ProblemError {}

/** 423. */
export class Locked extends ProblemError {}

/** 429; `retryAfter` is the `Retry-After` header in seconds, when it is a number. */
export class RateLimited extends ProblemError {
  get retryAfter(): number | undefined {
    const raw = this.headers.get("retry-after");
    if (raw === null || raw.trim() === "") {
      return undefined;
    }
    const seconds = Number(raw);
    return Number.isNaN(seconds) ? undefined : seconds;
  }
}

/** 5xx. */
export class ServerError extends ProblemError {}

const BY_STATUS: ReadonlyMap<number, typeof ProblemError> = new Map([
  [400, BadRequest],
  [401, Unauthorized],
  [403, Forbidden],
  [404, NotFound],
  [412, PreconditionFailed],
  [422, ValidationFailed],
  [423, Locked],
  [429, RateLimited],
]);

// Python's `http.HTTPStatus` phrases, so both SDKs synthesize the same title.
const PHRASES: ReadonlyMap<number, string> = new Map([
  [100, "Continue"],
  [101, "Switching Protocols"],
  [102, "Processing"],
  [103, "Early Hints"],
  [200, "OK"],
  [201, "Created"],
  [202, "Accepted"],
  [203, "Non-Authoritative Information"],
  [204, "No Content"],
  [205, "Reset Content"],
  [206, "Partial Content"],
  [207, "Multi-Status"],
  [208, "Already Reported"],
  [226, "IM Used"],
  [300, "Multiple Choices"],
  [301, "Moved Permanently"],
  [302, "Found"],
  [303, "See Other"],
  [304, "Not Modified"],
  [305, "Use Proxy"],
  [307, "Temporary Redirect"],
  [308, "Permanent Redirect"],
  [400, "Bad Request"],
  [401, "Unauthorized"],
  [402, "Payment Required"],
  [403, "Forbidden"],
  [404, "Not Found"],
  [405, "Method Not Allowed"],
  [406, "Not Acceptable"],
  [407, "Proxy Authentication Required"],
  [408, "Request Timeout"],
  [409, "Conflict"],
  [410, "Gone"],
  [411, "Length Required"],
  [412, "Precondition Failed"],
  [413, "Content Too Large"],
  [414, "URI Too Long"],
  [415, "Unsupported Media Type"],
  [416, "Range Not Satisfiable"],
  [417, "Expectation Failed"],
  [418, "I'm a Teapot"],
  [421, "Misdirected Request"],
  [422, "Unprocessable Content"],
  [423, "Locked"],
  [424, "Failed Dependency"],
  [425, "Too Early"],
  [426, "Upgrade Required"],
  [428, "Precondition Required"],
  [429, "Too Many Requests"],
  [431, "Request Header Fields Too Large"],
  [451, "Unavailable For Legal Reasons"],
  [500, "Internal Server Error"],
  [501, "Not Implemented"],
  [502, "Bad Gateway"],
  [503, "Service Unavailable"],
  [504, "Gateway Timeout"],
  [505, "HTTP Version Not Supported"],
  [506, "Variant Also Negotiates"],
  [507, "Insufficient Storage"],
  [508, "Loop Detected"],
  [510, "Not Extended"],
  [511, "Network Authentication Required"],
]);

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function normalizeErrors(items: readonly unknown[]): ProblemDetail[] {
  return items.map((item) => {
    if (isObject(item)) {
      return {
        loc: Array.isArray(item["loc"])
          ? (item["loc"] as (string | number)[])
          : [],
        msg: String(item["msg"] ?? ""),
        type: String(item["type"] ?? ""),
      };
    }
    return { loc: [], msg: String(item), type: "" };
  });
}

/**
 * Builds the matching `ProblemError` subclass from an error response. A body
 * that is not a JSON object yields a synthesized problem from the status
 * phrase. Reads a clone, so `response.body` stays readable.
 */
export async function problemFromResponse(
  response: Response,
): Promise<ProblemError> {
  const status = response.status;
  const phrase = PHRASES.get(status) ?? "Error";
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.clone().text());
  } catch {
    parsed = undefined;
  }
  const body: Obj = isObject(parsed) ? parsed : {};
  const rawDetail = body["detail"];
  const rawErrors = Array.isArray(rawDetail) ? rawDetail : body["errors"];
  const Cls =
    BY_STATUS.get(status) ?? (status >= 500 ? ServerError : ProblemError);
  const instance = body["instance"];
  return new Cls({
    status,
    title: String(body["title"] || phrase),
    detail: typeof rawDetail === "string" ? rawDetail : undefined,
    type: String(body["type"] || NO_TYPE),
    instance: typeof instance === "string" ? instance : undefined,
    errors: Array.isArray(rawErrors) ? normalizeErrors(rawErrors) : [],
    headers: response.headers,
    response,
  });
}
