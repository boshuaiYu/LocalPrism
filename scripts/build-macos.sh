#!/usr/bin/env bash
# Build LocalPrism macOS installers (DMG / .app). Must run on macOS.
# Usage: bash scripts/build-macos.sh [aarch64-apple-darwin|x86_64-apple-darwin]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGET="${1:-aarch64-apple-darwin}"
export TECTONIC_DEP_BACKEND="${TECTONIC_DEP_BACKEND:-vcpkg}"
export VCPKG_ROOT="${VCPKG_ROOT:-$HOME/vcpkg}"
export CXXFLAGS="${CXXFLAGS:--std=c++17}"
export CFLAGS="${CFLAGS:-}"

corepack pnpm --filter=@claude-prism/desktop tauri build \
  --target "$TARGET" \
  --no-sign \
  --config src-tauri/tauri.local-build.conf.json

echo "==> macOS artifacts"
find "$ROOT/apps/desktop/src-tauri/target/$TARGET/release/bundle" \
  -type f \( -name '*.dmg' -o -name '*.app.tar.gz' \) -print
