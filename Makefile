# template-npm-package's implementation of template-base's release contract
# (docs/TEMPLATE.md, "Release: a Makefile contract"). release.yml sets
# RELEASE_VERSION / RELEASE_TAG / RELEASE_ARCH -- see there. One pure-JS
# tarball is built once, on one arch; the version lives only in the git tag
# and `build` stamps it. The logic is in scripts/release-*.sh; release-run.sh
# runs it on the host, or in the pinned Node image when the host has no pnpm
# (release.yml's bare runner). NPM_PUBLISH (a repository variable; any
# non-empty value) turns publishing on -- see scripts/README.md.

.PHONY: release-arches build sbom release-assets publish release-check finalize

release-arches:
	@echo '["amd64"]'

# Leaves only the packed tarball in dist/: dist/ is what release.yml attaches
# to the GitHub release.
build:
	scripts/release-run.sh scripts/release-build.sh

sbom:
	scripts/release-sbom.sh

release-assets:
	@set -e; for pat in 'dist/*.tgz' 'dist/*.spdx.json'; do \
		ls $$pat >/dev/null 2>&1 || { echo "missing release asset: $$pat" >&2; exit 1; }; \
	done; ls dist

publish:
	scripts/release-run.sh scripts/release-publish.sh

# Runs once after the arch leg, inside the devcontainer; dist/ holds the
# downloaded tarball. See scripts/release-check.sh.
release-check:
	scripts/release-check.sh

# Nothing to combine: a single tarball is built once.
finalize:
	@echo "Single pure-JS tarball -- nothing to finalize."
