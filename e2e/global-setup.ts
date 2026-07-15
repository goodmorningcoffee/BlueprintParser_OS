// [refactor jun12 P0.4] e2e global setup — seeds the LOCAL test database with
// the synthetic-viewer world and makes the run self-sufficient:
//   company "E2E Co" + credentialed user + completed 100-page project whose
//   canonical dataUrl maps through the S3-shaped fixture endpoint.
// Raw SQL on purpose (no app imports): upserts keyed on the schema's unique
// columns (companies.data_key, users.email, projects.data_url) so re-runs are
// idempotent and survive the vitest suite's fresh-migrate wiping things.
import { mkdirSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import bcrypt from "bcrypt";
import { ensureSyntheticPdfFixture } from "./ensure-synthetic-pdf.mjs";

const TEST_DATABASE_URL = "postgres://bp_test:bp_test@localhost:5433/bp_test";
export const E2E = {
  email: "e2e@test.invalid",
  password: "e2e-password-123",
  dataUrl: "e2e-co/00000000000000000001",
  outsiderEmail: "e2e-outsider@outsider.test.invalid",
  outsiderPassword: "e2e-outsider-password-123",
  // [refactor jun16 P0-review] a second, is_demo=true project for the demo
  // read-only golden path. Distinct data_url (data_url is unique); the cdn-stub
  // serves any <dataUrl>/original.pdf so it shares the one fixture.
  demoDataUrl: "e2e-co/00000000000000000002",
  pages: 100,
};

export default async function globalSetup() {
  ensureSyntheticPdfFixture();

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
       ON CONFLICT (data_key) DO UPDATE
         SET name = excluded.name,
             access_key = excluded.access_key,
             email_domain = excluded.email_domain
       RETURNING id`,
    );
    const companyId = company.rows[0].id;

    const hash = bcrypt.hashSync(E2E.password, 10);
    const user = await pool.query(
      `INSERT INTO users
         (username, email, company_id, password_hash, role, can_run_models, is_root_admin)
       VALUES ('e2e-user', $1, $2, $3, 'member', false, false)
       ON CONFLICT (email) DO UPDATE
         SET username = excluded.username,
             password_hash = excluded.password_hash,
             company_id = excluded.company_id,
             role = 'member',
             can_run_models = false,
             is_root_admin = false
       RETURNING id`,
      [E2E.email, companyId, hash],
    );
    const userId = user.rows[0].id;

    // The private-asset transport oracle needs a real second-tenant session.
    // Keep it structurally incapable of becoming a privileged bypass even if a
    // prior local run edited the fixture row: every upsert pins member scope,
    // disables model authority, and clears root-admin authority.
    const outsiderCompany = await pool.query(
      `INSERT INTO companies (name, data_key, access_key, email_domain)
       VALUES ('E2E Outsider Co', 'e2e-outsider', 'e2e-outsider-access', 'outsider.test.invalid')
       ON CONFLICT (data_key) DO UPDATE
         SET name = excluded.name,
             access_key = excluded.access_key,
             email_domain = excluded.email_domain
       RETURNING id`,
    );
    const outsiderCompanyId = outsiderCompany.rows[0].id;
    if (outsiderCompanyId === companyId) {
      throw new Error(
        "E2E outsider company must be distinct from the fixture owner",
      );
    }
    const outsiderHash = bcrypt.hashSync(E2E.outsiderPassword, 10);
    const outsider = await pool.query(
      `INSERT INTO users
         (username, email, company_id, password_hash, role, can_run_models, is_root_admin)
       VALUES ('e2e-outsider', $1, $2, $3, 'member', false, false)
       ON CONFLICT (email) DO UPDATE
         SET username = excluded.username,
             company_id = excluded.company_id,
             password_hash = excluded.password_hash,
             role = 'member',
             can_run_models = false,
             is_root_admin = false
       RETURNING id`,
      [E2E.outsiderEmail, outsiderCompanyId, outsiderHash],
    );
    const outsiderUserId = outsider.rows[0].id;

    // Project reseeding is one serialized transaction. A prior interrupted run
    // may have left the fixture published as a demo or holding mutation leases;
    // withdraw it through the lifecycle guard, clear leases, and rebuild all
    // mutable fixture rows before exposing world.json.
    const projectClient = await pool.connect();
    let projectId: number;
    let publicId: string;
    try {
      await projectClient.query("BEGIN");
      await projectClient.query(
        `INSERT INTO projects (name, data_url, company_id, author_id, status, num_pages, is_demo)
         VALUES ('E2E Synthetic Plan Set', $1, $2, $3, 'completed', $4, false)
         ON CONFLICT (data_url) DO NOTHING`,
        [E2E.dataUrl, companyId, userId, E2E.pages],
      );
      const project = await projectClient.query(
        `SELECT id, public_id, company_id, is_demo
           FROM projects
          WHERE data_url = $1
          FOR UPDATE`,
        [E2E.dataUrl],
      );
      if (
        project.rows.length !== 1 ||
        project.rows[0].company_id !== companyId
      ) {
        throw new Error(
          "E2E private storage root is not owned by the fixture company",
        );
      }
      projectId = project.rows[0].id;
      publicId = project.rows[0].public_id;

      if (project.rows[0].is_demo) {
        await projectClient.query(
          `UPDATE projects
              SET is_demo = false,
                  lifecycle_epoch = lifecycle_epoch + 1,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [projectId],
        );
      }
      await projectClient.query(
        `DELETE FROM project_mutation_leases WHERE project_id = $1`,
        [projectId],
      );
      await projectClient.query(
        `UPDATE projects
            SET name = 'E2E Synthetic Plan Set',
                author_id = $2,
                status = 'completed',
                num_pages = $3,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [projectId, userId, E2E.pages],
      );

      // [refactor jun16 P0-review] the golden paths write annotations and a
      // takeoff item; clear them before replacing pages so every run starts at
      // the same private-project state.
      await projectClient.query(
        `DELETE FROM annotations WHERE project_id = $1`,
        [projectId],
      );
      await projectClient.query(
        `DELETE FROM takeoff_items WHERE project_id = $1`,
        [projectId],
      );
      await projectClient.query(`DELETE FROM pages WHERE project_id = $1`, [
        projectId,
      ]);
      await projectClient.query(
        `INSERT INTO pages (project_id, page_number, name)
         SELECT $1, n, 'Page ' || n FROM generate_series(1, $2::int) n`,
        [projectId, E2E.pages],
      );
      // pages.search_vector has no DB trigger; seed both source text and the
      // vector so the search-jump golden path deterministically matches.
      await projectClient.query(
        `UPDATE pages
         SET raw_text = 'door schedule plan page ' || page_number,
             search_vector = to_tsvector('english', 'door schedule plan page ' || page_number)
         WHERE project_id = $1`,
        [projectId],
      );
      await projectClient.query("COMMIT");
    } catch (error) {
      await projectClient.query("ROLLBACK");
      throw error;
    } finally {
      projectClient.release();
    }

    // [refactor jun16 P0-review] demo project for the read-only golden path. Demo child rows are
    // immutable at the database boundary, so the idempotent fixture must withdraw an existing demo,
    // seed while private, and publish only after the complete test world exists.
    // No demo user is needed — the /demo/* routes are public.
    const demoClient = await pool.connect();
    let demoProjectId: number;
    let demoPublicId: string;
    try {
      await demoClient.query("BEGIN");
      await demoClient.query(
        `INSERT INTO projects (name, data_url, company_id, author_id, status, num_pages, is_demo)
         VALUES ('E2E Demo Plan Set', $1, $2, $3, 'completed', $4, false)
         ON CONFLICT (data_url) DO NOTHING`,
        [E2E.demoDataUrl, companyId, userId, E2E.pages],
      );
      const demo = await demoClient.query(
        `SELECT id, public_id, company_id, is_demo
           FROM projects
          WHERE data_url = $1
          FOR UPDATE`,
        [E2E.demoDataUrl],
      );
      if (demo.rows.length !== 1 || demo.rows[0].company_id !== companyId) {
        throw new Error(
          "E2E demo storage root is not owned by the fixture company",
        );
      }
      demoProjectId = demo.rows[0].id;
      demoPublicId = demo.rows[0].public_id;

      if (demo.rows[0].is_demo) {
        await demoClient.query(
          `UPDATE projects
              SET is_demo = false,
                  lifecycle_epoch = lifecycle_epoch + 1,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [demoProjectId],
        );
      }
      await demoClient.query(
        `UPDATE projects
            SET name = 'E2E Demo Plan Set',
                author_id = $2,
                status = 'completed',
                num_pages = $3,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [demoProjectId, userId, E2E.pages],
      );
      await demoClient.query(`DELETE FROM pages WHERE project_id = $1`, [
        demoProjectId,
      ]);
      await demoClient.query(
        `INSERT INTO pages (project_id, page_number, name)
         SELECT $1, n, 'Page ' || n FROM generate_series(1, $2::int) n`,
        [demoProjectId, E2E.pages],
      );
      await demoClient.query(
        `UPDATE pages
         SET page_intelligence = $2::jsonb
         WHERE project_id = $1 AND page_number = 1`,
        [
          demoProjectId,
          JSON.stringify({
            parsedRegions: [
              {
                id: "e2e-demo-retained-schedule",
                type: "schedule",
                category: "door-schedule",
                bbox: [0.1, 0.1, 0.8, 0.35],
                confidence: 0.85,
                source: "user",
                csiTags: [],
                data: {
                  headers: ["TAG", "DESCRIPTION"],
                  rows: [{ TAG: "D-201", DESCRIPTION: "Demo door" }],
                  tagColumn: "TAG",
                  tableName: "E2E Demo Door Schedule",
                  rowCount: 1,
                  columnCount: 2,
                },
              },
            ],
          }),
        ],
      );
      await demoClient.query(
        `UPDATE projects
            SET is_demo = true,
                lifecycle_epoch = lifecycle_epoch + 1,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [demoProjectId],
      );
      await demoClient.query("COMMIT");
    } catch (error) {
      await demoClient.query("ROLLBACK");
      throw error;
    } finally {
      demoClient.release();
    }

    mkdirSync("e2e/.state", { recursive: true });
    writeFileSync(
      "e2e/.state/world.json",
      JSON.stringify(
        {
          publicId,
          projectDbId: projectId,
          demoPublicId,
          demoProjectDbId: demoProjectId,
          outsiderCompanyId,
          outsiderUserId,
          ...E2E,
        },
        null,
        2,
      ),
    );
    console.log(
      `[e2e-setup] world ready: project ${publicId} + demo ${demoPublicId} (${E2E.pages} pages each)`,
    );
  } finally {
    await pool.end();
  }
}
