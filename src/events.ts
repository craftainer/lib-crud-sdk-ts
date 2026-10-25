/**
 * SSE subscriber that turns `GET {base_path}/events` into callbacks.
 *
 * One connection per (fetch, url), reference-counted and fanned out to every
 * subscriber. The caller passes an already authenticated `fetch`: this is
 * fetch streaming, not `EventSource`, because `EventSource` cannot send an
 * Authorization header. Frames carry no `event:` name: the first has
 * `id: 0` and `{"subscriber_id": ...}`; later ones are record events. A
 * reconnect passes `?{resume_param}=<subscriber_id>` explicitly (never
 * `Last-Event-ID`, which the server would read as a subscriber id) when the
 * stream replays, and always tells subscribers to reset, so the gap is
 * covered even without replay. A stream silent for three keep-alive
 * intervals is dead and is reconnected with exponential backoff and jitter.
 * Events invalidate; they never apply snapshots.
 *
 * A hub is shared by every subscriber of the same (fetch, url) and the first
 * subscriber's options win: the keep-alive, resume parameter, replay mode and
 * resource label of later subscribers are ignored. In development
 * (`process.env.NODE_ENV !== "production"`) a later subscriber whose options
 * differ gets a `console.warn` naming the URL and the fields.
 *
 * Every connection has an identity (an opaque {@link EventConnection}) that
 * the hub passes to `onReset` (for the connect reset) and to `onStatus(true)`.
 * A subscriber that joins an already connected hub, or during the handshake's
 * reset fan-out, gets no connect reset; it sees `onStatus(true)` with a
 * connection it was never reset for and resets itself (see `invalidateOnEvents`
 * and `bridgeEvents`).
 */
import { createParser } from "eventsource-parser";
import type { EventSourceMessage } from "eventsource-parser";
import type { CrudEvent, MaybePromise } from "./interfaces.ts";

/** The manifest's `capabilities.events` object (I1), plain. */
export interface EventsConfig {
  /** The server's event label, not the manifest name. */
  readonly resource: string;
  readonly path?: string;
  readonly resume_param?: string;
  readonly replay?: "persistent" | "none";
  readonly keepalive_seconds?: number;
}

/** Opaque identity of one connection of a hub; a new one per connect. */
export type EventConnection = object;

/**
 * What a subscriber wants to hear. A handler that throws must not kill the
 * stream, so errors are swallowed; handlers run one after another, in order.
 */
export interface EventHandlers {
  onEvent(event: CrudEvent): MaybePromise<void>;
  /**
   * After every connect (the first included), and for an event with no usable
   * record id: clear the resource. `connection` is set for the connect reset
   * only, and is the same object `onStatus(true)` then receives.
   */
  onReset?(connection?: EventConnection): MaybePromise<void>;
  /**
   * `true` when the stream is connected, `false` on any loss, exit or
   * unsubscribe. `connection` identifies the connection when `connected`.
   * A subscriber that joined after the connect reset gets `true` without
   * having been sent `onReset` for that connection.
   */
  onStatus?(
    connected: boolean,
    connection?: EventConnection,
  ): MaybePromise<void>;
}

/** A shared event stream: `subscribe` returns the (idempotent) unsubscribe. */
export interface EventHub {
  subscribe(handlers: EventHandlers): () => void;
}

export interface EventHubOptions {
  /** Authenticated; shared hubs are keyed by this function and `url`. */
  readonly fetch: typeof fetch;
  /** Absolute URL of the events endpoint. */
  readonly url: string;
  /**
   * Used only by the first subscriber of a hub (first wins): a later
   * subscriber's differing `resource`, `resume_param`, `replay` or
   * `keepalive_seconds` is ignored, with a development `console.warn`.
   */
  readonly events: EventsConfig;
  /** Jitter source in `[0, 1)`; defaults to `Math.random`. */
  readonly random?: () => number;
}

export interface SubscribeEventsOptions extends EventHubOptions, EventHandlers {
  /** Aborting unsubscribes. */
  readonly signal?: AbortSignal;
}

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const DEFAULT_KEEPALIVE_S = 15;
const DEAD_AFTER_KEEPALIVES = 3;
/** `setTimeout` clamps a longer delay to 1 ms, which would declare the stream dead at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const ACTIONS: ReadonlySet<unknown> = new Set([
  "create",
  "update",
  "delete",
  "restore",
]);

/**
 * The keep-alive interval in seconds. Zero, negative and non-finite values
 * are invalid and treated as unset, so the default applies (as the WHATWG SSE
 * spec ignores an invalid `retry` value instead of acting on it); otherwise a
 * dead-stream deadline of 0 would reconnect forever.
 */
function keepaliveSeconds(events: EventsConfig): number {
  const value = events.keepalive_seconds;
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_KEEPALIVE_S;
}

/** The `events` fields that change what a hub does, with defaults applied. */
function hubSettings(events: EventsConfig): Record<string, unknown> {
  return {
    resource: events.resource,
    resume_param: events.resume_param ?? "subscriber_id",
    replay: events.replay,
    keepalive_seconds: keepaliveSeconds(events),
  };
}

/** `process.env.NODE_ENV` is replaced by bundlers; without it (no `process`) assume development. */
function inDevelopment(): boolean {
  try {
    return process.env.NODE_ENV !== "production";
  } catch {
    return true;
  }
}

/** Warns, in development, that a later subscriber's options differ from the hub's. */
function warnOnDifferingOptions(
  hub: EventHubOptions,
  later: EventHubOptions,
): void {
  if (!inDevelopment()) {
    return;
  }
  const first = hubSettings(hub.events);
  const next = hubSettings(later.events);
  const differing = Object.keys(first).filter(
    (key) => first[key] !== next[key],
  );
  if (differing.length > 0) {
    console.warn(
      `crud-sdk: the event hub for ${hub.url} was opened with other events options; ` +
        `the first subscriber's win and these are ignored: ${differing.join(", ")}`,
    );
  }
}

const registry = new WeakMap<typeof fetch, Map<string, Hub>>();

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

class Hub {
  private readonly handlers = new Set<EventHandlers>();
  private readonly options: EventHubOptions;
  private readonly onEmpty: () => void;
  private controller: AbortController | undefined;
  private connected = false;
  private connection: EventConnection | undefined;
  private subscriberId: string | undefined;
  private attempt = 0;

  constructor(options: EventHubOptions, onEmpty: () => void) {
    this.options = options;
    this.onEmpty = onEmpty;
  }

  subscribe(handlers: EventHandlers, requested: EventHubOptions): () => void {
    if (this.handlers.size > 0) {
      warnOnDifferingOptions(this.options, requested);
    }
    // The same object may subscribe twice; give each subscription its own identity.
    const entry: EventHandlers = {
      onEvent: (event) => handlers.onEvent(event),
      onReset: (connection) => handlers.onReset?.(connection),
      onStatus: (connected, connection) =>
        handlers.onStatus?.(connected, connection),
    };
    this.handlers.add(entry);
    if (this.controller === undefined) {
      this.controller = new AbortController();
      void this.run(this.controller.signal);
    } else if (this.connected) {
      void this.guard(() => entry.onStatus?.(true, this.connection));
    }
    return () => {
      if (!this.handlers.delete(entry)) {
        return;
      }
      void this.guard(() => entry.onStatus?.(false));
      if (this.handlers.size === 0) {
        // Abort the live stream instead of waiting for the next frame.
        this.controller?.abort();
        this.controller = undefined;
        this.onEmpty();
      }
    };
  }

  private async guard(
    call: () => MaybePromise<void> | undefined,
  ): Promise<void> {
    try {
      await call();
    } catch {
      // A failing subscriber must not take the stream down.
    }
  }

  private async fan(
    call: (handlers: EventHandlers) => MaybePromise<void> | undefined,
  ): Promise<void> {
    for (const handlers of Array.from(this.handlers)) {
      await this.guard(() => call(handlers));
    }
  }

  private async setConnected(
    connected: boolean,
    connection?: EventConnection,
  ): Promise<void> {
    if (this.connected === connected) {
      return;
    }
    this.connected = connected;
    this.connection = connected ? connection : undefined;
    await this.fan((handlers) => handlers.onStatus?.(connected, connection));
  }

  private backoff(): number {
    const base = Math.min(BACKOFF_START_MS * 2 ** this.attempt, BACKOFF_MAX_MS);
    this.attempt += 1;
    const jitter = (this.options.random ?? Math.random)();
    return Math.min(base * (1 + 0.5 * jitter), BACKOFF_MAX_MS);
  }

  /** Connect, read and reconnect until aborted. */
  private async run(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        try {
          await this.readOnce(signal);
        } catch {
          // Lost, refused or dead: reconnect below.
        }
        await this.setConnected(false);
        await sleep(this.backoff(), signal);
      }
    } finally {
      // On any exit, tell the subscribers so the freshness gate closes.
      await this.setConnected(false);
    }
  }

  private resumeUrl(): string {
    const { url, events } = this.options;
    if (events.replay !== "persistent" || this.subscriberId === undefined) {
      return url;
    }
    const param = events.resume_param ?? "subscriber_id";
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}${encodeURIComponent(param)}=${encodeURIComponent(this.subscriberId)}`;
  }

  private async readOnce(signal: AbortSignal): Promise<void> {
    const deadMs = Math.min(
      keepaliveSeconds(this.options.events) * DEAD_AFTER_KEEPALIVES * 1000,
      MAX_TIMER_MS,
    );
    const conn = new AbortController();
    const abortConn = (): void => {
      conn.abort();
    };
    signal.addEventListener("abort", abortConn, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(abortConn, deadMs);
    };
    try {
      arm();
      const response = await this.options.fetch(this.resumeUrl(), {
        headers: { accept: "text/event-stream" },
        signal: conn.signal,
      });
      if (!response.ok || response.body === null) {
        throw new Error(`event stream refused: HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const pending: EventSourceMessage[] = [];
      const parser = createParser({
        onEvent: (message) => {
          pending.push(message);
        },
      });
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        parser.feed(decoder.decode(value, { stream: true }));
        // Any byte, keep-alive comments included, proves the stream is alive.
        // Handlers may be slow and nothing is read meanwhile, so the timer is
        // paused while they run and restarts once they are done.
        clearTimeout(timer);
        for (const message of pending.splice(0)) {
          await this.handle(message);
        }
        arm();
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abortConn);
      conn.abort(); // release the connection on every way out
    }
  }

  private async handle(message: EventSourceMessage): Promise<void> {
    let data: unknown;
    try {
      data = JSON.parse(message.data);
    } catch {
      return;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return;
    }
    const record = data as Record<string, unknown>;
    if ("subscriber_id" in record) {
      this.subscriberId = String(record["subscriber_id"]);
      this.attempt = 0;
      // Every connect, the first included: entries stored before this stream
      // (an earlier page session, a persisted store) may predate server changes.
      // A subscriber that joins while this fans out is not in it; it gets
      // `onStatus(true)` with this connection and resets itself.
      const connection: EventConnection = {};
      const present = new Set(this.handlers);
      await this.fan((handlers) => handlers.onReset?.(connection));
      if (this.connected) {
        // A repeated handshake on a live stream: whoever joined during the
        // fan-out was told about the old connection only.
        this.connection = connection;
        for (const handlers of Array.from(this.handlers)) {
          if (!present.has(handlers)) {
            await this.guard(() => handlers.onStatus?.(true, connection));
          }
        }
      } else {
        await this.setConnected(true, connection);
      }
      return;
    }
    if (record["resource"] !== this.options.events.resource) {
      return;
    }
    const action = record["action"];
    const recordId = record["record_id"];
    if (!ACTIONS.has(action) || !Number.isInteger(recordId)) {
      await this.fan((handlers) => handlers.onReset?.());
      return;
    }
    const snapshot = record["snapshot"];
    const event: CrudEvent = {
      resource: String(record["resource"]),
      recordId: recordId as number,
      action: action as CrudEvent["action"],
      snapshot:
        typeof snapshot === "object" && snapshot !== null
          ? (snapshot as Record<string, unknown>)
          : {},
      timestamp: String(record["timestamp"] ?? ""),
    };
    await this.fan((handlers) => handlers.onEvent(event));
  }
}

/**
 * The shared hub for `(fetch, url)`: the first subscriber opens the stream,
 * the last one aborts it. A later subscribe after that opens a fresh one.
 *
 * The first subscriber's `events` options win while the hub lives. A later
 * subscriber whose `resource`, `resume_param`, `replay` or `keepalive_seconds`
 * differ is served by the same stream with the first's values, and in
 * development (`process.env.NODE_ENV !== "production"`) gets a `console.warn`
 * naming the URL and the differing fields.
 */
export function getEventHub(options: EventHubOptions): EventHub {
  return {
    subscribe(handlers) {
      let hubs = registry.get(options.fetch);
      if (hubs === undefined) {
        hubs = new Map();
        registry.set(options.fetch, hubs);
      }
      const byUrl = hubs;
      let hub = byUrl.get(options.url);
      if (hub === undefined) {
        hub = new Hub(options, () => {
          byUrl.delete(options.url);
        });
        byUrl.set(options.url, hub);
      }
      return hub.subscribe(handlers, options);
    },
  };
}

/**
 * Subscribe to one resource's event stream. Returns the unsubscribe; the
 * last unsubscribe aborts the stream. `signal` aborting unsubscribes too.
 */
export function subscribeEvents(options: SubscribeEventsOptions): () => void {
  const { signal } = options;
  if (signal?.aborted === true) {
    return () => undefined;
  }
  const unsubscribe = getEventHub(options).subscribe(options);
  signal?.addEventListener("abort", unsubscribe, { once: true });
  return () => {
    signal?.removeEventListener("abort", unsubscribe);
    unsubscribe();
  };
}
