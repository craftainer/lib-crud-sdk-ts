/**
 * "Reset once per target per connection" (ADR 0002). A subscriber that is told
 * about a connection runs its reset through here; a second subscriber with the
 * same target (the same cache, or the same QueryClient, and resource) on the
 * same connection joins the first one's reset instead of running another.
 */
import type { EventConnection } from "./events.ts";

const ledger = new WeakMap<
  EventConnection,
  WeakMap<object, Map<string, Promise<void>>>
>();

/**
 * Runs `reset` unless `owner`/`key` was already reset on `connection`; resolves
 * when that reset is done, whoever started it. A failed reset is forgotten so
 * a later subscriber can retry.
 */
export function resetOnce(
  connection: EventConnection,
  owner: object,
  key: string,
  reset: () => Promise<void> | void,
): Promise<void> {
  let owners = ledger.get(connection);
  if (owners === undefined) {
    owners = new WeakMap();
    ledger.set(connection, owners);
  }
  let keys = owners.get(owner);
  if (keys === undefined) {
    keys = new Map();
    owners.set(owner, keys);
  }
  const done = keys.get(key);
  if (done !== undefined) {
    return done;
  }
  const started = (async (): Promise<void> => {
    await reset();
  })();
  keys.set(key, started);
  const forget = keys;
  started.catch(() => {
    forget.delete(key);
  });
  return started;
}
