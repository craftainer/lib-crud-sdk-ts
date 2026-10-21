import type { TokenProvider } from "./interfaces.ts";

/** The scope of an anonymous caller. */
export const ANON = "anon";

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
