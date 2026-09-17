#!/usr/bin/env bash
# Validate that a release tag is strict SemVer AND that package.json matches it.
# The git tag is the single source of truth; this aborts before any publish if
# the tag is malformed or the package has drifted from it.
#
# Usage: validate-release-version.sh <ref-or-version>
#   ref may be refs/tags/vX.Y.Z, vX.Y.Z, or X.Y.Z. Reads ./package.json.
#   Echoes the bare version on success.
set -euo pipefail

ref="${1:?usage: validate-release-version.sh <ref-or-version>}"
V="${ref#refs/tags/}"
V="${V#v}"

# Full semver.org grammar, build metadata disallowed: each prerelease identifier
# is 0 | [1-9]digits | <alnum-with-letter/hyphen>, dot-separated and non-empty —
# so 1.2.3-01, 1.2.3-., 1.2.3-a..b are all rejected.
if ! printf '%s' "$V" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(\.(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*)?$'; then
  echo "::error::tag '${ref}' is not strict SemVer vMAJOR.MINOR.PATCH[-prerelease] (no leading zeros, no empty/dotted-empty prerelease ids, no +build)" >&2
  exit 1
fi

pkg_json="${PKG_JSON:-package.json}"   # test seam
pkg_v="$(node -p "require('./${pkg_json}').version")"
if [ "$pkg_v" != "$V" ]; then
  echo "::error::tag ${V} != package.json@${pkg_v} — bump the version to ${V} before tagging" >&2
  exit 1
fi

echo "$V"
