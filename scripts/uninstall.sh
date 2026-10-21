#!/usr/bin/env bash
#
# dsh-cua-preview uninstaller.
#
# Removes the loader row from the desktop profile's user patch, removes the
# `file:` dependency from the profile manifest and (optionally) deletes local
# logs/state.
#
# Usage:
#   bash scripts/uninstall.sh            # keep logs and backups
#   bash scripts/uninstall.sh --purge    # also delete ~/.dsh/cua-preview
#
set -euo pipefail

PURGE=0
if [ "${1:-}" = "--purge" ]; then PURGE=1; fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DSH_APP="${DSH_APP:-/Applications/DeepSeek Harness.app}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/desktop"
ELECTRON_BIN="$DSH_APP/Contents/MacOS/DeepSeek Harness"
RUNTIME_DIR="$DSH_APP/Contents/Resources/runtime"
PNPM_MAIN="$RUNTIME_DIR/primary-runtime/dependencies/pnpm/bin/pnpm.mjs"
PATCH_HELPER="$REPO_DIR/scripts/profile-patch.mjs"

if [ ! -f "$PROFILE_DIR/package.json" ]; then
  echo "error: desktop profile not found at $PROFILE_DIR" >&2
  exit 1
fi

echo "==> removing the loader row from cordis.patch.yml"
ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BIN" "$PATCH_HELPER" uninstall "$PROFILE_DIR"

echo "==> removing the profile dependency"
(
  cd "$PROFILE_DIR"
  ELECTRON_RUN_AS_NODE=1 \
  DSH_DESKTOP_NODE_EXECUTABLE="$ELECTRON_BIN" \
  PATH="$RUNTIME_DIR/bin:$PATH" \
  "$ELECTRON_BIN" --expose-internals "$PNPM_MAIN" remove dsh-cua-preview || true
)

if [ "$PURGE" = "1" ]; then
  echo "==> deleting ~/.dsh/cua-preview (logs, window position, backups)"
  rm -rf "$DSH_HOME/cua-preview"
fi

cat <<EOF

Uninstalled. Restart DeepSeek Harness so the overlay process is gone.
Backups of the profile were made by install.sh under ~/.dsh/cua-preview/install-backup-*.
EOF
