/** The cache scope of a request: derived from the Authorization header it is sent with. */

/**
 * `"anon"` when the request has no Authorization header; otherwise the first
 * 32 hex characters of the SHA-256 of the whole credential (a `Bearer `
 * prefix is dropped, any other value is hashed as it is). It is read from the
 * request the cache sees, so it must be the innermost middleware that matters:
 * whatever sets Authorization has to run before the cache. The raw credential
 * never enters a key or a log, and the unverified `sub` claim is never used.
 */
export async function credentialScope(headers: Headers): Promise<string> {
  const value = headers.get("authorization");
  if (value === null) {
    return "anon";
  }
  const credential = /^bearer\s+(.+)$/i.exec(value)?.[1] ?? value;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(credential),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 32);
}
