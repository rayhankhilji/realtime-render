#!/bin/sh
# Copies the plugin into a Claude Code dev-mods folder so a session hot-reloads it.
# Usage: scripts/sync-dev-mod.sh <dev-mods session folder>
set -e
DEST="${1:?usage: sync-dev-mod.sh <dev-mods folder>}/live-view"
mkdir -p "$DEST"
(cd "$(dirname "$0")/../plugins/live-view" && tar cf - --exclude=node_modules .) | (cd "$DEST" && tar xf -)
echo "synced to $DEST"
