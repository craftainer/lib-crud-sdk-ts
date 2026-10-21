import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import {
  IndexedDbStore,
  cachePolicyFromManifest,
  cacheStatus,
  createCache,
  invalidateOnEvents,
  subscribeEvents,
} from "../../src/cache/index.ts";
import { composeMiddleware } from "../../src/interfaces.ts";
import { ctxFor, json } from "./helpers.ts";

/** The whole path: cache middleware over IndexedDB, invalidated by a real SSE stream. */
describe("cache + IndexedDB + SSE", () => {
  it("serves fresh hits while the stream is up, and SSE invalidation ends them", async () => {
    const enc = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let streamSignal: AbortSignal | undefined;
    const streamFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      streamSignal = init?.signal ?? undefined;
      streamSignal?.addEventListener("abort", () =>
        controller.error(new DOMException("aborted", "AbortError")),
      );
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
        }),
      );
    }) as unknown as typeof fetch;

    const store = new IndexedDbStore({ name: "integration" });
    const cache = createCache({
      store,
      policies: {
        heroes: cachePolicyFromManifest({
          cache: { max_age: 60, etag: true },
        }),
      },
    });
    let etag = 1;
    const network = vi.fn(async (_ctx: unknown) => {
      const response = json([{ id: 5 }], { headers: { etag: `W/"${etag}"` } });
      return response;
    });
    const send = composeMiddleware([cache.middleware], (ctx) => network(ctx));

    const stop = invalidateOnEvents(
      cache,
      {
        subscribe: (handlers) =>
          subscribeEvents({
            fetch: streamFetch,
            url: "https://api.test/heroes/events",
            events: { resource: "hero" },
            ...handlers,
          }),
      },
      "heroes",
    );
    await vi.waitFor(() => expect(streamSignal).toBeDefined());
    controller.enqueue(enc.encode('id: 0\ndata: {"subscriber_id":"s"}\n\n'));
    await vi.waitFor(() => expect(cache.eventsActive("heroes")).toBe(true));

    expect(cacheStatus(await send(ctxFor("list")))).toBe("miss"); // stored fresh: the stream is up
    expect(cacheStatus(await send(ctxFor("list")))).toBe("hit");
    expect(network).toHaveBeenCalledTimes(1);

    etag = 2;
    controller.enqueue(
      enc.encode(
        `id: 1\ndata: ${JSON.stringify({ resource: "hero", record_id: 5, action: "update", snapshot: {}, timestamp: "t" })}\n\n`,
      ),
    );
    await vi.waitFor(async () => {
      expect(await store.get("v1/heroes/list/_/_/anon/")).toBeUndefined();
    });
    expect(cacheStatus(await send(ctxFor("list")))).toBe("miss");
    expect(network).toHaveBeenCalledTimes(2);

    stop();
    expect(cache.eventsActive("heroes")).toBe(false);
    await vi.waitFor(() => expect(streamSignal?.aborted).toBe(true));
    await store.close();
  });
});
