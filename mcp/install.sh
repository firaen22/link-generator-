#!/usr/bin/env bash
#
# One-line installer for the pwp-links MCP server (Codex).
#
#   curl -fsSL https://raw.githubusercontent.com/firaen22/link-generator-/main/mcp/install.sh | bash
#
# Downloads the server (+ its one dependency, sharp) and registers it in
# ~/.codex/config.toml. Prompts for your access key (or pass it via PWP_API_KEY=).
#
# Override (for testing): PWP_INSTALL_DIR, CODEX_CONFIG, PWP_SRC
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/firaen22/link-generator-/main/mcp"
INSTALL_DIR="${PWP_INSTALL_DIR:-$HOME/.pwp-links}"
SERVER="$INSTALL_DIR/server.mjs"
CODEX_CONFIG="${CODEX_CONFIG:-$HOME/.codex/config.toml}"
SRC="${PWP_SRC:-$REPO_RAW/server.mjs}"

echo "→ Installing pwp-links MCP for Codex…"

# 1. Node + npm check
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js is required but not found. Install Node 18+ from https://nodejs.org and re-run." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "✗ npm is required (it installs the 'sharp' image-compression dependency) but not found." >&2
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

# 2b. Install the sharp dependency into the install dir. The server does
#     `import sharp` to compress preview images, so node_modules must be present
#     alongside server.mjs. A local package.json keeps the install self-contained.
echo "→ Installing sharp into $INSTALL_DIR (one-time)…"
cat > "$INSTALL_DIR/package.json" <<'PKG'
{ "name": "pwp-links-installed", "private": true, "type": "module", "dependencies": { "sharp": "^0.33.5" } }
PKG
( cd "$INSTALL_DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) || {
  echo "✗ Failed to install 'sharp'. Run: cd $INSTALL_DIR && npm install" >&2
  exit 1
}

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

# 4. Register with whichever hosts are present (Codex and/or Claude)
REGISTERED=""

# --- Codex (register if the codex CLI exists or a config already does) ---
if command -v codex >/dev/null 2>&1 || [ -f "$CODEX_CONFIG" ]; then
  mkdir -p "$(dirname "$CODEX_CONFIG")"
  touch "$CODEX_CONFIG"
  if grep -q '^\[mcp_servers.pwp-links\]' "$CODEX_CONFIG"; then
    echo "✓ Codex already has [mcp_servers.pwp-links] — leaving config unchanged."
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
  REGISTERED="${REGISTERED}Codex "
fi

# --- Claude (register via the claude CLI if available; idempotent) ---
if command -v claude >/dev/null 2>&1; then
  claude mcp remove pwp-links --scope user >/dev/null 2>&1 || true
  if claude mcp add pwp-links --scope user -e PWP_API_KEY="$KEY" -- node "$SERVER" >/dev/null 2>&1; then
    echo "✓ Registered with Claude (user scope)"
    REGISTERED="${REGISTERED}Claude "
  else
    echo "⚠ Claude CLI found but registration failed — register manually (see README)."
  fi
fi

if [ -z "$REGISTERED" ]; then
  echo "⚠ Neither Codex nor Claude detected. Server is at $SERVER —"
  echo "  add it manually using the snippets in the README."
fi

echo ""
echo "✓ Done${REGISTERED:+ ($REGISTERED)}. Restart your app, then try:"
echo "    \"generate a share link for <client> using <pdf path>\""
