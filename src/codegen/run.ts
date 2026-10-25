import { readFile, writeFile } from "node:fs/promises";
import { createClient } from "../client.ts";
import { parseManifest } from "../manifest.ts";
import type { Manifest } from "../manifest.ts";
import { generateTypes, loadCompiler } from "./generate.ts";
import type { Compile } from "./generate.ts";

const USAGE = `Usage: crud-sdk-codegen --manifest <url|file> --out <file> [--allow-insecure-http]

Writes TypeScript interfaces (Read, Create, Update per resource) from the
JSON Schemas of a CRUD manifest. A URL is the manifest itself, or a server
origin (path "/") to discover it through the api-catalog. The manifest is
per caller: set CRUD_SDK_TOKEN to a bearer token to see more than the
anonymous view. The token is refused over plain http except to loopback;
--allow-insecure-http lifts that. Needs the optional peer json-schema-to-typescript.
`;

/** What {@link run} touches outside itself; tests replace them. */
export interface Deps {
  readonly fetch?: typeof fetch | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly loadCompiler?: (() => Promise<Compile>) | undefined;
  readonly readFile?: ((path: string) => Promise<string>) | undefined;
  readonly writeFile?:
    ((path: string, text: string) => Promise<void>) | undefined;
  readonly stdout?: ((text: string) => void) | undefined;
  readonly stderr?: ((text: string) => void) | undefined;
}

function parseArgs(
  argv: readonly string[],
): { manifest: string; out: string; allowInsecureHttp: boolean } | undefined {
  let manifest: string | undefined;
  let out: string | undefined;
  let allowInsecureHttp = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--allow-insecure-http") {
      allowInsecureHttp = true;
    } else if (argv[i] === "--manifest") {
      manifest = argv[(i += 1)];
    } else if (argv[i] === "--out") {
      out = argv[(i += 1)];
    } else {
      return undefined;
    }
  }
  return manifest === undefined || out === undefined
    ? undefined
    : { manifest, out, allowInsecureHttp };
}

async function readManifest(
  source: string,
  allowInsecureHttp: boolean,
  deps: Deps,
): Promise<Manifest> {
  if (!/^https?:\/\//.test(source)) {
    const text = await (deps.readFile ?? ((p) => readFile(p, "utf8")))(source);
    return parseManifest(JSON.parse(text));
  }
  const url = new URL(source);
  const token = deps.env?.["CRUD_SDK_TOKEN"];
  const client = createClient({
    baseUrl: url.href,
    fetch: deps.fetch,
    allowInsecureHttp,
    tokenProvider:
      token === undefined || token === "" ? undefined : () => token,
    ...(url.pathname === "/" ? {} : { manifestUrl: url.href }),
  });
  return client.manifest();
}

/** Runs the CLI; resolves to the process exit code. */
export async function run(
  argv: readonly string[],
  deps: Deps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((text) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text) => process.stderr.write(text));
  const args = parseArgs(argv);
  if (args === undefined) {
    stderr(USAGE);
    return 2;
  }
  try {
    const manifest = await readManifest(
      args.manifest,
      args.allowInsecureHttp,
      deps,
    );
    const compile = await (deps.loadCompiler ?? loadCompiler)();
    const text = await generateTypes(manifest, args.manifest, compile);
    await (deps.writeFile ?? ((p, t) => writeFile(p, t, "utf8")))(
      args.out,
      text,
    );
    stdout(`wrote ${args.out} (${manifest.resources.length} resources)\n`);
    return 0;
  } catch (error) {
    stderr(
      `crud-sdk-codegen: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
