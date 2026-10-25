import { describe, expect, it } from "vitest";
import {
  ConnectionFailed,
  InsecureTransportError,
  createClient,
} from "../src/index.ts";
import type { ClientOptions } from "../src/index.ts";
import { isInsecureRemote } from "../src/auth.ts";
import { fakeFetch, fixture, json } from "./_support.ts";
import { run } from "../src/codegen/run.ts";

const manifest = fixture("admin.manifest.json");

function clientAt(origin: string, options: Partial<ClientOptions> = {}) {
  const { fetch, seen } = fakeFetch(() => json(manifest));
  const client = createClient({
    baseUrl: origin,
    manifestUrl: `${origin}/m`,
    fetch,
    tokenProvider: () => "tok",
    ...options,
  });
  return { client, seen };
}

describe("isInsecureRemote", () => {
  it.each([
    "http://localhost",
    "http://localhost:8080/x",
    "http://LOCALHOST./x",
    "http://api.localhost",
    "http://a.b.localhost:3000",
    "http://127.0.0.1",
    "http://127.255.255.254:9",
    "http://127.1",
    "http://[::1]:8000",
    "https://api.example.com",
    "https://10.0.0.5",
    "ftp://example.com",
  ])("allows %s", (url) => {
    expect(isInsecureRemote(url)).toBe(false);
  });

  it.each([
    "http://api.example.com",
    "http://localhost.evil.example",
    "http://evil-localhost",
    "http://localhost@evil.example",
    "http://127.0.0.1.evil.example",
    "http://128.0.0.1",
    "http://10.0.0.5:8080",
    "http://[::2]",
    "http://[::ffff:8.8.8.8]",
  ])("flags %s", (url) => {
    expect(isInsecureRemote(url)).toBe(true);
  });
});

describe("bearer token over plain http", () => {
  it("refuses a non-loopback http host before sending, naming origin and opt-in", async () => {
    const { client, seen } = clientAt("http://api.example.com:8080");
    const error = await client.manifest().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InsecureTransportError);
    expect((error as Error).message).toContain("http://api.example.com:8080");
    expect((error as Error).message).toContain("allowInsecureHttp");
    expect(error).not.toBeInstanceOf(ConnectionFailed);
    expect(seen).toEqual([]);
  });

  it("refuses on resource calls too, not only on discovery", async () => {
    const { fetch, seen } = fakeFetch(() => json(manifest));
    const secure = createClient({
      baseUrl: "https://api.test",
      manifestUrl: "https://api.test/m",
      fetch,
    });
    const resource = await secure.resource("heroes");
    expect(resource).toBeDefined();
    seen.length = 0;
    const insecure = createClient({
      baseUrl: "http://api.test",
      manifestUrl: "http://api.test/m",
      fetch,
      tokenProvider: () => "tok",
    });
    await expect(insecure.resource("heroes")).rejects.toBeInstanceOf(
      InsecureTransportError,
    );
    expect(seen).toEqual([]);
  });

  it("refuses when a middleware rewrites the URL to plain http", async () => {
    const { fetch, seen } = fakeFetch(() => json(manifest));
    const client = createClient({
      baseUrl: "https://api.test",
      manifestUrl: "https://api.test/m",
      fetch,
      tokenProvider: () => "tok",
      middleware: [
        (ctx, next) =>
          next({
            ...ctx,
            request: new Request("http://elsewhere.example/m", ctx.request),
          }),
      ],
    });
    await expect(client.manifest()).rejects.toBeInstanceOf(
      InsecureTransportError,
    );
    expect(seen).toEqual([]);
  });

  it.each([
    "http://localhost:8000",
    "http://app.localhost",
    "http://127.0.0.1:8000",
    "http://127.9.9.9",
    "http://[::1]:8000",
    "https://api.example.com",
  ])("sends the token to %s", async (origin) => {
    const { client, seen } = clientAt(origin);
    await client.manifest();
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer tok");
  });

  it("sends the token when allowInsecureHttp is set", async () => {
    const { client, seen } = clientAt("http://api.example.com", {
      allowInsecureHttp: true,
    });
    await client.manifest();
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer tok");
  });

  it("still sends anonymous requests over plain http", async () => {
    for (const tokenProvider of [undefined, () => null, () => ""]) {
      const { client, seen } = clientAt("http://api.example.com", {
        tokenProvider,
      });
      await client.manifest();
      expect(seen[0]!.headers.get("authorization")).toBeNull();
    }
  });
});

describe("crud-sdk-codegen over plain http", () => {
  const args = ["--manifest", "http://api.example.com/m", "--out", "t.ts"];
  const harness = () => {
    const { fetch, seen } = fakeFetch(() => json(manifest));
    const err: string[] = [];
    const deps = {
      fetch,
      env: { CRUD_SDK_TOKEN: "tok" },
      loadCompiler: () =>
        Promise.resolve((_schema: unknown, name: string) =>
          Promise.resolve(`export interface ${name} {}\n`),
        ),
      writeFile: () => Promise.resolve(),
      stdout: () => undefined,
      stderr: (t: string) => err.push(t),
    };
    return { deps, seen, err };
  };

  it("refuses CRUD_SDK_TOKEN without the flag", async () => {
    const h = harness();
    expect(await run(args, h.deps)).toBe(1);
    expect(h.err[0]).toContain("http://api.example.com");
    expect(h.seen).toEqual([]);
  });

  it("sends it with --allow-insecure-http", async () => {
    const h = harness();
    expect(await run([...args, "--allow-insecure-http"], h.deps)).toBe(0);
    expect(h.seen[0]!.headers.get("authorization")).toBe("Bearer tok");
  });

  it("allows a loopback host without the flag", async () => {
    const h = harness();
    const local = ["--manifest", "http://localhost:8000/m", "--out", "t.ts"];
    expect(await run(local, h.deps)).toBe(0);
  });
});
