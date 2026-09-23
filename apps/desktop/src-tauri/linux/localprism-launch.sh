#!/bin/sh
# Desktop entry wrapper for the .deb. The WebKitGTK binary cannot print a
# dialog itself: the dynamic linker exits before main() if the library is
# missing. This script runs first and explains the apt packages.
set -eu

if [ "$#" -lt 1 ]; then
  echo "usage: localprism-launch <binary> [args...]" >&2
  exit 1
fi

bin=$1
shift

if ! ldconfig -p 2>/dev/null | grep -q 'libwebkit2gtk-4.1.so'; then
  msg="LocalPrism needs WebKitGTK 4.1 before it can open a window.

Debian / Ubuntu:
  sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1

Ubuntu 24.04 and Debian 13: if libgtk-3-0 is missing, install libgtk-3-0t64 instead.

Install the package with apt so those dependencies are pulled in:
  sudo apt install ./LocalPrism-Linux.deb

dpkg -i alone does not install them, and the app then exits with no window."
  if command -v zenity >/dev/null 2>&1; then
    zenity --error --width=520 --title="LocalPrism" --text="$msg" || true
  elif command -v kdialog >/dev/null 2>&1; then
    kdialog --error "$msg" || true
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send "LocalPrism" "WebKitGTK 4.1 is missing. See the terminal or README for apt packages." || true
    printf '%s\n' "$msg" >&2
  else
    printf '%s\n' "$msg" >&2
  fi
  exit 1
fi

exec "$bin" "$@"
