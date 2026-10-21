import { vi } from "vitest";
import type { Op, RequestContext } from "../../src/interfaces.ts";

export const BASE = "https://api.test/heroes";

export function ctxFor(
  op: Op,
  options: {
    method?: string;
    query?: string;
    recordId?: number;
    resource?: string | undefined;
    scope?: string;
    apiVersion?: string | null;
    headers?: Record<string, string>;
    url?: string;
    signal?: AbortSignal;
  } = {},
): RequestContext {
  const url = options.url ?? `${BASE}${options.query ?? ""}`;
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: options.headers ?? {},
  };
  if (options.signal !== undefined) {
    init.signal = options.signal;
  }
  return {
    request: new Request(url, init),
    resource: "resource" in options ? options.resource : "heroes",
    op,
    recordId: options.recordId,
    scope: options.scope ?? "anon",
    apiVersion: options.apiVersion ?? null,
    signal: options.signal,
  };
}

export function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

/** A fake network: queue responses (or factories), read what was sent. */
export function fakeNet() {
  const queue: Array<Response | (() => Response | Promise<Response>)> = [];
  const sent: Request[] = [];
  const next = vi.fn(async (ctx: RequestContext): Promise<Response> => {
    sent.push(ctx.request);
    const item = queue.shift();
    if (item === undefined) {
      throw new Error("fakeNet: no response queued");
    }
    return typeof item === "function" ? item() : item;
  });
  return {
    next,
    sent,
    push: (...items: Array<Response | (() => Response | Promise<Response>)>) =>
      queue.push(...items),
  };
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
