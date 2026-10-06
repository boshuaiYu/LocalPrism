#!/usr/bin/env bash
# Put hash-pinned GNU tarballs into vcpkg's download cache before `vcpkg install`.
#
# gperf's portfile only lists ftpmirror.gnu.org and ftp.gnu.org. GitHub-hosted
# runners time out against both (curl 7 / "Download timed out"), and the source
# build then fails. Other ports in this install, such as automake, already fall
# back to mirrorservice.org and recover.
#
# VCPKG_BINARY_SOURCES=clear stays set. The Windows triplet
# x64-windows-static-release is not published in Microsoft's binary cache, so
# dropping `clear` would still compile gperf from source. vcpkg skips the
# network when $VCPKG_DOWNLOADS already has the portfile FILENAME and that
# file matches the portfile SHA512.
#
# Usage: ci-prefetch-vcpkg-downloads.sh [port ...]
# Default port is gperf. Extra port names are read from the same vcpkg tree.
# Requires VCPKG_ROOT or VCPKG_INSTALLATION_ROOT.

set -euo pipefail

if [[ -z "${VCPKG_ROOT:-}" ]]; then
  if [[ -n "${VCPKG_INSTALLATION_ROOT:-}" ]]; then
    VCPKG_ROOT="$VCPKG_INSTALLATION_ROOT"
  else
    echo "VCPKG_ROOT is not set" >&2
    exit 1
  fi
fi

if [[ -z "${VCPKG_DOWNLOADS:-}" ]]; then
  VCPKG_DOWNLOADS="${VCPKG_ROOT}/downloads"
fi

if [[ $# -eq 0 ]]; then
  set -- gperf
fi

mkdir -p "$VCPKG_DOWNLOADS"

sha512_file() {
  local file="$1"
  # windows-latest passes C:\vcpkg\downloads\... to sha512sum. GNU sha512sum
  # and shasum prefix that line with '\', so awk's $1 is \246b75b8... and
  # never matches the portfile. Drop the marker. coreutils opens the path
  # itself in binary mode; hashing via stdin can translate CRLF under Git
  # Bash and change the digest of a gzip tarball.
  if command -v sha512sum >/dev/null 2>&1; then
    sha512sum -- "$file" | awk '{sub(/^\\/, "", $1); print tolower($1)}' | tr -d '\r'
  else
    shasum -a 512 -- "$file" | awk '{sub(/^\\/, "", $1); print tolower($1)}' | tr -d '\r'
  fi
}

lower() {
  printf '%s' "$1" | tr 'A-F' 'a-f'
}

prefetch_port() {
  local port="$1"
  local port_dir="${VCPKG_ROOT}/ports/${port}"
  local manifest="${port_dir}/vcpkg.json"
  local portfile="${port_dir}/portfile.cmake"
  local version filename_tmpl filename gnu_pkg sha512 dest got tmp url bytes
  local -a urls

  if [[ ! -f "$manifest" || ! -f "$portfile" ]]; then
    echo "vcpkg port not found: ${port} (${port_dir})" >&2
    exit 1
  fi

  # Drop CR so a CRLF port file cannot leak into the URL or expected digest.
  version="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -n 1 | tr -d '\r')"
  filename_tmpl="$(sed -n 's/^[[:space:]]*FILENAME[[:space:]]\{1,\}"\{0,1\}\([^"[:space:]]*\).*/\1/p' "$portfile" | head -n 1 | tr -d '\r')"
  sha512="$(sed -n 's/^[[:space:]]*SHA512[[:space:]]\{1,\}"\{0,1\}\([0-9A-Fa-f][0-9A-Fa-f]*\).*/\1/p' "$portfile" | head -n 1 | tr -d '\r')"
  gnu_pkg="$(sed -n 's#.*gnu/\([^/"][^/"]*\)/.*#\1#p' "$portfile" | head -n 1 | tr -d '\r')"

  if [[ -z "$version" || -z "$sha512" || -z "$gnu_pkg" ]]; then
    echo "Could not parse version, SHA512, or GNU directory for ${port}" >&2
    exit 1
  fi

  if [[ -n "$filename_tmpl" ]]; then
    filename="${filename_tmpl//\$\{VERSION\}/$version}"
  else
    filename="${gnu_pkg}-${version}.tar.gz"
  fi
  sha512="$(lower "$sha512")"
  dest="${VCPKG_DOWNLOADS}/${filename}"

  if [[ -f "$dest" ]]; then
    got="$(sha512_file "$dest")"
    if [[ "$got" == "$sha512" ]]; then
      echo "Using cached ${filename}"
      return 0
    fi
    echo "Removing ${filename}; SHA512 does not match the portfile" >&2
    echo "  expected ${sha512}" >&2
    echo "  got      ${got}" >&2
    rm -f "$dest"
  fi

  # HTTPS mirrors with the standard /gnu/<package>/ layout. ftpmirror.gnu.org
  # and ftp.gnu.org are omitted: they are the hosts that time out in CI.
  # Array assignment is split from `local` so macOS /bin/bash 3.2 accepts it.
  urls=(
    "https://www.mirrorservice.org/sites/ftp.gnu.org/gnu/${gnu_pkg}/${filename}"
    "https://mirrors.kernel.org/gnu/${gnu_pkg}/${filename}"
    "https://mirror.csclub.uwaterloo.ca/gnu/${gnu_pkg}/${filename}"
    "https://ftp-ext.osuosl.org/pub/gnu/${gnu_pkg}/${filename}"
    "https://mirrors.ocf.berkeley.edu/gnu/${gnu_pkg}/${filename}"
  )

  for url in "${urls[@]}"; do
    tmp="$(mktemp "${VCPKG_DOWNLOADS}/.${filename}.XXXXXX")"
    echo "Prefetch ${filename} from ${url}"
    if ! curl --fail --location --silent --show-error --retry 2 --retry-delay 2 \
        --connect-timeout 20 --max-time 90 \
        --output "$tmp" "$url"; then
      rm -f "$tmp"
      continue
    fi
    got="$(sha512_file "$tmp")"
    if [[ "$got" == "$sha512" ]]; then
      mv "$tmp" "$dest"
      echo "Prefetched ${dest}"
      return 0
    fi
    bytes="$(wc -c <"$tmp" | tr -d '[:space:]')"
    echo "SHA512 mismatch from ${url} (${bytes} bytes)" >&2
    echo "  expected ${sha512}" >&2
    echo "  got      ${got}" >&2
    rm -f "$tmp"
  done

  echo "Could not prefetch ${filename} for ${port} from any HTTPS GNU mirror" >&2
  exit 1
}

for port in "$@"; do
  prefetch_port "$port"
done
