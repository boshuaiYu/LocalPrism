#!/usr/bin/env bash
# Build LocalPrism Linux installers (AppImage / .deb). Must run on Linux.
# Usage: bash scripts/build-linux.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export TECTONIC_DEP_BACKEND="${TECTONIC_DEP_BACKEND:-pkg-config}"
export TECTONIC_PKGCONFIG_FORCE_SEMI_STATIC="${TECTONIC_PKGCONFIG_FORCE_SEMI_STATIC:-true}"
export CXXFLAGS="${CXXFLAGS:--std=c++17}"
export CFLAGS="${CFLAGS:-}"

corepack pnpm --filter=@claude-prism/desktop tauri build \
  --target x86_64-unknown-linux-gnu \
  --bundles appimage,deb \
  --config src-tauri/tauri.local-build.conf.json

echo "==> Linux artifacts"
find "$ROOT/apps/desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle" \
  -type f \( -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' \) -print
