#!/usr/bin/env bash
# `make release-check`: install the built tarball into a scratch project and
# import every `exports` entry; when publishing is on, do the same with the
# published release from the registry.
#
# Reads: NPM_PUBLISH (empty = skip the registry check), and
# RELEASE_CHECK_ATTEMPTS / RELEASE_CHECK_DELAY (retry tuning for registry
# propagation, defaults 3 and 5 seconds, doubling).
#
# A first release is staged, so it is not installable until a maintainer
# approves it: a version that is not on the registry yet is a notice, not a
# failure.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/release-lib.sh
source scripts/release-lib.sh
use_npm

tmp=$(mktemp -d)
on_exit "rm -rf '$tmp'"

tarball=$(find_tarball)
name=$(tarball_field "$tarball" name)
version=$(tarball_field "$tarball" version)

# <dir> <expected version>: import `name` and every exports subpath (ESM,
# Node) from the package installed in <dir>.
check_import() {
    (cd "$1" && node --input-type=module -e '
        import { readFileSync } from "node:fs";
        const [name, want] = process.argv.slice(1);
        const pkg = JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8"));
        if (pkg.version !== want) throw new Error(`installed ${name} ${pkg.version}, expected ${want}`);
        // exports may be missing, a string, an array, a conditions object
        // (no "."-prefixed keys) or a subpath map; only the last has several
        // entries. Without a subpath map the entry is the bare package name.
        const exp = pkg.exports;
        const isMap = exp && typeof exp === "object" && !Array.isArray(exp)
            && Object.keys(exp).some((k) => k.startsWith("."));
        const keys = isMap ? Object.keys(exp) : ["."];
        for (const key of keys) {
            if (key.endsWith(".json") || (isMap && exp[key] === null)) continue;
            if (key.includes("*")) {
                console.log(`NOTICE: skipping wildcard export ${key}`);
                continue;
            }
            const spec = name + key.slice(1);
            const mod = await import(spec);
            console.log(`OK: import ${spec} (${Object.keys(mod).length} exports)`);
        }
    ' "$name" "$2")
}

install_into() { # <dir> <package spec>
    echo '{"private":true,"type":"module"}' >"$1/package.json"
    (cd "$1" && npm install --ignore-scripts --no-audit --no-fund --silent "$2")
}

echo "== local tarball: $(basename "$tarball")"
mkdir "$tmp/local"
install_into "$tmp/local" "$tarball"
check_import "$tmp/local" "$version"

if [[ -z ${NPM_PUBLISH:-} ]]; then
    echo "NPM_PUBLISH not set -- skipping the registry check."
    exit 0
fi

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
            check_import "$tmp/published" "$version"
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
echo "NOTICE: approve it with 'npm stage approve <stage-id>'; the tarball check above passed."
