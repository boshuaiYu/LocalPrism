#!/usr/bin/env bash
# Create a throwaway updater key so `tauri build` can write updater archives.
# The release signing key is intentionally absent from build jobs.
set -euo pipefail

if [[ -z "${GITHUB_ENV:-}" ]]; then
  echo "GITHUB_ENV is required" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY_PATH="${RUNNER_TEMP:-/tmp}/ephemeral-updater.key"
PASSWORD="ephemeral"

cd "$ROOT"

generate_key() {
  local cmd=(pnpm --filter @claude-prism/desktop exec tauri signer generate
    --ci --force --password "$PASSWORD" -w "$KEY_PATH")
  if "${cmd[@]}"; then
    return 0
  fi
  echo "pnpm tauri signer generate failed; trying the pinned CLI package." >&2
  npx --yes @tauri-apps/cli@2.10.0 signer generate \
    --ci --force --password "$PASSWORD" -w "$KEY_PATH"
}

if ! generate_key; then
  echo "Could not create an ephemeral updater key; refusing to build unsigned updater archives." >&2
  exit 1
fi

if [[ ! -f "$KEY_PATH" && -f "${KEY_PATH}.key" ]]; then
  KEY_PATH="${KEY_PATH}.key"
fi
if [[ ! -f "$KEY_PATH" ]]; then
  echo "Ephemeral updater key was not written to $KEY_PATH" >&2
  exit 1
fi

{
  echo "TAURI_SIGNING_PRIVATE_KEY<<EOF"
  cat "$KEY_PATH"
  echo
  echo "EOF"
  echo "TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$PASSWORD"
} >> "$GITHUB_ENV"

rm -f "$KEY_PATH" "${KEY_PATH}.pub" "${KEY_PATH}.key" "${KEY_PATH}.key.pub" || true
echo "Configured an ephemeral updater key for this build job only."
