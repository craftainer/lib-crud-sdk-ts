import { describe, expect, it } from "vitest";
import {
  CATALOG_PATH,
  ManifestError,
  PROFILE,
  findResource,
  loadManifest,
  manifestUrlFromCatalog,
  parseManifest,
} from "../src/index.ts";
import type { Manifest, Resource } from "../src/index.ts";
import { fixture } from "./_support.ts";

const admin = fixture("admin.manifest.json") as Record<string, any>;
const mutate = (fn: (doc: Record<string, any>) => void): unknown => {
  const doc = structuredClone(admin);
  fn(doc);
  return doc;
};

describe("parseManifest", () => {
  it("parses every fixture", () => {
    for (const name of [
      "admin",
      "anonymous",
      "hero-reader",
      "legacy-reader",
      "stranger",
    ]) {
      const manifest = parseManifest(fixture(`${name}.manifest.json`));
      expect(manifest.manifest_version).toBe("1");
    }
    const parsed = parseManifest(admin);
    expect(parsed.service).toEqual({ name: "heroes-api", version: "1.4.0" });
    expect(parsed.resources.map((r) => `${r.name}/${r.api_version}`)).toEqual([
      "heroes/v1",
      "heroes/v2",
      "quests/v1",
    ]);
    const v2 = parsed.resources[1]!;
    expect(v2.capabilities.events?.resume_param).toBe("subscriber_id");
    expect(v2.pagination.skip_param).toBe("skip");
    expect(v2.bulk.max_matched).toBe(1000);
    expect(
      parsed.resources[2]!.fields.find((x) => x.name === "difficulty")?.choices,
    ).toEqual(["easy", "hard", "deadly"]);
  });

  it("ignores unknown members at every level", () => {
    const doc = mutate((d) => {
      d["future"] = 1;
      d["service"]["future"] = 1;
      d["resources"][0]["future"] = 1;
      d["resources"][0]["fields"][0]["future"] = 1;
      d["resources"][0]["capabilities"]["future"] = 1;
      d["resources"][0]["capabilities"]["events"]["future"] = 1;
    });
    expect(parseManifest(doc)).toEqual(parseManifest(admin));
  });

  it("keeps optional members null", () => {
    const doc = mutate((d) => {
      const r = d["resources"][0];
      r["capabilities"]["events"] = null;
      r["schemas"]["draft"] = null;
      r["fields"][0]["choices"] = null;
      delete r["cache"]["stats_ttl"];
      r["auth"]["oidc_discovery_url"] = null;
    });
    const r = parseManifest(doc).resources[0]!;
    expect(r.capabilities.events).toBeNull();
    expect(r.schemas.draft).toBeNull();
    expect(r.cache.stats_ttl).toBeNull();
    expect(r.auth.oidc_discovery_url).toBeNull();
  });

  it("drops non-string path entries", () => {
    const doc = mutate((d) => {
      d["resources"][0]["paths"]["junk"] = 5;
    });
    expect(parseManifest(doc).resources[0]!.paths).not.toHaveProperty("junk");
  });

  it.each<[string, (d: Record<string, any>) => void]>([
    ["manifest_version missing", (d) => delete d["manifest_version"]],
    ["unsupported version", (d) => (d["manifest_version"] = "2")],
    ["service not an object", (d) => (d["service"] = [])],
    ["resources not a list", (d) => (d["resources"] = {})],
    ["resource not an object", (d) => (d["resources"][0] = 5)],
    ["string member wrong", (d) => (d["resources"][0]["name"] = 5)],
    [
      "bool member wrong",
      (d) => (d["resources"][0]["fields"][0]["sortable"] = "yes"),
    ],
    [
      "number member wrong",
      (d) =>
        (d["resources"][0]["capabilities"]["events"]["keepalive_seconds"] =
          "15"),
    ],
    [
      "number not finite",
      (d) =>
        (d["resources"][0]["capabilities"]["events"]["keepalive_seconds"] =
          null),
    ],
    [
      "int member fractional",
      (d) => (d["resources"][0]["pagination"]["max_limit"] = 1.5),
    ],
    [
      "list member wrong",
      (d) => (d["resources"][0]["fields"][0]["filter_ops"] = "eq"),
    ],
    [
      "list of non strings",
      (d) => (d["resources"][0]["fields"][0]["filter_ops"] = [1]),
    ],
    ["object member wrong", (d) => (d["resources"][0]["cache"] = 1)],
    [
      "optional member wrong",
      (d) => (d["resources"][0]["cache"]["stats_ttl"] = "x"),
    ],
  ])("rejects: %s", (_name, fn) => {
    expect(() => parseManifest(mutate(fn))).toThrow(ManifestError);
  });

  it("rejects a non-object document", () => {
    expect(() => parseManifest([])).toThrow(ManifestError);
    expect(() => parseManifest(null)).toThrow("not a JSON object");
  });
});

describe("findResource", () => {
  const manifest = parseManifest(
    mutate((d) => {
      const extra = structuredClone(d["resources"][1]);
      extra.api_version = "v10";
      const odd = structuredClone(d["resources"][1]);
      odd.api_version = "next";
      const same = structuredClone(d["resources"][1]);
      d["resources"].push(extra, odd, same);
    }),
  );

  it("takes the highest version numerically, the first among equals", () => {
    expect(findResource(manifest, "heroes")?.api_version).toBe("v10");
    expect(findResource(manifest, "quests")?.api_version).toBe("v1");
  });

  it("takes an exact version", () => {
    expect(findResource(manifest, "heroes", "v1")?.api_version).toBe("v1");
    expect(findResource(manifest, "heroes", "next")?.api_version).toBe("next");
    expect(findResource(manifest, "heroes", "v9")).toBeUndefined();
    expect(findResource(manifest, "nope")).toBeUndefined();
  });

  it("ranks only the spec's v<N> numerically", () => {
    const resource = (api_version: string) =>
      ({ name: "heroes", api_version }) as Resource;
    const pick = (...versions: string[]) =>
      findResource(
        { resources: versions.map(resource) } as unknown as Manifest,
        "heroes",
      )?.api_version;
    expect(pick("v2beta", "v1")).toBe("v1"); // suffixed: not a version number
    expect(pick("x5", "v1")).toBe("v1"); // wrong prefix
    expect(pick("v1", "v02")).toBe("v02");
  });

  it("ranks a non numeric version lowest", () => {
    const only = {
      ...manifest,
      resources: [manifest.resources[4]!, manifest.resources[1]!],
    };
    expect(findResource(only as Manifest, "heroes")?.api_version).toBe("v2");
  });
});

describe("discovery", () => {
  const catalog = (href: unknown, profile: unknown = PROFILE) => ({
    linkset: [{ anchor: "x", describedby: [{ href, profile }] }],
  });

  it("finds the manifest link and resolves it against the catalog URL", () => {
    expect(
      manifestUrlFromCatalog(
        catalog("/api/_crud/manifest"),
        "https://a.test/.well-known/api-catalog",
      ),
    ).toBe("https://a.test/api/_crud/manifest");
    expect(
      manifestUrlFromCatalog(
        catalog("https://a.test/other/m"),
        "https://a.test/c",
      ),
    ).toBe("https://a.test/other/m");
  });

  it("refuses a link to another origin (the token would follow)", () => {
    expect(() =>
      manifestUrlFromCatalog(
        catalog("https://other.test/m"),
        "https://a.test/c",
      ),
    ).toThrow(/another origin/);
  });

  it.each([
    ["not an object", null],
    ["no linkset", {}],
    ["linkset entry not an object", { linkset: [1] }],
    ["describedby not a list", { linkset: [{ describedby: 1 }] }],
    ["link not an object", { linkset: [{ describedby: [1] }] }],
    ["other profile", catalog("/m", "other")],
    ["href not a string", catalog(5)],
  ])("rejects a catalog: %s", (_name, linkset) => {
    expect(() => manifestUrlFromCatalog(linkset, "https://a.test/c")).toThrow(
      ManifestError,
    );
  });

  it("loads through the catalog, or directly", async () => {
    const calls: [string, boolean][] = [];
    const getJson = (url: string, isCatalog: boolean): Promise<unknown> => {
      calls.push([url, isCatalog]);
      return Promise.resolve(isCatalog ? catalog("/m") : admin);
    };
    await loadManifest(getJson, "https://a.test/some/path");
    expect(calls).toEqual([
      [`https://a.test${CATALOG_PATH}`, true],
      ["https://a.test/m", false],
    ]);
    calls.length = 0;
    await loadManifest(getJson, "https://a.test", "https://a.test/direct");
    expect(calls).toEqual([["https://a.test/direct", false]]);
  });
});
