#!/usr/bin/env bash
# Re-sign updater binaries with the release key and emit latest.json.
# Runs only in the dedicated sign-updater job.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ARTIFACTS="${ARTIFACTS_DIR:-artifacts}"
UPLOAD="${UPLOAD_DIR:-signed-upload}"
mkdir -p "$UPLOAD"

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "TAURI_SIGNING_PRIVATE_KEY is not available; not producing latest.json."
  echo "unsigned" > "$UPLOAD/.no-release-signatures"
  exit 0
fi

mapfile -d '' files < <(find "$ARTIFACTS" -type f \( \
  -name '*-setup.exe' -o \
  -name '*.app.tar.gz' -o \
  -name '*.AppImage' \
\) -print0)

if [[ ${#files[@]} -eq 0 ]]; then
  echo "No updater binaries were found to sign." >&2
  exit 1
fi

for file in "${files[@]}"; do
  [[ -z "$file" ]] && continue
  echo "Signing ${file}"
  tauri signer sign "$file"
done

copy_signed_updater_files() {
  local file rel dest
  for file in "${files[@]}"; do
    [[ -z "$file" ]] && continue
    rel="${file#"$ARTIFACTS"/}"
    dest="$UPLOAD/$rel"
    mkdir -p "$(dirname "$dest")"
    cp "$file" "$dest"
    if [[ -f "${file}.sig" ]]; then
      cp "${file}.sig" "${dest}.sig"
    fi
  done
}

if [[ -z "${TAG:-}" ]]; then
  echo "No release tag; uploading re-signed updater binaries only."
  copy_signed_updater_files
  echo "signed-binaries-only" > "$UPLOAD/.signed-without-manifest"
  exit 0
fi

node --experimental-strip-types --disable-warning=ExperimentalWarning \
  apps/desktop/scripts/generate-latest-json.ts \
  --artifacts "$ARTIFACTS" \
  --upload "$UPLOAD"
