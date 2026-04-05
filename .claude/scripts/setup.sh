#!/usr/bin/env bash
# setup.sh — Run this once after cloning to install plugins and dependencies.
#
# Usage:
#   bash .claude/scripts/setup.sh

set -euo pipefail

GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

step() { echo -e "\n${BLUE}==>${NC} $1"; }
ok()   { echo -e "${GREEN}✓${NC} $1"; }
err()  { echo -e "${RED}✗${NC} $1"; exit 1; }

# --- Prerequisites ---
step "Checking prerequisites"
command -v git  >/dev/null 2>&1 || err "git is required"
command -v node >/dev/null 2>&1 || err "node is required (>=20)"
command -v npm  >/dev/null 2>&1 || err "npm is required"
ok "Prerequisites met"

# --- npm dependencies (hit-em-with-the-docs) ---
step "Installing npm dependencies"
cd "$PROJECT_DIR"
npm install
ok "npm dependencies installed"

# --- persistent-planning ---
step "Installing persistent-planning"
git clone --depth=1 --quiet \
    https://github.com/TheGlitchKing/persistent-planning.git \
    "$TMP_DIR/persistent-planning"
bash "$TMP_DIR/persistent-planning/install.sh" --scope project
ok "persistent-planning installed"

# --- babel-fish ---
step "Installing babel-fish"
git clone --depth=1 --quiet \
    https://github.com/TheGlitchKing/babel-fish.git \
    "$TMP_DIR/babel-fish"
bash "$TMP_DIR/babel-fish/.claude/install.sh" "$PROJECT_DIR"
ok "babel-fish installed"

# --- Done ---
echo ""
echo -e "${GREEN}=============================${NC}"
echo -e "${GREEN}Setup complete!${NC}"
echo -e "${GREEN}=============================${NC}"
echo ""
echo "Installed plugins:"
echo "  • persistent-planning  → .claude/skills/, .claude/commands/"
echo "  • babel-fish           → .claude/skills/, .claude/rules/, .claude/templates/"
echo "  • hit-em-with-the-docs → node_modules/ (CLI: hewtd)"
echo ""
echo "Open this project in Claude Code to get started."
