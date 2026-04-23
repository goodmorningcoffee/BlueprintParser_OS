import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // 15 per task × ECS max 8 tasks = 120 max connections, leaves headroom
  // under the db.t4g.medium default ~100 before RDS connection exhaustion.
  // Pre-Reddit-launch trim from 25.
  max: 15,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === "true" }
      : undefined,
});

export const db = drizzle(pool, { schema });
