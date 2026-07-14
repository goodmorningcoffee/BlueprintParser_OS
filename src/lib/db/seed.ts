import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { companies, users, projects, pages } from "./schema";
import { logger } from "@/lib/logger";
import { assertLocalSchemaMutationTarget } from "../../../scripts/run-local-drizzle-command.mjs";

async function seed() {
  assertLocalSchemaMutationTarget();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  try {
    logger.info("Seeding database...");

    const existing = await pool.query(
      "SELECT email FROM users WHERE email = 'demo@demo.com' LIMIT 1",
    );
    if (existing.rows.length > 0) {
      logger.info("Demo data already exists; no changes made.");
      return;
    }

    // Create test company
    const accessKey = crypto.randomBytes(16).toString("hex");
    const [company] = await db
    .insert(companies)
    .values({
      name: "Demo Company",
      dataKey: "demo",
      accessKey,
      emailDomain: "demo.com",
      subscription: 1,
      features: { yolo: true, llm: true, textract: true },
    })
    .returning();

    logger.info(`Company created: "${company.name}"`);
    logger.info(`Access Key: ${accessKey}`);

  // Create test user
    const passwordHash = await bcrypt.hash("password123", 12);
    const [user] = await db
    .insert(users)
    .values({
      username: "Demo User",
      email: "demo@demo.com",
      passwordHash,
      role: "admin",
      companyId: company.id,
    })
    .returning();

    logger.info(`User created: ${user.email} / password123`);

  // Create a sample project (no real PDF, just for UI testing)
    const [project] = await db
    .insert(projects)
    .values({
      name: "Sample Blueprint Set",
      dataUrl: "demo/00000000000000000001",
      numPages: 3,
      status: "completed",
      authorId: user.id,
      companyId: company.id,
    })
    .returning();

  // Create sample pages
    await db.insert(pages).values([
    {
      pageNumber: 1,
      name: "Page 1",
      drawingNumber: "A-100",
      rawText:
        "FLOOR PLAN LEVEL 1 concrete wall assembly door single 3-0 x 7-0",
      projectId: project.id,
    },
    {
      pageNumber: 2,
      name: "Page 2",
      drawingNumber: "A-200",
      rawText: "FLOOR PLAN LEVEL 2 electrical panel HVAC unit fire sprinkler",
      projectId: project.id,
    },
    {
      pageNumber: 3,
      name: "Page 3",
      drawingNumber: "E-100",
      rawText: "ELECTRICAL PLAN power distribution lighting fixtures conduit",
      projectId: project.id,
    },
  ]);

    logger.info(`Project created: "${project.name}" (${project.publicId})`);
    logger.info("\n--- Login credentials ---");
    logger.info(`Email: demo@demo.com`);
    logger.info(`Password: password123`);
    logger.info(`Access Key (for registration): ${accessKey}`);
  } finally {
    await pool.end();
  }
}

seed().catch((error) => {
  logger.error(error);
  process.exitCode = 1;
});
