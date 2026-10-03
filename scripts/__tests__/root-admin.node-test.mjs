import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const scriptPath = path.join(repoRoot, "root_admin.sh");
const account = "123456789012";
const region = "us-east-1";
const cluster = "beaver-cluster";
const service = "beaver-app";
const taskId = "a".repeat(32);
const otherTaskId = "b".repeat(32);
const taskArn = `arn:aws:ecs:${region}:${account}:task/${cluster}/${taskId}`;
const otherTaskArn = `arn:aws:ecs:${region}:${account}:task/${cluster}/${otherTaskId}`;
const taskDefinition = `arn:aws:ecs:${region}:${account}:task-definition/${service}:42`;
const clusterArn = `arn:aws:ecs:${region}:${account}:cluster/${cluster}`;
const serviceArn = `arn:aws:ecs:${region}:${account}:service/${cluster}/${service}`;
const appDigest = `sha256:${"a".repeat(64)}`;
const appImage = `${account}.dkr.ecr.${region}.amazonaws.com/beaver-app@${appDigest}`;
const yoloImage = `${account}.dkr.ecr.${region}.amazonaws.com/beaver-yolo-pipeline@sha256:${"b".repeat(64)}`;
const secretVersion = "1".repeat(32);
const secretArn = `arn:aws:secretsmanager:${region}:${account}:secret:beaver/DATABASE_URL-AbCd12`;
const secretSelector = `${secretArn}:::${secretVersion}`;
const databaseUrl =
  "postgresql://beaver_admin:p%40ssword@beaver-db.abc123.us-east-1.rds.amazonaws.com:5432/beaver";
const domain = "example.com";
const cloudFrontDistributionId = "E1234567890123";
const appTaskDefinition = {
  family: service,
  networkMode: "awsvpc",
  requiresCompatibilities: ["FARGATE"],
  executionRoleArn: `arn:aws:iam::${account}:role/beaver-ecs-execution-role`,
  taskRoleArn: `arn:aws:iam::${account}:role/beaver-ecs-task-role`,
  runtimePlatform: {
    operatingSystemFamily: "LINUX",
    cpuArchitecture: "X86_64",
  },
  volumes: [],
  containerDefinitions: [
    {
      name: service,
      image: appImage,
      essential: true,
      command: [],
      environment: [
        { name: "NODE_ENV", value: "production" },
        { name: "PORT", value: "3000" },
        { name: "S3_BUCKET", value: `beaver-data-${account}` },
        { name: "AWS_REGION", value: region },
        { name: "CLOUDFRONT_DOMAIN", value: `assets.${domain}` },
        {
          name: "CLOUDFRONT_DISTRIBUTION_ID",
          value: cloudFrontDistributionId,
        },
        { name: "NEXTAUTH_URL", value: `https://app.${domain}` },
        {
          name: "STEP_FUNCTION_ARN",
          value: `arn:aws:states:${region}:${account}:stateMachine:beaver-process-blueprint`,
        },
        {
          name: "LABEL_STUDIO_URL",
          value: `https://labelstudio.${domain}`,
        },
        {
          name: "LABEL_STUDIO_INSTANCE_ID",
          value: "fs-0123456789abcdef0:generation-1",
        },
        { name: "AWS_ACCOUNT", value: account },
        { name: "ROOT_ADMIN_EMAIL", value: "" },
        { name: "YOLO_ECR_IMAGE", value: yoloImage },
        {
          name: "SAGEMAKER_ROLE_ARN",
          value: `arn:aws:iam::${account}:role/beaver-sagemaker-role`,
        },
        { name: "LAMBDA_CV_ENABLED", value: "true" },
        { name: "LAMBDA_CV_FUNCTION_NAME", value: "beaver-cv-pipeline" },
        { name: "ALLOW_MODEL_UPLOAD", value: "false" },
      ],
      secrets: [
        { name: "DATABASE_URL", valueFrom: secretSelector },
        {
          name: "NEXTAUTH_SECRET",
          valueFrom: `arn:aws:secretsmanager:${region}:${account}:secret:beaver/NEXTAUTH_SECRET-AbCd12`,
        },
        {
          name: "PROCESSING_WEBHOOK_SECRET",
          valueFrom: `arn:aws:secretsmanager:${region}:${account}:secret:beaver/PROCESSING_WEBHOOK_SECRET-AbCd12`,
        },
        {
          name: "ANTHROPIC_API_KEY",
          valueFrom: `arn:aws:secretsmanager:${region}:${account}:secret:beaver/ANTHROPIC_API_KEY-AbCd12`,
        },
        {
          name: "GROQ_API_KEY",
          valueFrom: `arn:aws:secretsmanager:${region}:${account}:secret:beaver/GROQ_API_KEY-AbCd12`,
        },
        {
          name: "LABEL_STUDIO_API_KEY",
          valueFrom: `arn:aws:secretsmanager:${region}:${account}:secret:beaver/LABEL_STUDIO_API_KEY-AbCd12`,
        },
      ],
      mountPoints: [],
      volumesFrom: [],
      logConfiguration: {
        logDriver: "awslogs",
        options: {
          "awslogs-stream-prefix": "beaver",
          "awslogs-group": "/ecs/blueprintparser-app",
          "awslogs-region": region,
        },
      },
      healthCheck: {
        timeout: 5,
        command: [
          "CMD-SHELL",
          "curl -f http://localhost:3000/api/health || exit 1",
        ],
        startPeriod: 60,
        retries: 3,
        interval: 30,
      },
    },
  ],
};
const appTaskDefinitionJson = JSON.stringify(appTaskDefinition);

let fixtureDir;
let logPath;
let databaseLogPath;

const mockDatabaseTls = `export function databaseTlsOptions(env) {
  if (env?.NODE_ENV !== "production") throw new Error("production TLS required");
  if (env?.DATABASE_URL !== "${databaseUrl}") throw new Error("database URL authority required");
  return { ca: "mock-code-owned-rds-ca", rejectUnauthorized: true };
}
`;

const mockPg = `const { appendFileSync } = require("node:fs");
function log(value) {
  appendFileSync(process.env.MOCK_DATABASE_LOG, JSON.stringify(value) + "\\n");
}
class Pool {
  constructor(options) {
    log({ kind: "pool", options });
  }
  async connect() {
    return {
      async query(text, values = []) {
        log({ kind: "query", text, values });
        if (text.startsWith("UPDATE public.users")) {
          const rowCount = Number(process.env.MOCK_PG_ROW_COUNT ?? "1");
          return {
            rowCount,
            rows: Array.from({ length: rowCount }, () => ({
              email: values[0],
              is_root_admin: text.includes("= true"),
            })),
          };
        }
        if (text.startsWith("SELECT email")) {
          return {
            rowCount: 2,
            rows: [
              { email: "first@example.test", is_root_admin: true },
              { email: "second@example.test", is_root_admin: false },
            ],
          };
        }
        return { rowCount: null, rows: [] };
      },
      release() {
        log({ kind: "release" });
      },
    };
  }
  async end() {
    log({ kind: "end" });
  }
}
module.exports = { Pool };
`;

const fakeAws = `#!/usr/bin/env bash
set -euo pipefail
{
  printf 'CALL'
  for arg in "$@"; do printf '\\t%q' "$arg"; done
  printf '\\n'
} >> "\${MOCK_AWS_LOG}"

case "\${1:-} \${2:-}" in
  "sts get-caller-identity")
    printf '%s\\n' "\${MOCK_CALLER_ACCOUNT:-${account}}"
    ;;
  "ecs describe-services")
    printf '{"failures":[],"services":[{"serviceArn":"%s","clusterArn":"%s","serviceName":"%s","status":"%s","enableExecuteCommand":%s,"taskDefinition":"%s"}]}\\n' \\
      "\${MOCK_SERVICE_ARN:-${serviceArn}}" \\
      "\${MOCK_CLUSTER_ARN:-${clusterArn}}" \\
      "\${MOCK_SERVICE_NAME:-${service}}" \\
      "\${MOCK_SERVICE_STATUS:-ACTIVE}" \\
      "\${MOCK_SERVICE_EXEC_ENABLED:-true}" \\
      "\${MOCK_SERVICE_TASK_DEFINITION:-${taskDefinition}}"
    ;;
  "ecs describe-task-definition")
    query=''
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --query) query="\${2:-}"; shift 2 ;;
        --task-definition|--region|--output) shift 2 ;;
        *) shift ;;
      esac
    done
    case "\${query}" in
      taskDefinition)
        definition='${appTaskDefinitionJson}'
        if [ -n "\${MOCK_TASK_ROLE_ARN:-}" ]; then
          definition="\${definition/arn:aws:iam::${account}:role\/beaver-ecs-task-role/\${MOCK_TASK_ROLE_ARN}}"
        fi
        if [ -n "\${MOCK_DATABASE_SELECTOR:-}" ]; then
          definition="\${definition/${secretSelector}/\${MOCK_DATABASE_SELECTOR}}"
        fi
        printf '%s\\n' "\${definition}"
        ;;
      'taskDefinition.containerDefinitions[0].image')
        printf '%s\\n' "\${MOCK_TASK_IMAGE:-${appImage}}"
        ;;
      *) printf 'unexpected task-definition query: %s\\n' "\${query}" >&2; exit 97 ;;
    esac
    ;;
  "secretsmanager describe-secret")
    printf '{"ARN":"%s","Name":"beaver/DATABASE_URL","VersionIdsToStages":{"%s":["%s"]}}\\n' \
      "\${MOCK_SECRET_ARN:-${secretArn}}" \
      "${secretVersion}" \
      "\${MOCK_SECRET_STAGE:-AWSCURRENT}"
    ;;
  "secretsmanager get-secret-value")
    printf '%s\\n' "\${MOCK_DATABASE_URL:-${databaseUrl}}"
    ;;
  "rds describe-db-instances")
    printf '{"DBInstances":[{"DBInstanceIdentifier":"beaver-db","DBInstanceArn":"arn:aws:rds:us-east-1:%s:db:beaver-db","Engine":"postgres","DBInstanceStatus":"available","DBName":"beaver","MasterUsername":"beaver_admin","PubliclyAccessible":false,"Endpoint":{"Address":"beaver-db.abc123.us-east-1.rds.amazonaws.com","Port":5432}}]}\\n' \
      "\${MOCK_RDS_ACCOUNT:-${account}}"
    ;;
  "ecs list-tasks")
    case "\${MOCK_LIST_COUNT:-1}" in
      0) printf '{"taskArns":[]}\\n' ;;
      1) printf '{"taskArns":["%s"]%s}\\n' \\
           "\${MOCK_LIST_TASK_ARN:-${taskArn}}" \\
           "\${MOCK_LIST_TRAILER:-}" ;;
      2) printf '{"taskArns":["${taskArn}","${otherTaskArn}"]}\\n' ;;
      *) exit 96 ;;
    esac
    ;;
  "ecs describe-tasks")
    printf '{"failures":[],"tasks":[{"taskArn":"%s","clusterArn":"%s","group":"%s","lastStatus":"%s","desiredStatus":"%s","enableExecuteCommand":%s,"taskDefinitionArn":"%s","containers":[{"name":"%s","lastStatus":"%s","taskArn":"%s"}]}]}\\n' \\
      "\${MOCK_DESCRIBED_TASK_ARN:-${taskArn}}" \\
      "\${MOCK_TASK_CLUSTER_ARN:-${clusterArn}}" \\
      "\${MOCK_TASK_GROUP:-service:${service}}" \\
      "\${MOCK_TASK_LAST_STATUS:-RUNNING}" \\
      "\${MOCK_TASK_DESIRED_STATUS:-RUNNING}" \\
      "\${MOCK_TASK_EXEC_ENABLED:-true}" \\
      "\${MOCK_TASK_DEFINITION:-${taskDefinition}}" \\
      "\${MOCK_CONTAINER_NAME:-${service}}" \\
      "\${MOCK_CONTAINER_STATUS:-RUNNING}" \\
      "\${MOCK_CONTAINER_TASK_ARN:-${taskArn}}"
    ;;
  "ecs execute-command")
    if [ "\${MOCK_EXECUTE_LOCAL:-0}" = 1 ]; then
      remote_command=''
      while [ "$#" -gt 0 ]; do
        if [ "$1" = --command ]; then
          remote_command="$2"
          break
        fi
        shift
      done
      [ -n "\${remote_command}" ] || exit 95
      (
        cd "\${MOCK_REMOTE_ROOT}"
        ROOT_ADMIN_EMAIL="\${MOCK_REMOTE_ROOT_ADMIN_EMAIL:-\${ROOT_ADMIN_EMAIL:-}}" bash -c "\${remote_command}"
      )
    else
      printf 'mock ECS Exec session\\n'
    fi
    ;;
  *)
    printf 'unexpected fake AWS call: %s\\n' "$*" >&2
    exit 97
    ;;
esac
`;

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "bp-root-admin-"));
  logPath = path.join(fixtureDir, "aws.log");
  databaseLogPath = path.join(fixtureDir, "database.log");
  const awsPath = path.join(fixtureDir, "aws");
  await Promise.all([
    mkdir(path.join(fixtureDir, "scripts"), { recursive: true }),
    mkdir(path.join(fixtureDir, "node_modules", "pg"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(awsPath, fakeAws),
    writeFile(
      path.join(fixtureDir, "scripts", "database-tls.mjs"),
      mockDatabaseTls,
    ),
    writeFile(path.join(fixtureDir, "node_modules", "pg", "index.js"), mockPg),
  ]);
  await chmod(awsPath, 0o755);
});

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

async function runRootAdmin(input, extraEnv = {}) {
  await Promise.all([writeFile(logPath, ""), writeFile(databaseLogPath, "")]);
  const { TASK_ARN: _ignoredTaskArn, ...cleanProcessEnv } = process.env;
  const result = spawnSync("bash", [scriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
    input,
    env: {
      ...cleanProcessEnv,
      PATH: `${fixtureDir}:${process.env.PATH ?? ""}`,
      BP_ROOT_ADMIN_ENV_FILE: path.join(fixtureDir, "missing.env"),
      MOCK_AWS_LOG: logPath,
      MOCK_DATABASE_LOG: databaseLogPath,
      MOCK_REMOTE_ROOT: fixtureDir,
      AWS_ACCOUNT: account,
      AWS_REGION: region,
      ECS_CLUSTER: cluster,
      ECS_SERVICE: service,
      ECR_REPO: service,
      DOMAIN: domain,
      CLOUDFRONT_DISTRIBUTION_ID: cloudFrontDistributionId,
      ROOT_ADMIN_EMAIL: "",
      NODE_ENV: "production",
      DATABASE_URL: databaseUrl,
      ...extraEnv,
    },
  });
  return {
    ...result,
    log: await readFile(logPath, "utf8"),
    databaseLog: await readFile(databaseLogPath, "utf8"),
  };
}

test("verifies the canonical caller, service revision, task, and container before ECS Exec", async () => {
  const result = await runRootAdmin("1\nq\n");
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stderr,
    /Verified app task contract, immutable image, and live database secret/u,
  );
  assert.match(result.stderr, new RegExp(`Verified task: ${taskId}`));
  assert.match(result.log, /CALL\tsts\tget-caller-identity/u);
  assert.match(result.log, /CALL\tecs\tdescribe-services/u);
  assert.match(result.log, /CALL\tecs\tdescribe-task-definition/u);
  assert.match(result.log, /CALL\tsecretsmanager\tdescribe-secret/u);
  assert.match(result.log, /CALL\trds\tdescribe-db-instances/u);
  assert.match(result.log, /CALL\tsecretsmanager\tget-secret-value/u);
  assert.match(result.log, /CALL\tecs\tlist-tasks/u);
  assert.match(result.log, /CALL\tecs\tdescribe-tasks/u);
  assert.match(result.log, /CALL\tecs\texecute-command/u);
  assert.match(result.log, /--cluster\tbeaver-cluster/u);
  assert.match(
    result.log,
    new RegExp(`--task\\t${taskArn.replaceAll("/", "\\/")}`),
  );
  assert.match(result.log, /--container\tbeaver-app/u);
  assert.match(result.log, /--region\tus-east-1/u);
  assert.match(result.log, /databaseTlsOptions/u);
  assert.match(result.log, /scripts\/database-tls\.mjs/u);
  assert.equal(result.log.includes("$1"), true);
  assert.ok(
    result.log.indexOf("CALL\tecs\tdescribe-task-definition") <
      result.log.indexOf("CALL\tecs\tlist-tasks"),
  );
  assert.ok(
    result.log.indexOf("CALL\tsecretsmanager\tget-secret-value") <
      result.log.indexOf("CALL\tecs\texecute-command"),
  );
});

test("rejects caller task substitution before any AWS call", async () => {
  const result = await runRootAdmin("1\n", {
    TASK_ARN: `arn:aws:ecs:${region}:${account}:task/attacker/task`,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TASK_ARN overrides are forbidden/u);
  assert.equal(result.log, "");
});

test("rejects noncanonical local configuration before any AWS call", async () => {
  for (const extraEnv of [
    { AWS_ACCOUNT: "not-an-account" },
    { AWS_REGION: "us-west-2" },
    { ECS_CLUSTER: "other-cluster" },
    { ECS_SERVICE: "other-service" },
  ]) {
    const result = await runRootAdmin("1\n", extraEnv);
    assert.notEqual(result.status, 0, JSON.stringify(extraEnv));
    assert.equal(result.log, "", JSON.stringify(extraEnv));
  }
});

test("rejects a substituted AWS caller before inspecting ECS", async () => {
  const result = await runRootAdmin("1\n", {
    MOCK_CALLER_ACCOUNT: "999999999999",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /caller account identity/u);
  assert.doesNotMatch(result.log, /CALL\tecs/u);
});

test("fails closed on absent or overlapping running service tasks", async () => {
  for (const count of ["0", "2"]) {
    const result = await runRootAdmin("1\n", { MOCK_LIST_COUNT: count });
    assert.notEqual(result.status, 0, `count=${count}`);
    assert.match(result.stderr, /absent or ambiguous running-task selection/u);
    assert.doesNotMatch(result.log, /CALL\tecs\tdescribe-tasks/u);
    assert.doesNotMatch(result.log, /CALL\tecs\texecute-command/u);
  }
});

test("rejects a listed task ARN outside the canonical account/region/cluster", async () => {
  const result = await runRootAdmin("1\n", {
    MOCK_LIST_TASK_ARN: `arn:aws:ecs:${region}:999999999999:task/${cluster}/${taskId}`,
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /outside the canonical account, region, or cluster/u,
  );
  assert.doesNotMatch(result.log, /CALL\tecs\tdescribe-tasks/u);
  assert.doesNotMatch(result.log, /CALL\tecs\texecute-command/u);
});

test("rejects service identity, active revision, and ECS Exec substitutions", async () => {
  for (const extraEnv of [
    {
      MOCK_SERVICE_ARN: `arn:aws:ecs:${region}:${account}:service/${cluster}/other`,
    },
    {
      MOCK_SERVICE_TASK_DEFINITION: `arn:aws:ecs:${region}:${account}:task-definition/other:42`,
    },
    { MOCK_SERVICE_STATUS: "DRAINING" },
    { MOCK_SERVICE_EXEC_ENABLED: "false" },
  ]) {
    const result = await runRootAdmin("1\n", extraEnv);
    assert.notEqual(result.status, 0, JSON.stringify(extraEnv));
    assert.match(result.stderr, /service verification failed/iu);
    assert.doesNotMatch(result.log, /CALL\tecs\tlist-tasks/u);
    assert.doesNotMatch(result.log, /CALL\tecs\texecute-command/u);
  }
});

test("rejects task-contract, mutable-image, and database-selector drift before task selection", async () => {
  const cases = [
    {
      env: {
        MOCK_TASK_ROLE_ARN: `arn:aws:iam::${account}:role/other-task-role`,
      },
      error: /canonical app task contract/u,
    },
    {
      env: {
        MOCK_DATABASE_SELECTOR: `${secretArn}:AWSCURRENT:`,
      },
      error: /canonical app task contract/u,
    },
    {
      env: {
        MOCK_TASK_IMAGE: `${account}.dkr.ecr.${region}.amazonaws.com/beaver-app:latest`,
      },
      error: /canonical digest-pinned app image/u,
    },
    {
      env: {
        MOCK_TASK_IMAGE: `${account}.dkr.ecr.${region}.amazonaws.com/beaver-app@sha256:not-a-digest`,
      },
      error: /exact immutable app digest/u,
    },
  ];
  for (const { env, error } of cases) {
    const result = await runRootAdmin("1\n", env);
    assert.notEqual(result.status, 0, JSON.stringify(env));
    assert.match(result.stderr, error, JSON.stringify(env));
    assert.doesNotMatch(result.log, /CALL\tecs\tlist-tasks/u);
    assert.doesNotMatch(result.log, /CALL\tecs\texecute-command/u);
  }
});

test("rejects stale secret stages, foreign RDS identity, and noncanonical live URLs", async () => {
  const cases = [
    { MOCK_SECRET_STAGE: "AWSPREVIOUS" },
    { MOCK_RDS_ACCOUNT: "999999999999" },
    {
      MOCK_DATABASE_URL:
        "postgresql://beaver_admin:password@foreign.example.test:5432/beaver",
    },
    {
      MOCK_DATABASE_URL: `${databaseUrl}?options=-csearch_path%3Dattacker`,
    },
  ];
  for (const env of cases) {
    const result = await runRootAdmin("1\n", env);
    assert.notEqual(result.status, 0, JSON.stringify(env));
    assert.match(
      result.stderr,
      /canonical immutable DATABASE_URL secret/u,
      JSON.stringify(env),
    );
    assert.doesNotMatch(result.log, /CALL\tecs\tlist-tasks/u);
    assert.doesNotMatch(result.log, /CALL\tecs\texecute-command/u);
  }
});

test("rejects tasks outside the canonical service, revision, and container", async () => {
  for (const extraEnv of [
    { MOCK_TASK_GROUP: "service:other" },
    {
      MOCK_TASK_DEFINITION: `arn:aws:ecs:${region}:${account}:task-definition/${service}:41`,
    },
    { MOCK_CONTAINER_NAME: "sidecar" },
    { MOCK_TASK_EXEC_ENABLED: "false" },
    { MOCK_CONTAINER_STATUS: "STOPPED" },
  ]) {
    const result = await runRootAdmin("1\n", extraEnv);
    assert.notEqual(result.status, 0, JSON.stringify(extraEnv));
    assert.match(
      result.stderr,
      /does not belong to the canonical service deployment/u,
    );
    assert.doesNotMatch(result.log, /CALL\tecs\texecute-command/u);
  }
});

test("promotion is exact-email, explicitly confirmed, and command-line encoded", async () => {
  const email = "owner+recovery@example.test";
  const result = await runRootAdmin(`2\n${email}\nPROMOTE\nq\n`, {
    MOCK_EXECUTE_LOCAL: "1",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /CALL\tecs\texecute-command/u);
  assert.match(result.log, /promote/u);
  assert.match(result.log, new RegExp(Buffer.from(email).toString("base64")));
  assert.equal(result.log.includes(email), false);
  assert.match(result.stdout, /update verified for exactly one user/u);
  const databaseEvents = result.databaseLog
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(databaseEvents[0], {
    kind: "pool",
    options: {
      connectionString: databaseUrl,
      ssl: { ca: "mock-code-owned-rds-ca", rejectUnauthorized: true },
    },
  });
  assert.equal(
    databaseEvents.some(
      (event) =>
        event.kind === "query" &&
        event.text.includes("UPDATE public.users SET is_root_admin = true") &&
        event.text.includes("email = $1") &&
        JSON.stringify(event.values) === JSON.stringify([email]),
    ),
    true,
    result.databaseLog,
  );
  assert.equal(
    databaseEvents.some(
      (event) => event.kind === "query" && event.text === "COMMIT",
    ),
    true,
  );

  const cancelled = await runRootAdmin(`2\n${email}\nno\nq\n`);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /Promotion cancelled/u);
  assert.equal(cancelled.log, "");
});

test("demotion requires explicit confirmation and uses only the fixed guarded operation", async () => {
  const email = "departing-owner@example.test";
  const result = await runRootAdmin(`3\n${email}\nDEMOTE\nq\n`, {
    MOCK_EXECUTE_LOCAL: "1",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /CALL\tecs\texecute-command/u);
  assert.match(result.log, /demote/u);
  assert.match(result.log, new RegExp(Buffer.from(email).toString("base64")));
  assert.equal(result.log.includes(email), false);
  assert.match(result.databaseLog, /pg_catalog\.pg_advisory_xact_lock/u);
  assert.match(result.databaseLog, /UPDATE public\.users AS target/u);
  assert.match(result.databaseLog, /FROM public\.users AS other/u);
  assert.match(result.databaseLog, /other\.is_root_admin = true/u);
  assert.match(result.databaseLog, /other\.id <> target\.id/u);

  const cancelled = await runRootAdmin(`3\n${email}\nno\nq\n`);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /Demotion cancelled/u);
  assert.equal(cancelled.log, "");
});

test("refuses case-insensitive demotion of nonempty remote ROOT_ADMIN_EMAIL", async () => {
  const result = await runRootAdmin(
    "3\nbootstrap-owner@example.test\nDEMOTE\n",
    {
      MOCK_EXECUTE_LOCAL: "1",
      MOCK_REMOTE_ROOT_ADMIN_EMAIL: "Bootstrap-Owner@Example.Test",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to demote.*ROOT_ADMIN_EMAIL/u);
  assert.match(result.stderr, /clear root_admin_email in Terraform/u);
  assert.match(result.stderr, /same-digest deploy\.sh activate/u);
  assert.match(result.log, /CALL\tecs\texecute-command/u);
  assert.equal(result.databaseLog, "");
  assert.doesNotMatch(result.stdout, /update verified/u);
});

test("zero or multiple affected users is a hard failure with rollback", async () => {
  const email = "ambiguous@example.test";
  for (const rowCount of ["0", "2"]) {
    const result = await runRootAdmin(`2\n${email}\nPROMOTE\n`, {
      MOCK_EXECUTE_LOCAL: "1",
      MOCK_PG_ROW_COUNT: rowCount,
    });
    assert.notEqual(result.status, 0, `rowCount=${rowCount}`);
    assert.match(result.stderr, /expected exactly one changed user/u);
    assert.match(result.databaseLog, /"text":"ROLLBACK"/u);
    assert.doesNotMatch(result.databaseLog, /"text":"COMMIT"/u);
    assert.doesNotMatch(result.stdout, /update verified/u);
  }
});

function sourceSecurityIssues(source) {
  const required = [
    'readonly CANONICAL_AWS_REGION="us-east-1"',
    'readonly CANONICAL_ECS_CLUSTER="beaver-cluster"',
    'readonly CANONICAL_ECS_SERVICE="beaver-app"',
    'readonly CANONICAL_CONTAINER_NAME="beaver-app"',
    'readonly CANONICAL_ECR_REPO="beaver-app"',
    'source "${SCRIPT_DIR}/scripts/lib/ecs-schema-tools.sh"',
    'if [ "${TASK_ARN+x}" = x ]',
    'bp_assert_task_definition_contract "${task_definition}" app',
    'bp_task_definition_image "${task_definition}"',
    'bp_assert_database_secret_identity "${database_selector}"',
    "task.group !== `service:${service}`",
    "task.taskDefinitionArn !== expectedTaskDefinition",
    "containers[0].name !== containerName",
    "const{databaseTlsOptions}=await import('./scripts/database-tls.mjs')",
    "databaseTlsOptions(process.env)",
    "result.rowCount!==1",
    "FROM public.users",
    "UPDATE public.users",
    "other.is_root_admin = true AND other.id <> target.id",
    "SELECT pg_catalog.pg_advisory_xact_lock(737375864)",
    "bootstrapEmail.toLowerCase()===email.trim().toLowerCase()",
    "clear root_admin_email in Terraform",
    "same-digest deploy.sh activate",
    "Type PROMOTE to confirm",
    "Type DEMOTE to confirm",
  ];
  const forbidden = [
    "rejectUnauthorized:false",
    "data_key",
    "Run custom SQL",
    "promote_first_user",
    "reset_password",
    "ALTER TABLE",
    "environment[*].[name,value]",
    '--task "$TASK_ARN"',
    "FROM users",
    "UPDATE users",
    "SELECT pg_advisory_xact_lock",
  ];
  return [
    ...required
      .filter((marker) => !source.includes(marker))
      .map((marker) => `missing:${marker}`),
    ...forbidden
      .filter((marker) => source.includes(marker))
      .map((marker) => `forbidden:${marker}`),
  ];
}

test("source freezes fixed operations, verified TLS, exact-one updates, and minimized output", async () => {
  const source = await readFile(scriptPath, "utf8");
  assert.deepEqual(sourceSecurityIssues(source), []);
  assert.match(source, /SELECT email, is_root_admin FROM public\.users/u);
  assert.doesNotMatch(source, /SELECT id, email, username/u);
  assert.doesNotMatch(source, /List companies/u);
  assert.doesNotMatch(source, /Check ECS task env vars/u);
});

test("source freezes the exact remote operation and SQL set", async () => {
  const source = await readFile(scriptPath, "utf8");
  const operationBlock = source.match(
    /const operations=Object\.freeze\(\{([\s\S]*?)\n  \}\);/u,
  )?.[1];
  assert.ok(operationBlock);
  const operations = [
    ...operationBlock.matchAll(
      /(list|promote|demote):Object\.freeze\(\{text:'([^']+)',values:(\[\]|\[email\]),mutation:(true|false)\}\)/gu,
    ),
  ].map((match) => ({
    name: match[1],
    text: match[2].replace(/\\{3}\$1/gu, "$1"),
    values: match[3],
    mutation: match[4],
  }));
  assert.deepEqual(operations, [
    {
      name: "list",
      text: "SELECT email, is_root_admin FROM public.users ORDER BY lower(email), email",
      values: "[]",
      mutation: "false",
    },
    {
      name: "promote",
      text: "UPDATE public.users SET is_root_admin = true WHERE email = $1 AND is_root_admin = false RETURNING email, is_root_admin",
      values: "[email]",
      mutation: "true",
    },
    {
      name: "demote",
      text: "UPDATE public.users AS target SET is_root_admin = false WHERE target.email = $1 AND target.is_root_admin = true AND EXISTS (SELECT 1 FROM public.users AS other WHERE other.is_root_admin = true AND other.id <> target.id) RETURNING target.email, target.is_root_admin",
      values: "[email]",
      mutation: "true",
    },
  ]);
  assert.equal(
    (source.match(/run_fixed_operation (?:list|promote|demote)/gu) ?? [])
      .length,
    3,
  );
  assert.doesNotMatch(
    source,
    /run_fixed_operation (?!list(?:\s|$)|promote(?:\s|$)|demote(?:\s|$))\w+/u,
  );
});

test("menu exposes only fixed root-admin operations and side-effect-free setup help", async () => {
  const result = await runRootAdmin("q\n");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.log, "");
  const plainOutput = result.stdout.replace(/\u001b\[[0-9;]*m/gu, "");
  for (const label of [
    "1  List user emails and root-admin status",
    "2  Promote one exact email",
    "3  Demote one exact email (never the last root admin)",
    "4  Show ROOT_ADMIN_EMAIL Terraform setup",
  ]) {
    assert.equal(plainOutput.includes(label), true, label);
  }
  assert.doesNotMatch(
    plainOutput,
    /custom SQL|password|first user|companies|env vars/iu,
  );
});

test("static policy detects representative trust-boundary mutations", async () => {
  const source = await readFile(scriptPath, "utf8");
  const mutations = [
    source.replace(
      'readonly CANONICAL_AWS_REGION="us-east-1"',
      'readonly CANONICAL_AWS_REGION="${AWS_REGION}"',
    ),
    source.replace(
      "databaseTlsOptions(process.env)",
      "{rejectUnauthorized:false}",
    ),
    source.replace("result.rowCount!==1", "result.rowCount<1"),
    source.replace(
      'bp_assert_database_secret_identity "${database_selector}"',
      "true",
    ),
    source.replaceAll("public.users", "users"),
    source.replace("pg_catalog.pg_advisory_xact_lock", "pg_advisory_xact_lock"),
    source.replace(
      "bootstrapEmail.toLowerCase()===email.trim().toLowerCase()",
      "false",
    ),
    source.replace("task.group !== `service:${service}`", "false"),
    source.replace("containers[0].name !== containerName", "false"),
    `${source}\n# data_key`,
  ];
  for (const mutation of mutations) {
    assert.notDeepEqual(sourceSecurityIssues(mutation), []);
  }
});
