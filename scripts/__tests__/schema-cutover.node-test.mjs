import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  P2_CURRENT_TAG,
  P2_DURABLE_CHECKPOINT_TAG,
  assertEmptyDatabaseBootstrapStart,
  assertStrictEmptyDatabaseBootstrapStart,
  assertLegacyLabelingRowsRetired,
  assertP2LocalMigrationContract,
  assertP2CutoverStart,
  assertSchemaCurrent,
  localMigrationContract,
} from "../schema-migration-contract.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const SCHEMA_POLICY_CHECKER = path.join(
  REPO_ROOT,
  "scripts/check-schema-cutover-policy.mjs",
);
const SCHEMA_POLICY_INPUTS = [
  "Dockerfile",
  ".dockerignore",
  ".github/workflows/ci.yml",
  "CONTRIBUTING.md",
  "README.md",
  "deploy.sh",
  "ecs-tune.sh",
  "entrypoint.sh",
  "install_setup.sh",
  "infrastructure/terraform/ecr.tf",
  "infrastructure/terraform/ecs.tf",
  "infrastructure/terraform/backend.hcl.example",
  "infrastructure/terraform/iam.tf",
  "infrastructure/terraform/main.tf",
  "infrastructure/terraform/project-asset-deletions.tf",
  "infrastructure/terraform/rds.tf",
  "infrastructure/terraform/s3.tf",
  "infrastructure/terraform/secrets.tf",
  "infrastructure/terraform/stepfunctions.tf",
  "infrastructure/terraform/variables.tf",
  "package.json",
  "root_admin.sh",
  "scripts/create-local-root-admin.mjs",
  "scripts/cost-control.sh",
  "scripts/database-tls.mjs",
  "scripts/lib/ecs-schema-tools.sh",
  "scripts/p2-schema-cutover.sh",
  "scripts/assert-schema-current.mjs",
  "scripts/assert-schema-migration-ready.mjs",
  "scripts/run-local-drizzle-command.mjs",
  "scripts/run-schema-migrations.mjs",
  "scripts/schema-migration-contract.mjs",
  "scripts/setup.sh",
  "src/lib/db/index.ts",
  "src/lib/yolo.ts",
  "drizzle/0033_project_lifecycle_epoch_and_leases.sql",
];

async function schemaPolicyFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "bp-schema-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(
    SCHEMA_POLICY_INPUTS.map(async (relative) => {
      const destination = path.join(root, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(REPO_ROOT, relative), destination);
    }),
  );
  return root;
}

async function mutateSchemaPolicyFile(root, relative, transform) {
  const file = path.join(root, relative);
  const before = await readFile(file, "utf8");
  const after = transform(before);
  assert.notEqual(
    after,
    before,
    `${relative} mutation must change its fixture`,
  );
  await writeFile(file, after, "utf8");
}

function mutateOneOffTaskContract(source, before, after) {
  const marker = "bp_run_one_off_task() {";
  const start = source.indexOf(marker);
  assert.ok(start >= 0, "one-off task helper must exist in its fixture");
  const body = source.slice(start);
  assert.equal(
    body.split(before).length - 1,
    1,
    "one-off task mutation needle must be unique inside the helper",
  );
  return source.slice(0, start) + body.replace(before, () => after);
}

function runSchemaPolicy(root) {
  return spawnSync(process.execPath, [SCHEMA_POLICY_CHECKER], {
    cwd: root,
    encoding: "utf8",
  });
}

const TEST_ADMIN_URL =
  process.env.BP_TEST_ADMIN_URL ??
  "postgres://bp_test:bp_test@localhost:5433/postgres";
const REQUIRE_DB = process.env.BP_REQUIRE_TEST_DB === "1";

const adminUrl = new URL(TEST_ADMIN_URL);
if (
  !["localhost", "127.0.0.1", "::1"].includes(adminUrl.hostname) ||
  adminUrl.pathname !== "/postgres"
) {
  throw new Error(
    "BP_TEST_ADMIN_URL must target the local postgres maintenance database",
  );
}

test("schema cutover policy freezes Terraform account and gate-first cutover authority structurally", async (t) => {
  await t.test(
    "rejects a comment and string decoy in place of the bucket-policy dependency",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "infrastructure/terraform/s3.tf",
        (source) =>
          source.replace(
            "  depends_on = [aws_cloudfront_distribution.beaver]",
            '  dependency_decoy = "depends_on = [aws_cloudfront_distribution.beaver]"\n  # depends_on = [aws_cloudfront_distribution.beaver]',
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /depends_on does not match/u);
    },
  );

  await t.test(
    "rejects literal state coordinates hidden by a comment",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "infrastructure/terraform/main.tf",
        (source) =>
          source.replace(
            '  backend "s3" {}',
            '  backend "s3" {\n    bucket = "example-real-state-bucket"\n    # bucket = "CHANGEME-terraform-state-bucket"\n  }',
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /tracked backend block must not assign bucket/u,
      );
    },
  );

  await t.test(
    "rejects a literal provider account despite a variable decoy",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "infrastructure/terraform/main.tf",
        (source) =>
          source.replace(
            "  allowed_account_ids = [var.account_id]",
            '  allowed_account_ids = ["111111111111"]\n  # allowed_account_ids = [var.account_id]',
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /allowed_account_ids does not match/u);
    },
  );
});

test("schema cutover policy freezes sparse replay and terminal one-off task identity structurally", async (t) => {
  await t.test("accepts the exact live one-off task contract", async (t) => {
    const root = await schemaPolicyFixture(t);
    const result = runSchemaPolicy(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Schema cutover policy check passed/u);
  });

  await t.test(
    "rejects sparse replay provenance forced independently of an explicit token",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "scripts/lib/ecs-schema-tools.sh",
        (source) =>
          mutateOneOffTaskContract(
            source,
            '    "${ECS_CLUSTER##*/}" "${explicit_client_token}"); then',
            '    "${ECS_CLUSTER##*/}" "true"); then',
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /canonical cluster\/account\/region\/name identity, and explicit-token provenance/u,
      );
    },
  );

  await t.test(
    "rejects sparse replay without the explicit-client-token gate",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "scripts/lib/ecs-schema-tools.sh",
        (source) =>
          mutateOneOffTaskContract(
            source,
            '      explicitClientToken === "true" &&',
            '      true && // explicitClientToken === "true" &&',
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /sparse replay must require explicit-token provenance/u,
      );
    },
  );

  await t.test(
    "rejects sparse replay when only one identity property is absent",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "scripts/lib/ecs-schema-tools.sh",
        (source) =>
          mutateOneOffTaskContract(
            source,
            "      !hasTaskDefinition &&\n      !hasCluster &&",
            "      (!hasTaskDefinition || !hasCluster) &&",
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /both absent identity properties/u);
    },
  );

  await t.test(
    "rejects sparse replay with weakened STOPPED status proof",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "scripts/lib/ecs-schema-tools.sh",
        (source) =>
          mutateOneOffTaskContract(
            source,
            '      task?.desiredStatus === "STOPPED";',
            '      task?.desiredStatus !== "RUNNING"; // desiredStatus === "STOPPED"',
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /STOPPED\/STOPPED/u);
    },
  );

  await t.test(
    "rejects a long task ARN with a noncanonical task identifier",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "scripts/lib/ecs-schema-tools.sh",
        (source) =>
          mutateOneOffTaskContract(
            source,
            "      `^arn:aws:ecs:${expectedRegion}:${expectedAccount}:task/${expectedClusterName}/[0-9a-f]{32}$`,",
            "      `^arn:aws:ecs:${expectedRegion}:${expectedAccount}:task/${expectedClusterName}/[0-9a-z]{32}$`,",
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /long task ARNs must be canonical/u);
    },
  );

  await t.test("rejects widened RunTask task cardinality", async (t) => {
    const root = await schemaPolicyFixture(t);
    await mutateSchemaPolicyFile(
      root,
      "scripts/lib/ecs-schema-tools.sh",
      (source) =>
        mutateOneOffTaskContract(
          source,
          '      !Array.isArray(response?.tasks) ||\n      response.tasks.length !== 1 ||\n      !Array.isArray(response?.failures) ||\n      response.failures.length !== 0 ||\n      typeof task?.taskArn !== "string" ||',
          '      !Array.isArray(response?.tasks) ||\n      response.tasks.length < 1 ||\n      !Array.isArray(response?.failures) ||\n      response.failures.length !== 0 ||\n      typeof task?.taskArn !== "string" ||',
        ),
    );
    const result = runSchemaPolicy(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /exactly one canonical task/u);
  });

  await t.test("rejects widened RunTask failure cardinality", async (t) => {
    const root = await schemaPolicyFixture(t);
    await mutateSchemaPolicyFile(
      root,
      "scripts/lib/ecs-schema-tools.sh",
      (source) =>
        mutateOneOffTaskContract(
          source,
          '      !Array.isArray(response?.tasks) ||\n      response.tasks.length !== 1 ||\n      !Array.isArray(response?.failures) ||\n      response.failures.length !== 0 ||\n      typeof task?.taskArn !== "string" ||',
          '      !Array.isArray(response?.tasks) ||\n      response.tasks.length !== 1 ||\n      !Array.isArray(response?.failures) ||\n      response.failures.length < 0 ||\n      typeof task?.taskArn !== "string" ||',
        ),
    );
    const result = runSchemaPolicy(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no failures/u);
  });

  await t.test("rejects a bypassed terminal exit-code proof", async (t) => {
    const root = await schemaPolicyFixture(t);
    await mutateSchemaPolicyFile(
      root,
      "scripts/lib/ecs-schema-tools.sh",
      (source) =>
        mutateOneOffTaskContract(
          source,
          '      container?.name !== expectedContainer ||\n      container?.lastStatus !== "STOPPED" ||\n      container?.exitCode !== 0',
          '      container?.name !== expectedContainer ||\n      container?.lastStatus !== "STOPPED" ||\n      container?.exitCode < 0',
        ),
    );
    const result = runSchemaPolicy(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /STOPPED exit-zero container/u);
  });

  await t.test(
    "rejects terminal DescribeTasks moved before the task waiter",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "scripts/lib/ecs-schema-tools.sh",
        (source) => {
          const marker = "bp_run_one_off_task() {";
          const start = source.indexOf(marker);
          assert.ok(start >= 0, "one-off task helper must exist");
          const body = source.slice(start);
          const waiterStart = body.indexOf(
            "  if ! bp_aws ecs wait tasks-stopped",
          );
          const describeStart = body.indexOf(
            "  if ! response=$(bp_aws ecs describe-tasks",
          );
          assert.ok(
            waiterStart >= 0 && describeStart > waiterStart,
            "waiter must initially precede terminal describe",
          );
          const waiterEndMarker = body.indexOf("\n  fi\n", waiterStart);
          const describeEndMarker = body.indexOf("\n  fi\n", describeStart);
          assert.ok(
            waiterEndMarker >= 0 && describeEndMarker >= 0,
            "waiter and terminal describe blocks must be balanced",
          );
          const waiterEnd = waiterEndMarker + "\n  fi\n".length;
          const describeEnd = describeEndMarker + "\n  fi\n".length;
          const between = body.slice(waiterEnd, describeStart);
          return (
            source.slice(0, start) +
            body.slice(0, waiterStart) +
            body.slice(describeStart, describeEnd) +
            between +
            body.slice(waiterStart, waiterEnd) +
            body.slice(describeEnd)
          );
        },
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /waiter must precede/u);
    },
  );
});

test("schema cutover policy freezes exact writer tuples, witnessed modes, and least privilege structurally", async (t) => {
  await t.test(
    "rejects a widened outage tuple despite an exact comment decoy",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "infrastructure/terraform/ecs.tf",
        (source) =>
          source.replace(
            "  beaver_writer_outage_tuple           = var.ecs_desired_count == 0 && var.ecs_min_count == 0 && var.ecs_max_count == 1 && !var.ecs_autoscaling_enabled && !var.maintenance_worker_schedule_enabled",
            "  beaver_writer_outage_tuple           = var.ecs_desired_count == 0 && var.ecs_min_count == 0 && var.ecs_max_count == 2 && !var.ecs_autoscaling_enabled && !var.maintenance_worker_schedule_enabled\n  # beaver_writer_outage_tuple = var.ecs_desired_count == 0 && var.ecs_min_count == 0 && var.ecs_max_count == 1 && !var.ecs_autoscaling_enabled && !var.maintenance_worker_schedule_enabled",
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /beaver_writer_outage_tuple must be the exact/u,
      );
    },
  );

  await t.test(
    "rejects a bypassed tuple precondition with a comment decoy",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "infrastructure/terraform/ecs.tf",
        (source) =>
          source.replace(
            "      condition     = local.beaver_writer_operational_tuple_valid",
            "      condition     = true\n      # condition = local.beaver_writer_operational_tuple_valid",
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /condition must be the exact expression/u);
    },
  );

  await t.test(
    "rejects a writer epoch coupled to the candidate digest",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "infrastructure/terraform/ecs.tf",
        (source) =>
          source.replace(
            '  triggers_replace = [local.beaver_writer_outage_tuple ? "outage" : "live"]',
            '  triggers_replace = [local.beaver_writer_outage_tuple ? "outage" : "live", var.beaver_app_image_digest]\n  # triggers_replace = [local.beaver_writer_outage_tuple ? "outage" : "live"]',
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /triggers_replace does not match/u);
    },
  );

  await t.test(
    "rejects an unhashed opaque Terraform epoch despite an exact comment",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "infrastructure/terraform/ecs.tf",
        (source) =>
          source.replace(
            "    BlueprintParserWriterModeEpoch = sha256(terraform_data.beaver_writer_mode_epoch.id)",
            "    BlueprintParserWriterModeEpoch = terraform_data.beaver_writer_mode_epoch.id\n    # BlueprintParserWriterModeEpoch = sha256(terraform_data.beaver_writer_mode_epoch.id)",
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /sha256\(terraform_data\.beaver_writer_mode_epoch\.id\)/u,
      );
    },
  );

  await t.test(
    "rejects a widened remote writer epoch with a regex comment decoy",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "scripts/p2-schema-cutover.sh",
        (source) =>
          source.replace(
            "    !/^[0-9a-f]{64}$/u.test(epochs[0].value)) {",
            "    !/^[0-9a-f-]+$/u.test(epochs[0].value)) { // !/^[0-9a-f]{64}$/u.test(epochs[0].value)",
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /remote service tag|remote writer-mode tag epoch/u,
      );
    },
  );

  await t.test(
    "rejects a widened epoch in newly written receipts",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "scripts/p2-schema-cutover.sh",
        (source) =>
          source.replace(
            "  !/^[0-9a-f]{64}$/u.test(outageEpoch) ||",
            "  !/^[0-9a-f-]+$/u.test(outageEpoch) || /* !/^[0-9a-f]{64}$/u.test(outageEpoch) || */",
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /newly written witness/u);
    },
  );

  await t.test(
    "rejects removal of the remote epoch recheck before baseline admission",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "scripts/p2-schema-cutover.sh",
        (source) =>
          source.replace(
            "  assert_witness_outage_epoch\n  baseline_image=$(bp_expected_image_uri",
            "  : # assert_witness_outage_epoch\n  baseline_image=$(bp_expected_image_uri",
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /remote outage epoch assertion/u);
    },
  );

  await t.test(
    "rejects a receipt schema that drops one candidate task definition",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "scripts/p2-schema-cutover.sh",
        (source) =>
          source.replace(
            '  "candidateMaintenanceTaskDefinition", "candidateMigratorTaskDefinition",',
            '  "candidateMaintenanceTaskDefinition",',
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /exact v2 receipt schema/u);
    },
  );

  await t.test(
    "rejects default notification takeover despite a false comment",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "infrastructure/terraform/variables.tf",
        (source) =>
          source.replace(
            'variable "acknowledge_beaver_data_notification_takeover" {\n  description = "Owner acknowledgement that the complete existing beaver data-bucket notification configuration was inventoried and Terraform may replace it with the declared EventBridge-only configuration."\n  type        = bool\n  default     = false',
            'variable "acknowledge_beaver_data_notification_takeover" {\n  description = "Owner acknowledgement that the complete existing beaver data-bucket notification configuration was inventoried and Terraform may replace it with the declared EventBridge-only configuration."\n  type        = bool\n  default     = true\n  # default = false',
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /default must be the exact expression false/u,
      );
    },
  );

  await t.test(
    "rejects a permission policy targeting the migrator role",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "infrastructure/terraform/iam.tf",
        (source) =>
          `${source}\nresource "aws_iam_role_policy" "unsafe_migrator" {\n  name = "unsafe"\n  role = aws_iam_role.beaver_schema_migrator_task_role.id\n  policy = jsonencode({ Version = "2012-10-17", Statement = [] })\n}\n`,
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /must not target the migrator role/u);
    },
  );

  await t.test("rejects a quoted witness prerequisite", async (t) => {
    const root = await schemaPolicyFixture(t);
    await mutateSchemaPolicyFile(
      root,
      "scripts/p2-schema-cutover.sh",
      (source) =>
        source.replace(
          '  load_writer_outage_witness\n  assert_eq "${WRITER_WITNESS_PHASE}" outage-preflight "writer witness phase"',
          '  witness_decoy=\'load_writer_outage_witness\'\n  assert_eq "${WRITER_WITNESS_PHASE}" outage-preflight "writer witness phase"',
        ),
    );
    const result = runSchemaPolicy(root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /assert_witnessed_baseline_binding is missing the witness load/u,
    );
  });

  await t.test(
    "rejects an unwitnessed P2 run dispatch despite a quoted decoy",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "scripts/p2-schema-cutover.sh",
        (source) =>
          source.replace(
            'run_migration_and_bind "${EXPECTED_IMAGE}" "${P2_MIGRATION_MODE}" "P2 boundary" "witnessed-boundary"',
            'run_migration_and_bind "${EXPECTED_IMAGE}" "${P2_MIGRATION_MODE}" "P2 boundary" "empty-bootstrap" # witnessed-boundary',
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /candidate and P2-boundary rollouts/u);
    },
  );

  await t.test(
    "rejects a candidate-admitted receipt whose absolute expiry is extended",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "scripts/p2-schema-cutover.sh",
        (source) =>
          source.replace(
            "const expiresAtEpoch = durable ? null : (creating ? nowEpoch + ttl : Number(expiresAtArg));",
            "const expiresAtEpoch = durable ? null : nowEpoch + ttl;",
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /fixed absolute expiry/u);
    },
  );

  await t.test(
    "rejects a loader that widens the six-hour receipt TTL",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "scripts/p2-schema-cutover.sh",
        (source) =>
          source.replace(
            "record.expiresAtEpoch !== record.issuedAtEpoch + 21600",
            "record.expiresAtEpoch !== record.issuedAtEpoch + 86400",
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /expire after exactly six hours/u);
    },
  );

  await t.test(
    "rejects candidate admission without all four exact candidate definitions",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "scripts/p2-schema-cutover.sh",
        (source) =>
          source.replace(
            '    "${candidate_digest}" "${APP_TASK_DEFINITION}" "${CPU_TASK_DEFINITION}" \\\n    "${MAINTENANCE_TASK_DEFINITION}" "${MIGRATOR_TASK_DEFINITION}" \\',
            '    "${candidate_digest}" "${APP_TASK_DEFINITION}" "${CPU_TASK_DEFINITION}" \\\n    "${MAINTENANCE_TASK_DEFINITION}" - \\',
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /all four exact candidate task definitions/u);
    },
  );

  await t.test(
    "rejects candidate admission written after UpdateService",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "scripts/p2-schema-cutover.sh",
        (source) => {
          const start = source.indexOf("run_migration_and_bind() {");
          assert.ok(start >= 0);
          const prefix = source.slice(0, start);
          let body = source.slice(start);
          body = body.replace(
            '    write_candidate_admission "${BP_APP_IMAGE_DIGEST}"\n',
            "",
          );
          body = body.replace(
            '  bp_assert_service_revision_stable "${APP_TASK_DEFINITION}" 0\n  desired=$(',
            '  bp_assert_service_revision_stable "${APP_TASK_DEFINITION}" 0\n  write_candidate_admission "${BP_APP_IMAGE_DIGEST}"\n  desired=$(',
          );
          return prefix + body;
        },
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /baseline\/candidate admission/u);
    },
  );

  await t.test(
    "rejects a candidate retry that accepts an unrecorded service revision",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "scripts/p2-schema-cutover.sh",
        (source) =>
          source.replace(
            '  elif [ "${service_task_definition}" = "${WRITER_WITNESS_CANDIDATE_TASK_DEFINITION}" ]; then',
            '  elif [ -n "${service_task_definition}" ]; then',
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /exact candidate service retry branch/u);
    },
  );

  await t.test(
    "rejects a nondeterministic P2 migration client token",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "scripts/p2-schema-cutover.sh",
        (source) =>
          source.replace(
            'migration_client_token="bp-p2-${WRITER_WITNESS_NONCE:0:48}"',
            'migration_client_token="bp-p2-${RANDOM}"',
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /deterministic migration|P2-boundary rollouts/u,
      );
    },
  );

  await t.test(
    "rejects removal of the retained-definition revalidation",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "scripts/p2-schema-cutover.sh",
        (source) =>
          source.replaceAll("  assert_retained_task_definitions_only\n", ""),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /post-run revalidation/u);
    },
  );

  await t.test(
    "rejects removal of the post-migration admitted-candidate proof",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "scripts/p2-schema-cutover.sh",
        (source) =>
          source.replace(
            '    assert_admitted_candidate_contract "${BP_APP_IMAGE_DIGEST}"\n    bp_assert_service_revision_stable \\\n      "${WRITER_WITNESS_CANDIDATE_TASK_DEFINITION}" 0',
            '    : # admitted candidate proof removed\n    bp_assert_service_revision_stable \\\n      "${WRITER_WITNESS_CANDIDATE_TASK_DEFINITION}" 0',
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /post-run revalidation/u);
    },
  );

  await t.test(
    "rejects a warning-only ambiguous RunTask response",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "scripts/lib/ecs-schema-tools.sh",
        (source) =>
          source.replace(
            '    bp_die "ECS RunTask outcome is unknown for client token ${client_token} (started-by ${started_by}); do not change writer state until matching family tasks and schema history are verified"',
            '    echo "ECS RunTask outcome is unknown for ${client_token}" >&2',
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /ambiguous RunTask refusal/u);
    },
  );

  await t.test("rejects a non-failing ECS waiter path", async (t) => {
    const root = await schemaPolicyFixture(t);
    await mutateSchemaPolicyFile(
      root,
      "scripts/lib/ecs-schema-tools.sh",
      (source) =>
        source.replace(
          "  if ! bp_aws ecs wait tasks-stopped \\",
          "  if bp_aws ecs wait tasks-stopped \\",
        ),
    );
    const result = runSchemaPolicy(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /fail-closed tasks-stopped waiter/u);
  });

  await t.test("rejects retirement that omits one writer family", async (t) => {
    const root = await schemaPolicyFixture(t);
    await mutateSchemaPolicyFile(
      root,
      "scripts/p2-schema-cutover.sh",
      (source) =>
        source.replace(
          '  retire_other_active_revisions "${MIGRATOR_FAMILY}" "${MIGRATOR_TASK_DEFINITION}"',
          "  : # migrator family retirement removed",
        ),
    );
    const result = runSchemaPolicy(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /four exact writer families/u);
  });

  await t.test(
    "rejects a configurable restored count hidden by a literal decoy",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "scripts/p2-schema-cutover.sh",
        (source) =>
          source.replace(
            '  bp_assert_service_revision_stable "${APP_TASK_DEFINITION}" 1',
            '  bp_assert_service_revision_stable "${APP_TASK_DEFINITION}" "${BP_RESTORED_DESIRED_COUNT:-1}"\n  # bp_assert_service_revision_stable "${APP_TASK_DEFINITION}" 1',
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /exact live tuple|restored positive service assertion/u,
      );
    },
  );

  await t.test(
    "rejects candidate activation when the same-digest refusal is only quoted",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(root, "deploy.sh", (source) =>
        source.replace(
          '    bp_die "activate is same-digest only: service ${current_service_td##*/} uses ${current_service_image}; use preflight-outage, bind-quiescent, and verify-restored for a candidate digest"',
          '    echo "activate is same-digest only: service ${current_service_td##*/} uses ${current_service_image}; use preflight-outage, bind-quiescent, and verify-restored for a candidate digest"',
        ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /same-digest-only refusal|reject a new digest/u,
      );
    },
  );

  await t.test(
    "rejects an outage-preflight runbook that omits the intended candidate",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(root, "README.md", (source) =>
        source.replace(
          "./deploy.sh preflight-outage sha256:CURRENT_DIGEST sha256:CANDIDATE_DIGEST",
          "./deploy.sh preflight-outage sha256:CURRENT_DIGEST",
        ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /owner runbook/u);
    },
  );
});

test("schema cutover policy freezes digest-pinned isolated YOLO execution and narrow IAM", async (t) => {
  await t.test(
    "rejects a loose YOLO digest validator with an exact comment decoy",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "infrastructure/terraform/variables.tf",
        (source) =>
          source.replace(
            'condition     = can(regex("^sha256:[0-9a-f]{64}$", var.beaver_yolo_image_digest))',
            'condition     = can(regex("^.+$", var.beaver_yolo_image_digest))\n    # condition = can(regex("^sha256:[0-9a-f]{64}$", var.beaver_yolo_image_digest))',
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /beaver_yolo_image_digest must use its exact/u,
      );
    },
  );

  await t.test(
    "rejects a mutable YOLO image with a digest comment decoy",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "infrastructure/terraform/ecs.tf",
        (source) =>
          source.replace(
            'value = "${aws_ecr_repository.beaver_yolo_pipeline.repository_url}@${var.beaver_yolo_image_digest}"',
            'value = "${aws_ecr_repository.beaver_yolo_pipeline.repository_url}:latest" },\n        # value = "${aws_ecr_repository.beaver_yolo_pipeline.repository_url}@${var.beaver_yolo_image_digest}"\n        { name = "YOLO_DIGEST_DECOY", value = "unused"',
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /YOLO_ECR_IMAGE must use the immutable/u);
    },
  );

  await t.test(
    "rejects disabled network isolation despite a true comment",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(root, "src/lib/yolo.ts", (source) =>
        source.replace(
          "      EnableNetworkIsolation: true,",
          "      EnableNetworkIsolation: false, // EnableNetworkIsolation: true",
        ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /EnableNetworkIsolation must be true/u);
    },
  );

  await t.test(
    "rejects a changed processing instance hidden by a comment",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(root, "src/lib/yolo.ts", (source) =>
        source.replace(
          '        InstanceType: "ml.g4dn.xlarge",',
          '        InstanceType: "ml.p3.2xlarge", // InstanceType: "ml.g4dn.xlarge"',
        ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /InstanceType must remain ml\.g4dn\.xlarge/u);
    },
  );

  await t.test(
    "rejects SageMaker FullAccess in a real attachment",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "infrastructure/terraform/iam.tf",
        (source) =>
          `${source}\nresource "aws_iam_role_policy_attachment" "unsafe_sagemaker_full_access" {\n  role       = aws_iam_role.beaver_sagemaker_role.name\n  policy_arn = "arn:aws:iam::aws:policy/AmazonSageMakerFullAccess"\n}\n`,
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /AmazonSageMakerFullAccess may not be/u);
    },
  );

  await t.test("rejects a wildcard SageMaker S3 output grant", async (t) => {
    const root = await schemaPolicyFixture(t);
    await mutateSchemaPolicyFile(
      root,
      "infrastructure/terraform/iam.tf",
      (source) =>
        source.replace(
          '        Resource = "${aws_s3_bucket.beaver_data.arn}/*/*/yolo-output/*"',
          '        Resource = "*"\n        # Resource = "${aws_s3_bucket.beaver_data.arn}/*/*/yolo-output/*"',
        ),
    );
    const result = runSchemaPolicy(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /S3 policy may not use a wildcard Resource/u);
  });
});

test("schema cutover policy freezes authenticated production database TLS", async (t) => {
  await t.test(
    "rejects disabled certificate verification despite a true comment",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(root, "scripts/database-tls.mjs", (source) =>
        source.replace(
          "    rejectUnauthorized: true,",
          "    rejectUnauthorized: false, // rejectUnauthorized: true",
        ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /rejectUnauthorized/u);
    },
  );

  await t.test("rejects an environment-selected CA path", async (t) => {
    const root = await schemaPolicyFixture(t);
    await mutateSchemaPolicyFile(root, "scripts/database-tls.mjs", (source) =>
      source.replace(
        'readTrustedBundle(AWS_RDS_CA_BUNDLE_PATH, "utf8")',
        'readTrustedBundle(env.RDS_CA_BUNDLE_PATH, "utf8") // readTrustedBundle(AWS_RDS_CA_BUNDLE_PATH, "utf8")',
      ),
    );
    const result = runSchemaPolicy(root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /fixed code-owned path|only NODE_ENV and the structurally validated DATABASE_URL/u,
    );
  });

  await t.test(
    "rejects a connection-string override channel hidden by a comment",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(root, "scripts/database-tls.mjs", (source) =>
        source.replace(
          '    url.search !== "" ||',
          '    false || // url.search !== "" ||',
        ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /exact protocol, authority, port, path/u);
    },
  );

  await t.test(
    "rejects restoring the postgres alias in the live secret validator",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "scripts/lib/ecs-schema-tools.sh",
        (source) =>
          source.replace(
            '    if (url.protocol !== "postgresql:") throw new Error("protocol");',
            '    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("protocol"); // if (url.protocol !== "postgresql:")',
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /streamed canonical live DATABASE_URL secret/u,
      );
    },
  );

  await t.test(
    "rejects an app Pool that bypasses the shared helper",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(root, "src/lib/db/index.ts", (source) =>
        source.replace(
          "  ssl: databaseTlsOptions(),",
          "  ssl: true, // ssl: databaseTlsOptions(),",
        ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /production pg clients must use databaseTlsOptions/u,
      );
    },
  );

  await t.test(
    "rejects a newly introduced production Pool outside the old inventory",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      const file = path.join(root, "src/server/unsafe-production-pool.ts");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        'import { Pool } from "pg";\nexport const unsafe = new Pool({ connectionString: process.env.DATABASE_URL });\n',
        "utf8",
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /every production pg client source must import/u,
      );
      assert.match(
        result.stderr,
        /production pg clients must use databaseTlsOptions/u,
      );
    },
  );

  await t.test("rejects a future shell-embedded production Pool", async (t) => {
    const root = await schemaPolicyFixture(t);
    const file = path.join(root, "scripts/unsafe-production-pool.sh");
    await writeFile(
      file,
      "#!/usr/bin/env bash\nnode -e 'const { Pool } = require(\"pg\"); new Pool({ connectionString: process.env.DATABASE_URL });'\n",
      "utf8",
    );
    const result = runSchemaPolicy(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /shell-embedded pg clients require/u);
  });

  await t.test("rejects a Docker bundle URL decoy in a comment", async (t) => {
    const root = await schemaPolicyFixture(t);
    await mutateSchemaPolicyFile(root, "Dockerfile", (source) =>
      source.replace(
        "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \\",
        "https://example.invalid/untrusted-bundle.pem \\\n+    # https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem",
      ),
    );
    const result = runSchemaPolicy(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /runner must install and validate/u);
  });

  await t.test(
    "rejects rds.force_ssl disabled with an enabled comment decoy",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(
        root,
        "infrastructure/terraform/rds.tf",
        (source) =>
          source.replace(
            '    value = "1"',
            '    value = "0"\n    # value = "1"',
          ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /value must be the exact string "1"/u);
    },
  );
});

test("schema cutover policy freezes the root-admin menu, SQL, and TLS allowlist", async (t) => {
  await t.test("rejects a newly added secret SELECT", async (t) => {
    const root = await schemaPolicyFixture(t);
    await mutateSchemaPolicyFile(root, "root_admin.sh", (source) =>
      source.replace(
        "      await client.query('SELECT pg_catalog.pg_advisory_xact_lock(737375864)');",
        "      await client.query('SELECT pg_catalog.pg_advisory_xact_lock(737375864)');\n      await client.query('SELECT password_hash FROM public.users');",
      ),
    );
    const result = runSchemaPolicy(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /remote client\.query calls must be exactly/u);
  });

  await t.test("rejects an extra executable menu choice", async (t) => {
    const root = await schemaPolicyFixture(t);
    await mutateSchemaPolicyFile(root, "root_admin.sh", (source) =>
      source.replace(
        "      4) show_root_email_setup ;;",
        "      4) show_root_email_setup ;;\n      5) run_fixed_operation secrets ;;",
      ),
    );
    const result = runSchemaPolicy(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /executable menu must expose only/u);
  });

  await t.test("rejects a root-admin TLS environment decoy", async (t) => {
    const root = await schemaPolicyFixture(t);
    await mutateSchemaPolicyFile(root, "root_admin.sh", (source) =>
      source.replace(
        "ssl:databaseTlsOptions(process.env)",
        "ssl:databaseTlsOptions({NODE_ENV:'test'})/* databaseTlsOptions(process.env) */",
      ),
    );
    const result = runSchemaPolicy(root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /remote Pool must pass its complete environment/u,
    );
  });
});

test("schema cutover policy rejects mutable ECR despite an immutable comment decoy", async (t) => {
  const root = await schemaPolicyFixture(t);
  await mutateSchemaPolicyFile(
    root,
    "infrastructure/terraform/ecr.tf",
    (source) =>
      source.replace(
        'image_tag_mutability = "IMMUTABLE"',
        'image_tag_mutability = "MUTABLE"\n  # image_tag_mutability = "IMMUTABLE"',
      ),
  );

  const result = runSchemaPolicy(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /image_tag_mutability must be the exact string/u);
});

test("schema cutover policy reads the authoritative CI database job, not YAML comments", async (t) => {
  await t.test("rejects an older PostgreSQL service image", async (t) => {
    const root = await schemaPolicyFixture(t);
    await mutateSchemaPolicyFile(root, ".github/workflows/ci.yml", (source) =>
      source.replace(
        "image: postgres:17",
        "image: postgres:16\n        # image: postgres:17",
      ),
    );
    const result = runSchemaPolicy(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must pin PostgreSQL major version 17/u);
  });

  await t.test("rejects a disabled required-database gate", async (t) => {
    const root = await schemaPolicyFixture(t);
    await mutateSchemaPolicyFile(root, ".github/workflows/ci.yml", (source) =>
      source.replace(
        'BP_REQUIRE_TEST_DB: "1"',
        'BP_REQUIRE_TEST_DB: "0"\n      # BP_REQUIRE_TEST_DB: "1"',
      ),
    );
    const result = runSchemaPolicy(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /BP_REQUIRE_TEST_DB must equal 1/u);
  });

  await t.test("rejects an unsafe admin database URL", async (t) => {
    const root = await schemaPolicyFixture(t);
    await mutateSchemaPolicyFile(root, ".github/workflows/ci.yml", (source) =>
      source.replace(
        "BP_TEST_ADMIN_URL: postgresql://ci:ci@localhost:5432/postgres",
        "BP_TEST_ADMIN_URL: postgresql://ci:ci@production.example.com:5432/postgres\n      # BP_TEST_ADMIN_URL: postgresql://ci:ci@localhost:5432/postgres",
      ),
    );
    const result = runSchemaPolicy(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /guarded admin\/test URLs must match/u);
  });

  await t.test(
    "rejects a conditionally skipped script-test step",
    async (t) => {
      const root = await schemaPolicyFixture(t);
      await mutateSchemaPolicyFile(root, ".github/workflows/ci.yml", (source) =>
        source.replace(
          "- name: script tests\n        run: npm run test:scripts",
          "- name: script tests\n        if: ${{ false }}\n        run: npm run test:scripts\n        # - run: npm run test:scripts",
        ),
      );
      const result = runSchemaPolicy(root);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /must execute npm run test:scripts unconditionally/u,
      );
    },
  );
});

test("schema cutover policy rejects unsafe or missing shell commands hidden by quoted decoys", async (t) => {
  await t.test("rejects a migrator in normal app startup", async (t) => {
    const root = await schemaPolicyFixture(t);
    await mutateSchemaPolicyFile(root, "entrypoint.sh", (source) =>
      source.replace(
        "  app)\n    node scripts/assert-schema-current.mjs\n    ;;",
        "  app)\n    exec node scripts/run-schema-migrations.mjs\n    decoy='node scripts/assert-schema-current.mjs'\n    ;;",
      ),
    );
    const result = runSchemaPolicy(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /app may not invoke the production migrator/u);
    assert.match(
      result.stderr,
      /app must execute node scripts\/assert-schema-current/u,
    );
  });

  await t.test("rejects a missing migrate command", async (t) => {
    const root = await schemaPolicyFixture(t);
    await mutateSchemaPolicyFile(root, "entrypoint.sh", (source) =>
      source.replace(
        "  migrate)\n    exec node scripts/run-schema-migrations.mjs\n    ;;",
        "  migrate)\n    echo 'migration disabled'\n    decoy='exec node scripts/run-schema-migrations.mjs'\n    ;;",
      ),
    );
    const result = runSchemaPolicy(root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /migrate must execute exec node scripts\/run-schema-migrations/u,
    );
  });

  await t.test("rejects a quoted readiness-order marker", async (t) => {
    const root = await schemaPolicyFixture(t);
    await mutateSchemaPolicyFile(
      root,
      "scripts/p2-schema-cutover.sh",
      (source) =>
        source.replace(
          '  bp_run_one_off_task "${MIGRATOR_TASK_DEFINITION}" "${readiness_overrides}" >/dev/null',
          '  readiness_marker=\'bp_run_one_off_task "${MIGRATOR_TASK_DEFINITION}" "${readiness_overrides}" >/dev/null\'',
        ),
    );
    const result = runSchemaPolicy(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /readiness, zero-count binding, retirement/u);
  });

  await t.test("rejects a quoted deploy admission marker", async (t) => {
    const root = await schemaPolicyFixture(t);
    await mutateSchemaPolicyFile(root, "deploy.sh", (source) =>
      source.replace(
        '  bp_assert_service_revision_stable "${app_td}" 1',
        "  admission_marker='bp_assert_service_revision_stable \"${app_td}\" 1'",
      ),
    );
    const result = runSchemaPolicy(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /positive-count stable-service assertion/u);
  });
});

test("schema contract accepts only an exact timestamp/hash match", () => {
  const local = localMigrationContract();
  const current = local.entries.map(({ when, hash }) => ({ when, hash }));
  assert.doesNotThrow(() => assertSchemaCurrent(local, current));
  const alteredPrior = current.map((entry) => ({ ...entry }));
  alteredPrior[10].hash = "0".repeat(64);
  assert.throws(
    () => assertSchemaCurrent(local, alteredPrior),
    /not exactly current/u,
  );
  assert.throws(
    () => assertSchemaCurrent(local, current.slice(1)),
    /not exactly current/u,
  );
  assert.throws(() => assertSchemaCurrent(local, []), /not exactly current/u);
});

test("P2 migrator accepts exact full-history prefixes from 0032 through 0039", () => {
  const local = localMigrationContract();
  assert.equal(local.latest.tag, P2_CURRENT_TAG);
  const checkpoint = local.entries.find(
    (entry) => entry.tag === P2_DURABLE_CHECKPOINT_TAG,
  );
  assert.ok(checkpoint);
  for (const entry of local.entries.slice(checkpoint.idx)) {
    const history = local.entries
      .slice(0, entry.idx + 1)
      .map(({ when, hash }) => ({ when, hash }));
    assert.doesNotThrow(() => assertP2CutoverStart(local, history));
    const missingPrior = history.filter((_, index) => index !== 5);
    assert.throws(
      () => assertP2CutoverStart(local, missingPrior),
      /requires an exact/u,
    );
  }
  const older = local.entries.find((entry) => entry.idx === checkpoint.idx - 1);
  assert.ok(older);
  assert.throws(
    () =>
      assertP2CutoverStart(
        local,
        local.entries
          .slice(0, older.idx + 1)
          .map(({ when, hash }) => ({ when, hash })),
      ),
    /requires an exact/u,
  );
});

test("both P2 modes reject an incomplete or future local migration journal", () => {
  const local = localMigrationContract();
  assert.doesNotThrow(() => assertP2LocalMigrationContract(local));
  assert.throws(
    () =>
      assertP2LocalMigrationContract({
        ...local,
        latest: { ...local.latest, tag: "0040_unreviewed_future" },
      }),
    /pinned to 0039_runtime_state/u,
  );
  assert.throws(
    () =>
      assertP2LocalMigrationContract({
        entries: local.entries.filter(
          (entry) => entry.tag !== P2_DURABLE_CHECKPOINT_TAG,
        ),
        latest: local.latest,
      }),
    /boundary is incomplete/u,
  );
});

test("armed empty bootstrap retry admits only zero history or exact current history", async () => {
  const local = localMigrationContract();
  const noPublicObjects = {
    query: async () => ({ rows: [] }),
  };
  await assert.doesNotReject(
    assertEmptyDatabaseBootstrapStart(noPublicObjects, local, []),
  );
  await assert.doesNotReject(
    assertEmptyDatabaseBootstrapStart(
      {
        query: async () => {
          throw new Error(
            "current-history retry must not require an empty catalog",
          );
        },
      },
      local,
      local.entries.map(({ when, hash }) => ({ when, hash })),
    ),
  );
  await assert.rejects(
    assertEmptyDatabaseBootstrapStart(
      noPublicObjects,
      local,
      local.entries.slice(0, 33).map(({ when, hash }) => ({ when, hash })),
    ),
    /zero applied migrations or the exact current history/u,
  );
});

test("unarmed empty bootstrap strictly rejects an arbitrary exact-current database", async () => {
  const local = localMigrationContract();
  const noPublicObjects = { query: async () => ({ rows: [] }) };
  await assert.doesNotReject(
    assertStrictEmptyDatabaseBootstrapStart(noPublicObjects, local, []),
  );
  await assert.rejects(
    assertStrictEmptyDatabaseBootstrapStart(
      noPublicObjects,
      local,
      local.entries.map(({ when, hash }) => ({ when, hash })),
    ),
    /unarmed empty-database bootstrap requires zero applied migrations/u,
  );
});

async function databaseAvailable() {
  const pool = new Pool({
    connectionString: TEST_ADMIN_URL,
    connectionTimeoutMillis: 1_500,
    max: 1,
  });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (error) {
    if (REQUIRE_DB) throw error;
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

const dbUp = await databaseAvailable();

async function migrationFolderThrough(maximumIndex) {
  const folder = await mkdtemp(
    path.join(tmpdir(), `bp-migrations-${maximumIndex}-`),
  );
  await mkdir(path.join(folder, "meta"));
  const journal = JSON.parse(
    await readFile("drizzle/meta/_journal.json", "utf8"),
  );
  journal.entries = journal.entries.filter(
    (entry) => entry.idx <= maximumIndex,
  );
  for (const entry of journal.entries) {
    await cp(`drizzle/${entry.tag}.sql`, path.join(folder, `${entry.tag}.sql`));
  }
  await writeFile(
    path.join(folder, "meta/_journal.json"),
    `${JSON.stringify(journal, null, 2)}\n`,
  );
  return folder;
}

async function migrationFolderWithLegacyIntentSeed() {
  const folder = await mkdtemp(path.join(tmpdir(), "bp-migrations-intent-"));
  await cp("drizzle", folder, { recursive: true });
  const migrationPath = path.join(
    folder,
    "0036_project_asset_object_event_generation.sql",
  );
  const sql = await readFile(migrationPath, "utf8");
  await writeFile(
    migrationPath,
    `${sql}\n--> statement-breakpoint
INSERT INTO label_studio_project_intents
  (id, project_id, company_id, lifecycle_epoch, marker, state)
SELECT
  '11111111-1111-4111-8111-111111111111'::uuid,
  id,
  company_id,
  lifecycle_epoch,
  'bp-labeling-intent:11111111-1111-4111-8111-111111111111',
  'creating'
FROM projects
WHERE data_url = 'cutover-test/aaaaaaaaaaaaaaaaaaaa';
`,
  );
  return folder;
}

async function migrationFolderThrough0033WithLockPause() {
  const folder = await migrationFolderThrough(33);
  const migrationPath = path.join(
    folder,
    "0033_project_lifecycle_epoch_and_leases.sql",
  );
  const sql = await readFile(migrationPath, "utf8");
  const marker = "$$;--> statement-breakpoint\n\nCREATE TABLE";
  assert.ok(sql.includes(marker));
  await writeFile(
    migrationPath,
    sql.replace(
      marker,
      () =>
        "$$;--> statement-breakpoint\nSELECT pg_sleep(1);--> statement-breakpoint\n\nCREATE TABLE",
    ),
  );
  return folder;
}

function quotedDatabase(name) {
  assert.match(name, /^bp_cutover_[a-z0-9_]+$/u);
  return `"${name}"`;
}

async function withTemporaryDatabase(run) {
  const name = `bp_cutover_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const admin = new Pool({ connectionString: TEST_ADMIN_URL, max: 1 });
  await admin.query(`CREATE DATABASE ${quotedDatabase(name)}`);
  const databaseUrl = new URL(TEST_ADMIN_URL);
  databaseUrl.pathname = `/${name}`;
  try {
    await run(databaseUrl.toString());
  } finally {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [name],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${quotedDatabase(name)}`);
    await admin.end();
  }
}

async function seedProject(pool) {
  const company = await pool.query(
    `INSERT INTO companies (name, data_key, access_key, email_domain)
     VALUES ('Cutover Test Company', 'cutover-test', 'test-access', 'cutover.invalid')
     RETURNING id`,
  );
  const companyId = company.rows[0].id;
  const user = await pool.query(
    `INSERT INTO users (username, email, password_hash, company_id)
     VALUES ('cutover', 'cutover@cutover.invalid', 'not-a-real-hash', $1)
     RETURNING id`,
    [companyId],
  );
  const project = await pool.query(
    `INSERT INTO projects (name, data_url, author_id, company_id)
     VALUES ('Cutover Project', 'cutover-test/aaaaaaaaaaaaaaaaaaaa', $1, $2)
     RETURNING id`,
    [user.rows[0].id, companyId],
  );
  return {
    companyId,
    projectId: project.rows[0].id,
    userId: user.rows[0].id,
  };
}

async function waitFor0033NamespaceLock(pool) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const lock = await pool.query(
      `SELECT 1
         FROM pg_catalog.pg_locks
        WHERE relation IN (
          'public.companies'::pg_catalog.regclass,
          'public.projects'::pg_catalog.regclass
        )
          AND mode = 'ShareRowExclusiveLock'
          AND granted
        LIMIT 1`,
    );
    if (lock.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("migration 0033 never acquired its namespace fence");
}

function runSingleton(databaseUrl, mode) {
  return spawnSync(process.execPath, ["scripts/run-schema-migrations.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      NODE_ENV: "test",
      BP_SCHEMA_MIGRATION_MODE: mode,
    },
  });
}

function runReadiness(databaseUrl, mode) {
  return spawnSync(
    process.execPath,
    ["scripts/assert-schema-migration-ready.mjs", mode],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        NODE_ENV: "test",
      },
    },
  );
}

test("legacy Label Studio emptiness applies before 0037 but not after it", async () => {
  const local = localMigrationContract();
  const preBoundary = local.entries.find(
    (entry) => entry.tag === "0036_project_asset_object_event_generation",
  );
  assert.ok(preBoundary);
  const preBoundaryHistory = local.entries
    .slice(0, preBoundary.idx + 1)
    .map(({ when, hash }) => ({ when, hash }));
  await assert.rejects(
    assertLegacyLabelingRowsRetired(
      {
        query: async (sql) => {
          assert.match(sql, /public\.labeling_sessions/u);
          return { rows: [{ id: 123 }] };
        },
      },
      local,
      preBoundaryHistory,
    ),
    /zero legacy labeling_sessions/u,
  );

  await assert.doesNotReject(
    assertLegacyLabelingRowsRetired(
      {
        query: async () => {
          throw new Error("post-0037 rows must not be queried as legacy");
        },
      },
      local,
      local.entries.map(({ when, hash }) => ({ when, hash })),
    ),
  );
});

function migrationBoundaryError(error) {
  let current = error;
  while (current) {
    if (
      current.code === "P0001" &&
      String(current.message).includes(
        "Label Studio sessions/intents must be retired before migration 0037",
      )
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

for (const legacyRow of ["session", "intent"]) {
  test(
    `actual migration 0037 refuses a legacy ${legacyRow} row and rolls back to 0032`,
    { skip: !dbUp, timeout: 60_000 },
    async () => {
      const subset = await migrationFolderThrough(32);
      let fullFolder;
      try {
        await withTemporaryDatabase(async (databaseUrl) => {
          const pool = new Pool({ connectionString: databaseUrl, max: 2 });
          try {
            await migrate(drizzle(pool), { migrationsFolder: subset });
            const { companyId, projectId } = await seedProject(pool);
            if (legacyRow === "session") {
              await pool.query(
                `INSERT INTO labeling_sessions
                   (project_id, company_id, label_studio_project_id, status)
                 VALUES ($1, $2, 123, 'active')`,
                [projectId, companyId],
              );
              fullFolder = "./drizzle";
              const readiness = runReadiness(
                databaseUrl,
                "p2-0037-singleton-quiescent",
              );
              assert.notEqual(readiness.status, 0);
              assert.match(readiness.stderr, /zero legacy labeling_sessions/u);
            } else {
              fullFolder = await migrationFolderWithLegacyIntentSeed();
            }

            await assert.rejects(
              migrate(drizzle(pool), { migrationsFolder: fullFolder }),
              migrationBoundaryError,
            );

            const journal = await pool.query(
              `SELECT created_at
                 FROM drizzle.__drizzle_migrations
                ORDER BY created_at DESC
                LIMIT 1`,
            );
            const local = localMigrationContract();
            const migration0032 = local.entries.find(
              (entry) => entry.tag === P2_DURABLE_CHECKPOINT_TAG,
            );
            assert.equal(
              Number(journal.rows[0].created_at),
              migration0032.when,
            );
            const addedColumns = await pool.query(
              `SELECT count(*)::integer AS count
                 FROM information_schema.columns
                WHERE table_schema = 'public' AND (
                  (table_name = 'projects' AND column_name = 'lifecycle_epoch')
                  OR (
                    table_name IN ('labeling_sessions', 'label_studio_project_intents')
                    AND column_name IN ('provider_base_url', 'provider_instance_id')
                  )
                )`,
            );
            assert.equal(addedColumns.rows[0].count, 0);
          } finally {
            await pool.end();
          }
        });
      } finally {
        await rm(subset, { recursive: true, force: true });
        if (fullFolder && fullFolder !== "./drizzle") {
          await rm(fullFolder, { recursive: true, force: true });
        }
      }
    },
  );
}

test(
  "actual singleton migration upgrades the durable 0032 checkpoint through 0039",
  { skip: !dbUp, timeout: 60_000 },
  async () => {
    const subset = await migrationFolderThrough(32);
    try {
      await withTemporaryDatabase(async (databaseUrl) => {
        const pool = new Pool({ connectionString: databaseUrl, max: 2 });
        try {
          await migrate(drizzle(pool), { migrationsFolder: subset });
          const readiness = runReadiness(
            databaseUrl,
            "p2-0037-singleton-quiescent",
          );
          assert.equal(readiness.status, 0, readiness.stderr);
          const result = runSingleton(
            databaseUrl,
            "p2-0037-singleton-quiescent",
          );
          assert.equal(result.status, 0, result.stderr);
          const applied = await pool.connect();
          try {
            const history = await applied.query(
              `SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC`,
            );
            assert.doesNotThrow(() =>
              assertSchemaCurrent(
                localMigrationContract(),
                history.rows.map((row) => ({
                  hash: row.hash,
                  when: Number(row.created_at),
                })),
              ),
            );
          } finally {
            applied.release();
          }
        } finally {
          await pool.end();
        }
      });
    } finally {
      await rm(subset, { recursive: true, force: true });
    }
  },
);

test(
  "migration 0033 locks legacy roots until its validated constraint and trigger exist",
  { skip: !dbUp, timeout: 60_000 },
  async () => {
    const subset = await migrationFolderThrough(32);
    const through0033 = await migrationFolderThrough0033WithLockPause();
    try {
      await withTemporaryDatabase(async (databaseUrl) => {
        const pool = new Pool({ connectionString: databaseUrl, max: 5 });
        const observer = new Pool({ connectionString: databaseUrl, max: 1 });
        try {
          await migrate(drizzle(pool), { migrationsFolder: subset });
          const { companyId, userId } = await seedProject(pool);
          const migration = migrate(drizzle(pool), {
            migrationsFolder: through0033,
          });
          await waitFor0033NamespaceLock(observer);

          const invalidCompany = pool.query(
            `INSERT INTO companies (name, data_key, access_key, email_domain)
             VALUES ('Racing Invalid Company', '_bp-public', 'test', 'race.invalid')`,
          );
          const invalidProject = pool.query(
            `INSERT INTO projects (name, data_url, author_id, company_id)
             VALUES ('Racing Invalid Project', 'wrong/not-canonical', $1, $2)`,
            [userId, companyId],
          );

          await migration;
          await assert.rejects(invalidCompany, (error) => {
            assert.equal(
              error.constraint,
              "companies_data_key_storage_namespace_guard",
            );
            return true;
          });
          await assert.rejects(invalidProject, (error) => {
            assert.equal(error.constraint, "project_storage_root_guard");
            return true;
          });

          const catalog = await pool.query(
            `SELECT
               (SELECT convalidated
                  FROM pg_catalog.pg_constraint
                 WHERE conname = 'companies_data_key_storage_namespace_guard') AS company_validated,
               EXISTS (
                 SELECT 1
                   FROM pg_catalog.pg_trigger
                  WHERE tgname = 'projects_lifecycle_guard'
                    AND NOT tgisinternal
               ) AS project_trigger`,
          );
          assert.equal(catalog.rows[0].company_validated, true);
          assert.equal(catalog.rows[0].project_trigger, true);
        } finally {
          await observer.end();
          await pool.end();
        }
      });
    } finally {
      await rm(subset, { recursive: true, force: true });
      await rm(through0033, { recursive: true, force: true });
    }
  },
);

test(
  "P2 singleton refuses an invalid legacy company storage namespace at 0032",
  { skip: !dbUp, timeout: 60_000 },
  async () => {
    const subset = await migrationFolderThrough(32);
    try {
      await withTemporaryDatabase(async (databaseUrl) => {
        const pool = new Pool({ connectionString: databaseUrl, max: 2 });
        try {
          await migrate(drizzle(pool), { migrationsFolder: subset });
          await pool.query(
            `INSERT INTO companies (name, data_key, access_key, email_domain)
             VALUES ('Invalid Namespace', '_bp-public', 'test', 'invalid.example')`,
          );
          const result = runSingleton(
            databaseUrl,
            "p2-0037-singleton-quiescent",
          );
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /valid, non-reserved storage namespace/u);
          const latest = await pool.query(
            `SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`,
          );
          const checkpoint = localMigrationContract().entries.find(
            (entry) => entry.tag === P2_DURABLE_CHECKPOINT_TAG,
          );
          assert.equal(Number(latest.rows[0].created_at), checkpoint.when);
        } finally {
          await pool.end();
        }
      });
    } finally {
      await rm(subset, { recursive: true, force: true });
    }
  },
);

test(
  "P2 singleton refuses a legacy project outside its company storage namespace",
  { skip: !dbUp, timeout: 60_000 },
  async () => {
    const subset = await migrationFolderThrough(32);
    try {
      await withTemporaryDatabase(async (databaseUrl) => {
        const pool = new Pool({ connectionString: databaseUrl, max: 2 });
        try {
          await migrate(drizzle(pool), { migrationsFolder: subset });
          const { projectId } = await seedProject(pool);
          await pool.query(
            "UPDATE projects SET data_url = 'wrong-root/not-canonical' WHERE id = $1",
            [projectId],
          );
          const result = runSingleton(
            databaseUrl,
            "p2-0037-singleton-quiescent",
          );
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /match its company storage namespace/u);
          const latest = await pool.query(
            `SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`,
          );
          const checkpoint = localMigrationContract().entries.find(
            (entry) => entry.tag === P2_DURABLE_CHECKPOINT_TAG,
          );
          assert.equal(Number(latest.rows[0].created_at), checkpoint.when);
          const added = await pool.query(
            `SELECT count(*)::integer AS count
               FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'projects'
                AND column_name = 'lifecycle_epoch'`,
          );
          assert.equal(added.rows[0].count, 0);
        } finally {
          await pool.end();
        }
      });
    } finally {
      await rm(subset, { recursive: true, force: true });
    }
  },
);

test(
  "P2 singleton fails immediately instead of waiting behind another migrator",
  { skip: !dbUp, timeout: 60_000 },
  async () => {
    const subset = await migrationFolderThrough(32);
    try {
      await withTemporaryDatabase(async (databaseUrl) => {
        const pool = new Pool({ connectionString: databaseUrl, max: 2 });
        const lockClient = await pool.connect();
        try {
          await migrate(drizzle(pool), { migrationsFolder: subset });
          await lockClient.query(
            "SELECT pg_advisory_lock($1)",
            [72_420_370_038],
          );
          const started = Date.now();
          const result = runSingleton(
            databaseUrl,
            "p2-0037-singleton-quiescent",
          );
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /refusing to wait and migrate later/u);
          assert.ok(Date.now() - started < 5_000);
          const latest = await lockClient.query(
            `SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`,
          );
          const checkpoint = localMigrationContract().entries.find(
            (entry) => entry.tag === P2_DURABLE_CHECKPOINT_TAG,
          );
          assert.equal(Number(latest.rows[0].created_at), checkpoint.when);
        } finally {
          await lockClient
            .query("SELECT pg_advisory_unlock($1)", [72_420_370_038])
            .catch(() => undefined);
          lockClient.release();
          await pool.end();
        }
      });
    } finally {
      await rm(subset, { recursive: true, force: true });
    }
  },
);

test(
  "empty-database singleton bootstrap migrates only a truly empty database",
  { skip: !dbUp, timeout: 60_000 },
  async () => {
    await withTemporaryDatabase(async (databaseUrl) => {
      const readiness = runReadiness(
        databaseUrl,
        "empty-database-strict-readiness",
      );
      assert.equal(readiness.status, 0, readiness.stderr);
      const result = runSingleton(
        databaseUrl,
        "empty-database-singleton-quiescent",
      );
      assert.equal(result.status, 0, result.stderr);
      const pool = new Pool({ connectionString: databaseUrl, max: 1 });
      try {
        const history = await pool.query(
          `SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC`,
        );
        assert.doesNotThrow(() =>
          assertSchemaCurrent(
            localMigrationContract(),
            history.rows.map((row) => ({
              hash: row.hash,
              when: Number(row.created_at),
            })),
          ),
        );
        const readinessRetry = runReadiness(
          databaseUrl,
          "empty-database-armed-retry-readiness",
        );
        assert.equal(readinessRetry.status, 0, readinessRetry.stderr);
        const migrationRetry = runSingleton(
          databaseUrl,
          "empty-database-singleton-quiescent",
        );
        assert.equal(migrationRetry.status, 0, migrationRetry.stderr);
        assert.match(migrationRetry.stdout, /already current/u);
        const historyAfterRetry = await pool.query(
          `SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC`,
        );
        assert.deepEqual(historyAfterRetry.rows, history.rows);
      } finally {
        await pool.end();
      }
    });
  },
);

test(
  "singleton migration overrides a URL-supplied search_path before applying SQL",
  { skip: !dbUp, timeout: 60_000 },
  async () => {
    await withTemporaryDatabase(async (databaseUrl) => {
      const pool = new Pool({ connectionString: databaseUrl, max: 1 });
      try {
        await pool.query("CREATE SCHEMA redirected");
      } finally {
        await pool.end();
      }

      const redirectedUrl = new URL(databaseUrl);
      redirectedUrl.searchParams.set("options", "-csearch_path=redirected");
      const result = runSingleton(
        redirectedUrl.toString(),
        "empty-database-singleton-quiescent",
      );
      assert.equal(result.status, 0, result.stderr);

      const verifier = new Pool({ connectionString: databaseUrl, max: 1 });
      try {
        const relations = await verifier.query(
          `SELECT
             to_regclass('public.companies') AS public_companies,
             to_regclass('redirected.companies') AS redirected_companies`,
        );
        assert.equal(relations.rows[0].public_companies, "companies");
        assert.equal(relations.rows[0].redirected_companies, null);
      } finally {
        await verifier.end();
      }
    });
  },
);

test(
  "empty-database singleton bootstrap refuses an existing public table",
  { skip: !dbUp, timeout: 60_000 },
  async () => {
    await withTemporaryDatabase(async (databaseUrl) => {
      const pool = new Pool({ connectionString: databaseUrl, max: 1 });
      try {
        await pool.query("CREATE TABLE existing_owner_data (id integer)");
      } finally {
        await pool.end();
      }
      const result = runSingleton(
        databaseUrl,
        "empty-database-singleton-quiescent",
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /refuses an existing public object/u);
    });
  },
);

for (const [kind, createSql] of [
  ["view", "CREATE VIEW public.existing_owner_view AS SELECT 1 AS id"],
  [
    "routine",
    "CREATE FUNCTION public.existing_owner_function() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
  ],
  ["type", "CREATE TYPE public.existing_owner_type AS ENUM ('owner')"],
  [
    "collation",
    'CREATE COLLATION public.existing_owner_collation FROM pg_catalog."C"',
  ],
]) {
  test(
    `empty-database singleton bootstrap refuses an existing public ${kind}`,
    { skip: !dbUp, timeout: 60_000 },
    async () => {
      await withTemporaryDatabase(async (databaseUrl) => {
        const pool = new Pool({ connectionString: databaseUrl, max: 1 });
        try {
          await pool.query(createSql);
        } finally {
          await pool.end();
        }
        const result = runSingleton(
          databaseUrl,
          "empty-database-singleton-quiescent",
        );
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /refuses an existing public object/u);

        const verifier = new Pool({ connectionString: databaseUrl, max: 1 });
        try {
          const journal = await verifier.query(
            "SELECT pg_catalog.to_regclass('drizzle.__drizzle_migrations') AS relation",
          );
          assert.equal(journal.rows[0].relation, null);
        } finally {
          await verifier.end();
        }
      });
    },
  );
}
