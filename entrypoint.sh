#!/bin/sh
set -e

echo "Running database migrations..."
node -e "
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
const { Pool } = require('pg');

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations complete.');

  // Clean up stale projects stuck in uploading/processing from prior deploys
  const stale = await pool.query(
    \"UPDATE projects SET status = 'error', processing_error = 'Stale - stuck from prior deployment', updated_at = NOW() WHERE status IN ('uploading', 'processing') AND updated_at < NOW() - INTERVAL '1 hour' RETURNING id\"
  );
  if (stale.rowCount > 0) {
    console.log('Cleaned up ' + stale.rowCount + ' stale project(s).');
  }

  await pool.end();
}

run().catch(err => { console.error('Migration failed:', err); process.exit(1); });
"

echo "Starting application..."
exec node server.js
