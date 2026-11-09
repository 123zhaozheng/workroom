#!/usr/bin/env bash
# Source backup: git bundle (full history) + zip of the working tree (tracked files) into artifacts/backups/.
# Data volume backup is separate (see docs/operations.md): it contains user data and is never bundled with source.
set -euo pipefail
cd "$(dirname "$0")/.."
ts=$(date -u +%Y%m%dT%H%M%SZ)
out=artifacts/backups
mkdir -p "$out"
git bundle create "$out/workroom-$ts.bundle" --all
git archive --format=zip -o "$out/workroom-src-$ts.zip" HEAD
git rev-parse HEAD > "$out/workroom-$ts.HEAD"
ls -1t "$out"/workroom-*.bundle | tail -n +6 | xargs -r rm -f   # keep last 5
ls -1t "$out"/workroom-src-*.zip | tail -n +6 | xargs -r rm -f
echo "backup: $out/workroom-$ts.bundle ($(git rev-parse --short HEAD))"
