#!/usr/bin/env bash
set -euo pipefail

REPO_URL="git@github.com:Traveler0014/pi-providers.git"
EXTENSIONS_DIR="${HOME}/.pi/agent/extensions"
CLONE_DIR="${HOME}/.pi/agent/git/github.com/Traveler0014/pi-providers"

info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m  !\033[0m %s\n' "$*"; }
err()   { printf '\033[1;31m  ✗\033[0m %s\n' "$*" >&2; }

# ── Preflight ──────────────────────────────────────────────────────────

if ! command -v git &>/dev/null; then
  err "git is required but not installed."
  exit 1
fi

# ── Method 1: pi install (preferred) ──────────────────────────────────

if command -v pi &>/dev/null; then
  info "Installing via pi install..."
  if pi install "$REPO_URL" 2>/dev/null; then
    ok "Installed via pi install"
    info "Restart pi or run /reload to load extensions."
    exit 0
  else
    warn "pi install failed, falling back to manual install..."
  fi
fi

# ── Method 2: Manual copy ─────────────────────────────────────────────

info "Cloning repository..."
if [ -d "$CLONE_DIR" ]; then
  git -C "$CLONE_DIR" pull --ff-only 2>/dev/null || git -C "$CLONE_DIR" pull --rebase
else
  mkdir -p "$(dirname "$CLONE_DIR")"
  git clone "$REPO_URL" "$CLONE_DIR"
fi
ok "Repository cloned to $CLONE_DIR"

info "Installing extensions to $EXTENSIONS_DIR..."
mkdir -p "$EXTENSIONS_DIR"

# Install each extension
installed=0
for ext_dir in "$CLONE_DIR"/*/; do
  ext_name="$(basename "$ext_dir")"
  entry="$ext_dir/index.ts"

  if [ -f "$entry" ]; then
    cp "$entry" "$EXTENSIONS_DIR/${ext_name}.ts"
    ok "Installed $ext_name"
    installed=$((installed + 1))
  fi
done

if [ "$installed" -eq 0 ]; then
  err "No extensions found to install."
  exit 1
fi

echo ""
info "Installed $installed extension(s)."
info "Restart pi or run /reload to load them."
