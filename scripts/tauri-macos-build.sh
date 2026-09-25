#!/usr/bin/env bash
# macOS Tauri build used by Build Desktop.
#
# bundle_dmg.sh / hdiutil fails intermittently on GitHub macos runners after the
# .app is already signed (same image, same ad-hoc identity, ~8s then exit 1,
# with no hdiutil stderr unless --verbose). A later attempt on the same commit
# succeeds. Retry only that failure; other build errors stop immediately.
#
# Usage: bash scripts/tauri-macos-build.sh <aarch64-apple-darwin|x86_64-apple-darwin>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGET="${1:?target triple required}"
MAX_ATTEMPTS="${TAURI_DMG_BUILD_ATTEMPTS:-3}"

# Do not pass `--no-sign` when TAURI_SIGNING_PRIVATE_KEY is set.
# In Tauri CLI 2 that flag skips Apple codesign AND updater minisign
# ("Updater signing is skipped due to --no-sign flag."), so
# *.app.tar.gz.sig is never written and publish cannot build latest.json.
# With an updater key but no Developer ID, use Tauri's ad-hoc identity
# "-" (https://v2.tauri.app/distribute/sign/macos/#ad-hoc-signing).
EXTRA=()
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  EXTRA+=(--config src-tauri/tauri.local-build.conf.json)
fi
if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    export APPLE_SIGNING_IDENTITY="-"
  else
    EXTRA+=(--no-sign)
  fi
fi

cleanup_dmg_state() {
  if [ -d /Volumes/LocalPrism ]; then
    hdiutil detach /Volumes/LocalPrism -force || true
  fi
  local bundle="apps/desktop/src-tauri/target/${TARGET}/release/bundle"
  rm -f "${bundle}/dmg/"*.dmg "${bundle}/macos/rw."*.dmg || true
}

attempt=1
while true; do
  args=(--target "$TARGET")
  if [ "${#EXTRA[@]}" -gt 0 ]; then
    args+=("${EXTRA[@]}")
  fi
  # First attempt stays quiet. Retries turn on Tauri's script trace so the
  # hdiutil line is in the log if the flake persists.
  if [ "$attempt" -gt 1 ]; then
    args+=(--verbose)
    echo "==> Retrying macOS Tauri build (attempt ${attempt}/${MAX_ATTEMPTS})"
  fi

  log="$(mktemp)"
  set +e
  pnpm --filter @claude-prism/desktop tauri build "${args[@]}" 2>&1 | tee "$log"
  code="${PIPESTATUS[0]}"
  set -e

  if [ "$code" -eq 0 ]; then
    rm -f "$log"
    exit 0
  fi

  dmg_failed=0
  if grep -q "bundle_dmg.sh" "$log"; then
    dmg_failed=1
  fi
  rm -f "$log"

  if [ "$dmg_failed" -eq 0 ] || [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    echo "macOS Tauri build failed (attempt ${attempt}/${MAX_ATTEMPTS})" >&2
    exit "$code"
  fi

  echo "bundle_dmg.sh failed; detaching leftover volumes before retry" >&2
  cleanup_dmg_state
  sleep $((attempt * 10))
  attempt=$((attempt + 1))
done
