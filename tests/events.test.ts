import { afterEach, describe, expect, it, vi } from "vitest";
import { getEventHub, subscribeEvents } from "../src/events.ts";
import type { EventsConfig } from "../src/events.ts";
import type { CrudEvent } from "../src/interfaces.ts";

const encoder = new TextEncoder();
const URL_ = "https://api.test/heroes/events";

interface Conn {
  url: string;
  signal: AbortSignal | undefined;
  push(text: string): void;
  end(): void;
}

type Plan = "ok" | number | Error | "nobody";

/** A fake streaming fetch: each call is a connection the test drives. */
function sseFetch(plan: Plan[] = []) {
  const conns: Conn[] = [];
  const fn = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const step = plan.shift() ?? "ok";
      if (step instanceof Error) {
        throw step;
      }
      if (typeof step === "number") {
        return new Response("nope", { status: step });
      }
      const signal = init?.signal ?? undefined;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      signal?.addEventListener("abort", () => {
        controller.error(new DOMException("aborted", "AbortError"));
      });
      conns.push({
        url: String(input),
        signal,
        push: (text) => controller.enqueue(encoder.encode(text)),
        end: () => controller.close(),
      });
      if (step === "nobody") {
        return { ok: true, status: 200, body: null } as unknown as Response;
      }
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  );
  return { fn: fn as unknown as typeof fetch, conns, calls: fn };
}

const handshake = (id: string, n = 0) =>
  `id: ${n}\ndata: {"subscriber_id":"${id}"}\n\n`;
const frame = (n: number, data: Record<string, unknown>) =>
  `id: ${n}\ndata: ${JSON.stringify(data)}\n\n`;
const record = (action: string, id: number, extra = {}) => ({
  resource: "hero",
  record_id: id,
  action,
  snapshot: { id },
  timestamp: "2026-10-21T00:00:00Z",
  ...extra,
});

const config: EventsConfig = {
  resource: "hero",
  resume_param: "sub",
  replay: "persistent",
  keepalive_seconds: 10,
};

function collect() {
  const log: string[] = [];
  const events: CrudEvent[] = [];
  return {
    log,
    events,
    handlers: {
      onEvent: (event: CrudEvent) => {
        events.push(event);
        log.push(`event:${event.action}:${event.recordId}`);
      },
      onReset: () => {
        log.push("reset");
      },
      onStatus: (connected: boolean) => {
        log.push(`status:${connected}`);
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("subscribeEvents", () => {
  it("handshakes, fans out events and filters on the server label", async () => {
    const net = sseFetch();
    const c = collect();
    const stop = subscribeEvents({
      fetch: net.fn,
      url: URL_,
      events: config,
      ...c.handlers,
    });
    await vi.waitFor(() => expect(net.conns).toHaveLength(1));
    expect(net.calls.mock.calls[0]?.[1]).toMatchObject({
      headers: { accept: "text/event-stream" },
    });
    const conn = net.conns[0]!;
    conn.push(": keep-alive\n\n");
    conn.push(handshake("abc"));
    conn.push(frame(1, record("create", 5)));
    conn.push(frame(2, record("update", 6, { resource: "other" })));
    conn.push("id: 3\ndata: not json\n\n");
    conn.push("id: 4\ndata: [1]\n\n");
    conn.push("id: 5\ndata: 7\n\n");
    conn.push(
      frame(6, record("delete", 7, { snapshot: "x", timestamp: null })),
    );
    await vi.waitFor(() =>
      expect(c.log).toEqual([
        "status:true",
        "event:create:5",
        "event:delete:7",
      ]),
    );
    expect(c.events[0]).toEqual({
      resource: "hero",
      recordId: 5,
      action: "create",
      snapshot: { id: 5 },
      timestamp: "2026-10-21T00:00:00Z",
    });
    expect(c.events[1]).toMatchObject({ snapshot: {}, timestamp: "" });
    stop();
    await vi.waitFor(() => expect(conn.signal?.aborted).toBe(true));
  });

  it("resets on an event it cannot map to one record", async () => {
    const net = sseFetch();
    const c = collect();
    const stop = subscribeEvents({
      fetch: net.fn,
      url: URL_,
      events: config,
      ...c.handlers,
    });
    await vi.waitFor(() => expect(net.conns).toHaveLength(1));
    const conn = net.conns[0]!;
    conn.push(handshake("abc"));
    conn.push(frame(1, record("update", 1, { record_id: null })));
    conn.push(frame(2, record("explode", 1)));
    conn.push(frame(3, record("update", 1, { record_id: 1.5 })));
    await vi.waitFor(() =>
      expect(c.log).toEqual(["status:true", "reset", "reset", "reset"]),
    );
    stop();
  });

  it("handlers may omit onReset and onStatus", async () => {
    const net = sseFetch();
    const seen: number[] = [];
    const stop = subscribeEvents({
      fetch: net.fn,
      url: URL_,
      events: config,
      onEvent: (event) => {
        seen.push(event.recordId);
      },
    });
    await vi.waitFor(() => expect(net.conns).toHaveLength(1));
    net.conns[0]!.push(handshake("a"));
    net.conns[0]!.push(frame(1, record("update", 1, { record_id: null })));
    net.conns[0]!.push(frame(2, record("create", 2)));
    await vi.waitFor(() => expect(seen).toEqual([2]));
    stop();
  });

  it("reconnects explicitly with the subscriber id and resets", async () => {
    vi.useFakeTimers();
    const net = sseFetch();
    const c = collect();
    const stop = subscribeEvents({
      fetch: net.fn,
      url: URL_,
      events: config,
      random: () => 0,
      ...c.handlers,
    });
    await vi.advanceTimersByTimeAsync(0);
    net.conns[0]!.push(handshake("abc"));
    await vi.advanceTimersByTimeAsync(0);
    net.conns[0]!.end(); // the server closes the stream
    await vi.advanceTimersByTimeAsync(0);
    expect(c.log).toEqual(["status:true", "status:false"]);
    await vi.advanceTimersByTimeAsync(999);
    expect(net.conns).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(net.conns).toHaveLength(2);
    expect(net.conns[1]!.url).toBe(`${URL_}?sub=abc`);
    net.conns[1]!.push(handshake("def"));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.log).toEqual([
      "status:true",
      "status:false",
      "reset",
      "status:true",
    ]);
    stop();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("does not resume when the stream does not replay, and appends to a query", async () => {
    vi.useFakeTimers();
    const net = sseFetch();
    const stop = subscribeEvents({
      fetch: net.fn,
      url: `${URL_}?x=1`,
      events: { resource: "hero", replay: "none" },
      random: () => 0,
      onEvent: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(0);
    net.conns[0]!.push(handshake("abc"));
    net.conns[0]!.end();
    await vi.advanceTimersByTimeAsync(1000);
    expect(net.conns[1]!.url).toBe(`${URL_}?x=1`);
    stop();
    await vi.advanceTimersByTimeAsync(0);

    const net2 = sseFetch();
    const stop2 = subscribeEvents({
      fetch: net2.fn,
      url: `${URL_}?x=1`,
      events: { resource: "hero", replay: "persistent" },
      random: () => 0,
      onEvent: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(0);
    net2.conns[0]!.push(handshake("a b"));
    net2.conns[0]!.end();
    await vi.advanceTimersByTimeAsync(1000);
    expect(net2.conns[1]!.url).toBe(`${URL_}?x=1&subscriber_id=a%20b`);
    stop2();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("backs off exponentially with jitter, capped, and resets after a handshake", async () => {
    vi.useFakeTimers();
    const net = sseFetch([503, 503, 503, 503, 503, 503, 503]);
    const c = collect();
    const stop = subscribeEvents({
      fetch: net.fn,
      url: URL_,
      events: config,
      random: () => 1, // the longest jitter: base * 1.5
      ...c.handlers,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(net.calls).toHaveBeenCalledTimes(1);
    const waits = [1500, 3000, 6000, 12000, 24000, 30000];
    for (const [i, wait] of waits.entries()) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(net.calls).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(net.calls).toHaveBeenCalledTimes(i + 2);
    }
    // The 8th attempt succeeds; a handshake resets the backoff.
    await vi.advanceTimersByTimeAsync(30000);
    expect(net.conns).toHaveLength(1);
    net.conns[0]!.push(handshake("abc"));
    await vi.advanceTimersByTimeAsync(0);
    net.conns[0]!.end();
    await vi.advanceTimersByTimeAsync(1499);
    expect(net.conns).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(net.conns).toHaveLength(2);
    stop();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("treats a stream silent for three keep-alives as dead", async () => {
    vi.useFakeTimers();
    const net = sseFetch();
    const c = collect();
    const stop = subscribeEvents({
      fetch: net.fn,
      url: URL_,
      events: config, // keepalive 10 s -> dead after 30 s
      random: () => 0,
      ...c.handlers,
    });
    await vi.advanceTimersByTimeAsync(0);
    net.conns[0]!.push(handshake("abc"));
    await vi.advanceTimersByTimeAsync(29_000);
    net.conns[0]!.push(": keep-alive\n\n"); // bytes arrive: the timer restarts
    await vi.advanceTimersByTimeAsync(29_999);
    expect(c.log).toEqual(["status:true"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.log).toEqual(["status:true", "status:false"]);
    expect(net.conns[0]!.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(net.conns).toHaveLength(2);
    stop();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("uses a 15 s keep-alive when the manifest gives none", async () => {
    vi.useFakeTimers();
    const net = sseFetch();
    const c = collect();
    const stop = subscribeEvents({
      fetch: net.fn,
      url: URL_,
      events: { resource: "hero" },
      ...c.handlers,
    });
    await vi.advanceTimersByTimeAsync(0);
    net.conns[0]!.push(handshake("abc"));
    await vi.advanceTimersByTimeAsync(44_999);
    expect(c.log).toEqual(["status:true"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.log).toEqual(["status:true", "status:false"]);
    stop();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("retries after a refused request, a network error and a body-less response", async () => {
    vi.useFakeTimers();
    const net = sseFetch([401, new TypeError("offline"), "nobody"]);
    const stop = subscribeEvents({
      fetch: net.fn,
      url: URL_,
      events: config,
      random: () => 0,
      onEvent: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(net.calls).toHaveBeenCalledTimes(4);
    stop();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("shares one connection and aborts it when the last subscriber leaves", async () => {
    const net = sseFetch();
    const a = collect();
    const b = collect();
    const stopA = subscribeEvents({
      fetch: net.fn,
      url: URL_,
      events: config,
      ...a.handlers,
    });
    await vi.waitFor(() => expect(net.conns).toHaveLength(1));
    net.conns[0]!.push(handshake("abc"));
    await vi.waitFor(() => expect(a.log).toEqual(["status:true"]));
    const stopB = subscribeEvents({
      fetch: net.fn,
      url: URL_,
      events: config,
      ...b.handlers,
    });
    await vi.waitFor(() => expect(b.log).toEqual(["status:true"]));
    expect(net.conns).toHaveLength(1);
    net.conns[0]!.push(frame(1, record("update", 3)));
    await vi.waitFor(() => expect(b.log).toContain("event:update:3"));
    expect(a.log).toContain("event:update:3");

    stopA();
    stopA(); // idempotent
    await vi.waitFor(() => expect(a.log.at(-1)).toBe("status:false"));
    expect(net.conns[0]!.signal?.aborted).toBe(false);
    stopB();
    // The reader is unblocked by aborting, not by waiting for a frame.
    await vi.waitFor(() => expect(net.conns[0]!.signal?.aborted).toBe(true));
    expect(b.log.at(-1)).toBe("status:false");
    // A new subscriber opens a fresh stream.
    const c = collect();
    const stopC = subscribeEvents({
      fetch: net.fn,
      url: URL_,
      events: config,
      ...c.handlers,
    });
    await vi.waitFor(() => expect(net.conns).toHaveLength(2));
    stopC();
  });

  it("a join after the last leave ends with a live reader, whatever the old one is doing", async () => {
    const net = sseFetch();
    const first = collect();
    const stopFirst = subscribeEvents({
      fetch: net.fn,
      url: URL_,
      events: config,
      ...first.handlers,
    });
    await vi.waitFor(() => expect(net.conns).toHaveLength(1));
    net.conns[0]!.push(handshake("one"));
    await vi.waitFor(() => expect(first.log).toEqual(["status:true"]));
    // Leave and join in the same tick: the old reader is still stopping.
    stopFirst();
    const second = collect();
    const stopSecond = subscribeEvents({
      fetch: net.fn,
      url: URL_,
      events: config,
      ...second.handlers,
    });
    await vi.waitFor(() => expect(net.conns).toHaveLength(2));
    expect(net.conns[0]!.signal?.aborted).toBe(true);
    expect(net.conns[1]!.signal?.aborted).toBe(false);
    net.conns[1]!.push(handshake("two"));
    net.conns[1]!.push(frame(1, record("create", 9)));
    await vi.waitFor(() =>
      expect(second.log).toEqual(["status:true", "event:create:9"]),
    );
    // The old reader's exit did not clear the new one's state.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second.log).toEqual(["status:true", "event:create:9"]);
    expect(net.conns[1]!.signal?.aborted).toBe(false);
    stopSecond();
  });

  it("tells a listener that joins a connected stream it is up, immediately", async () => {
    const net = sseFetch();
    const a = collect();
    const stopA = subscribeEvents({
      fetch: net.fn,
      url: URL_,
      events: config,
      ...a.handlers,
    });
    await vi.waitFor(() => expect(net.conns).toHaveLength(1));
    net.conns[0]!.push(handshake("abc"));
    await vi.waitFor(() => expect(a.log).toEqual(["status:true"]));
    const b = collect();
    const stopB = subscribeEvents({
      fetch: net.fn,
      url: URL_,
      events: config,
      ...b.handlers,
    });
    expect(b.log).toEqual(["status:true"]); // synchronously, before any await
    stopA();
    stopB();
  });

  it("keeps hubs apart per fetch and url", async () => {
    const one = sseFetch();
    const two = sseFetch();
    const stops = [
      subscribeEvents({
        fetch: one.fn,
        url: URL_,
        events: config,
        onEvent: () => undefined,
      }),
      subscribeEvents({
        fetch: one.fn,
        url: `${URL_}2`,
        events: config,
        onEvent: () => undefined,
      }),
      subscribeEvents({
        fetch: two.fn,
        url: URL_,
        events: config,
        onEvent: () => undefined,
      }),
    ];
    await vi.waitFor(() => {
      expect(one.conns).toHaveLength(2);
      expect(two.conns).toHaveLength(1);
    });
    for (const stop of stops) {
      stop();
    }
  });

  it("signals onStatus(false) when the subscriber stops, whatever the reason", async () => {
    // The stream dies while onStatus handlers are being told: still closes cleanly.
    const net = sseFetch();
    const log: string[] = [];
    const hub = getEventHub({ fetch: net.fn, url: URL_, events: config });
    const stop = hub.subscribe({
      onEvent: () => undefined,
      onStatus: (connected) => {
        log.push(`s:${connected}`);
        if (!connected) {
          stop(); // unsubscribing from inside the handler: the loop must exit
        }
      },
    });
    await vi.waitFor(() => expect(net.conns).toHaveLength(1));
    net.conns[0]!.push(handshake("abc"));
    await vi.waitFor(() => expect(log).toEqual(["s:true"]));
    net.conns[0]!.end();
    // Told once for the loss and once for the unsubscribe: false is idempotent.
    await vi.waitFor(() =>
      expect(log).toEqual(["s:true", "s:false", "s:false"]),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(net.conns).toHaveLength(1);
  });

  it("survives a throwing handler and keeps delivering", async () => {
    const net = sseFetch();
    const seen: number[] = [];
    const stop = subscribeEvents({
      fetch: net.fn,
      url: URL_,
      events: config,
      onEvent: (event) => {
        if (event.recordId === 1) {
          throw new Error("boom");
        }
        seen.push(event.recordId);
      },
      onStatus: () => Promise.reject(new Error("boom")),
    });
    await vi.waitFor(() => expect(net.conns).toHaveLength(1));
    net.conns[0]!.push(handshake("abc"));
    net.conns[0]!.push(frame(1, record("create", 1)));
    net.conns[0]!.push(frame(2, record("create", 2)));
    await vi.waitFor(() => expect(seen).toEqual([2]));
    stop();
  });

  it("awaits async handlers in order", async () => {
    const net = sseFetch();
    const order: string[] = [];
    const stop = subscribeEvents({
      fetch: net.fn,
      url: URL_,
      events: config,
      onEvent: async (event) => {
        order.push(`start:${event.recordId}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(`end:${event.recordId}`);
      },
    });
    await vi.waitFor(() => expect(net.conns).toHaveLength(1));
    net.conns[0]!.push(handshake("abc"));
    net.conns[0]!.push(
      frame(1, record("create", 1)) + frame(2, record("create", 2)),
    );
    await vi.waitFor(() => expect(order).toHaveLength(4));
    expect(order).toEqual(["start:1", "end:1", "start:2", "end:2"]);
    stop();
  });

  it("subscribing twice with the same handlers counts twice", async () => {
    const net = sseFetch();
    const c = collect();
    const stop1 = subscribeEvents({
      fetch: net.fn,
      url: URL_,
      events: config,
      ...c.handlers,
    });
    const stop2 = subscribeEvents({
      fetch: net.fn,
      url: URL_,
      events: config,
      ...c.handlers,
    });
    await vi.waitFor(() => expect(net.conns).toHaveLength(1));
    net.conns[0]!.push(handshake("abc"));
    net.conns[0]!.push(frame(1, record("create", 1)));
    await vi.waitFor(() =>
      expect(c.log.filter((l) => l === "event:create:1")).toHaveLength(2),
    );
    stop1();
    expect(net.conns[0]!.signal?.aborted).toBe(false);
    stop2();
    await vi.waitFor(() => expect(net.conns[0]!.signal?.aborted).toBe(true));
  });

  it("unsubscribes when the signal aborts, and not at all if already aborted", async () => {
    const net = sseFetch();
    const c = collect();
    const controller = new AbortController();
    subscribeEvents({
      fetch: net.fn,
      url: URL_,
      events: config,
      signal: controller.signal,
      ...c.handlers,
    });
    await vi.waitFor(() => expect(net.conns).toHaveLength(1));
    controller.abort();
    await vi.waitFor(() => expect(net.conns[0]!.signal?.aborted).toBe(true));

    const done = subscribeEvents({
      fetch: net.fn,
      url: URL_,
      events: config,
      signal: controller.signal,
      ...c.handlers,
    });
    done();
    expect(net.conns).toHaveLength(1);

    // Calling the returned unsubscribe detaches the abort listener.
    const other = new AbortController();
    const stop = subscribeEvents({
      fetch: net.fn,
      url: URL_,
      events: config,
      signal: other.signal,
      ...c.handlers,
    });
    stop();
    other.abort();
    await vi.waitFor(() => expect(net.conns).toHaveLength(2));
  });
});
