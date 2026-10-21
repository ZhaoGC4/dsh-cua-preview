#!/usr/bin/env bash
#
# dsh-cua-preview installer.
#
# The DSH Desktop application owns its `desktop` profile, so the official
# `dsh plugin --profile desktop` command refuses to manage it. This script
# performs the same two steps that the app's Plugins page does for a normal
# bundle:
#   1. pnpm-add this repository as a `file:` dependency of the desktop profile;
#   2. append the loader row (and its config) to the profile's user patch.
#
# Run from anywhere:  bash scripts/install.sh
# Uninstall:          bash scripts/uninstall.sh
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DSH_APP="${DSH_APP:-/Applications/DeepSeek Harness.app}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/desktop"
ELECTRON_BIN="$DSH_APP/Contents/MacOS/DeepSeek Harness"
RUNTIME_DIR="$DSH_APP/Contents/Resources/runtime"
PNPM_MAIN="$RUNTIME_DIR/primary-runtime/dependencies/pnpm/bin/pnpm.mjs"
PATCH_HELPER="$REPO_DIR/scripts/profile-patch.mjs"
BACKUP_ROOT="$DSH_HOME/cua-preview/install-backup-$(date +%Y%m%d-%H%M%S)"

if [ ! -d "$DSH_APP" ]; then
  echo "error: DeepSeek Harness.app not found at $DSH_APP (set DSH_APP to override)" >&2
  exit 1
fi
if [ ! -f "$PROFILE_DIR/package.json" ]; then
  echo "error: desktop profile not found at $PROFILE_DIR" >&2
  echo "       Start the DSH Desktop app once, then re-run this script." >&2
  exit 1
fi
if [ ! -f "$PNPM_MAIN" ]; then
  echo "error: bundled pnpm not found under $RUNTIME_DIR" >&2
  exit 1
fi

# Prefer an Electron binary the user already has (dsh-orb ships a pinned one),
# so this project never downloads an Electron runtime of its own.
find_electron() {
  local candidates=(
    "${DSH_CUA_PREVIEW_ELECTRON:-}"
    "$HOME/.dsh/dsh-orb/electron-runtime/Electron.app/Contents/MacOS/Electron"
    "/Applications/Electron.app/Contents/MacOS/Electron"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

ELECTRON_PATH="$(find_electron || true)"
if [ -z "$ELECTRON_PATH" ]; then
  echo "warning: no Electron binary found."
  echo "         Install dsh-orb (its pinned Electron cache is reused) or set"
  echo "         DSH_CUA_PREVIEW_ELECTRON=/path/to/Electron before running."
fi

echo "==> backing up the desktop profile to $BACKUP_ROOT"
mkdir -p "$BACKUP_ROOT"
cp -p "$PROFILE_DIR/package.json" "$BACKUP_ROOT/"
cp -p "$PROFILE_DIR/cordis.patch.yml" "$BACKUP_ROOT/" 2>/dev/null || true
cp -p "$PROFILE_DIR/pnpm-lock.yaml" "$BACKUP_ROOT/" 2>/dev/null || true

echo "==> installing dsh-cua-preview into $PROFILE_DIR"
(
  cd "$PROFILE_DIR"
  ELECTRON_RUN_AS_NODE=1 \
  DSH_DESKTOP_NODE_EXECUTABLE="$ELECTRON_BIN" \
  PATH="$RUNTIME_DIR/bin:$PATH" \
  "$ELECTRON_BIN" --expose-internals "$PNPM_MAIN" add "file:$REPO_DIR"
)

echo "==> registering the loader row in cordis.patch.yml"
ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BIN" "$PATCH_HELPER" install "$PROFILE_DIR" "$ELECTRON_PATH"

cat <<EOF

Installed.

  profile : $PROFILE_DIR
  backup  : $BACKUP_ROOT
  electron: ${ELECTRON_PATH:-<not found — set electronPath in cordis.patch.yml>}

Next: restart DeepSeek Harness (or wait for the plugin recomposition).
A Host restart interrupts any running session, so save your work first.
The preview appears only while the Agent uses background Computer Use.
EOF
