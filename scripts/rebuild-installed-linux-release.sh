#!/usr/bin/env bash

set -euo pipefail

SCRIPT_NAME=$(basename "$0")

REF="origin/main"
CHERRY_PICK_COMMIT=""
INSTALL_DIR=""
SERVICE_NAME="vibe-kanban"
PORT="10000"
API_BASE="https://api.vibekanban.com"
RELAY_API_BASE="https://relay.vibekanban.com"
RUST_TOOLCHAIN="nightly-2025-12-04"
RUST_TARGET="x86_64-unknown-linux-musl"
PLATFORM_NAME="linux-x64"
ZIG_VERSION="0.15.2"
CARGO_ZIGBUILD_VERSION="0.20.1"
KEEP_WORKTREE="0"
SKIP_FETCH="0"
WORKTREE_DIR=""
REPO_ROOT=""

usage() {
  cat <<EOF
Usage: $SCRIPT_NAME [options]

Build the Linux x64 npm payload the same way the CI release pipeline does,
replace the installed local vibe-kanban backend payload, and restart the
user service.

Options:
  --ref <git-ref>            Git ref to build from. Default: $REF
  --cherry-pick <commit>     Cherry-pick a commit onto the build worktree.
  --install-dir <path>       Installed linux-x64 cache directory to replace.
  --service <name>           systemd user service name. Default: $SERVICE_NAME
  --port <port>              Port used for post-start health checks. Default: $PORT
  --api-base <url>           VK_SHARED_API_BASE / VITE_VK_SHARED_API_BASE.
  --relay-api-base <url>     VK_SHARED_RELAY_API_BASE.
  --keep-worktree            Keep the temporary build worktree on disk.
  --skip-fetch               Skip git fetch before creating the worktree.
  --help                     Show this help text.

Example:
  $SCRIPT_NAME --cherry-pick 15829fed2
EOF
}

log() {
  printf '[%s] %s\n' "$SCRIPT_NAME" "$*"
}

fail() {
  printf '[%s] error: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$WORKTREE_DIR" && "$KEEP_WORKTREE" != "1" && -d "$WORKTREE_DIR" ]]; then
    git -C "$REPO_ROOT" worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1 || true
    rmdir "$WORKTREE_DIR" >/dev/null 2>&1 || true
  fi
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

detect_install_dir() {
  local base_dir
  local dirs

  base_dir="${HOME}/.vibe-kanban/bin"
  [[ -d "$base_dir" ]] || fail "install cache directory not found: $base_dir"

  mapfile -t dirs < <(find "$base_dir" -mindepth 2 -maxdepth 2 -type d -name "$PLATFORM_NAME" | sort)
  [[ "${#dirs[@]}" -gt 0 ]] || fail "no installed $PLATFORM_NAME cache directories found under $base_dir"

  printf '%s\n' "${dirs[-1]}"
}

ensure_linux_build_dependencies() {
  local missing=()

  if ! command -v clang >/dev/null 2>&1; then
    missing+=("clang")
  fi
  if ! command -v lld >/dev/null 2>&1; then
    missing+=("lld")
  fi
  if ! command -v nasm >/dev/null 2>&1; then
    missing+=("nasm")
  fi
  if ! command -v ninja >/dev/null 2>&1; then
    missing+=("ninja-build")
  fi

  if [[ "${#missing[@]}" -eq 0 ]]; then
    return
  fi

  log "Installing Linux build dependencies: ${missing[*]}"
  sudo apt-get update
  DEBIAN_FRONTEND=noninteractive sudo apt-get install -y \
    clang libclang-dev lld llvm nasm cmake ninja-build
}

ensure_rust_toolchain() {
  log "Ensuring Rust toolchain $RUST_TOOLCHAIN and target $RUST_TARGET"
  rustup toolchain install "$RUST_TOOLCHAIN" --component rustfmt --component clippy
  rustup target add --toolchain "$RUST_TOOLCHAIN" "$RUST_TARGET"
}

ensure_zig() {
  local zig_root
  local zig_dir
  local zig_archive
  local temp_dir

  zig_root="${HOME}/.local/opt"
  zig_dir="${zig_root}/zig-${ZIG_VERSION}"

  if [[ -x "${zig_dir}/zig" ]]; then
    printf '%s\n' "$zig_dir"
    return
  fi

  temp_dir=$(mktemp -d "/tmp/zig-${ZIG_VERSION}-XXXXXX")
  zig_archive="zig-x86_64-linux-${ZIG_VERSION}.tar.xz"

  log "Installing Zig $ZIG_VERSION into $zig_dir"
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

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ref)
        REF="$2"
        shift 2
        ;;
      --cherry-pick)
        CHERRY_PICK_COMMIT="$2"
        shift 2
        ;;
      --install-dir)
        INSTALL_DIR="$2"
        shift 2
        ;;
      --service)
        SERVICE_NAME="$2"
        shift 2
        ;;
      --port)
        PORT="$2"
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
      --keep-worktree)
        KEEP_WORKTREE="1"
        shift
        ;;
      --skip-fetch)
        SKIP_FETCH="1"
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
require_command sha256sum
require_command rustup
require_command pnpm
require_command npm
require_command systemctl

REPO_ROOT=$(git rev-parse --show-toplevel)
trap cleanup EXIT

if [[ -z "$INSTALL_DIR" ]]; then
  INSTALL_DIR=$(detect_install_dir)
fi

[[ -d "$INSTALL_DIR" ]] || fail "install dir does not exist: $INSTALL_DIR"
[[ -f "$INSTALL_DIR/vibe-kanban.zip" ]] || fail "missing installed zip: $INSTALL_DIR/vibe-kanban.zip"
[[ -f "$INSTALL_DIR/vibe-kanban" ]] || fail "missing installed binary: $INSTALL_DIR/vibe-kanban"

log "Repository root: $REPO_ROOT"
log "Install dir: $INSTALL_DIR"
log "Build ref: $REF"
if [[ -n "$CHERRY_PICK_COMMIT" ]]; then
  log "Cherry-pick commit: $CHERRY_PICK_COMMIT"
fi

if [[ "$SKIP_FETCH" != "1" ]]; then
  log "Fetching git refs"
  git -C "$REPO_ROOT" fetch origin
fi

ensure_linux_build_dependencies
ensure_rust_toolchain
ZIG_DIR=$(ensure_zig)
ensure_cargo_zigbuild

WORKTREE_DIR=$(mktemp -d "/tmp/vibe-kanban-release-build-XXXXXX")
rmdir "$WORKTREE_DIR"

log "Creating worktree at $WORKTREE_DIR"
git -C "$REPO_ROOT" worktree add --detach "$WORKTREE_DIR" "$REF"

if [[ -n "$CHERRY_PICK_COMMIT" ]]; then
  if git -C "$WORKTREE_DIR" merge-base --is-ancestor "$CHERRY_PICK_COMMIT" HEAD; then
    log "Cherry-pick commit is already included in $REF"
  else
    log "Cherry-picking $CHERRY_PICK_COMMIT"
    git -C "$WORKTREE_DIR" cherry-pick "$CHERRY_PICK_COMMIT"
  fi
fi

log "Installing Node dependencies in worktree"
(
  cd "$WORKTREE_DIR"
  pnpm install
)

log "Building frontend artifact"
(
  cd "$WORKTREE_DIR/packages/local-web"
  export VITE_VK_SHARED_API_BASE="$API_BASE"
  npm run build
)

log "Building backend binaries with cargo zigbuild"
(
  cd "$WORKTREE_DIR"
  export PATH="${ZIG_DIR}:$PATH"
  export CARGO_INCREMENTAL=0
  export VK_SHARED_API_BASE="$API_BASE"
  export VK_SHARED_RELAY_API_BASE="$RELAY_API_BASE"
  cargo +"$RUST_TOOLCHAIN" zigbuild --release --target "$RUST_TARGET" \
    -p server -p mcp -p review \
    --bin server --bin vibe-kanban-mcp --bin review
)

log "Packaging linux-x64 npm payload"
(
  cd "$WORKTREE_DIR"
  mkdir -p dist "npx-cli/dist/${PLATFORM_NAME}" \
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

TIMESTAMP=$(date +%Y%m%d%H%M%S)
BUILT_SERVER="${WORKTREE_DIR}/target/${RUST_TARGET}/release/server"
BUILT_ZIP="${WORKTREE_DIR}/npx-cli/dist/${PLATFORM_NAME}/vibe-kanban.zip"

log "Backing up installed payload"
cp "${INSTALL_DIR}/vibe-kanban" "${INSTALL_DIR}/vibe-kanban.backup-${TIMESTAMP}"
cp "${INSTALL_DIR}/vibe-kanban.zip" "${INSTALL_DIR}/vibe-kanban.zip.backup-${TIMESTAMP}"

log "Stopping ${SERVICE_NAME}.service"
systemctl --user stop "$SERVICE_NAME"

log "Installing rebuilt payload"
cp "$BUILT_SERVER" "${INSTALL_DIR}/vibe-kanban"
cp "$BUILT_ZIP" "${INSTALL_DIR}/vibe-kanban.zip"

log "Starting ${SERVICE_NAME}.service"
systemctl --user start "$SERVICE_NAME"
sleep 2

log "Verifying service health"
systemctl --user status "$SERVICE_NAME" --no-pager
curl --fail --silent --show-error "http://127.0.0.1:${PORT}/api/info" >/dev/null

log "Installed binary sha256:"
sha256sum "${INSTALL_DIR}/vibe-kanban"
log "Installed zip sha256:"
sha256sum "${INSTALL_DIR}/vibe-kanban.zip"
log "Done"
