#!/usr/bin/env bash
#
# One-line installer for the pwp-links MCP server (Codex).
#
#   curl -fsSL https://raw.githubusercontent.com/firaen22/link-generator-/main/mcp/install.sh | bash
#
# Downloads the zero-dependency server and registers it in ~/.codex/config.toml.
# Prompts for your personal access key (or pass it via PWP_API_KEY=... ).
#
# Override (for testing): PWP_INSTALL_DIR, CODEX_CONFIG, PWP_SRC
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/firaen22/link-generator-/main/mcp"
INSTALL_DIR="${PWP_INSTALL_DIR:-$HOME/.pwp-links}"
SERVER="$INSTALL_DIR/server.mjs"
CODEX_CONFIG="${CODEX_CONFIG:-$HOME/.codex/config.toml}"
SRC="${PWP_SRC:-$REPO_RAW/server.mjs}"

echo "→ Installing pwp-links MCP for Codex…"

# 1. Node check
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js is required but not found. Install Node 18+ from https://nodejs.org and re-run." >&2
  exit 1
fi

# 2. Fetch the server (download URL, or copy a local path when PWP_SRC is local)
mkdir -p "$INSTALL_DIR"
if [ -f "$SRC" ]; then
  cp "$SRC" "$SERVER"
else
  echo "→ Downloading server to $SERVER"
  curl -fsSL "$SRC" -o "$SERVER"
fi

# 3. Access key (from env or interactive prompt via the terminal)
KEY="${PWP_API_KEY:-}"
if [ -z "$KEY" ]; then
  if [ -r /dev/tty ]; then
    printf "Enter your pwp-links access key: " > /dev/tty
    read -r KEY < /dev/tty
  fi
fi
if [ -z "$KEY" ]; then
  echo "✗ No access key provided. Re-run with PWP_API_KEY=<your-key> or answer the prompt." >&2
  exit 1
fi

# 4. Register in Codex config (idempotent)
mkdir -p "$(dirname "$CODEX_CONFIG")"
touch "$CODEX_CONFIG"
if grep -q '^\[mcp_servers.pwp-links\]' "$CODEX_CONFIG"; then
  echo "✓ Codex already has [mcp_servers.pwp-links] — leaving config unchanged."
  echo "  To update the key, edit $CODEX_CONFIG (the PWP_API_KEY under [mcp_servers.pwp-links.env])."
else
  {
    echo ""
    echo "[mcp_servers.pwp-links]"
    echo "command = \"node\""
    echo "args = [\"$SERVER\"]"
    echo ""
    echo "[mcp_servers.pwp-links.env]"
    echo "PWP_API_KEY = \"$KEY\""
  } >> "$CODEX_CONFIG"
  echo "✓ Added [mcp_servers.pwp-links] to $CODEX_CONFIG"
fi

echo ""
echo "✓ Done. Restart Codex, then try:"
echo "    \"generate a share link for <client> using <pdf path>\""
