// [2026-10-23] Upload compute preset: the CPUProcessing state takes Cpu/Memory overrides and a
// PAGE_CONCURRENCY env from the execution input, defaulted in ValidateInput. These tests pin that
//   • infrastructure/terraform/stepfunctions.tf carries exactly that wiring, and
//   • bp_state_machine_cpu_target (scripts/lib/ecs-schema-tools.sh — the deploy/cutover gates' reader of
//     the LIVE definition) accepts the legacy shape AND the compute shape built from the .tf's own merge
//     string, and refuses a half-migrated or tampered definition.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TF = path.join(REPO_ROOT, "infrastructure/terraform/stepfunctions.tf");
const TOOLS = path.join(REPO_ROOT, "scripts/lib/ecs-schema-tools.sh");

const TASK = "arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-cpu-pipeline:42";
const CLUSTER = "arn:aws:ecs:us-east-1:123456789012:cluster/beaver-cluster";

/** The HCL string literal assigned to "compute.$", decoded the way Terraform decodes it. */
async function tfComputeMerge() {
  const tf = await readFile(TF, "utf8");
  const m = /^\s*"compute\.\$"\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/mu.exec(tf);
  assert.ok(m, "stepfunctions.tf must assign compute.$ in ValidateInput");
  return m[1].replace(/\\(.)/gu, "$1");
}

function definition({ compute, overrides = {}, extraEnv = [], dropEnv = [] } = {}) {
  const env = [
    { Name: "PROJECT_ID", "Value.$": "States.Format('{}', $.projectId)" },
    { Name: "DATA_URL", "Value.$": "$.dataUrl" },
    { Name: "S3_BUCKET", "Value.$": "$.s3Bucket" },
    { Name: "WEBHOOK_URL", "Value.$": "$.webhookUrl" },
    { Name: "WEBHOOK_SECRET", "Value.$": "$.webhookSecret" },
    ...extraEnv,
  ].filter((e) => !dropEnv.includes(e.Name));
  return {
    Comment: "Beaver blueprint processing pipeline",
    StartAt: "ValidateInput",
    States: {
      ValidateInput: {
        Type: "Pass",
        Parameters: {
          "projectId.$": "$.projectId",
          "dataUrl.$": "$.dataUrl",
          "s3Bucket.$": "$.s3Bucket",
          "webhookUrl.$": "$.webhookUrl",
          "webhookSecret.$": "$.webhookSecret",
          status: "PROCESSING",
          ...(compute === undefined ? {} : { "compute.$": compute }),
        },
        Next: "CPUProcessing",
      },
      CPUProcessing: {
        Type: "Task",
        Resource: "arn:aws:states:::ecs:runTask.sync",
        Parameters: {
          LaunchType: "FARGATE",
          TaskDefinition: TASK,
          Cluster: CLUSTER,
          PlatformVersion: "1.4.0",
          NetworkConfiguration: {
            AwsvpcConfiguration: { Subnets: ["subnet-test"], SecurityGroups: ["sg-test"], AssignPublicIp: "DISABLED" },
          },
          Overrides: { ...overrides, ContainerOverrides: [{ Name: "beaver-cpu-pipeline", Environment: env }] },
        },
        ResultPath: "$.cpuResult",
        Retry: [{ ErrorEquals: ["States.TaskFailed"], IntervalSeconds: 30, MaxAttempts: 2, BackoffRate: 2 }],
        Catch: [{ ErrorEquals: ["States.ALL"], Next: "ProcessingFailed", ResultPath: "$.error" }],
        Next: "ProcessingComplete",
      },
      ProcessingComplete: { Type: "Succeed" },
      ProcessingFailed: {
        Type: "Fail",
        Error: "ProcessingFailed",
        Cause: "Blueprint processing pipeline failed. Check CloudWatch logs for details.",
      },
    },
  };
}

const COMPUTE_OVERRIDES = { "Cpu.$": "$.compute.cpu", "Memory.$": "$.compute.memory" };
const PAGE_ENV = { Name: "PAGE_CONCURRENCY", "Value.$": "$.compute.pageConcurrency" };

function target(def) {
  const script = `source "${TOOLS}"; bp_aws() { printf '%s' "$BP_TEST_DEFINITION"; }; bp_state_machine_cpu_target`;
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, STEP_FUNCTION_ARN: "arn:aws:states:us-east-1:123456789012:stateMachine:x", AWS_REGION: "us-east-1", BP_TEST_DEFINITION: JSON.stringify(def) },
  });
}

test("stepfunctions.tf defaults the compute fields and wires Cpu/Memory/PAGE_CONCURRENCY from them", async () => {
  const tf = await readFile(TF, "utf8");
  assert.equal(
    await tfComputeMerge(),
    `States.JsonMerge(States.StringToJson('\\{"cpu":"8192","memory":"16384","pageConcurrency":"8"\\}'), $, false)`,
  );
  assert.match(tf, /^\s*"Cpu\.\$"\s*=\s*"\$\.compute\.cpu"\s*$/mu);
  assert.match(tf, /^\s*"Memory\.\$"\s*=\s*"\$\.compute\.memory"\s*$/mu);
  assert.match(tf, /\{ Name = "PAGE_CONCURRENCY", "Value\.\$" = "\$\.compute\.pageConcurrency" \}/u);
  // The task definition itself is unchanged (the overrides carry the preset).
  const ecs = await readFile(path.join(REPO_ROOT, "infrastructure/terraform/ecs.tf"), "utf8");
  assert.match(ecs, /family\s*=\s*"beaver-cpu-pipeline"[\s\S]{0,200}cpu\s*=\s*8192\s*\n\s*memory\s*=\s*16384/u);
});

test("bp_state_machine_cpu_target accepts the legacy shape and the stepfunctions.tf compute shape", async () => {
  const legacy = target(definition());
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(legacy.stdout, `${TASK}\t${CLUSTER}\n`);
  const compute = target(definition({ compute: await tfComputeMerge(), overrides: COMPUTE_OVERRIDES, extraEnv: [PAGE_ENV] }));
  assert.equal(compute.status, 0, compute.stderr);
  assert.equal(compute.stdout, `${TASK}\t${CLUSTER}\n`);
});

test("bp_state_machine_cpu_target refuses half-migrated or tampered compute wiring", async () => {
  const merge = await tfComputeMerge();
  const bad = [
    definition({ compute: merge }), // compute input but no overrides/env
    definition({ compute: merge, overrides: COMPUTE_OVERRIDES }), // no PAGE_CONCURRENCY env
    definition({ compute: merge, extraEnv: [PAGE_ENV] }), // no Cpu/Memory overrides
    definition({ overrides: COMPUTE_OVERRIDES, extraEnv: [PAGE_ENV] }), // overrides without the defaulted input
    definition({ compute: merge.replace('"8192"', '"16384"'), overrides: COMPUTE_OVERRIDES, extraEnv: [PAGE_ENV] }),
    definition({ compute: merge, overrides: { ...COMPUTE_OVERRIDES, "Cpu.$": "$.cpu" }, extraEnv: [PAGE_ENV] }),
    definition({ compute: merge, overrides: { "Cpu.$": "$.compute.cpu", Memory: "65536" }, extraEnv: [PAGE_ENV] }),
    definition({ compute: merge, overrides: { ...COMPUTE_OVERRIDES, TaskRoleArn: "arn:aws:iam::1:role/x" }, extraEnv: [PAGE_ENV] }),
    definition({ compute: merge, overrides: COMPUTE_OVERRIDES, extraEnv: [{ Name: "PAGE_CONCURRENCY", "Value.$": "$.cpu" }] }),
    definition({ extraEnv: [PAGE_ENV] }), // legacy shape with a stray env
  ];
  for (const [i, def] of bad.entries()) {
    const r = target(def);
    assert.notEqual(r.status, 0, `case ${i} must be refused`);
    assert.match(r.stderr, /could not resolve CPUProcessing target/u, `case ${i}`);
  }
});
