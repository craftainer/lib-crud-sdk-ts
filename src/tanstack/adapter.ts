// Adapts TS1's `ResourceClient` (options-object methods) to the structural
// slices the `./tanstack` factories take (`list(query, { signal })`, ...).
import type { CrudClient, ResourceClient } from "../client.ts";
import type { JsonObject, Manifest } from "../manifest.ts";
import type { CrudQuery } from "./index.ts";

type Init = { signal?: AbortSignal };

/** What `tanstackApi` returns: every slice the factories use, bound to one resource. */
export interface TanstackApi<Read, Create, Update> {
  list(query: CrudQuery | undefined, init?: Init): Promise<Read[]>;
  get(id: number, init?: Init): Promise<Read>;
  stats(query: CrudQuery | undefined, init?: Init): Promise<JsonObject>;
  predict(query: CrudQuery | undefined, init?: Init): Promise<JsonObject>;
  revisions(id: number, init?: Init): Promise<JsonObject[]>;
  /** The manifest the client already loaded (the client's loader takes no signal). */
  manifest(init?: Init): Promise<Manifest>;
  create(body: Create): Promise<Read>;
  update(id: number, patch: Update, init?: { ifMatch?: string }): Promise<Read>;
  delete(id: number): Promise<void>;
}

/**
 * A query is the client's `ListOptions`, `StatsOptions` or `PredictOptions`
 * without `signal` (`{ filters, sort, skip, limit, ... }`); TanStack's signal
 * is added per call.
 */
export function tanstackApi<
  Read extends object,
  Create extends object,
  Update extends object,
>(
  client: CrudClient,
  resource: ResourceClient<Read, Create, Update>,
): TanstackApi<Read, Create, Update> {
  return {
    list: (query, init) => resource.list({ ...query, ...init }),
    get: (id, init) => resource.get(id, init),
    stats: (query, init) => resource.stats({ ...query, ...init }),
    predict: (query, init) => resource.predict({ ...query, ...init }),
    revisions: (id, init) => resource.revisions(id, init),
    manifest: () => client.manifest(),
    create: (body) => resource.create(body),
    update: (id, patch, init) => resource.update(id, patch, init),
    delete: (id) => resource.delete(id),
  };
}
