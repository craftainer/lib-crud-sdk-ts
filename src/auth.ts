import type { TokenProvider } from "./interfaces.ts";

/** The scope of an anonymous caller. */
export const ANON = "anon";

/**
 * Internal marker (a symbol-keyed property on the `RequestContext`, which
 * survives `{ ...ctx }`): the client sets it when `scope` came from the
 * `cacheScope` option, and the cache then keys by `ctx.scope` instead of the
 * Authorization header. Not part of the public API.
 */
export const EXPLICIT_SCOPE: unique symbol = Symbol.for(
  "@craftainer/crud-sdk/explicit-scope",
);

/**
 * Cache scope of a caller: `"anon"`, or the first 32 hex characters of the
 * SHA-256 of the whole bearer token. Nothing in the token is trusted or
 * decoded (a forged `sub` must not select another caller's entries), and the
 * raw token never leaves this function.
 */
export async function cacheScope(
  token: string | null | undefined,
): Promise<string> {
  if (token === null || token === undefined) {
    return ANON;
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest).subarray(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** A provider that always returns `token` (a refresh changes nothing). */
export function staticToken(token: string | null): TokenProvider {
  return () => token;
}

/**
 * Whether `url` is plain `http:` to a host that is not loopback. Loopback is
 * `localhost`, `*.localhost`, `127.0.0.0/8` and `[::1]`, judged on the parsed
 * hostname (so `http://localhost.evil.example` is not loopback). `https:` and
 * any other scheme are never insecure here.
 */
export function isInsecureRemote(url: string): boolean {
  const { protocol, hostname } = new URL(url);
  if (protocol !== "http:") {
    return false;
  }
  // WHATWG URL has already normalised numeric hosts (`127.1` -> `127.0.0.1`)
  // and lower-cased the name; a trailing dot is the same host.
  const host = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  return !(
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}
