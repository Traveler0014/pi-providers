#!/usr/bin/env bash
#
# release.sh — Bump extension version, commit, tag, and push.
#
# Usage:
#   bash scripts/release.sh <extension-name> <bump>
#
# Arguments:
#   extension-name   Directory name of the extension (e.g. dashscope-provider)
#   bump             One of: major, minor, patch, or a specific version (e.g. 1.2.3)
#
# Examples:
#   bash scripts/release.sh dashscope-provider patch
#   bash scripts/release.sh cloudflare-openrouter-provider 2.0.0
#

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Args ─────────────────────────────────────────────────────────────────────

if [ $# -lt 2 ]; then
  echo "Usage: $0 <extension-name> <bump>"
  echo "  bump: major | minor | patch | <x.y.z>"
  exit 1
fi

EXT_NAME="$1"
BUMP="$2"
EXT_DIR="$REPO_ROOT/$EXT_NAME"
EXT_PKG="$EXT_DIR/package.json"
ROOT_PKG="$REPO_ROOT/package.json"

# ── Preflight ────────────────────────────────────────────────────────────────

if [ ! -f "$EXT_PKG" ]; then
  echo "✗ Extension package.json not found: $EXT_PKG"
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo "✗ node is required but not installed."
  exit 1
fi

cd "$REPO_ROOT"

# Ensure we're on main
CURRENT_BRANCH="$(git branch --show-current)"
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "✗ Must be on 'main' branch (currently on '$CURRENT_BRANCH')"
  exit 1
fi

# Ensure working tree is clean (except for the docs we're about to regenerate)
if ! git diff --quiet -- "$EXT_DIR"; then
  echo "✗ Uncommitted changes in $EXT_DIR — commit or stash first."
  exit 1
fi

# ── Read current version ─────────────────────────────────────────────────────

OLD_VERSION="$(node -p "require('$EXT_PKG').version")"
echo "  Extension: $EXT_NAME"
echo "  Current:   v$OLD_VERSION"

# ── Bump version ─────────────────────────────────────────────────────────────

if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  # Explicit version
  NEW_VERSION="$BUMP"
  # Update extension package.json
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('$EXT_PKG', 'utf-8'));
    pkg.version = '$NEW_VERSION';
    fs.writeFileSync('$EXT_PKG', JSON.stringify(pkg, null, 2) + '\n');
  "
else
  # Semantic bump
  case "$BUMP" in
    major|minor|patch)
      NEW_VERSION="$(node -e "
        const v = '$OLD_VERSION'.split('.').map(Number);
        const bump = '$BUMP';
        if (bump === 'major') { v[0]++; v[1] = 0; v[2] = 0; }
        if (bump === 'minor') { v[1]++; v[2] = 0; }
        if (bump === 'patch') { v[2]++; }
        process.stdout.write(v.join('.'));
      ")"
      node -e "
        const fs = require('fs');
        const pkg = JSON.parse(fs.readFileSync('$EXT_PKG', 'utf-8'));
        pkg.version = '$NEW_VERSION';
        fs.writeFileSync('$EXT_PKG', JSON.stringify(pkg, null, 2) + '\n');
      "
      ;;
    *)
      echo "✗ Invalid bump value: $BUMP (use major, minor, patch, or x.y.z)"
      exit 1
      ;;
  esac
fi

echo "  New:       v$NEW_VERSION"

# ── Regenerate docs ──────────────────────────────────────────────────────────

echo ""
echo "→ Regenerating README.md..."
npm run --silent update-docs

# ── Commit ───────────────────────────────────────────────────────────────────

TAG="${EXT_NAME}@${NEW_VERSION}"

echo ""
echo "→ Committing..."
git add -A
git commit -m "release: ${TAG}"

# ── Tag ──────────────────────────────────────────────────────────────────────

echo "→ Creating tag: $TAG"
git tag "$TAG"

# ── Push ─────────────────────────────────────────────────────────────────────

echo "→ Pushing to origin..."
git push origin main
git push origin --tags

echo ""
echo "✓ Released $TAG"
echo "  Commit: $(git rev-parse --short HEAD)"
echo "  Tag:    $TAG"
echo ""
echo "  Install: pi install $(node -p "require('$ROOT_PKG').installUrl || require('$ROOT_PKG').repository")"
