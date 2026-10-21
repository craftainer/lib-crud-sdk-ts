# 0001. Provide an npm package template with staged bootstrap and trusted publishing

## Status

Proposed

## Context

The CRUD framework's TypeScript SDK and its React views are packages that
several applications consume, and more will follow. Each needs the same
quality bar (strict types, a 100% coverage gate, linting, a package that
resolves correctly for ESM and TypeScript consumers) and a release path to
npm. Copying that setup by hand would let the copies drift.
`template-python-package` solved this for Python; the TypeScript packages
should share one release contract with it: the version lives only in the git
tag, `make build` stamps it, `release-check` installs the published artifact
back.

Publishing needs credentials. A long-lived npm token stored as a secret is a
standing risk; npm supports trusted publishing through GitHub's OIDC identity
(npm 11.5.1 or later). But npm has no pending publishers: a trusted
publisher can only be configured on a package that already exists, so the
first release of each package needs a token. npm is also removing direct
publishing for tokens that bypass 2FA (targeted January 2027), and offers
staged publishing (`npm stage publish`, npm 11.15.0 or later) instead: a
token can stage a release without 2FA, and a maintainer approves it with 2FA.
OIDC trusted publishing additionally breaks when `NODE_AUTH_TOKEN` is set,
even to an empty string, so a workflow cannot simply map an optional token
secret to it.

A scoped package under the `craftainer` org is named `@craftainer/<name>`.

## Decision

We will create `craftainer/template-npm-package`, an instance of
`template-base` that is itself a template, and create every npm package from
it. It contains:

- an ESM-only TypeScript package built with `tsdown` (declarations
  generated, `isolatedDeclarations` on), pnpm via Corepack with
  `pnpm-lock.yaml` committed, and a hand-written `exports` map;
- `tsc --noEmit`, `vitest` with a 100% coverage gate, `oxlint`, `prettier`,
  `publint` and `arethetypeswrong`, all run by `prek`, with the build before
  the two checks that inspect `dist/`;
- a `Makefile` implementing `template-base`'s release contract with the
  logic in `scripts/release-*.sh`: one pure-JS tarball (`release-arches` is
  `["amd64"]`), a Syft SPDX SBOM of the tarball and its production
  dependencies, and `publish`, which is enabled by the `NPM_PUBLISH`
  variable and takes one of two paths: with the bootstrap `NPM_TOKEN` it runs
  `npm stage publish` (the token is stage-only, passed in a temporary npmrc),
  and without it `npm publish --provenance` through OIDC trusted publishing.
  It publishes the packed tarball from `dist/`, uses an exact pinned npm
  (11.15.0 or later) through `npx`, and never sets `NODE_AUTH_TOKEN`;
- a `release-check` that always installs the `dist/` tarball into a scratch
  project and imports every `exports` entry, and when publishing is on also
  installs the version from the registry. A version that is not on the
  registry yet is a notice, not a failure, because a staged release is not
  installable until it is approved;
- the GPL-3.0 license, matching the other templates, and a sync manifest
  that classifies the scaffold (`package.json`, `tsconfig*.json`,
  `tsdown.config.ts`, `vitest.config.ts`, `src/`, `tests/`,
  `pnpm-lock.yaml`) as instance-owned and the release scripts and the two
  hooks as template-owned.

A package's first release is staged with the bootstrap token and approved
with 2FA; the maintainer then configures the trusted publisher on npmjs.com
and deletes the token, and later releases go through OIDC.

## Consequences

- A new package starts with the full quality bar and release path, and
  receives fixes through two sync hops (`template-base`, then this
  template).
- No long-lived token outlives a package's first release, and the token that
  exists cannot publish on its own: a maintainer's 2FA is part of every
  bootstrap release. The cost is a manual approval step on the first release
  and a one-time trusted-publisher setup per package; npm expires a
  trusted-publisher configuration that has not published within 48 hours, so
  its setup is timed just before the next release.
- The bare release runner has docker but no pnpm, so `build` and `publish`
  fall back to the pinned Node image there. The Node version then has one
  source (`.devcontainer/Dockerfile`), but a package's `engines.node` has to
  be kept in step by hand.
- A first release that is staged and not yet approved passes
  `release-check` on the tarball alone; the registry install is verified
  only on later releases or after approval, so a staged release that is
  never approved is not caught by the release.
- `npm stage` is new and its CLI may still change; the scripts pin npm
  exactly and Renovate bumps it.
- The tool versions in `package.json` are instance-owned, so a template-side
  bump does not propagate by sync; Renovate keeps each package current
  instead, and packages can drift apart.
- Pure-JS ESM only: a package with native addons or a CommonJS build needs
  a per-arch matrix or another template.
