#!/usr/bin/env bash
# Capture the GitHub release body for latest.json `notes`.
# The sign-updater job runs before `gh release create --generate-notes`,
# so a title-only notes field would ship unless this step runs first.
# Failure stays non-fatal: an empty file falls back to the release title,
# and the app can still load the GitHub body for that tag.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT="${UPDATER_RELEASE_NOTES_FILE:-updater-release-notes.md}"
TAG="${TAG:-}"
mkdir -p "$(dirname "$OUT")"

write_empty() {
  : > "$OUT"
}

if [[ -z "$TAG" ]]; then
  write_empty
  exit 0
fi

token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [[ -z "$token" ]]; then
  echo "No GitHub token; latest.json notes will fall back to the release title." >&2
  write_empty
  exit 0
fi
export GH_TOKEN="$token"

existing=""
if existing="$(gh release view "$TAG" --json body --jq .body 2>/dev/null)"; then
  if [[ -n "${existing//[[:space:]]/}" ]]; then
    printf '%s\n' "$existing" > "$OUT"
    echo "Using the existing GitHub release body for latest.json notes."
    exit 0
  fi
fi

repo="${GITHUB_REPOSITORY:-}"
if [[ -z "$repo" ]]; then
  echo "GITHUB_REPOSITORY is unset; latest.json notes will fall back to the release title." >&2
  write_empty
  exit 0
fi

generated=""
if generated="$(gh api --method POST \
  -H "Accept: application/vnd.github+json" \
  "/repos/${repo}/releases/generate-notes" \
  -f tag_name="$TAG" \
  --jq .body)"; then
  if [[ -n "${generated//[[:space:]]/}" ]]; then
    printf '%s\n' "$generated" > "$OUT"
    echo "Using the generated changelog for latest.json notes."
    exit 0
  fi
fi

echo "Could not load a changelog; latest.json notes will fall back to the release title." >&2
write_empty
exit 0
