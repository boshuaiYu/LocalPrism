#!/usr/bin/env bash
# Fail if the Linux desktop executable exports private C-library symbols.
#
# Tectonic's semi-static link pulls ICU, HarfBuzz, FreeType, Fontconfig,
# expat, and zlib into the binary. Those symbols must not be dynamic: GTK,
# Mesa, and WebKit load the system copies, and an exported definition in the
# executable interposes on them. GLib must not be linked statically at all;
# g_malloc / glib_major_version must not be defined in this executable.
#
# Usage: bash scripts/check-linux-desktop-symbols.sh path/to/claude-prism-desktop
set -euo pipefail

BIN="${1:-}"
if [[ -z "$BIN" || ! -f "$BIN" ]]; then
  echo "usage: $0 path/to/claude-prism-desktop" >&2
  exit 2
fi

defined="$(nm -D --defined-only "$BIN" | awk '{print $3}')"
fail=0

check() {
  local re="$1"
  local hit
  hit="$(printf '%s\n' "$defined" | grep -E "$re" || true)"
  if [[ -n "$hit" ]]; then
    echo "error: $BIN exports symbols matching $re" >&2
    printf '%s\n' "$hit" | head -20 >&2
    fail=1
  fi
}

check '^(g_|glib_)'
check '^XML_'
check '^(deflate|inflate|crc32|adler32|compress|uncompress)($|_)'
check '^Brotli'
check '^BZ2_'
check '^pcre'
check '^u[a-z]'
check '^(AES_|error$|fatal_error$)'

# A statically linked GLib still defines g_malloc in the regular symbol table
# even when a version script keeps it out of .dynsym. That split still crashes.
if nm "$BIN" | awk '{
  sym = $NF
  sub(/@.*/, "", sym)
  if ($2 ~ /^[TtDdRrBb]$/ && (sym == "g_malloc" || sym == "glib_major_version"))
    found = 1
} END { exit !found }'; then
  echo "error: $BIN still contains a statically linked GLib (g_malloc / glib_major_version)" >&2
  fail=1
fi

if ! nm -D "$BIN" | awk '{
  sym = $NF
  sub(/@.*/, "", sym)
  if ($1 == "U" && sym == "g_object_new_with_properties") found = 1
} END { exit !found }'; then
  echo "error: g_object_new_with_properties is not an undefined reference to system libgobject" >&2
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi

echo "ok: $BIN does not export interposed GLib/expat/zlib/ICU symbols"
