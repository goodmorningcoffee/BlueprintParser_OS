import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { companies, users, projects, pages } from "./schema";

async function seed() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  console.log("Seeding database...");

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

  console.log(`Company created: "${company.name}"`);
  console.log(`Access Key: ${accessKey}`);

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

  console.log(`User created: ${user.email} / password123`);

  // Create a sample project (no real PDF, just for UI testing)
  const [project] = await db
    .insert(projects)
    .values({
      name: "Sample Blueprint Set",
      dataUrl: "demo/sample-project",
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
      rawText: "FLOOR PLAN LEVEL 1 concrete wall assembly door single 3-0 x 7-0",
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

  console.log(`Project created: "${project.name}" (${project.publicId})`);
  console.log("\n--- Login credentials ---");
  console.log(`Email: demo@demo.com`);
  console.log(`Password: password123`);
  console.log(`Access Key (for registration): ${accessKey}`);

  await pool.end();
}

seed().catch(console.error);
