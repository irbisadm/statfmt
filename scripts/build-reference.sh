#!/usr/bin/env bash
#
# build-reference.sh — download and build the reference C ReadStat CLI so the
# end-to-end test suite can cross-validate the TypeScript port against the
# canonical implementation.
#
# Prefers the release tarball (ships a pre-generated ./configure, so only a C
# compiler + make + zlib/iconv are required — no autotools/gettext). Falls back
# to a git clone + autogen when the tarball cannot be fetched.
#
# The build is placed under <repo>/.reference/ReadStat (git-ignored). Tests
# locate the resulting libtool wrapper at <repo>/.reference/ReadStat/readstat
# (override with the READSTAT_BIN environment variable).
#
set -euo pipefail

REF_VER="${READSTAT_REF_VER:-1.1.9}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF_DIR="$ROOT/.reference"
SRC="$REF_DIR/ReadStat"
BIN="$SRC/readstat"
TARBALL_URL="https://github.com/WizardMac/ReadStat/releases/download/v${REF_VER}/readstat-${REF_VER}.tar.gz"

if [ -x "$BIN" ] && [ -z "${READSTAT_REBUILD:-}" ]; then
  echo "reference already built: $BIN"
  exit 0
fi

for tool in make cc; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: missing build tool '$tool'" >&2; exit 2; }
done

mkdir -p "$REF_DIR"
rm -rf "$SRC"

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2";
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1";
  else return 1; fi
}

if fetch "$TARBALL_URL" "$REF_DIR/readstat.tar.gz"; then
  echo "extracting release tarball v${REF_VER} ..."
  tar -xzf "$REF_DIR/readstat.tar.gz" -C "$REF_DIR"
  mv "$REF_DIR/readstat-${REF_VER}" "$SRC"
  rm -f "$REF_DIR/readstat.tar.gz"
  cd "$SRC"
  ./configure
else
  echo "tarball fetch failed; falling back to git clone + autogen ..."
  command -v autoreconf >/dev/null 2>&1 || { echo "ERROR: need autoreconf for the git fallback" >&2; exit 2; }
  git clone --depth 1 --branch "v${REF_VER}" https://github.com/WizardMac/ReadStat.git "$SRC"
  cd "$SRC"
  autoreconf --force --install
  ./configure
fi

# ReadStat bakes -Werror / -pedantic-errors into per-target CFLAGS; newer
# compilers (e.g. GCC 16) emit warnings that then abort the build. Strip them
# from the generated Makefile so the reference builds on any toolchain.
sed -i 's/-Werror//g; s/-pedantic-errors//g' Makefile

make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"

[ -x "$BIN" ] || { echo "ERROR: build finished but $BIN is missing" >&2; exit 3; }
echo "reference built: $BIN"
