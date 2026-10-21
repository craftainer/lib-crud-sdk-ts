import { ANON, cacheScope } from "../auth.ts";

/**
 * `"anon"` when the request has no Authorization header; otherwise the first
 * 32 hex characters of the SHA-256 of the whole credential, the same digest as
 * the client's `cacheScope(token)` (a `Bearer ` prefix is dropped, any other value is hashed as it is). It is read from the
 * request the cache sees, so it must be the innermost middleware that matters:
 * whatever sets Authorization has to run before the cache. The raw credential
 * never enters a key or a log, and the unverified `sub` claim is never used.
 */
export async function credentialScope(headers: Headers): Promise<string> {
  const value = headers.get("authorization");
  if (value === null) {
    return ANON;
  }
  const credential = /^bearer\s+(.+)$/i.exec(value)?.[1] ?? value;
  return cacheScope(credential);
}
