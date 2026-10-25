#!/usr/bin/env bash
# `make verify-published`: install the release that `publish-packages` just
# uploaded from the registry into a scratch project and import every
# `exports` entry.
#
# Runs after the GitHub release exists and the upload succeeded, only when a
# *_PUBLISH variable is set (release.yml), with no secrets or OIDC token; with
# NPM_PUBLISH unset (another registry is publishing) it does nothing. Needs
# `dist/` (the tarball `build` produced names the expected package and
# version).
#
# Reads: NPM_PUBLISH, and RELEASE_CHECK_ATTEMPTS / RELEASE_CHECK_DELAY
# (retry tuning for registry propagation, defaults 3 and 5 seconds,
# doubling).
#
# A first release is staged, so it is not installable until a maintainer
# approves it: a version that is not on the registry yet is a notice, not a
# failure.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/release-lib.sh
source scripts/release-lib.sh

if [[ -z ${NPM_PUBLISH:-} ]]; then
    echo "NPM_PUBLISH not set -- nothing to verify."
    exit 0
fi

use_npm

tmp=$(mktemp -d)
on_exit "rm -rf '$tmp'"

tarball=$(find_tarball)
name=$(tarball_field "$tarball" name)
version=$(tarball_field "$tarball" version)

echo "== registry: $name@$version"
attempts=${RELEASE_CHECK_ATTEMPTS:-3}
delay=${RELEASE_CHECK_DELAY:-5}
for ((i = 1; i <= attempts; i++)); do
    # `npm view name@version version` exits 0 with empty output when the
    # package exists but that version does not (still propagating, or staged
    # and unapproved), and exits 1 with E404 when the package is unknown.
    if found=$(npm view "$name@$version" version 2>"$tmp/err"); then
        if [[ -n $found ]]; then
            mkdir "$tmp/published"
            install_into "$tmp/published" "$name@$version"
            check_import "$tmp/published" "$name" "$version"
            exit 0
        fi
    # Anything but "not found" (network, auth) is a real failure.
    elif ! grep -q E404 "$tmp/err"; then
        cat "$tmp/err" >&2
        exit 1
    fi
    if ((i < attempts)); then
        echo "attempt $i/$attempts: not found; retrying in ${delay}s (registry propagation)"
        sleep "$delay"
        delay=$((delay * 2))
    fi
done
echo "NOTICE: $name@$version is not yet on the registry (staged, awaiting approval?)."
echo "NOTICE: approve it with 'npm stage approve <stage-id>'."
