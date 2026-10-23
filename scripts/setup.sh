#!/bin/bash
# ──────────────────────────────────────────────────────────────
# BlueprintParser — First-time setup
#
# Creates the root admin account and initializes the database.
# Run this once after cloning the repo and starting PostgreSQL.
#
# Prerequisites:
#   - Node.js 24 (see .nvmrc)
#   - PostgreSQL running (docker compose up -d)
#   - .env.local configured with DATABASE_URL
#
# Usage: bash scripts/setup.sh
# ──────────────────────────────────────────────────────────────

set -euo pipefail

echo ""
echo "  BlueprintParser — First-Time Setup"
echo "  ==================================="
echo ""

# ── Check prerequisites ──────────────────────────────────────
command -v node >/dev/null 2>&1 || { echo "Error: Node.js is required. Install it from https://nodejs.org"; exit 1; }
command -v npx >/dev/null 2>&1 || { echo "Error: npx is required (comes with Node.js)"; exit 1; }

if [ ! -f .env.local ] && [ -z "${DATABASE_URL:-}" ]; then
  echo "Error: No .env.local found and DATABASE_URL not set."
  echo "  Copy .env.example to .env.local and fill in DATABASE_URL first."
  echo "  Example: cp .env.example .env.local"
  exit 1
fi

# Read only DATABASE_URL through dotenv; never execute .env.local as shell code.
if [ -f .env.local ] && [ -z "${DATABASE_URL:-}" ]; then
  DATABASE_URL=$(node -e "
const { config } = require('dotenv');
config({ path: '.env.local', quiet: true });
process.stdout.write(process.env.DATABASE_URL || '');
")
  export DATABASE_URL
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "Error: DATABASE_URL not set in .env.local"
  exit 1
fi

# ── Run database migrations ──────────────────────────────────
echo "Step 1: Running database migrations..."
npm run db:migrate --silent 2>&1 | tail -3
echo "  Migrations complete."
echo ""

# ── Prompt for admin credentials ─────────────────────────────
echo "Step 2: Create root admin account"
echo ""

read -p "  Admin email: " ADMIN_EMAIL
if [ -z "$ADMIN_EMAIL" ]; then
  echo "  Error: Email is required."
  exit 1
fi

read -p "  Admin username [admin]: " ADMIN_USER
ADMIN_USER=${ADMIN_USER:-admin}

while true; do
  read -s -p "  Password (min 8 chars): " ADMIN_PASS
  echo ""
  if [ ${#ADMIN_PASS} -lt 8 ]; then
    echo "  Password must be at least 8 characters. Try again."
  else
    break
  fi
done

# ── Create admin user via Node.js ────────────────────────────
echo ""
echo "Step 3: Creating admin account..."

# Pass credentials via env vars (not command line args) for security. The
# invoked writer independently rechecks local database authority immediately
# before loading the PostgreSQL driver.
export SETUP_EMAIL="$ADMIN_EMAIL"
export SETUP_USER="$ADMIN_USER"
export SETUP_PASS="$ADMIN_PASS"

node scripts/create-local-root-admin.mjs 2>&1

echo ""
echo "  Setup complete!"
echo ""
echo "  Start the app:  npm run dev"
echo "  Open:           http://localhost:3000"
echo "  Login with:     $ADMIN_EMAIL"
echo ""
