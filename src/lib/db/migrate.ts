import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { logger } from "@/lib/logger";

async function runMigrations() {
  logger.info("Running database migrations...");

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : undefined,
  });

  const db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./drizzle" });

  logger.info("Migrations complete.");
  await pool.end();
}

runMigrations().catch((err) => {
  logger.error("Migration failed:", err);
  process.exit(1);
});
