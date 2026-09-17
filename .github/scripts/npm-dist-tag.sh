#!/usr/bin/env bash
# Echo the npm dist-tag for a release: a pre-release (vX.Y.Z-rc.1) must take
# `next`, never `latest`, or `npm install <pkg>` hands everyone the RC.
#
# Usage: npm-dist-tag.sh <ref-or-version>   ->  prints `next` or `latest`
set -euo pipefail

V="${1:?usage: npm-dist-tag.sh <ref-or-version>}"
V="${V#refs/tags/}"
V="${V#v}"
case "$V" in
  *-*) echo next ;;
  *)   echo latest ;;
esac
