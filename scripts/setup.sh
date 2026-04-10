#!/bin/bash
# ──────────────────────────────────────────────────────────────
# BlueprintParser — First-time setup
#
# Creates the root admin account and initializes the database.
# Run this once after cloning the repo and starting PostgreSQL.
#
# Prerequisites:
#   - Node.js 20+
#   - PostgreSQL running (docker compose up -d)
#   - .env.local configured with DATABASE_URL
#
# Usage: bash scripts/setup.sh
# ──────────────────────────────────────────────────────────────

set -e

echo ""
echo "  BlueprintParser — First-Time Setup"
echo "  ==================================="
echo ""

# ── Check prerequisites ──────────────────────────────────────
command -v node >/dev/null 2>&1 || { echo "Error: Node.js is required. Install it from https://nodejs.org"; exit 1; }
command -v npx >/dev/null 2>&1 || { echo "Error: npx is required (comes with Node.js)"; exit 1; }

if [ ! -f .env.local ] && [ -z "$DATABASE_URL" ]; then
  echo "Error: No .env.local found and DATABASE_URL not set."
  echo "  Copy .env.example to .env.local and fill in DATABASE_URL first."
  echo "  Example: cp .env.example .env.local"
  exit 1
fi

# Source .env.local if it exists (for DATABASE_URL)
if [ -f .env.local ]; then
  export $(grep -v '^#' .env.local | grep -v '^\s*$' | xargs)
fi

if [ -z "$DATABASE_URL" ]; then
  echo "Error: DATABASE_URL not set in .env.local"
  exit 1
fi

# ── Run database migrations ──────────────────────────────────
echo "Step 1: Running database migrations..."
npx drizzle-kit migrate 2>&1 | tail -3
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

# Pass credentials via env vars (not command line args) for security
export SETUP_EMAIL="$ADMIN_EMAIL"
export SETUP_USER="$ADMIN_USER"
export SETUP_PASS="$ADMIN_PASS"

node -e "
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  });

  const hash = await bcrypt.hash(process.env.SETUP_PASS, 12);

  // Create default company if none exists
  let companyId;
  const existing = await pool.query('SELECT id FROM companies LIMIT 1');
  if (existing.rows.length > 0) {
    companyId = existing.rows[0].id;
  } else {
    const result = await pool.query(
      \"INSERT INTO companies (name, public_id) VALUES ('Default', 'default') RETURNING id\"
    );
    companyId = result.rows[0].id;
  }

  // Create or update admin user
  await pool.query(
    \"INSERT INTO users (email, username, password_hash, role, is_root_admin, company_id) VALUES (\\\$1, \\\$2, \\\$3, 'admin', true, \\\$4) ON CONFLICT (email) DO UPDATE SET is_root_admin = true, password_hash = \\\$3, role = 'admin'\",
    [process.env.SETUP_EMAIL, process.env.SETUP_USER, hash, companyId]
  );

  console.log('  Root admin created: ' + process.env.SETUP_EMAIL);
  await pool.end();
}

run().catch(err => { console.error('  Error:', err.message); process.exit(1); });
" 2>&1

echo ""
echo "  Setup complete!"
echo ""
echo "  Start the app:  npm run dev"
echo "  Open:           http://localhost:3000"
echo "  Login with:     $ADMIN_EMAIL"
echo ""
