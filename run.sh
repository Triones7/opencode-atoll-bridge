#!/bin/zsh
# LaunchAgent wrapper for opencode-atoll-bridge.
# Resolves the node binary across nvm / homebrew / system installs, then runs
# bridge.mjs from this script's own directory (so the install location is not
# hardcoded).
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi
# Keep common install locations on PATH so the bridge can find the `opencode`
# CLI (used to auto-discover the API port).
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

NODE="$(command -v node 2>/dev/null)"
[ -z "$NODE" ] && [ -x /opt/homebrew/bin/node ] && NODE=/opt/homebrew/bin/node
[ -z "$NODE" ] && [ -x /usr/local/bin/node ] && NODE=/usr/local/bin/node
[ -z "$NODE" ] && NODE=/usr/bin/node

DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$NODE" "$DIR/bridge.mjs"
