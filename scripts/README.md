# scripts/

- `develop.sh` — `../.devcontainer/Dockerfile`'s `develop`-stage setup: installs `prek`,
  the Claude Code CLI, `snip` and the GitHub CLI (`gh`), the only tooling this template requires
  regardless of instance language. An instance adds its own language
  runtime/tooling install on top, either by extending this script or
  copying its shape into a second script. Prefer the hook below over
  either.
- `post-create.sh` — the devcontainer's `postCreateCommand`: git
  `safe.directory`, `prek install`, then every `post-create.d/*.sh`.
- `release-*.sh` — the release logic behind the `Makefile` targets (see
  `docs/TEMPLATE.md`, "Package template notes"). `release-lib.sh` (sourced)
  pins the npm and Syft versions; `release-run.sh` runs a script on the
  host, or in the pinned Node image when the host has no pnpm;
  `release-build.sh` stamps the version, builds and packs into `dist/`;
  `release-sbom.sh` (+ `release-sbom-install.sh`, `release-field.sh`) writes the SPDX SBOM;
  `release-publish.sh` skips, stages with the bootstrap token
  (`npm stage publish`) or publishes through OIDC, under a dist-tag from
  `dist_tag` (prerelease id or `next`; `v<major>-latest` for a backport); `release-check.sh`
  installs the `dist/` tarball into a scratch project and imports every
  `exports` entry, then, if `NPM_PUBLISH` is set, does the same from the
  registry (a version not there yet, e.g. staged and unapproved, is a
  notice, not a failure).
- `develop.d/`, `post-create.d/` — instance hook directories. This template
  ships `develop.d/10-corepack.sh` (enables pnpm, installing a pinned
  Corepack when Node lacks one) and
  `post-create.d/10-pnpm-install.sh` (installs dependencies); a package adds
  its own scripts after them.

## Do

- Keep this script's own tools pinned to an exact version (a `# renovate:`
  ARG in `../.devcontainer/Dockerfile`) and checksum-verified where the upstream project
  publishes checksums, matching the pattern each install step here already
  follows.
- Keep `NPM_VERSION` in `release-lib.sh` at 11.15.0 or later (staged
  publishing) and pin it exactly, with its `# renovate:` marker.

## Don't

- Set or export `NODE_AUTH_TOKEN` in a release script, even empty: npm's
  OIDC trusted publishing breaks if it is present.
- Add a language runtime or stack-specific tool here — that belongs in the
  instance's own layer (`develop.d/`), not the base template's.
