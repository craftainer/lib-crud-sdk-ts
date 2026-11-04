import { CrudError, describeUrl } from "../errors.ts";
import type { JsonObject, Manifest, Resource } from "../manifest.ts";

/** The part of `json-schema-to-typescript`'s `compile` this tool uses. */
export type Compile = (
  schema: JsonObject,
  name: string,
  options: Record<string, unknown>,
) => Promise<string>;

/** Loads the optional peer `json-schema-to-typescript`; a clear error when it is missing. */
export async function loadCompiler(): Promise<Compile> {
  try {
    const mod = await import("json-schema-to-typescript");
    return mod.compile as unknown as Compile;
  } catch (error) {
    throw new CrudError(
      "crud-sdk-codegen needs the optional peer dependency json-schema-to-typescript: " +
        "install it (for example `pnpm add -D json-schema-to-typescript`) and run again",
      { cause: error },
    );
  }
}

const OPTIONS = {
  bannerComment: "",
  additionalProperties: false,
  // Inline `$defs` so two resources never declare the same helper type twice.
  declareExternallyReferenced: false,
  // The schemas are server-supplied: never read a file or call a URL for a `$ref`.
  $refOptions: { resolve: { file: false, http: false, external: false } },
};

/** Keywords the compiler copies into the output verbatim (`tsType`) or uses to name code (`tsEnumNames`). */
const CODE_KEYWORDS: ReadonlySet<string> = new Set(["tsType", "tsEnumNames"]);

const DATA_KEYWORDS: ReadonlySet<string> = new Set([
  "default",
  "const",
  "enum",
  "examples",
]);

/** Keywords whose object holds schemas under author-chosen names, not keywords. */
const NAME_MAPS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

/**
 * Prepares a server-supplied schema for the compiler:
 *
 * - drops `title` annotations below the root: the compiler turns each into a
 *   named type alias, which would collide across resources (and `Name` says
 *   little). A property that is itself called `title` stays;
 * - drops `tsType` and `tsEnumNames`, which the compiler would write into the
 *   generated source as code;
 * - rejects a `$ref` that leaves the document (anything not starting with `#`).
 */
function withoutTitles(node: unknown, isPropertyMap = false): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => withoutTitles(item));
  }
  if (typeof node !== "object" || node === null) {
    return node;
  }
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (!isPropertyMap && CODE_KEYWORDS.has(key)) {
      continue;
    }
    if (
      !isPropertyMap &&
      key === "$ref" &&
      typeof value === "string" &&
      !value.startsWith("#")
    ) {
      throw new CrudError(
        `the schema has a $ref that leaves the manifest ("${value.slice(0, 80)}"): only "#..." references are supported`,
      );
    }
    if (isPropertyMap || key !== "title" || typeof value !== "string") {
      // Data keywords hold values, not schemas: leave them whole.
      out[key] =
        !isPropertyMap && DATA_KEYWORDS.has(key)
          ? value
          : withoutTitles(value, !isPropertyMap && NAME_MAPS.has(key));
    }
  }
  return out;
}

/** `heroes` + `v2` -> `HeroesV2` (the prefix of the generated interface names). */
export function typeName(
  resource: Pick<Resource, "name" | "api_version">,
): string {
  const words = `${resource.name} ${resource.api_version}`.split(
    /[^A-Za-z0-9]+/,
  );
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

/** A `--manifest` URL without credentials, query or fragment (they may hold secrets and are not provenance). */
export function describeSource(source: string): string {
  if (!/^https?:\/\//i.test(source)) {
    return source;
  }
  return describeUrl(source);
}

/**
 * The interface name of every resource and view, or a `CrudError` when two
 * resources would share one (`hero-x` and `hero_x`) or a name is not a valid
 * TypeScript identifier (a leading digit, or nothing left after stripping).
 */
function interfaceNames(manifest: Manifest): Map<Resource, string> {
  const owners = new Map<string, string>();
  const names = new Map<Resource, string>();
  for (const resource of manifest.resources) {
    const label = `${resource.name} ${resource.api_version}`;
    const name = typeName(resource);
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
      throw new CrudError(
        `resource "${label}" maps to "${name}", which is not a valid TypeScript identifier`,
      );
    }
    const clash = owners.get(name);
    if (clash !== undefined) {
      throw new CrudError(
        `resources "${clash}" and "${label}" both map to the type name "${name}"`,
      );
    }
    owners.set(name, label);
    names.set(resource, name);
  }
  return names;
}

/**
 * TypeScript source with one interface per resource and record view:
 * `<Name><Version>Read`, `...Create`, `...Update` and, when the resource has
 * one, `...Draft`. The output has no timestamp, so it is reproducible.
 */
export async function generateTypes(
  manifest: Manifest,
  source: string,
  compile: Compile,
): Promise<string> {
  const chunks = [
    `// Generated by crud-sdk-codegen from ${describeSource(source)} (${manifest.service.name} ${manifest.service.version}).`,
    "// Do not edit by hand: regenerate.",
    "",
  ];
  for (const [resource, base] of interfaceNames(manifest)) {
    const views = [
      ["Read", resource.schemas.read],
      ["Create", resource.schemas.create],
      ["Update", resource.schemas.update],
      ["Draft", resource.schemas.draft],
    ] as const;
    for (const [view, schema] of views) {
      if (schema !== null) {
        const name = base + view;
        // The root title names the interface.
        const root = { ...(withoutTitles(schema) as JsonObject), title: name };
        chunks.push((await compile(root, name, OPTIONS)).trimEnd(), "");
      }
    }
  }
  return chunks.join("\n");
}
