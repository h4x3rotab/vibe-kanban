#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT="$SCRIPT_DIR"
BUILD_DESKTOP="0"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--desktop|--all]

Build local npx release artifacts using the same platform-specific path as the
CI release pipeline.

Options:
  --desktop, --all   Also build the Tauri desktop app
  --help             Show this help text
EOF
}

case "${1:-}" in
  --desktop|--all)
    BUILD_DESKTOP="1"
    shift
    ;;
  --help)
    usage
    exit 0
    ;;
  "")
    ;;
  *)
    echo "error: unknown argument: $1" >&2
    usage >&2
    exit 1
    ;;
esac

if [[ $# -ne 0 ]]; then
  echo "error: unexpected arguments: $*" >&2
  usage >&2
  exit 1
fi

bash "$REPO_ROOT/scripts/build-release-npx.sh" --repo-root "$REPO_ROOT"

if [[ "$BUILD_DESKTOP" != "1" ]]; then
  exit 0
fi

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
  x86_64)
    ARCH="x64"
    ;;
  arm64|aarch64)
    ARCH="arm64"
    ;;
  *)
    echo "warning: unknown architecture $ARCH, using as-is" >&2
    ;;
esac

case "$OS" in
  linux)
    TAURI_OS="linux"
    ;;
  darwin)
    TAURI_OS="darwin"
    ;;
  *)
    echo "warning: unknown OS $OS, using as-is" >&2
    TAURI_OS="$OS"
    ;;
esac

case "$ARCH" in
  arm64)
    TAURI_ARCH="aarch64"
    ;;
  x64)
    TAURI_ARCH="x86_64"
    ;;
  *)
    TAURI_ARCH="$ARCH"
    ;;
esac

TAURI_PLATFORM="${TAURI_OS}-${TAURI_ARCH}"
TAURI_CONF="$REPO_ROOT/crates/tauri-app/tauri.conf.json"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-target}"

echo "Building Tauri desktop app for $TAURI_PLATFORM..."

node -e "
  const fs = require('fs');
  const conf = JSON.parse(fs.readFileSync('$TAURI_CONF', 'utf8'));
  conf.plugins.updater.endpoints = conf.plugins.updater.endpoints.map((endpoint) =>
    endpoint === '__TAURI_UPDATE_ENDPOINT__' ? 'https://localhost/disabled' : endpoint
  );
  fs.writeFileSync('$TAURI_CONF', JSON.stringify(conf, null, 2) + '\n');
"

cleanup_tauri_conf() {
  git -C "$REPO_ROOT" checkout -- "$TAURI_CONF"
}

trap cleanup_tauri_conf EXIT

(
  cd "$REPO_ROOT/crates/tauri-app"
  cargo tauri build
)

TAURI_DIST="$REPO_ROOT/npx-cli/dist/tauri/$TAURI_PLATFORM"
mkdir -p "$TAURI_DIST"

BUNDLE_DIR="$REPO_ROOT/${CARGO_TARGET_DIR}/release/bundle"
find "$BUNDLE_DIR" -name "*.app.tar.gz" ! -name "*.sig" -exec cp {} "$TAURI_DIST/" \; 2>/dev/null || true
find "$BUNDLE_DIR" -name "*.AppImage.tar.gz" ! -name "*.sig" -exec cp {} "$TAURI_DIST/" \; 2>/dev/null || true
find "$BUNDLE_DIR" -name "*-setup.exe" -exec cp {} "$TAURI_DIST/" \; 2>/dev/null || true

echo "Desktop app built:"
ls -la "$TAURI_DIST/"
