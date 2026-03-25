#!/usr/bin/env bash

set -euo pipefail

SCRIPT_NAME=$(basename "$0")

REPO_ROOT=""
PLATFORM_NAME=""
API_BASE="https://api.vibekanban.com"
RELAY_API_BASE="https://relay.vibekanban.com"
RUST_TOOLCHAIN="nightly-2025-12-04"
ZIG_VERSION="0.15.2"
CARGO_ZIGBUILD_VERSION="0.20.1"
INSTALL_NODE_DEPS="0"

usage() {
  cat <<EOF
Usage: $SCRIPT_NAME [options]

Build the local npx release payload using the same platform-specific build path
as the CI release pipeline.

Options:
  --repo-root <path>         Repository root to build. Default: current git root
  --platform <name>          Platform package to build. Default: detected host platform
  --api-base <url>           VK_SHARED_API_BASE / VITE_VK_SHARED_API_BASE
  --relay-api-base <url>     VK_SHARED_RELAY_API_BASE
  --rust-toolchain <name>    Rust toolchain to use. Default: $RUST_TOOLCHAIN
  --install-node-deps        Run pnpm install before building
  --help                     Show this help text

Supported platforms:
  linux-x64
  linux-arm64
  macos-x64
  macos-arm64
EOF
}

log() {
  printf '[%s] %s\n' "$SCRIPT_NAME" "$*"
}

fail() {
  printf '[%s] error: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

ensure_rust_toolchain() {
  log "Ensuring Rust toolchain $RUST_TOOLCHAIN"
  rustup toolchain install "$RUST_TOOLCHAIN" --component rustfmt --component clippy
}

ensure_zig() {
  local zig_root
  local zig_dir
  local zig_ci_dir
  local zig_archive
  local temp_dir

  zig_root="${HOME}/.local/opt"
  zig_dir="${zig_root}/zig-${ZIG_VERSION}"
  zig_ci_dir="${zig_root}/zig-${ZIG_VERSION}-ci"

  if command -v zig >/dev/null 2>&1; then
    dirname "$(command -v zig)"
    return
  fi

  if [[ -x "${zig_dir}/zig" ]]; then
    printf '%s\n' "$zig_dir"
    return
  fi

  if [[ -x "${zig_ci_dir}/zig" ]]; then
    printf '%s\n' "$zig_ci_dir"
    return
  fi

  temp_dir=$(mktemp -d "/tmp/zig-${ZIG_VERSION}-XXXXXX")
  zig_archive="zig-x86_64-linux-${ZIG_VERSION}.tar.xz"

  log "Installing Zig $ZIG_VERSION into $zig_dir" >&2
  curl -L "https://ziglang.org/download/${ZIG_VERSION}/${zig_archive}" -o "${temp_dir}/${zig_archive}"
  tar -xf "${temp_dir}/${zig_archive}" -C "$temp_dir"
  mkdir -p "$zig_root"
  mv "${temp_dir}/zig-x86_64-linux-${ZIG_VERSION}" "$zig_dir"
  rm -rf "$temp_dir"

  printf '%s\n' "$zig_dir"
}

ensure_cargo_zigbuild() {
  if command -v cargo-zigbuild >/dev/null 2>&1; then
    if cargo-zigbuild --version | grep -q "cargo-zigbuild ${CARGO_ZIGBUILD_VERSION}"; then
      return
    fi
  fi

  log "Installing cargo-zigbuild $CARGO_ZIGBUILD_VERSION"
  cargo +"$RUST_TOOLCHAIN" install --locked cargo-zigbuild --version "$CARGO_ZIGBUILD_VERSION"
}

detect_platform() {
  local os
  local arch

  os=$(uname -s)
  arch=$(uname -m)

  case "${os}:${arch}" in
    Linux:x86_64)
      PLATFORM_NAME="linux-x64"
      ;;
    Linux:aarch64)
      PLATFORM_NAME="linux-arm64"
      ;;
    Darwin:x86_64)
      PLATFORM_NAME="macos-x64"
      ;;
    Darwin:arm64|Darwin:aarch64)
      PLATFORM_NAME="macos-arm64"
      ;;
    *)
      fail "unsupported host platform: ${os}:${arch}"
      ;;
  esac
}

set_platform_build_vars() {
  case "$PLATFORM_NAME" in
    linux-x64)
      RUST_TARGET="x86_64-unknown-linux-musl"
      BUILD_KIND="linux"
      ;;
    linux-arm64)
      RUST_TARGET="aarch64-unknown-linux-musl"
      BUILD_KIND="linux"
      ;;
    macos-x64)
      RUST_TARGET="x86_64-apple-darwin"
      BUILD_KIND="macos"
      ;;
    macos-arm64)
      RUST_TARGET="aarch64-apple-darwin"
      BUILD_KIND="macos"
      ;;
    *)
      fail "unsupported platform package: $PLATFORM_NAME"
      ;;
  esac
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo-root)
        REPO_ROOT="$2"
        shift 2
        ;;
      --platform)
        PLATFORM_NAME="$2"
        shift 2
        ;;
      --api-base)
        API_BASE="$2"
        shift 2
        ;;
      --relay-api-base)
        RELAY_API_BASE="$2"
        shift 2
        ;;
      --rust-toolchain)
        RUST_TOOLCHAIN="$2"
        shift 2
        ;;
      --install-node-deps)
        INSTALL_NODE_DEPS="1"
        shift
        ;;
      --help)
        usage
        exit 0
        ;;
      *)
        fail "unknown argument: $1"
        ;;
    esac
  done
}

parse_args "$@"

require_command git
require_command curl
require_command tar
require_command zip
require_command rustup
require_command pnpm
require_command npm

if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT=$(git rev-parse --show-toplevel)
fi

[[ -d "$REPO_ROOT" ]] || fail "repo root does not exist: $REPO_ROOT"

if [[ -z "$PLATFORM_NAME" ]]; then
  detect_platform
fi

set_platform_build_vars
ensure_rust_toolchain

if [[ "$BUILD_KIND" == "linux" ]]; then
  ZIG_DIR=$(ensure_zig)
  ensure_cargo_zigbuild
fi

log "Repository root: $REPO_ROOT"
log "Platform package: $PLATFORM_NAME"
log "Rust target: $RUST_TARGET"

if [[ "$INSTALL_NODE_DEPS" == "1" ]]; then
  log "Installing Node dependencies"
  (
    cd "$REPO_ROOT"
    pnpm install
  )
fi

log "Building frontend artifact"
(
  cd "$REPO_ROOT/packages/local-web"
  export VITE_VK_SHARED_API_BASE="$API_BASE"
  npm run build
)

log "Building backend binaries"
(
  cd "$REPO_ROOT"
  export CARGO_INCREMENTAL=0
  export VK_SHARED_API_BASE="$API_BASE"
  export VK_SHARED_RELAY_API_BASE="$RELAY_API_BASE"

  if [[ "$BUILD_KIND" == "linux" ]]; then
    export PATH="${ZIG_DIR}:$PATH"
    cargo +"$RUST_TOOLCHAIN" zigbuild --release --target "$RUST_TARGET" \
      -p server -p mcp -p review \
      --bin server --bin vibe-kanban-mcp --bin review
  else
    rustup target add --toolchain "$RUST_TOOLCHAIN" "$RUST_TARGET"
    cargo +"$RUST_TOOLCHAIN" build --release --target "$RUST_TARGET" \
      -p server -p mcp -p review \
      --bin server --bin vibe-kanban-mcp --bin review
  fi
)

log "Packaging npx release artifacts"
(
  cd "$REPO_ROOT"
  rm -rf "dist" "npx-cli/dist/${PLATFORM_NAME}" \
    "vibe-kanban-${PLATFORM_NAME}" \
    "vibe-kanban-mcp-${PLATFORM_NAME}" \
    "vibe-kanban-review-${PLATFORM_NAME}"

  mkdir -p "dist" "npx-cli/dist/${PLATFORM_NAME}" \
    "vibe-kanban-${PLATFORM_NAME}" \
    "vibe-kanban-mcp-${PLATFORM_NAME}" \
    "vibe-kanban-review-${PLATFORM_NAME}"

  cp "target/${RUST_TARGET}/release/server" "dist/vibe-kanban-${PLATFORM_NAME}"
  cp "target/${RUST_TARGET}/release/vibe-kanban-mcp" "dist/vibe-kanban-mcp-${PLATFORM_NAME}"
  cp "target/${RUST_TARGET}/release/review" "dist/vibe-kanban-review-${PLATFORM_NAME}"

  cp "dist/vibe-kanban-${PLATFORM_NAME}" "vibe-kanban-${PLATFORM_NAME}/vibe-kanban"
  cp "dist/vibe-kanban-mcp-${PLATFORM_NAME}" "vibe-kanban-mcp-${PLATFORM_NAME}/vibe-kanban-mcp"
  cp "dist/vibe-kanban-review-${PLATFORM_NAME}" "vibe-kanban-review-${PLATFORM_NAME}/vibe-kanban-review"

  zip -jq "npx-cli/dist/${PLATFORM_NAME}/vibe-kanban.zip" "vibe-kanban-${PLATFORM_NAME}/vibe-kanban"
  zip -jq "npx-cli/dist/${PLATFORM_NAME}/vibe-kanban-mcp.zip" "vibe-kanban-mcp-${PLATFORM_NAME}/vibe-kanban-mcp"
  zip -jq "npx-cli/dist/${PLATFORM_NAME}/vibe-kanban-review.zip" "vibe-kanban-review-${PLATFORM_NAME}/vibe-kanban-review"
)

log "Built artifacts:"
ls -lh "${REPO_ROOT}/npx-cli/dist/${PLATFORM_NAME}"
