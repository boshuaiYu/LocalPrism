#!/usr/bin/env bash
# Build LocalPrism Linux installers (AppImage / .deb / .rpm). Must run on Linux.
#
#   bash scripts/build-linux.sh
#
# Build machine (Debian/Ubuntu), not the end-user runtime set:
#   sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
#     patchelf libssl-dev libicu-dev libgraphite2-dev libharfbuzz-dev \
#     libfreetype-dev libfontconfig1-dev libpng-dev zlib1g-dev
#
# The .deb runtime Depends (libwebkit2gtk-4.1-0, GTK 3, appindicator) and the
# .rpm Requires (webkit2gtk4.1, gtk3) live in src-tauri/tauri.conf.json.
# Users should install the deb with apt, not dpkg -i, so those packages are
# pulled in. See the Linux section of the README.
#
# After the binary is linked, scripts/check-linux-desktop-symbols.sh rejects a
# build that exports static GLib/expat/zlib/ICU symbols. Those exports crash
# GTK on newer distros (Debian 13 SIGSEGV in g_application_register; Ubuntu
# 24.04 aborts in g_string_free / XML_ParserFree).
#
# Smoke-test the unpacked binary (does not need the AppImage):
#   xvfb-run -a dbus-run-session -- \
#     apps/desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/claude-prism-desktop
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

bash "$ROOT/scripts/check-linux-desktop-symbols.sh" \
  "$ROOT/apps/desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/claude-prism-desktop"

echo "==> Linux artifacts"
find "$ROOT/apps/desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle" \
  -type f \( -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' \) -print
