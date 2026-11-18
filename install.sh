#!/bin/zsh
# Idempotent installer for opencode-atoll-bridge.
#
#   ./install.sh              # install/update and start the LaunchAgent
#   ./install.sh --no-launch  # install files only, don't touch launchd
#   ./install.sh --uninstall  # stop and remove the LaunchAgent (keeps files)
#
# Env:
#   BRIDGE_DIR   install location (default ~/.opencode-atoll-bridge)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_DIR="${BRIDGE_DIR:-$HOME/.opencode-atoll-bridge}"
LABEL="ai.atoll.opencode-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

action="install"
case "${1:-}" in
  --no-launch) action="no-launch" ;;
  --uninstall) action="uninstall" ;;
  "") ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

if [ "$action" = "uninstall" ]; then
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "uninstalled launchd job (files kept at $BRIDGE_DIR)"
  exit 0
fi

# Copy the repo into place when it isn't already installed at BRIDGE_DIR.
if [ "$REPO_DIR" != "$BRIDGE_DIR" ]; then
  mkdir -p "$BRIDGE_DIR"
  cp -a "$REPO_DIR"/. "$BRIDGE_DIR"/
  echo "copied $REPO_DIR -> $BRIDGE_DIR"
fi

chmod +x "$BRIDGE_DIR/run.sh" "$BRIDGE_DIR/install.sh" 2>/dev/null || true

mkdir -p "$HOME/Library/LaunchAgents"
sed "s|__BRIDGE_DIR__|$BRIDGE_DIR|g" \
  "$BRIDGE_DIR/ai.atoll.opencode-bridge.plist.template" > "$PLIST"
echo "wrote $PLIST"

if [ "$action" = "no-launch" ]; then
  echo "done (launchd not touched)"
  exit 0
fi

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
sleep 2
if launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
  echo "started: $LABEL"
else
  echo "WARNING: job not loaded; check $BRIDGE_DIR/bridge.err.log" >&2
fi
