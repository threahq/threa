#!/usr/bin/env bash
# Repair the `xlsx` dependency when `bun install` drops it.
#
# Why this exists
# ---------------
# `apps/backend` pins xlsx to a CDN tarball (see apps/backend/package.json:
# "xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"). In the Claude
# Code web sandbox the SessionStart hook runs `rm -rf node_modules && bun install`
# on every session start/resume. `bun install` regularly reports success
# ("N packages installed") yet leaves xlsx ABSENT from the .bun store — the CDN
# fetch through the egress proxy stalls or is dropped while npm-registry deps
# resolve fine. Every backend `bun test` / `tsc` then dies immediately with
# `ENOENT reading .../node_modules/xlsx`, which looks unrelated to whatever you
# were doing.
#
# Two failure shapes have been seen:
#   1. The root `node_modules/xlsx` symlink is wiped but the store copy survives
#      — just needs relinking (ABSOLUTE path; a relative one fails from the
#      store's depth).
#   2. The store copy itself is gone — needs re-fetching. `curl` pulls the
#      tarball fine (HTTP 200, ~2.4 MB) where bun's fetch stalled.
#
# This script is idempotent and handles both: if xlsx already resolves it exits
# immediately; otherwise it curls the pinned tarball straight into the store and
# recreates both symlinks. Safe to run any time xlsx looks broken, and wired into
# the SessionStart hook so it self-heals after each install.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Store dir name is bun's hash of the tarball URL; stable while the pin holds.
STORE_DIR="node_modules/.bun/xlsx@https+++cdn.sheetjs.com+xlsx-0.20.3+xlsx-0.20.3.tgz/node_modules/xlsx"
XLSX_URL="https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"

relink() {
  ln -sfn "$ROOT/$STORE_DIR" node_modules/xlsx
  # apps/backend resolves xlsx via its own workspace symlink into the store.
  mkdir -p apps/backend/node_modules
  ln -sfn "../../../$STORE_DIR" apps/backend/node_modules/xlsx
}

# Fast path: store present, only the symlinks may be stale.
if [ -f "$STORE_DIR/package.json" ]; then
  relink
  [ -f node_modules/xlsx/package.json ] && exit 0
fi

echo "[ensure-xlsx] xlsx missing from the bun store — fetching $XLSX_URL" >&2
TARBALL="$(mktemp)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$TARBALL" "$STAGE"' EXIT

curl -sSL --max-time 120 -o "$TARBALL" "$XLSX_URL"
tar -xzf "$TARBALL" -C "$STAGE" --strip-components=1
if [ ! -f "$STAGE/package.json" ]; then
  echo "[ensure-xlsx] extracted tarball has no package.json — aborting" >&2
  exit 1
fi

rm -rf "$STORE_DIR"
mkdir -p "$(dirname "$STORE_DIR")"
mv "$STAGE" "$STORE_DIR"
trap 'rm -f "$TARBALL"' EXIT
relink

echo "[ensure-xlsx] xlsx repaired ($(grep -o '\"version\": *\"[^\"]*\"' "$STORE_DIR/package.json" | head -1))" >&2
