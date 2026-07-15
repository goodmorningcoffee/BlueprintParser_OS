import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { databaseTlsOptions } from "../../../scripts/database-tls.mjs";
import * as schema from "./schema";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Bounded per-task pool; the current Terraform live tuple admits exactly one
  // app task. Recalculate this before any future P5 horizontal scale-out.
  max: 15,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: databaseTlsOptions(),
});

export const db = drizzle(pool, { schema });
