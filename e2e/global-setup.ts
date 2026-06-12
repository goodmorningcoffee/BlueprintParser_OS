// [refactor jun12 P0.4] e2e global setup — seeds the LOCAL test database with
// the synthetic-viewer world and makes the run self-sufficient:
//   company "E2E Co" + credentialed user + completed 100-page project whose
//   dataUrl matches the cdn-stub route (e2e/synthetic) + the fixture PDF.
// Raw SQL on purpose (no app imports): upserts keyed on the schema's unique
// columns (companies.data_key, users.email, projects.data_url) so re-runs are
// idempotent and survive the vitest suite's fresh-migrate wiping things.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import bcrypt from "bcrypt";

const TEST_DATABASE_URL = "postgres://bp_test:bp_test@localhost:5433/bp_test";
export const E2E = {
  email: "e2e@test.invalid",
  password: "e2e-password-123",
  dataUrl: "e2e/synthetic",
  pages: 100,
};

export default async function globalSetup() {
  if (!existsSync("test/fixtures/synthetic-100pg.pdf")) {
    console.log("[e2e-setup] generating synthetic fixture…");
    execFileSync("node", ["scripts/make-synthetic-pdf.mjs"], { stdio: "inherit" });
  }

  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  try {
    // schema may not exist on a fresh db (vitest's global-setup usually
    // migrates; this makes e2e standalone). drizzle migrator is journal-
    // idempotent, safe to call on an already-migrated db.
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });

    const company = await pool.query(
      `INSERT INTO companies (name, data_key, access_key, email_domain)
       VALUES ('E2E Co', 'e2e-co', 'e2e-access', 'test.invalid')
       ON CONFLICT (data_key) DO UPDATE SET name = excluded.name
       RETURNING id`,
    );
    const companyId = company.rows[0].id;

    const hash = bcrypt.hashSync(E2E.password, 10);
    const user = await pool.query(
      `INSERT INTO users (username, email, company_id, password_hash, role)
       VALUES ('e2e-user', $1, $2, $3, 'member')
       ON CONFLICT (email) DO UPDATE SET password_hash = excluded.password_hash, company_id = excluded.company_id
       RETURNING id`,
      [E2E.email, companyId, hash],
    );
    const userId = user.rows[0].id;

    const project = await pool.query(
      `INSERT INTO projects (name, data_url, company_id, author_id, status, num_pages, is_demo)
       VALUES ('E2E Synthetic Plan Set', $1, $2, $3, 'completed', $4, false)
       ON CONFLICT (data_url) DO UPDATE SET num_pages = $4, status = 'completed', company_id = $2, author_id = $3
       RETURNING id, public_id`,
      [E2E.dataUrl, companyId, userId, E2E.pages],
    );
    const projectId = project.rows[0].id;
    const publicId = project.rows[0].public_id;

    await pool.query(`DELETE FROM pages WHERE project_id = $1`, [projectId]);
    await pool.query(
      `INSERT INTO pages (project_id, page_number, name)
       SELECT $1, n, 'Page ' || n FROM generate_series(1, $2::int) n`,
      [projectId, E2E.pages],
    );

    mkdirSync("e2e/.state", { recursive: true });
    writeFileSync("e2e/.state/world.json", JSON.stringify({ publicId, ...E2E }, null, 2));
    console.log(`[e2e-setup] world ready: project ${publicId} (${E2E.pages} pages)`);
  } finally {
    await pool.end();
  }
}
