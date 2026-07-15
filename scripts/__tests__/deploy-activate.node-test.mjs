import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE = `123456789012.dkr.ecr.us-east-1.amazonaws.com/beaver-app@${DIGEST}`;
const OTHER_IMAGE = `123456789012.dkr.ecr.us-east-1.amazonaws.com/beaver-app@sha256:${"c".repeat(64)}`;
const SECRET_VERSION = "1".repeat(32);
const SECRET_ARN =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:beaver/DATABASE_URL-AbCd12";
const SECRET_SELECTOR = `${SECRET_ARN}:::${SECRET_VERSION}`;
const SCHEMA_CHECK_TASK_ARN =
  "arn:aws:ecs:us-east-1:123456789012:task/beaver-cluster/44444444444444444444444444444444";
let fixtureDir;
let logPath;

const mockAws = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${MOCK_AWS_LOG}"
service="\${1:-}"
action="\${2:-}"
default_label_studio_url='https://labelstudio.example.com'
default_label_studio_instance='fs-0123456789abcdef0:generation-1'
default_label_studio_secret='arn:aws:secretsmanager:us-east-1:123456789012:secret:beaver/LABEL_STUDIO_API_KEY-AbCd12'
schema_check_task_arn='${SCHEMA_CHECK_TASK_ARN}'
shift 2 || true
query=""
task_definition=""
overrides=""
tasks=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --query) query="\${2:-}"; shift 2 ;;
    --task-definition) task_definition="\${2:-}"; shift 2 ;;
    --overrides) overrides="\${2:-}"; shift 2 ;;
    --tasks)
      shift
      while [ "$#" -gt 0 ] && [[ "$1" != --* ]]; do tasks+=("$1"); shift; done
      ;;
    --cluster|--region|--output|--services|--service|--launch-type|--platform-version|--network-configuration|--client-token|--started-by|--secret-id|--version-id|--version-stage|--db-instance-identifier|--state-machine-arn|--group-name|--name|--service-name|--desired-status|--service-namespace|--resource-ids|--role-name)
      [ "$#" -ge 2 ] || exit 96
      shift 2
      ;;
    --force-new-deployment) shift ;;
    tasks-stopped|services-stable) shift ;;
    *) echo "unsupported mock AWS option: $1" >&2; exit 96 ;;
  esac
done

case "\${service} \${action}" in
  "sts get-caller-identity") echo "\${MOCK_CALLER_ACCOUNT:-123456789012}" ;;
  "secretsmanager describe-secret") printf '{"ARN":"${SECRET_ARN}","Name":"beaver/DATABASE_URL","RotationEnabled":false,"VersionIdsToStages":{"${SECRET_VERSION}":["%s"]}}\n' "\${MOCK_SECRET_STAGE:-AWSCURRENT}" ;;
  "secretsmanager get-secret-value") echo "\${MOCK_DATABASE_URL:-postgresql://beaver_admin:p%40ssword@beaver-db.abc123.us-east-1.rds.amazonaws.com:5432/beaver}" ;;
  "rds describe-db-instances") printf '{"DBInstances":[{"DBInstanceIdentifier":"beaver-db","DBInstanceArn":"arn:aws:rds:us-east-1:%s:db:beaver-db","Engine":"postgres","DBInstanceStatus":"available","DBName":"beaver","MasterUsername":"beaver_admin","PubliclyAccessible":false,"Endpoint":{"Address":"beaver-db.abc123.us-east-1.rds.amazonaws.com","Port":5432}}]}\n' "\${MOCK_RDS_ACCOUNT:-123456789012}" ;;
  "iam list-role-policies") echo "\${MOCK_MIGRATOR_INLINE_POLICIES:-[]}" ;;
  "iam list-attached-role-policies") echo "\${MOCK_MIGRATOR_ATTACHED_POLICIES:-[]}" ;;
  "ecs describe-task-definition")
    family="\${task_definition##*/}"
    family="\${family%%:*}"
    case "\${query}" in
      taskDefinition.taskDefinitionArn)
        echo "arn:aws:ecs:us-east-1:123456789012:task-definition/\${family}:42"
        ;;
      taskDefinition.containerDefinitions\\[0\\].image)
        service_task_definition="\${MOCK_SERVICE_TASK_DEFINITION:-arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-app:41}"
        if [ "\${task_definition}" = "\${service_task_definition}" ] && [ -n "\${MOCK_SERVICE_BOUND_IMAGE:-}" ]; then
          echo "\${MOCK_SERVICE_BOUND_IMAGE}"
        else
          echo "${IMAGE}"
        fi
        ;;
      taskDefinition)
        case "\${family}" in
          beaver-app)
            name="beaver-app"; command='[]'; task_role="beaver-ecs-task-role"
            environment='[{"name":"NODE_ENV","value":"production"},{"name":"PORT","value":"3000"},{"name":"S3_BUCKET","value":"beaver-data-123456789012"},{"name":"AWS_REGION","value":"us-east-1"},{"name":"CLOUDFRONT_DOMAIN","value":"assets.example.com"},{"name":"CLOUDFRONT_DISTRIBUTION_ID","value":"E1234567890123"},{"name":"NEXTAUTH_URL","value":"https://app.example.com"},{"name":"STEP_FUNCTION_ARN","value":"arn:aws:states:us-east-1:123456789012:stateMachine:beaver-process-blueprint"},{"name":"LABEL_STUDIO_URL","value":"https://labelstudio.example.com"},{"name":"LABEL_STUDIO_INSTANCE_ID","value":"fs-0123456789abcdef0:generation-1"},{"name":"AWS_ACCOUNT","value":"123456789012"},{"name":"ROOT_ADMIN_EMAIL","value":""},{"name":"YOLO_ECR_IMAGE","value":"123456789012.dkr.ecr.us-east-1.amazonaws.com/beaver-yolo-pipeline@sha256:${"b".repeat(64)}"},{"name":"SAGEMAKER_ROLE_ARN","value":"arn:aws:iam::123456789012:role/beaver-sagemaker-role"},{"name":"LAMBDA_CV_ENABLED","value":"true"},{"name":"LAMBDA_CV_FUNCTION_NAME","value":"beaver-cv-pipeline"}]'
            secrets='[{"name":"DATABASE_URL","valueFrom":"${SECRET_SELECTOR}"},{"name":"NEXTAUTH_SECRET","valueFrom":"arn:aws:secretsmanager:us-east-1:123456789012:secret:beaver/NEXTAUTH_SECRET-AbCd12"},{"name":"PROCESSING_WEBHOOK_SECRET","valueFrom":"arn:aws:secretsmanager:us-east-1:123456789012:secret:beaver/PROCESSING_WEBHOOK_SECRET-AbCd12"},{"name":"ANTHROPIC_API_KEY","valueFrom":"arn:aws:secretsmanager:us-east-1:123456789012:secret:beaver/ANTHROPIC_API_KEY-AbCd12"},{"name":"GROQ_API_KEY","valueFrom":"arn:aws:secretsmanager:us-east-1:123456789012:secret:beaver/GROQ_API_KEY-AbCd12"},{"name":"LABEL_STUDIO_API_KEY","valueFrom":"arn:aws:secretsmanager:us-east-1:123456789012:secret:beaver/LABEL_STUDIO_API_KEY-AbCd12"}]'
            log_group='/ecs/blueprintparser-app'; log_prefix='beaver'
            health=',"healthCheck":{"timeout":5,"command":["CMD-SHELL","curl -f http://localhost:3000/api/health || exit 1"],"startPeriod":60,"retries":3,"interval":30}' ;;
          beaver-cpu-pipeline)
            name="beaver-cpu-pipeline"; command='["./entrypoint.sh","worker","node","scripts/process-worker.js"]'; task_role="beaver-ecs-task-role"
            environment='[{"name":"NODE_ENV","value":"production"},{"name":"AWS_REGION","value":"us-east-1"},{"name":"S3_BUCKET","value":"beaver-data-123456789012"},{"name":"CLOUDFRONT_DOMAIN","value":"assets.example.com"}]'
            secrets='[{"name":"DATABASE_URL","valueFrom":"${SECRET_SELECTOR}"}]'; health=''; log_group='/ecs/blueprintparser-cpu-pipeline'; log_prefix='cpu-pipeline' ;;
          beaver-project-asset-deletions)
            name="beaver-project-asset-deletions"; command='["./entrypoint.sh","worker","node","scripts/project-asset-deletion-worker.js"]'; task_role="beaver-project-asset-deletion-task-role"
            environment='[{"name":"NODE_ENV","value":"production"},{"name":"AWS_REGION","value":"us-east-1"},{"name":"S3_BUCKET","value":"beaver-data-123456789012"},{"name":"CLOUDFRONT_DOMAIN","value":"assets.example.com"},{"name":"CLOUDFRONT_DISTRIBUTION_ID","value":"E1234567890123"},{"name":"LABEL_STUDIO_URL","value":"https://labelstudio.example.com"},{"name":"LABEL_STUDIO_INSTANCE_ID","value":"fs-0123456789abcdef0:generation-1"},{"name":"PROJECT_ASSET_EVENT_QUEUE_URL","value":"https://sqs.us-east-1.amazonaws.com/123456789012/beaver-project-asset-events"}]'
            secrets='[{"name":"DATABASE_URL","valueFrom":"${SECRET_SELECTOR}"},{"name":"LABEL_STUDIO_API_KEY","valueFrom":"arn:aws:secretsmanager:us-east-1:123456789012:secret:beaver/LABEL_STUDIO_API_KEY-AbCd12"}]'; health=''; log_group='/ecs/blueprintparser-project-asset-deletions'; log_prefix='project-asset-deletions' ;;
          beaver-schema-migrator)
            name="beaver-schema-migrator"; command='["./entrypoint.sh","migrate"]'; task_role="beaver-schema-migrator-task-role"
            environment='[{"name":"NODE_ENV","value":"production"}]'; secrets='[{"name":"DATABASE_URL","valueFrom":"${SECRET_SELECTOR}"}]'; health=''; log_group='/ecs/blueprintparser-schema-migrator'; log_prefix='schema-migrator' ;;
          *) exit 97 ;;
        esac
        case "\${family}" in
          beaver-app)
            if [ -n "\${MOCK_APP_ENV_FROM:-}" ]; then environment="\${environment//"\${MOCK_APP_ENV_FROM}"/"\${MOCK_APP_ENV_TO:-}"}"; fi ;;
          beaver-cpu-pipeline)
            if [ -n "\${MOCK_CPU_ENV_FROM:-}" ]; then environment="\${environment//"\${MOCK_CPU_ENV_FROM}"/"\${MOCK_CPU_ENV_TO:-}"}"; fi ;;
          beaver-project-asset-deletions)
            if [ -n "\${MOCK_MAINTENANCE_ENV_FROM:-}" ]; then environment="\${environment//"\${MOCK_MAINTENANCE_ENV_FROM}"/"\${MOCK_MAINTENANCE_ENV_TO:-}"}"; fi ;;
        esac
        if [ "\${family}" = "beaver-project-asset-deletions" ]; then
          if [ -n "\${MOCK_MAINTENANCE_LS_URL:-}" ]; then
            environment="\${environment//"\${default_label_studio_url}"/"\${MOCK_MAINTENANCE_LS_URL}"}"
          fi
          if [ -n "\${MOCK_MAINTENANCE_LS_INSTANCE:-}" ]; then
            environment="\${environment//"\${default_label_studio_instance}"/"\${MOCK_MAINTENANCE_LS_INSTANCE}"}"
          fi
          if [ -n "\${MOCK_MAINTENANCE_LS_SECRET:-}" ]; then
            secrets="\${secrets//"\${default_label_studio_secret}"/"\${MOCK_MAINTENANCE_LS_SECRET}"}"
          fi
        fi
        printf '{"family":"%s","networkMode":"awsvpc","requiresCompatibilities":["FARGATE"],"executionRoleArn":"arn:aws:iam::123456789012:role/beaver-ecs-execution-role","taskRoleArn":"arn:aws:iam::123456789012:role/%s","runtimePlatform":{"operatingSystemFamily":"LINUX","cpuArchitecture":"X86_64"},"volumes":[],"containerDefinitions":[{"name":"%s","essential":true,"command":%s,"environment":%s,"secrets":%s,"mountPoints":[],"volumesFrom":[],"logConfiguration":{"logDriver":"awslogs","options":{"awslogs-stream-prefix":"%s","awslogs-group":"%s","awslogs-region":"us-east-1"}}%s}]}\\n' "\${name}" "\${task_role}" "\${name}" "\${command}" "\${environment}" "\${secrets}" "\${log_prefix}" "\${log_group}" "\${health}"
        ;;
      *environment*)
        echo "arn:aws:states:us-east-1:123456789012:stateMachine:beaver-process-blueprint"
        ;;
      *) echo "unexpected task-definition query: \${query}" >&2; exit 97 ;;
    esac
    ;;
  "stepfunctions describe-state-machine")
    printf '%s\\n' '{"Comment":"Beaver blueprint processing pipeline","StartAt":"ValidateInput","States":{"ValidateInput":{"Type":"Pass","Parameters":{"projectId.$":"$.projectId","dataUrl.$":"$.dataUrl","s3Bucket.$":"$.s3Bucket","webhookUrl.$":"$.webhookUrl","webhookSecret.$":"$.webhookSecret","status":"PROCESSING"},"Next":"CPUProcessing"},"CPUProcessing":{"Type":"Task","Resource":"arn:aws:states:::ecs:runTask.sync","Parameters":{"LaunchType":"FARGATE","TaskDefinition":"arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-cpu-pipeline:42","Cluster":"arn:aws:ecs:us-east-1:123456789012:cluster/beaver-cluster","PlatformVersion":"1.4.0","NetworkConfiguration":{"AwsvpcConfiguration":{"Subnets":["subnet-test"],"SecurityGroups":["sg-test"],"AssignPublicIp":"DISABLED"}},"Overrides":{"ContainerOverrides":[{"Name":"beaver-cpu-pipeline","Environment":[{"Name":"PROJECT_ID","Value.$":"States.Format('{}', $.projectId)"},{"Name":"DATA_URL","Value.$":"$.dataUrl"},{"Name":"S3_BUCKET","Value.$":"$.s3Bucket"},{"Name":"WEBHOOK_URL","Value.$":"$.webhookUrl"},{"Name":"WEBHOOK_SECRET","Value.$":"$.webhookSecret"}]}]}},"ResultPath":"$.cpuResult","Retry":[{"ErrorEquals":["States.TaskFailed"],"IntervalSeconds":30,"MaxAttempts":2,"BackoffRate":2}],"Catch":[{"ErrorEquals":["States.ALL"],"Next":"ProcessingFailed","ResultPath":"$.error"}],"Next":"ProcessingComplete"},"ProcessingComplete":{"Type":"Succeed"},"ProcessingFailed":{"Type":"Fail","Error":"ProcessingFailed","Cause":"Blueprint processing pipeline failed. Check CloudWatch logs for details."}}}'
    ;;
  "scheduler get-schedule")
    case "\${query}" in
      State)
        if [ -n "\${MOCK_SCHEDULE_STATE_AFTER_UPDATE:-}" ] &&
           grep -q '^ecs update-service ' "\${MOCK_AWS_LOG}"; then
          echo "\${MOCK_SCHEDULE_STATE_AFTER_UPDATE}"
        else
          echo "\${MOCK_SCHEDULE_STATE:-ENABLED}"
        fi
        ;;
      Target.EcsParameters.TaskDefinitionArn) echo "arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-project-asset-deletions:42" ;;
      Target.Arn) echo "arn:aws:ecs:us-east-1:123456789012:cluster/beaver-cluster" ;;
      Target.Input) echo "\${MOCK_SCHEDULE_INPUT:-None}" ;;
      FlexibleTimeWindow.Mode) echo "OFF" ;;
      Target.RetryPolicy.MaximumEventAgeInSeconds) echo "600" ;;
      Target.RetryPolicy.MaximumRetryAttempts) echo "2" ;;
      Target.EcsParameters.LaunchType) echo "FARGATE" ;;
      Target.EcsParameters.PlatformVersion) echo "1.4.0" ;;
      Target.EcsParameters.TaskCount) echo "1" ;;
      Target.RoleArn) echo "arn:aws:iam::123456789012:role/beaver-project-asset-deletion-scheduler-role" ;;
      Target.DeadLetterConfig.Arn) echo "arn:aws:sqs:us-east-1:123456789012:beaver-project-asset-deletion-scheduler-dlq" ;;
      ScheduleExpression) echo "rate(5 minutes)" ;;
      *) echo "unexpected schedule query: \${query}" >&2; exit 97 ;;
    esac
    ;;
  "application-autoscaling describe-scalable-targets")
    case "\${query}" in
      *MinCapacity*) echo "\${MOCK_MIN_CAPACITY:-1}" ;;
      *MaxCapacity*) echo "\${MOCK_MAX_CAPACITY:-1}" ;;
      *DynamicScalingInSuspended*) echo "\${MOCK_SCALE_IN_SUSPENDED:-False}" ;;
      *DynamicScalingOutSuspended*)
        if [ -n "\${MOCK_SCALE_OUT_SUSPENDED_AFTER_UPDATE:-}" ] &&
           grep -q '^ecs update-service ' "\${MOCK_AWS_LOG}"; then
          echo "\${MOCK_SCALE_OUT_SUSPENDED_AFTER_UPDATE}"
        else
          echo "\${MOCK_SCALE_OUT_SUSPENDED:-False}"
        fi
        ;;
      *ScheduledScalingSuspended*) echo "\${MOCK_SCHEDULED_SCALING_SUSPENDED:-False}" ;;
      *) echo "unexpected autoscaling query: \${query}" >&2; exit 97 ;;
    esac
    ;;
  "ecs describe-services")
    case "\${query}" in
      *networkConfiguration*) echo '{"awsvpcConfiguration":{"subnets":["subnet-test"],"securityGroups":["sg-test"],"assignPublicIp":"DISABLED"}}' ;;
      *taskDefinition*)
        if grep -q '^ecs update-service ' "\${MOCK_AWS_LOG}"; then
          echo "arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-app:42"
        else
          echo "\${MOCK_SERVICE_TASK_DEFINITION:-arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-app:41}"
        fi
        ;;
      *rolloutState*) echo COMPLETED ;;
      *deployments*) echo 1 ;;
      *desiredCount*) echo "\${MOCK_DESIRED_COUNT:-1}" ;;
      *runningCount*) echo "\${MOCK_RUNNING_COUNT:-1}" ;;
      *pendingCount*) echo "\${MOCK_PENDING_COUNT:-0}" ;;
      *platformVersion*) echo "1.4.0" ;;
      *) echo "unexpected service query: \${query}" >&2; exit 97 ;;
    esac
    ;;
  "ecs run-task")
    if [ "\${MOCK_RUN_TASK_FAILURE:-0}" = "1" ]; then exit 255; fi
    [[ "\${overrides}" == *schema-check* ]] || exit 97
    if [ "\${MOCK_RUN_TASK_RESPONSE_FAILURE:-0}" = "1" ]; then
      printf '{"tasks":[],"failures":[{"arn":"%s","reason":"RESOURCE"}]}\\n' "\${task_definition}"
    else
      printf '{"tasks":[{"taskArn":"%s","taskDefinitionArn":"%s","clusterArn":"arn:aws:ecs:us-east-1:123456789012:cluster/beaver-cluster"}],"failures":[]}\\n' "\${schema_check_task_arn}" "\${task_definition}"
    fi
    ;;
  "ecs wait")
    if [ "\${MOCK_TASK_WAITER_FAILURE:-0}" = "1" ] && [[ "\${tasks[*]}" == *"\${schema_check_task_arn}"* ]]; then exit 255; fi
    ;;
  "ecs describe-tasks")
    if [[ "\${tasks[*]}" == *app-test* ]]; then
      if [ "\${MOCK_RUNNING_DESCRIBE_PARTIAL:-0}" = "1" ]; then
        echo '{"tasks":[],"failures":[]}'
      else
        printf '{"tasks":[{"taskArn":"arn:aws:ecs:us-east-1:123456789012:task/beaver-cluster/app-test","taskDefinitionArn":"%s","lastStatus":"RUNNING"}],"failures":[]}\n' "\${MOCK_RUNNING_TASK_DEFINITION:-arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-app:42}"
      fi
    elif [ "\${MOCK_DESCRIBE_PARTIAL:-0}" = "1" ]; then
      echo '{"tasks":[],"failures":[]}'
    elif [ "\${MOCK_DESCRIBE_FAILURE:-0}" = "1" ]; then
      echo '{"tasks":[],"failures":[{"arn":"schema-check","reason":"MISSING"}]}'
    else
      printf '{"tasks":[{"taskArn":"%s","taskDefinitionArn":"arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-schema-migrator:42","clusterArn":"arn:aws:ecs:us-east-1:123456789012:cluster/beaver-cluster","lastStatus":"STOPPED","containers":[{"name":"beaver-schema-migrator","lastStatus":"STOPPED","exitCode":%s}]}],"failures":[]}\\n' "\${schema_check_task_arn}" "\${MOCK_SCHEMA_EXIT_CODE:-0}"
    fi
    ;;
  "ecs update-service") echo beaver-app ;;
  "ecs list-tasks")
    if [ "\${MOCK_RUNNING_COUNT:-1}" = "0" ]; then
      echo None
    else
      echo "arn:aws:ecs:us-east-1:123456789012:task/beaver-cluster/app-test"
    fi
    ;;
  *) echo "unexpected mock AWS call: \${service} \${action}" >&2; exit 97 ;;
esac
`;

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "bp-deploy-activate-"));
  logPath = path.join(fixtureDir, "aws.log");
  const awsPath = path.join(fixtureDir, "aws");
  await writeFile(awsPath, mockAws);
  await chmod(awsPath, 0o755);
});

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

async function activate(extraEnv = {}) {
  await writeFile(logPath, "");
  const result = spawnSync("bash", ["deploy.sh", "activate", DIGEST], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixtureDir}:${process.env.PATH}`,
      MOCK_AWS_LOG: logPath,
      BP_DEPLOY_ENV_FILE: path.join(fixtureDir, "missing.env"),
      AWS_ACCOUNT: "123456789012",
      AWS_REGION: "us-east-1",
      ECR_REPO: "beaver-app",
      ECS_CLUSTER: "beaver-cluster",
      ECS_SERVICE: "beaver-app",
      DOMAIN: "example.com",
      CLOUDFRONT_DISTRIBUTION_ID: "E1234567890123",
      ROOT_ADMIN_EMAIL: "",
      ...extraEnv,
    },
  });
  return { ...result, log: await readFile(logPath, "utf8") };
}

test("activate completes read-only schema admission before exact-revision rollout", async () => {
  const result = await activate();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    result.log.indexOf("ecs run-task") <
      result.log.indexOf("ecs update-service"),
  );
  assert.ok(
    result.log.indexOf("ecs update-service") <
      result.log.indexOf("ecs wait services-stable"),
  );
  assert.match(result.log, /schema-check/u);
  assert.match(
    result.log,
    /update-service .*--task-definition .*beaver-app:42/u,
  );
  assert.match(result.log, /run-task .*--platform-version 1\.4\.0/u);
  assert.match(result.log, /services\[0\]\.platformVersion/u);
  assert.match(result.stdout, /Deployment completed/u);
});

test("activate rejects a candidate digest before admission or rollout", async () => {
  const result = await activate({ MOCK_SERVICE_BOUND_IMAGE: OTHER_IMAGE });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /activate is same-digest only/u);
  assert.match(result.stderr, /preflight-outage.*bind-quiescent.*verify-restored/u);
  assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
});

test("activate rejects a disabled maintenance schedule before schema admission", async () => {
  const result = await activate({ MOCK_SCHEDULE_STATE: "DISABLED" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /maintenance schedule state/u);
  assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
});

for (const [name, extraEnv, error] of [
  ["minimum zero", { MOCK_MIN_CAPACITY: "0" }, /autoscaling minimum/u],
  ["maximum above one", { MOCK_MAX_CAPACITY: "2" }, /autoscaling maximum/u],
]) {
  test(`activate rejects live autoscaling ${name}`, async () => {
    const result = await activate(extraEnv);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
  });
}

for (const [name, variable, error] of [
  ["dynamic scale-in", "MOCK_SCALE_IN_SUSPENDED", /scale-in suspension/u],
  ["dynamic scale-out", "MOCK_SCALE_OUT_SUSPENDED", /scale-out suspension/u],
  [
    "scheduled scaling",
    "MOCK_SCHEDULED_SCALING_SUSPENDED",
    /scheduled scaling suspension/u,
  ],
]) {
  test(`activate rejects independently suspended ${name}`, async () => {
    const result = await activate({ [variable]: "True" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
  });
}

for (const [name, extraEnv, error] of [
  [
    "maintenance schedule",
    { MOCK_SCHEDULE_STATE_AFTER_UPDATE: "DISABLED" },
    /maintenance schedule state/u,
  ],
  [
    "dynamic scale-out control",
    { MOCK_SCALE_OUT_SUSPENDED_AFTER_UPDATE: "True" },
    /scale-out suspension/u,
  ],
]) {
  test(`activate refuses success when the ${name} drifts during rollout`, async () => {
    const result = await activate(extraEnv);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.match(result.log, /ecs update-service/u);
    assert.doesNotMatch(result.stdout, /Deployment completed/u);
  });
}

for (const [name, extraEnv] of [
  ["zero/zero", { MOCK_DESIRED_COUNT: "0", MOCK_RUNNING_COUNT: "0" }],
  ["one/zero", { MOCK_DESIRED_COUNT: "1", MOCK_RUNNING_COUNT: "0" }],
]) {
  test(`activate cannot report success for a ${name} service`, async () => {
    const result = await activate(extraEnv);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /counts do not match expected 1/u);
    assert.match(result.log, /ecs update-service/u);
    assert.doesNotMatch(result.stdout, /Deployment completed/u);
  });
}

test("schema-check task failure prevents service activation", async () => {
  const result = await activate({ MOCK_SCHEMA_EXIT_CODE: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /terminal response was .*nonzero/u);
  assert.doesNotMatch(result.log, /ecs update-service/u);
});

test("ambiguous schema-check RunTask outcome prevents service activation", async () => {
  const result = await activate({ MOCK_RUN_TASK_FAILURE: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RunTask outcome is unknown/u);
  assert.doesNotMatch(result.log, /ecs update-service/u);
});

test("RunTask API failures in a successful response prevent activation", async () => {
  const result = await activate({ MOCK_RUN_TASK_RESPONSE_FAILURE: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RunTask response is partial or mismatched/u);
  assert.doesNotMatch(result.log, /ecs update-service/u);
});

test("a partial schema-check DescribeTasks response prevents activation", async () => {
  const result = await activate({ MOCK_DESCRIBE_PARTIAL: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /terminal response was partial/u);
  assert.doesNotMatch(result.log, /ecs update-service/u);
});

test("activate rejects a DATABASE_URL selector that is not AWSCURRENT", async () => {
  const result = await activate({ MOCK_SECRET_STAGE: "AWSPREVIOUS" });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /DATABASE_URL secret metadata validation failed/u,
  );
  assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
});

test("activate rejects Label Studio URL drift between app and maintenance", async () => {
  const result = await activate({
    MOCK_MAINTENANCE_LS_URL: "https://labelstudio.other.example.com",
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /LABEL_STUDIO_URL value|different Label Studio provider identities/u,
  );
  assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
});

test("activate rejects Label Studio generation drift between app and maintenance", async () => {
  const result = await activate({
    MOCK_MAINTENANCE_LS_INSTANCE: "fs-0123456789abcdef0:generation-2",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /different Label Studio provider identities/u);
  assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
});

test("activate rejects Label Studio API secret drift between app and maintenance", async () => {
  const result = await activate({
    MOCK_MAINTENANCE_LS_SECRET:
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:beaver/LABEL_STUDIO_API_KEY-ZzYy12",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /different Label Studio provider identities/u);
  assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
});

test("activate rejects a scheduler command or environment input override", async () => {
  const result = await activate({
    MOCK_SCHEDULE_INPUT:
      '{"containerOverrides":[{"command":["./entrypoint.sh","migrate"]}]}',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /maintenance schedule input override/u);
  assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
});

test("activate rejects a substituted AWS caller before ECS inspection", async () => {
  const result = await activate({ MOCK_CALLER_ACCOUNT: "999999999999" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AWS caller account identity/u);
  assert.doesNotMatch(result.log, /^ecs /mu);
});

test("activate rejects any permission policy on the dedicated migrator role", async () => {
  const result = await activate({
    MOCK_MIGRATOR_ATTACHED_POLICIES:
      '[{"PolicyName":"AdministratorAccess","PolicyArn":"arn:aws:iam::aws:policy/AdministratorAccess"}]',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must have no inline or attached permission policies/u);
  assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
});

const exactEnvironmentMutations = [
  ["app production mode", "MOCK_APP_ENV", '"name":"NODE_ENV","value":"production"', '"name":"NODE_ENV","value":"development"', /NODE_ENV value/u],
  ["app AWS account", "MOCK_APP_ENV", '"name":"AWS_ACCOUNT","value":"123456789012"', '"name":"AWS_ACCOUNT","value":"999999999999"', /AWS_ACCOUNT value/u],
  ["app S3 bucket", "MOCK_APP_ENV", '"name":"S3_BUCKET","value":"beaver-data-123456789012"', '"name":"S3_BUCKET","value":"other"', /S3_BUCKET value/u],
  ["app region", "MOCK_APP_ENV", '"name":"AWS_REGION","value":"us-east-1"', '"name":"AWS_REGION","value":"us-west-2"', /AWS_REGION value/u],
  ["app CloudFront domain", "MOCK_APP_ENV", '"name":"CLOUDFRONT_DOMAIN","value":"assets.example.com"', '"name":"CLOUDFRONT_DOMAIN","value":"evil.example.com"', /CLOUDFRONT_DOMAIN value/u],
  ["app CloudFront distribution", "MOCK_APP_ENV", '"name":"CLOUDFRONT_DISTRIBUTION_ID","value":"E1234567890123"', '"name":"CLOUDFRONT_DISTRIBUTION_ID","value":"E9999999999999"', /CLOUDFRONT_DISTRIBUTION_ID value/u],
  ["app URL", "MOCK_APP_ENV", '"name":"NEXTAUTH_URL","value":"https://app.example.com"', '"name":"NEXTAUTH_URL","value":"https://evil.example.com"', /NEXTAUTH_URL value/u],
  ["Label Studio URL", "MOCK_APP_ENV", '"name":"LABEL_STUDIO_URL","value":"https://labelstudio.example.com"', '"name":"LABEL_STUDIO_URL","value":"https://evil.example.com"', /LABEL_STUDIO_URL value/u],
  ["Step Functions ARN", "MOCK_APP_ENV", '"name":"STEP_FUNCTION_ARN","value":"arn:aws:states:us-east-1:123456789012:stateMachine:beaver-process-blueprint"', '"name":"STEP_FUNCTION_ARN","value":"arn:aws:states:us-east-1:123456789012:stateMachine:evil"', /STEP_FUNCTION_ARN value/u],
  ["YOLO image", "MOCK_APP_ENV", '"name":"YOLO_ECR_IMAGE","value":"123456789012.dkr.ecr.us-east-1.amazonaws.com/beaver-yolo-pipeline@', '"name":"YOLO_ECR_IMAGE","value":"123456789012.dkr.ecr.us-east-1.amazonaws.com/evil@', /YOLO_ECR_IMAGE value/u],
  ["SageMaker role", "MOCK_APP_ENV", '"name":"SAGEMAKER_ROLE_ARN","value":"arn:aws:iam::123456789012:role/beaver-sagemaker-role"', '"name":"SAGEMAKER_ROLE_ARN","value":"arn:aws:iam::123456789012:role/evil"', /SAGEMAKER_ROLE_ARN value/u],
  ["Lambda flag", "MOCK_APP_ENV", '"name":"LAMBDA_CV_ENABLED","value":"true"', '"name":"LAMBDA_CV_ENABLED","value":"false"', /LAMBDA_CV_ENABLED value/u],
  ["Lambda name", "MOCK_APP_ENV", '"name":"LAMBDA_CV_FUNCTION_NAME","value":"beaver-cv-pipeline"', '"name":"LAMBDA_CV_FUNCTION_NAME","value":"evil"', /LAMBDA_CV_FUNCTION_NAME value/u],
  ["app port", "MOCK_APP_ENV", '"name":"PORT","value":"3000"', '"name":"PORT","value":"3001"', /PORT value/u],
  ["root-admin identity", "MOCK_APP_ENV", '"name":"ROOT_ADMIN_EMAIL","value":""', '"name":"ROOT_ADMIN_EMAIL","value":"root@evil.example"', /ROOT_ADMIN_EMAIL value/u],
  ["CPU S3 bucket", "MOCK_CPU_ENV", '"name":"S3_BUCKET","value":"beaver-data-123456789012"', '"name":"S3_BUCKET","value":"other"', /S3_BUCKET value/u],
  ["CPU region", "MOCK_CPU_ENV", '"name":"AWS_REGION","value":"us-east-1"', '"name":"AWS_REGION","value":"us-west-2"', /AWS_REGION value/u],
  ["CPU CloudFront domain", "MOCK_CPU_ENV", '"name":"CLOUDFRONT_DOMAIN","value":"assets.example.com"', '"name":"CLOUDFRONT_DOMAIN","value":"evil.example.com"', /CLOUDFRONT_DOMAIN value/u],
  ["maintenance S3 bucket", "MOCK_MAINTENANCE_ENV", '"name":"S3_BUCKET","value":"beaver-data-123456789012"', '"name":"S3_BUCKET","value":"other"', /S3_BUCKET value/u],
  ["maintenance region", "MOCK_MAINTENANCE_ENV", '"name":"AWS_REGION","value":"us-east-1"', '"name":"AWS_REGION","value":"us-west-2"', /AWS_REGION value/u],
  ["maintenance CloudFront domain", "MOCK_MAINTENANCE_ENV", '"name":"CLOUDFRONT_DOMAIN","value":"assets.example.com"', '"name":"CLOUDFRONT_DOMAIN","value":"evil.example.com"', /CLOUDFRONT_DOMAIN value/u],
  ["maintenance CloudFront distribution", "MOCK_MAINTENANCE_ENV", '"name":"CLOUDFRONT_DISTRIBUTION_ID","value":"E1234567890123"', '"name":"CLOUDFRONT_DISTRIBUTION_ID","value":"E9999999999999"', /CLOUDFRONT_DISTRIBUTION_ID value/u],
  ["maintenance queue", "MOCK_MAINTENANCE_ENV", '"name":"PROJECT_ASSET_EVENT_QUEUE_URL","value":"https://sqs.us-east-1.amazonaws.com/123456789012/beaver-project-asset-events"', '"name":"PROJECT_ASSET_EVENT_QUEUE_URL","value":"https://sqs.us-east-1.amazonaws.com/123456789012/evil"', /PROJECT_ASSET_EVENT_QUEUE_URL value/u],
];

test("activate fail-closes exact security-sensitive task environment values", async () => {
  for (const [name, prefix, from, to, error] of exactEnvironmentMutations) {
    const result = await activate({
      [`${prefix}_FROM`]: from,
      [`${prefix}_TO`]: to,
    });
    assert.notEqual(result.status, 0, `${name} mutation unexpectedly passed`);
    assert.match(result.stderr, error, `${name} mutation failed for the wrong reason`);
    assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
  }
});
