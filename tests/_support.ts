import { readFileSync } from "node:fs";
import { createClient } from "../src/index.ts";
import type { ClientOptions, CrudClient } from "../src/index.ts";

export const BASE = "https://api.test";

export function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  );
}

export const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

export interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
  readonly request: Request;
}

export type Handler = (
  seen: Seen,
  count: number,
) => Response | Promise<Response>;

/** A fake `fetch` that records every request and answers through `handler`. */
export function fakeFetch(handler: Handler): {
  fetch: typeof fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const fake = async (input: Request | string | URL): Promise<Response> => {
    const request = input as Request;
    const entry: Seen = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await request.clone().text(),
      request,
    };
    seen.push(entry);
    return handler(entry, seen.length);
  };
  return { fetch: fake as typeof fetch, seen };
}

/** A client whose `fetch` serves `manifest` at `/m` and `handler` for everything else. */
export function clientFor(
  manifest: unknown,
  handler: Handler = () => json({}),
  options: Partial<ClientOptions> = {},
): { client: CrudClient; seen: Seen[] } {
  const { fetch, seen } = fakeFetch((request, count) =>
    request.url === `${BASE}/m` ? json(manifest) : handler(request, count),
  );
  const client = createClient({
    baseUrl: BASE,
    manifestUrl: `${BASE}/m`,
    fetch,
    ...options,
  });
  return { client, seen };
}

/** A client whose `fetch` is `handler` for every URL, the manifest URL included. */
export function bareClient(
  handler: Handler,
  options: Partial<ClientOptions> = {},
): { client: CrudClient; seen: Seen[] } {
  const { fetch, seen } = fakeFetch(handler);
  return {
    client: createClient({
      baseUrl: BASE,
      manifestUrl: `${BASE}/m`,
      fetch,
      ...options,
    }),
    seen,
  };
}
