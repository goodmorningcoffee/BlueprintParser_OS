import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { after, before, test } from "node:test";

const DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE = `123456789012.dkr.ecr.us-east-1.amazonaws.com/beaver-app@${DIGEST}`;
const BASELINE_DIGEST = `sha256:${"c".repeat(64)}`;
const BASELINE_IMAGE = `123456789012.dkr.ecr.us-east-1.amazonaws.com/beaver-app@${BASELINE_DIGEST}`;
const SECRET_VERSION = "1".repeat(32);
const SECRET_ARN =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:beaver/DATABASE_URL-AbCd12";
const SECRET_SELECTOR = `${SECRET_ARN}:::${SECRET_VERSION}`;
const OUTAGE_EPOCH = "1".repeat(64);
const LIVE_EPOCH = "2".repeat(64);
const SCHEDULE_GENERATION = "2020-01-01T00:00:00.000Z";
const READINESS_TASK_ARN = `arn:aws:ecs:us-east-1:123456789012:task/beaver-cluster/${"1".repeat(32)}`;
const MIGRATOR_TASK_ARN = `arn:aws:ecs:us-east-1:123456789012:task/beaver-cluster/${"2".repeat(32)}`;
const LEGACY_MIGRATOR_TASK_ARN =
  "arn:aws:ecs:us-east-1:123456789012:task/33333333-3333-3333-3333-333333333333";
let fixtureDir;
let awsPath;
let logPath;
let bashEnvPath;
let witnessCounter = 0;

const mockAws = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${MOCK_AWS_LOG}"
service="\${1:-}"
action="\${2:-}"
default_database_secret='${SECRET_SELECTOR}'
default_label_studio_url='https://labelstudio.example.com'
default_label_studio_instance='fs-0123456789abcdef0:generation-1'
default_label_studio_secret='arn:aws:secretsmanager:us-east-1:123456789012:secret:beaver/LABEL_STUDIO_API_KEY-AbCd12'
readiness_task_arn='${READINESS_TASK_ARN}'
migrator_task_arn='${MIGRATOR_TASK_ARN}'
legacy_migrator_task_arn='${LEGACY_MIGRATOR_TASK_ARN}'
shift 2 || true
query=""
task_definition=""
service_name=""
family_prefix=""
family=""
desired_status=""
overrides=""
client_token=""
tasks=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --query) query="\${2:-}"; shift 2 ;;
    --task-definition) task_definition="\${2:-}"; shift 2 ;;
    --service-name) service_name="\${2:-}"; shift 2 ;;
    --family-prefix) family_prefix="\${2:-}"; shift 2 ;;
    --family) family="\${2:-}"; shift 2 ;;
    --desired-status) desired_status="\${2:-}"; shift 2 ;;
    --overrides) overrides="\${2:-}"; shift 2 ;;
    --client-token) client_token="\${2:-}"; shift 2 ;;
    --cluster|--region|--output|--group-name|--name|--state-machine-arn|--status-filter|--service-namespace|--resource-ids|--resource-arn|--services|--service|--launch-type|--platform-version|--network-configuration|--page-size|--desired-count|--status|--sort|--started-by|--secret-id|--version-id|--version-stage|--db-instance-identifier|--role-name)
      [ "$#" -ge 2 ] || { echo "missing value for $1" >&2; exit 96; }
      shift 2
      ;;
    --tasks)
      shift
      while [ "$#" -gt 0 ] && [[ "$1" != --* ]]; do tasks+=("$1"); shift; done
      ;;
    --force-new-deployment) shift ;;
    tasks-stopped|services-stable) shift ;;
    *) echo "unsupported mock AWS option: $1" >&2; exit 96 ;;
  esac
done

case "\${service} \${action}" in
  "sts get-caller-identity") echo "\${MOCK_CALLER_ACCOUNT:-123456789012}" ;;
  "secretsmanager describe-secret") printf '{"ARN":"${SECRET_ARN}","Name":"beaver/DATABASE_URL","VersionIdsToStages":{"${SECRET_VERSION}":["%s"]}}\n' "\${MOCK_SECRET_STAGE:-AWSCURRENT}" ;;
  "secretsmanager get-secret-value") echo "\${MOCK_DATABASE_URL:-postgresql://beaver_admin:p%40ssword@beaver-db.abc123.us-east-1.rds.amazonaws.com:5432/beaver}" ;;
  "rds describe-db-instances") printf '{"DBInstances":[{"DBInstanceIdentifier":"beaver-db","DBInstanceArn":"arn:aws:rds:us-east-1:%s:db:beaver-db","Engine":"postgres","DBInstanceStatus":"available","DBName":"beaver","MasterUsername":"beaver_admin","PubliclyAccessible":false,"Endpoint":{"Address":"beaver-db.abc123.us-east-1.rds.amazonaws.com","Port":5432}}]}\n' "\${MOCK_RDS_ACCOUNT:-123456789012}" ;;
  "iam list-role-policies") echo "\${MOCK_MIGRATOR_INLINE_POLICIES:-[]}" ;;
  "iam list-attached-role-policies") echo "\${MOCK_MIGRATOR_ATTACHED_POLICIES:-[]}" ;;
  "scheduler get-schedule")
    case "\${query}" in
      State) echo "\${MOCK_SCHEDULE_STATE:-DISABLED}" ;;
      Target.EcsParameters.TaskDefinitionArn) echo "arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-project-asset-deletions:\${MOCK_MAINTENANCE_REVISION:-\${MOCK_LATEST_REVISION:-42}}" ;;
      Target.Arn) echo "\${MOCK_SCHEDULE_CLUSTER:-arn:aws:ecs:us-east-1:123456789012:cluster/beaver-cluster}" ;;
      Target.RetryPolicy.MaximumEventAgeInSeconds) echo "\${MOCK_MAX_EVENT_AGE:-600}" ;;
      Target.RetryPolicy.MaximumRetryAttempts) echo "\${MOCK_MAX_RETRY_ATTEMPTS:-2}" ;;
      Target.Input) echo "\${MOCK_SCHEDULE_INPUT:-None}" ;;
      Target.EcsParameters.LaunchType) echo "\${MOCK_SCHEDULE_LAUNCH_TYPE:-FARGATE}" ;;
      Target.EcsParameters.PlatformVersion) echo "\${MOCK_SCHEDULE_PLATFORM_VERSION:-1.4.0}" ;;
      Target.EcsParameters.TaskCount) echo "\${MOCK_SCHEDULE_TASK_COUNT:-1}" ;;
      Target.RoleArn) echo "arn:aws:iam::123456789012:role/beaver-project-asset-deletion-scheduler-role" ;;
      Target.DeadLetterConfig.Arn) echo "arn:aws:sqs:us-east-1:123456789012:beaver-project-asset-deletion-scheduler-dlq" ;;
      FlexibleTimeWindow.Mode) echo "\${MOCK_FLEXIBLE_MODE:-OFF}" ;;
      ScheduleExpression) echo "rate(5 minutes)" ;;
      LastModificationDate) echo "\${MOCK_LAST_MODIFIED:-2020-01-01T00:00:00Z}" ;;
      *) echo "unexpected scheduler query: \${query}" >&2; exit 97 ;;
    esac
    ;;
  "ecs describe-services")
    case "\${query}" in
      *serviceArn*) echo "\${MOCK_SERVICE_ARN:-arn:aws:ecs:us-east-1:123456789012:service/beaver-cluster/beaver-app}" ;;
      *desiredCount*) echo "\${MOCK_DESIRED_COUNT:-0}" ;;
      *runningCount*) echo "\${MOCK_RUNNING_COUNT:-0}" ;;
      *pendingCount*) echo "\${MOCK_PENDING_COUNT:-0}" ;;
      *platformVersion*)
        if grep -q '^ecs update-service ' "\${MOCK_AWS_LOG}" && [ -n "\${MOCK_SERVICE_PLATFORM_VERSION_AFTER_UPDATE:-}" ]; then
          echo "\${MOCK_SERVICE_PLATFORM_VERSION_AFTER_UPDATE}"
        else
          echo "\${MOCK_SERVICE_PLATFORM_VERSION:-1.4.0}"
        fi
        ;;
      *networkConfiguration*) echo '{"awsvpcConfiguration":{"subnets":["subnet-test"],"securityGroups":["sg-test"],"assignPublicIp":"DISABLED"}}' ;;
      *taskDefinition*)
        if grep -q '^ecs update-service ' "\${MOCK_AWS_LOG}"; then
          echo "arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-app:\${MOCK_UPDATED_SERVICE_REVISION:-\${MOCK_LATEST_REVISION:-42}}"
        else
          echo "arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-app:\${MOCK_SERVICE_REVISION:-42}"
        fi
        ;;
      *rolloutState*) echo "\${MOCK_ROLLOUT_STATE:-COMPLETED}" ;;
      *deployments*) echo "\${MOCK_DEPLOYMENT_COUNT:-1}" ;;
      *) echo "None" ;;
    esac
    ;;
  "ecs list-tags-for-resource") printf '[{"key":"Project","value":"beaver"},{"key":"BlueprintParserWriterMode","value":"%s"},{"key":"BlueprintParserWriterModeEpoch","value":"%s"}]\n' "\${MOCK_WRITER_MODE:-outage}" "\${MOCK_WRITER_MODE_EPOCH:-${OUTAGE_EPOCH}}" ;;
  "application-autoscaling describe-scalable-targets")
    case "\${query}" in
      *MinCapacity*) echo "\${MOCK_MIN_CAPACITY:-0}" ;;
      *MaxCapacity*) echo "\${MOCK_MAX_CAPACITY:-1}" ;;
      *DynamicScalingInSuspended*) echo "\${MOCK_SCALE_IN_SUSPENDED:-\${MOCK_AUTOSCALING_SUSPENDED:-True}}" ;;
      *DynamicScalingOutSuspended*) echo "\${MOCK_SCALE_OUT_SUSPENDED:-\${MOCK_AUTOSCALING_SUSPENDED:-True}}" ;;
      *ScheduledScalingSuspended*) echo "\${MOCK_SCHEDULED_SCALING_SUSPENDED:-\${MOCK_AUTOSCALING_SUSPENDED:-True}}" ;;
      *) echo "unexpected autoscaling query: \${query}" >&2; exit 97 ;;
    esac
    ;;
  "stepfunctions list-executions") echo "\${MOCK_RUNNING_EXECUTIONS:-0}" ;;
  "stepfunctions describe-state-machine")
    target="\${MOCK_SFN_TASK_DEFINITION:-arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-cpu-pipeline:\${MOCK_LATEST_REVISION:-42}}"
    cluster="\${MOCK_SFN_CLUSTER:-arn:aws:ecs:us-east-1:123456789012:cluster/beaver-cluster}"
    if [ "\${MOCK_SFN_COMMAND_OVERRIDE:-0}" = "1" ]; then
      command_override=',"Command":["./entrypoint.sh","migrate"]'
    else
      command_override=''
    fi
    if [ "\${MOCK_SFN_ENVIRONMENT_FILES:-0}" = "1" ]; then
      environment_files=',"EnvironmentFiles":[{"Type":"s3","Value":"arn:aws:s3:::evil/env"}]'
    else
      environment_files=''
    fi
    if [ "\${MOCK_SFN_EXECUTE_COMMAND:-0}" = "1" ]; then
      execute_command=',"EnableExecuteCommand":true'
    else
      execute_command=''
    fi
    if [ "\${MOCK_SFN_ROLE_OVERRIDE:-0}" = "1" ]; then
      role_override='"TaskRoleArn":"arn:aws:iam::123456789012:role/evil",'
    else
      role_override=''
    fi
    if [ "\${MOCK_SFN_EXTRA_STATE:-0}" = "1" ]; then
      extra_state=',"Unexpected":{"Type":"Task","Resource":"arn:aws:states:::ecs:runTask.sync","End":true}'
    else
      extra_state=''
    fi
    printf '{"Comment":"Beaver blueprint processing pipeline","StartAt":"ValidateInput","States":{"ValidateInput":{"Type":"Pass","Parameters":{"projectId.$":"$.projectId","dataUrl.$":"$.dataUrl","s3Bucket.$":"$.s3Bucket","webhookUrl.$":"$.webhookUrl","webhookSecret.$":"$.webhookSecret","status":"PROCESSING"},"Next":"CPUProcessing"},"CPUProcessing":{"Type":"Task","Resource":"arn:aws:states:::ecs:runTask.sync","Parameters":{"LaunchType":"FARGATE","TaskDefinition":"%s","Cluster":"%s","PlatformVersion":"%s","NetworkConfiguration":{"AwsvpcConfiguration":{"Subnets":["subnet-test"],"SecurityGroups":["sg-test"],"AssignPublicIp":"DISABLED"}}%s,"Overrides":{%s"ContainerOverrides":[{"Name":"beaver-cpu-pipeline"%s%s,"Environment":[{"Name":"PROJECT_ID","Value.$":"States.Format('"'"'{}'"'"', $.projectId)"},{"Name":"DATA_URL","Value.$":"$.dataUrl"},{"Name":"S3_BUCKET","Value.$":"$.s3Bucket"},{"Name":"WEBHOOK_URL","Value.$":"$.webhookUrl"},{"Name":"WEBHOOK_SECRET","Value.$":"$.webhookSecret"}]}]}},"ResultPath":"$.cpuResult","Retry":[{"ErrorEquals":["States.TaskFailed"],"IntervalSeconds":30,"MaxAttempts":2,"BackoffRate":2}],"Catch":[{"ErrorEquals":["States.ALL"],"Next":"ProcessingFailed","ResultPath":"$.error"}],"Next":"ProcessingComplete"},"ProcessingComplete":{"Type":"Succeed"},"ProcessingFailed":{"Type":"Fail","Error":"ProcessingFailed","Cause":"Blueprint processing pipeline failed. Check CloudWatch logs for details."}%s}}\\n' "\${target}" "\${cluster}" "\${MOCK_SFN_PLATFORM_VERSION:-1.4.0}" "\${execute_command}" "\${role_override}" "\${command_override}" "\${environment_files}" "\${extra_state}"
    ;;
  "ecs list-tasks")
    if [ -n "\${service_name}" ]; then
      echo "\${MOCK_SERVICE_TASK_ARNS:-None}"
    elif [ "\${desired_status}" = "STOPPED" ] && [ "\${family}" = "\${MOCK_STOPPED_TASK_FAMILY:-}" ]; then
      count="\${MOCK_STOPPED_TASK_COUNT:-0}"
      if [ "\${count}" -eq 0 ]; then
        echo "None"
      else
        for ((i=1; i<=count; i++)); do printf 'arn:aws:ecs:us-east-1:123456789012:task/beaver-cluster/stopped-%s ' "\${i}"; done
        echo
      fi
    elif [ "\${desired_status}" = "RUNNING" ] && [ "\${family}" = "\${MOCK_RUNNING_TASK_FAMILY:-}" ]; then
      echo "arn:aws:ecs:us-east-1:123456789012:task/beaver-cluster/live-test"
    else
      echo "None"
    fi
    ;;
  "ecs describe-task-definition")
    if [ "\${query}" = "taskDefinition" ]; then
      family="\${task_definition##*/}"
      family="\${family%%:*}"
      case "\${family}" in
        beaver-app)
          name="beaver-app"; command='[]'; task_role="beaver-ecs-task-role"
          environment='[{"name":"NODE_ENV","value":"production"},{"name":"PORT","value":"3000"},{"name":"S3_BUCKET","value":"beaver-data-123456789012"},{"name":"AWS_REGION","value":"us-east-1"},{"name":"CLOUDFRONT_DOMAIN","value":"assets.example.com"},{"name":"CLOUDFRONT_DISTRIBUTION_ID","value":"E1234567890123"},{"name":"NEXTAUTH_URL","value":"https://app.example.com"},{"name":"STEP_FUNCTION_ARN","value":"arn:aws:states:us-east-1:123456789012:stateMachine:beaver-process-blueprint"},{"name":"LABEL_STUDIO_URL","value":"https://labelstudio.example.com"},{"name":"LABEL_STUDIO_INSTANCE_ID","value":"fs-0123456789abcdef0:generation-1"},{"name":"AWS_ACCOUNT","value":"123456789012"},{"name":"ROOT_ADMIN_EMAIL","value":""},{"name":"YOLO_ECR_IMAGE","value":"123456789012.dkr.ecr.us-east-1.amazonaws.com/beaver-yolo-pipeline@sha256:${"b".repeat(64)}"},{"name":"SAGEMAKER_ROLE_ARN","value":"arn:aws:iam::123456789012:role/beaver-sagemaker-role"},{"name":"LAMBDA_CV_ENABLED","value":"true"},{"name":"LAMBDA_CV_FUNCTION_NAME","value":"beaver-cv-pipeline"}]'
          secrets='[{"name":"DATABASE_URL","valueFrom":"${SECRET_SELECTOR}"},{"name":"NEXTAUTH_SECRET","valueFrom":"arn:aws:secretsmanager:us-east-1:123456789012:secret:beaver/NEXTAUTH_SECRET-AbCd12"},{"name":"PROCESSING_WEBHOOK_SECRET","valueFrom":"arn:aws:secretsmanager:us-east-1:123456789012:secret:beaver/PROCESSING_WEBHOOK_SECRET-AbCd12"},{"name":"ANTHROPIC_API_KEY","valueFrom":"arn:aws:secretsmanager:us-east-1:123456789012:secret:beaver/ANTHROPIC_API_KEY-AbCd12"},{"name":"GROQ_API_KEY","valueFrom":"arn:aws:secretsmanager:us-east-1:123456789012:secret:beaver/GROQ_API_KEY-AbCd12"},{"name":"LABEL_STUDIO_API_KEY","valueFrom":"arn:aws:secretsmanager:us-east-1:123456789012:secret:beaver/LABEL_STUDIO_API_KEY-AbCd12"}]'
          log_group='/ecs/blueprintparser-app'; log_prefix='beaver'
          health=',"healthCheck":{"command":["CMD-SHELL","curl -f http://localhost:3000/api/health || exit 1"],"interval":30,"timeout":5,"retries":3,"startPeriod":60}' ;;
        beaver-cpu-pipeline)
          name="beaver-cpu-pipeline"; command='["./entrypoint.sh","worker","node","scripts/process-worker.js"]'; task_role="beaver-ecs-task-role"
          environment='[{"name":"NODE_ENV","value":"production"},{"name":"AWS_REGION","value":"us-east-1"},{"name":"S3_BUCKET","value":"beaver-data-123456789012"},{"name":"CLOUDFRONT_DOMAIN","value":"assets.example.com"}]'
          secrets='[{"name":"DATABASE_URL","valueFrom":"${SECRET_SELECTOR}"}]'; health=''; log_group='/ecs/blueprintparser-cpu-pipeline'; log_prefix='cpu-pipeline' ;;
        beaver-project-asset-deletions)
          name="beaver-project-asset-deletions"; command='["./entrypoint.sh","worker","node","scripts/project-asset-deletion-worker.js"]'; task_role="beaver-project-asset-deletion-task-role"
          environment='[{"name":"NODE_ENV","value":"production"},{"name":"AWS_REGION","value":"us-east-1"},{"name":"S3_BUCKET","value":"beaver-data-123456789012"},{"name":"CLOUDFRONT_DOMAIN","value":"assets.example.com"},{"name":"CLOUDFRONT_DISTRIBUTION_ID","value":"E1234567890123"},{"name":"LABEL_STUDIO_URL","value":"https://labelstudio.example.com"},{"name":"LABEL_STUDIO_INSTANCE_ID","value":"fs-0123456789abcdef0:generation-1"},{"name":"PROJECT_ASSET_EVENT_QUEUE_URL","value":"https://sqs.us-east-1.amazonaws.com/123456789012/beaver-project-asset-events"}]'
          secrets='[{"name":"DATABASE_URL","valueFrom":"${SECRET_SELECTOR}"},{"name":"LABEL_STUDIO_API_KEY","valueFrom":"arn:aws:secretsmanager:us-east-1:123456789012:secret:beaver/LABEL_STUDIO_API_KEY-AbCd12"}]'; health=''; log_group='/ecs/blueprintparser-project-asset-deletions'; log_prefix='project-asset-deletions' ;;
        beaver-schema-migrator)
          name="beaver-schema-migrator"; command='["./entrypoint.sh","migrate"]'; task_role="beaver-schema-migrator-task-role"; health=''
          environment='[{"name":"NODE_ENV","value":"production"}]'; secrets='[{"name":"DATABASE_URL","valueFrom":"${SECRET_SELECTOR}"}]'; log_group='/ecs/blueprintparser-schema-migrator'; log_prefix='schema-migrator'
          if [ "\${MOCK_ARMED_MIGRATOR:-0}" = "1" ]; then
            environment='[{"name":"NODE_ENV","value":"production"},{"name":"BP_SCHEMA_MIGRATION_MODE","value":"p2-0037-singleton-quiescent"}]'
          fi
          ;;
        *) echo "unknown task family \${family}" >&2; exit 97 ;;
      esac
      if [ "\${MOCK_TASK_ENTRYPOINT:-0}" = "1" ]; then
        entrypoint=',"entryPoint":["/bin/sh","-c"]'
      else
        entrypoint=''
      fi
      if [ -n "\${MOCK_DATABASE_SECRET:-}" ]; then
        secrets="\${secrets//"\${default_database_secret}"/"\${MOCK_DATABASE_SECRET}"}"
      fi
      if [ "\${MOCK_NODE_OPTIONS:-0}" = "1" ]; then
        environment="\${environment%]}"',{"name":"NODE_OPTIONS","value":"--import=evil"}]'
      fi
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
      printf '{"family":"%s","networkMode":"awsvpc","requiresCompatibilities":["FARGATE"],"executionRoleArn":"arn:aws:iam::123456789012:role/beaver-ecs-execution-role","taskRoleArn":"arn:aws:iam::123456789012:role/%s","runtimePlatform":{"cpuArchitecture":"X86_64","operatingSystemFamily":"LINUX"},"volumes":[],"containerDefinitions":[{"name":"%s","essential":true,"command":%s%s,"environment":%s,"secrets":%s,"mountPoints":[],"volumesFrom":[],"logConfiguration":{"logDriver":"awslogs","options":{"awslogs-group":"%s","awslogs-region":"us-east-1","awslogs-stream-prefix":"%s"}}%s}]}\\n' "\${name}" "\${task_role}" "\${name}" "\${command}" "\${entrypoint}" "\${environment}" "\${secrets}" "\${log_group}" "\${log_prefix}" "\${health}"
    elif [[ "\${query}" == *environment* ]]; then
      echo "\${MOCK_APP_STEP_FUNCTION_ARN:-arn:aws:states:us-east-1:123456789012:stateMachine:beaver-process-blueprint}"
    elif [[ "\${query}" == *containerDefinitions* ]]; then
      if [ "\${MOCK_MUTABLE_IMAGE:-0}" = "1" ]; then
        echo "123456789012.dkr.ecr.us-east-1.amazonaws.com/beaver-app:latest"
      else
        service_task_definition="arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-app:\${MOCK_SERVICE_REVISION:-42}"
        if [ "\${task_definition}" = "\${service_task_definition}" ] && [ -n "\${MOCK_SERVICE_BOUND_IMAGE:-}" ]; then
          echo "\${MOCK_SERVICE_BOUND_IMAGE}"
        else
          echo "\${MOCK_LATEST_IMAGE:-${IMAGE}}"
        fi
      fi
    else
      family="\${task_definition##*/}"
      family="\${family%%:*}"
      echo "arn:aws:ecs:us-east-1:123456789012:task-definition/\${family}:\${MOCK_LATEST_REVISION:-42}"
    fi
    ;;
  "ecs run-task")
    if [[ "\${overrides}" == *schema-readiness* ]]; then
      if [ "\${MOCK_READINESS_RUN_TASK_FAILURE:-0}" = "1" ]; then exit 255; fi
      case "\${MOCK_READINESS_RUN_TASK_RESPONSE_MODE:-full}" in
        full)
          printf '{"tasks":[{"taskArn":"%s","taskDefinitionArn":"%s","clusterArn":"arn:aws:ecs:us-east-1:123456789012:cluster/beaver-cluster"}],"failures":[]}\\n' "\${readiness_task_arn}" "\${task_definition}"
          ;;
        sparse)
          printf '{"tasks":[{"taskArn":"%s","lastStatus":"STOPPED","desiredStatus":"STOPPED"}],"failures":[]}\\n' "\${readiness_task_arn}"
          ;;
        *) echo "unsupported readiness RunTask response mode" >&2; exit 97 ;;
      esac
    else
      if [ "\${MOCK_RUN_TASK_FAILURE:-0}" = "1" ]; then exit 255; fi
      task_arn="\${migrator_task_arn}"
      if [ "\${MOCK_MIGRATION_TASK_ARN_STYLE:-long}" = "legacy" ]; then
        task_arn="\${legacy_migrator_task_arn}"
      fi
      case "\${MOCK_MIGRATION_RUN_TASK_RESPONSE_MODE:-full}" in
        full)
          printf '{"tasks":[{"taskArn":"%s","taskDefinitionArn":"%s","clusterArn":"arn:aws:ecs:us-east-1:123456789012:cluster/beaver-cluster"}],"failures":[]}\\n' "\${task_arn}" "\${task_definition}"
          ;;
        sparse)
          printf '{"tasks":[{"taskArn":"%s","lastStatus":"STOPPED","desiredStatus":"STOPPED"}],"failures":[]}\\n' "\${task_arn}"
          ;;
        sparse-running)
          printf '{"tasks":[{"taskArn":"%s","lastStatus":"RUNNING","desiredStatus":"STOPPED"}],"failures":[]}\\n' "\${task_arn}"
          ;;
        half-sparse)
          printf '{"tasks":[{"taskArn":"%s","taskDefinitionArn":"%s","lastStatus":"STOPPED","desiredStatus":"STOPPED"}],"failures":[]}\\n' "\${task_arn}" "\${task_definition}"
          ;;
        null-identities)
          printf '{"tasks":[{"taskArn":"%s","taskDefinitionArn":null,"clusterArn":null,"lastStatus":"STOPPED","desiredStatus":"STOPPED"}],"failures":[]}\\n' "\${task_arn}"
          ;;
        wrong-task-definition)
          printf '{"tasks":[{"taskArn":"%s","taskDefinitionArn":"arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-schema-migrator:41","clusterArn":"arn:aws:ecs:us-east-1:123456789012:cluster/beaver-cluster"}],"failures":[]}\\n' "\${task_arn}"
          ;;
        malformed-task-arn)
          printf '{"tasks":[{"taskArn":"arn:aws:ecs:us-east-1:123456789012:task/beaver-cluster/not-a-task-id","taskDefinitionArn":"%s","clusterArn":"arn:aws:ecs:us-east-1:123456789012:cluster/beaver-cluster"}],"failures":[]}\\n' "\${task_definition}"
          ;;
        *) echo "unsupported migration RunTask response mode" >&2; exit 97 ;;
      esac
    fi
    ;;
  "ecs list-task-definitions")
    current="arn:aws:ecs:us-east-1:123456789012:task-definition/\${family_prefix}:\${MOCK_LATEST_REVISION:-42}"
    old="arn:aws:ecs:us-east-1:123456789012:task-definition/\${family_prefix}:41"
    list_count=$(grep -Fc "ecs list-task-definitions --family-prefix \${family_prefix}" "\${MOCK_AWS_LOG}")
    if [ "\${MOCK_OLD_TASK_DEFINITIONS:-0}" = "1" ] && { ! grep -Fq "ecs deregister-task-definition --task-definition \${old}" "\${MOCK_AWS_LOG}" || { [ "\${MOCK_DEREGISTRATION_LAG:-0}" = "1" ] && [ "\${list_count}" -le 2 ]; }; }; then
      printf '%s\\t%s\\n' "\${current}" "\${old}"
    else
      echo "\${current}"
    fi
    if [ "\${MOCK_SIBLING_TASK_DEFINITION:-0}" = "1" ]; then
      echo "arn:aws:ecs:us-east-1:123456789012:task-definition/\${family_prefix}-sibling:99"
    fi
    ;;
  "ecs deregister-task-definition")
    if [ "\${MOCK_DEREGISTER_FAILURE:-0}" = "1" ]; then
      echo "mock deregistration failure" >&2
      exit 98
    fi
    echo "\${task_definition}"
    ;;
  "ecs wait")
    if [ "\${MOCK_WAITER_FAILURE:-0}" = "1" ] &&
       { [[ "\${tasks[*]}" == *"\${migrator_task_arn}"* ]] ||
         [[ "\${tasks[*]}" == *"\${legacy_migrator_task_arn}"* ]]; }; then
      exit 255
    fi
    ;;
  "ecs describe-tasks")
    if [ -z "\${query}" ]; then
      printf '{"tasks":['
      emitted=0
      limit="\${#tasks[@]}"
      if [ "\${MOCK_DESCRIBE_PARTIAL:-0}" = "1" ] && [ "\${limit}" -gt 0 ]; then limit=$((limit - 1)); fi
      for ((i=0; i<limit; i++)); do
        arn="\${tasks[i]}"
        [ "\${emitted}" -eq 0 ] || printf ','
        status="RUNNING"
        task_def="\${MOCK_RUNNING_TASK_DEFINITION:-arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-app:42}"
        cluster_arn='arn:aws:ecs:us-east-1:123456789012:cluster/beaver-cluster'
        containers=''
        if [[ "\${arn}" == *'/stopped-'* ]]; then status="STOPPED"; fi
        if [ "\${arn}" = "\${readiness_task_arn}" ]; then
          status="STOPPED"
          task_def='arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-schema-migrator:42'
          containers=',"containers":[{"name":"beaver-schema-migrator","lastStatus":"STOPPED","exitCode":'"\${MOCK_READINESS_EXIT_CODE:-0}"'}]'
        elif [ "\${arn}" = "\${migrator_task_arn}" ] ||
             [ "\${arn}" = "\${legacy_migrator_task_arn}" ]; then
          status="STOPPED"
          task_def="\${MOCK_TERMINAL_TASK_DEFINITION:-arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-schema-migrator:42}"
          cluster_arn="\${MOCK_TERMINAL_CLUSTER_ARN:-arn:aws:ecs:us-east-1:123456789012:cluster/beaver-cluster}"
          containers=',"containers":[{"name":"beaver-schema-migrator","lastStatus":"STOPPED","exitCode":0}]'
        fi
        printf '{"taskArn":"%s","clusterArn":"%s","lastStatus":"%s","taskDefinitionArn":"%s"%s}' "\${arn}" "\${cluster_arn}" "\${status}" "\${task_def}" "\${containers}"
        emitted=$((emitted + 1))
      done
      if [ "\${MOCK_DESCRIBE_FAILURE:-0}" = "1" ]; then
        printf '],"failures":[{"arn":"failed-task","reason":"MISSING"}]}\\n'
      else
        printf '],"failures":[]}\\n'
      fi
    elif [[ "\${query}" == *taskDefinitionArn* ]]; then
      echo "\${MOCK_RUNNING_TASK_DEFINITION:-arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-app:42}"
    else
      echo "test stopped"
    fi
    ;;
  "ecs update-service")
    if [ "\${MOCK_UPDATE_SERVICE_FAILURE_AFTER_MUTATION:-0}" = "1" ]; then
      echo "mock ambiguous UpdateService response after remote mutation" >&2
      exit 255
    fi
    echo "beaver-app"
    ;;
  *) echo "unexpected mock AWS call: \${service} \${action}" >&2; exit 97 ;;
esac
`;

const mockBashEnv = `sleep() {
printf 'sleep %s\\n' "$*" >> "\${MOCK_AWS_LOG}"
}
`;

const unexpectedExternalSleep = `#!/usr/bin/env bash
set -euo pipefail
echo "test harness unexpectedly resolved an external sleep command" >&2
exit 99
`;

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "bp-cutover-aws-"));
  awsPath = path.join(fixtureDir, "aws");
  logPath = path.join(fixtureDir, "aws.log");
  await writeFile(awsPath, mockAws);
  await chmod(awsPath, 0o755);
  bashEnvPath = path.join(fixtureDir, "bash-env");
  await writeFile(bashEnvPath, mockBashEnv);
  const sleepPath = path.join(fixtureDir, "sleep");
  await writeFile(sleepPath, unexpectedExternalSleep);
  await chmod(sleepPath, 0o755);
});

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

async function runCutover(mode, extraEnv = {}, options = {}) {
  await writeFile(logPath, "");
  const translatedPreflight = mode === "preflight" && options.raw !== true;
  const scriptMode = translatedPreflight ? "preflight-outage" : mode;
  const result = spawnSync(
    "bash",
    ["scripts/p2-schema-cutover.sh", scriptMode],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixtureDir}:${process.env.PATH}`,
        BASH_ENV: bashEnvPath,
        MOCK_AWS_LOG: logPath,
        BP_DEPLOY_ENV_FILE: path.join(fixtureDir, "does-not-exist"),
        BP_WRITER_OUTAGE_WITNESS_FILE: path.join(
          fixtureDir,
          `implicit-witness-${witnessCounter++}.json`,
        ),
        AWS_ACCOUNT: "123456789012",
        AWS_REGION: "us-east-1",
        ECR_REPO: "beaver-app",
        ECS_CLUSTER: "beaver-cluster",
        ECS_SERVICE: "beaver-app",
        DOMAIN: "example.com",
        CLOUDFRONT_DISTRIBUTION_ID: "E1234567890123",
        ROOT_ADMIN_EMAIL: "",
        STEP_FUNCTION_ARN:
          "arn:aws:states:us-east-1:123456789012:stateMachine:beaver-process-blueprint",
        BP_APP_IMAGE_DIGEST: DIGEST,
        BP_CANDIDATE_IMAGE_DIGEST: DIGEST,
        ...(translatedPreflight
          ? {
              BP_APP_IMAGE_DIGEST: BASELINE_DIGEST,
              MOCK_LATEST_IMAGE: BASELINE_IMAGE,
              MOCK_LATEST_REVISION: "41",
              MOCK_SERVICE_REVISION: "41",
            }
          : {}),
        ...extraEnv,
      },
    },
  );
  return { ...result, log: await readFile(logPath, "utf8") };
}

async function writeCohortWitness(
  witnessPath,
  phase = "outage-preflight",
  overrides = {},
) {
  const bound = phase === "quiescent-bound";
  const admitted = phase === "candidate-admitted";
  const bootstrap = phase === "empty-bootstrap-armed";
  const now = Math.floor(Date.now() / 1000);
  await writeFile(
    witnessPath,
    `${JSON.stringify({
      version: 2,
      phase,
      account: "123456789012",
      region: "us-east-1",
      cluster: "beaver-cluster",
      service: "beaver-app",
      ecrRepo: "beaver-app",
      baselineDigest: bootstrap ? DIGEST : BASELINE_DIGEST,
      baselineTaskDefinition: bootstrap
        ? "arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-app:42"
        : "arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-app:41",
      baselineCpuTaskDefinition: `arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-cpu-pipeline:${bootstrap ? "42" : "41"}`,
      baselineMaintenanceTaskDefinition: `arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-project-asset-deletions:${bootstrap ? "42" : "41"}`,
      baselineMigratorTaskDefinition: `arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-schema-migrator:${bootstrap ? "42" : "41"}`,
      candidateDigest: DIGEST,
      candidateTaskDefinition:
        bound || admitted || bootstrap
          ? "arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-app:42"
          : null,
      candidateCpuTaskDefinition:
        bound || admitted || bootstrap
          ? "arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-cpu-pipeline:42"
          : null,
      candidateMaintenanceTaskDefinition:
        bound || admitted || bootstrap
          ? "arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-project-asset-deletions:42"
          : null,
      candidateMigratorTaskDefinition:
        bound || admitted || bootstrap
          ? "arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-schema-migrator:42"
          : null,
      databaseSecret: SECRET_SELECTOR,
      outageEpoch: OUTAGE_EPOCH,
      scheduleGeneration: SCHEDULE_GENERATION,
      issuedAtEpoch: now,
      expiresAtEpoch: bound ? null : now + 21_600,
      nonce: "9".repeat(64),
      ...overrides,
    })}\n`,
    { mode: 0o600 },
  );
  await chmod(witnessPath, 0o600);
}

async function runBoundary(extraEnv = {}) {
  const witnessPath = path.join(
    fixtureDir,
    `boundary-witness-${witnessCounter++}.json`,
  );
  await writeCohortWitness(witnessPath);
  return runCutover("run", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_SERVICE_REVISION: "41",
    MOCK_SERVICE_BOUND_IMAGE: BASELINE_IMAGE,
    ...extraEnv,
  });
}

async function runRestored(extraEnv = {}) {
  const witnessPath = path.join(
    fixtureDir,
    `restored-witness-${witnessCounter++}.json`,
  );
  await writeCohortWitness(witnessPath, "quiescent-bound");
  return runCutover("verify-restored", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_WRITER_MODE: "live",
    MOCK_WRITER_MODE_EPOCH: LIVE_EPOCH,
    ...extraEnv,
  });
}

async function withHeldWitnessLock(witnessPath, callback) {
  const lockPath = `${witnessPath}.lock`;
  await writeFile(lockPath, "", { mode: 0o600 });
  await chmod(lockPath, 0o600);
  const holder = spawn(
    "flock",
    [
      "-F",
      lockPath,
      process.execPath,
      "-e",
      'process.stdout.write("locked\\n"); setInterval(() => {}, 1000)',
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise((resolve, reject) => {
    holder.once("error", reject);
    holder.stdout.once("data", resolve);
  });
  try {
    await callback();
  } finally {
    holder.kill("SIGTERM");
    await new Promise((resolve) => holder.once("close", resolve));
  }
}

test("authoritative outage preflight accepts a fully quiescent, digest-pinned writer set", async () => {
  const result = await runCutover("preflight");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /outage preflight passed/u);
  assert.doesNotMatch(result.log, /ecs run-task/u);
  assert.doesNotMatch(result.log, /ecs update-service/u);
});

test("deploy env file cannot overwrite caller-supplied baseline or candidate digests", async () => {
  const deployEnv = path.join(fixtureDir, "digest-precedence.env");
  const witnessPath = path.join(fixtureDir, "digest-precedence-witness.json");
  await writeFile(
    deployEnv,
    `BP_APP_IMAGE_DIGEST=sha256:${"d".repeat(64)}\nBP_CANDIDATE_IMAGE_DIGEST=sha256:${"e".repeat(64)}\n`,
  );
  const result = await runCutover("preflight-outage", {
    BP_DEPLOY_ENV_FILE: deployEnv,
    BP_APP_IMAGE_DIGEST: BASELINE_DIGEST,
    BP_CANDIDATE_IMAGE_DIGEST: DIGEST,
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_LATEST_IMAGE: BASELINE_IMAGE,
    MOCK_LATEST_REVISION: "41",
    MOCK_SERVICE_REVISION: "41",
  });
  assert.equal(result.status, 0, result.stderr);
  const witness = JSON.parse(await readFile(witnessPath, "utf8"));
  assert.equal(witness.baselineDigest, BASELINE_DIGEST);
  assert.equal(witness.candidateDigest, DIGEST);
});

test("generic public preflight mode is removed", async () => {
  const result = await runCutover("preflight", {}, { raw: true });
  assert.equal(result.status, 64);
  assert.doesNotMatch(result.stdout, /preflight passed/u);
  assert.doesNotMatch(result.log, /^(?:ecs|scheduler|stepfunctions) /mu);
});

test("one-off task helper rejects an unsafe explicit client token before network discovery", () => {
  const result = spawnSync(
    "bash",
    [
      "-c",
      'source scripts/lib/ecs-schema-tools.sh; bp_service_network_configuration() { echo network-called >&2; }; bp_run_one_off_task "arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-schema-migrator:42" "" "BAD token"',
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /explicit ECS client token must be/u);
  assert.doesNotMatch(result.stderr, /network-called/u);
});

test("a concurrent operation lock refuses second preflight admission", async () => {
  const witnessPath = path.join(fixtureDir, "concurrent-preflight.json");
  await withHeldWitnessLock(witnessPath, async () => {
    const result = await runCutover("preflight", {
      BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /another writer-witness operation is already in progress/u,
    );
    assert.doesNotMatch(result.log, /^(?:sts|ecs|scheduler|stepfunctions) /mu);
  });
});

test("a concurrent operation lock refuses second restore consumption", async () => {
  const witnessPath = path.join(fixtureDir, "concurrent-restore.json");
  await writeCohortWitness(witnessPath, "quiescent-bound");
  await withHeldWitnessLock(witnessPath, async () => {
    const result = await runCutover("verify-restored", {
      BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /another writer-witness operation is already in progress/u,
    );
    assert.doesNotMatch(result.log, /^(?:sts|ecs|scheduler|stepfunctions) /mu);
  });
  assert.equal(
    JSON.parse(await readFile(witnessPath, "utf8")).phase,
    "quiescent-bound",
  );
});

test("cutover fails closed while the maintenance schedule is enabled", async () => {
  const result = await runBoundary({ MOCK_SCHEDULE_STATE: "ENABLED" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /maintenance schedule state/u);
  assert.doesNotMatch(result.log, /ecs run-task/u);
  assert.doesNotMatch(result.log, /ecs update-service/u);
});

test("cutover rejects a recently disabled schedule before its retry drain window", async () => {
  const result = await runBoundary({
    MOCK_LAST_MODIFIED: "2999-01-01T00:00:00Z",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /require at least 900s/u);
  assert.doesNotMatch(result.log, /^sleep 300$/mu);
  assert.doesNotMatch(result.log, /ecs run-task/u);
});

test("cutover fails closed while target tracking can repopulate the service", async () => {
  const result = await runBoundary({
    MOCK_AUTOSCALING_SUSPENDED: "False",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /scale-in suspension/u);
  assert.doesNotMatch(result.log, /ecs run-task/u);
  assert.doesNotMatch(result.log, /ecs update-service/u);
});

test("cutover rejects an outage whose autoscaling maximum exceeds one", async () => {
  const result = await runCutover("preflight", { MOCK_MAX_CAPACITY: "2" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /autoscaling maximum/u);
  assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
});

for (const [name, variable, error] of [
  ["dynamic scale-out", "MOCK_SCALE_OUT_SUSPENDED", /scale-out suspension/u],
  [
    "scheduled scaling",
    "MOCK_SCHEDULED_SCALING_SUSPENDED",
    /scheduled scaling suspension/u,
  ],
]) {
  test(`cutover rejects an outage with only ${name} left active`, async () => {
    const result = await runCutover("preflight", { [variable]: "False" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
  });
}

test("cutover rejects a mutable latest writer definition", async () => {
  const result = await runCutover("preflight", { MOCK_MUTABLE_IMAGE: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected .*@sha256/u);
  assert.doesNotMatch(result.log, /ecs run-task/u);
});

test("cutover rejects a live Step Functions target on another CPU revision", async () => {
  const result = await runCutover("preflight", {
    MOCK_SFN_TASK_DEFINITION:
      "arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-cpu-pipeline:40",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CPUProcessing targets/u);
  assert.doesNotMatch(result.log, /ecs run-task/u);
});

test("cutover rejects a Step Functions target on another ECS cluster", async () => {
  const result = await runCutover("preflight", {
    MOCK_SFN_CLUSTER:
      "arn:aws:ecs:us-east-1:123456789012:cluster/stale-cluster",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /targets cluster/u);
});

test("cutover rejects a maintenance schedule targeting another cluster", async () => {
  const result = await runCutover("preflight", {
    MOCK_SCHEDULE_CLUSTER:
      "arn:aws:ecs:us-east-1:123456789012:cluster/stale-cluster",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /maintenance schedule cluster/u);
});

test("cutover rejects a maintenance schedule input override", async () => {
  const result = await runCutover("preflight", {
    MOCK_SCHEDULE_INPUT: '{"containerOverrides":[]}',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /maintenance schedule input override/u);
});

test("cutover rejects a maintenance schedule with a non-Fargate launcher", async () => {
  const result = await runCutover("preflight", {
    MOCK_SCHEDULE_LAUNCH_TYPE: "EC2",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /maintenance schedule launch type/u);
});

test("cutover rejects a Step Functions command override", async () => {
  const result = await runCutover("preflight", {
    MOCK_SFN_COMMAND_OVERRIDE: "1",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not resolve CPUProcessing target/u);
});

test("cutover rejects Step Functions environment-file injection", async () => {
  const result = await runCutover("preflight", {
    MOCK_SFN_ENVIRONMENT_FILES: "1",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not resolve CPUProcessing target/u);
  assert.doesNotMatch(result.log, /ecs run-task/u);
});

test("cutover rejects Step Functions task-role overrides", async () => {
  const result = await runCutover("preflight", {
    MOCK_SFN_ROLE_OVERRIDE: "1",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not resolve CPUProcessing target/u);
  assert.doesNotMatch(result.log, /ecs run-task/u);
});

test("cutover rejects Step Functions execute-command enablement", async () => {
  const result = await runCutover("preflight", {
    MOCK_SFN_EXECUTE_COMMAND: "1",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not resolve CPUProcessing target/u);
  assert.doesNotMatch(result.log, /ecs run-task/u);
});

test("cutover rejects an extra state in the live Step Functions graph", async () => {
  const result = await runCutover("preflight", {
    MOCK_SFN_EXTRA_STATE: "1",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not resolve CPUProcessing target/u);
  assert.doesNotMatch(result.log, /ecs run-task/u);
});

test("cutover rejects a migrator task definition armed by default", async () => {
  const result = await runCutover("preflight", { MOCK_ARMED_MIGRATOR: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /migrator task-definition contract/u);
  assert.doesNotMatch(result.log, /ecs run-task/u);
});

test("cutover rejects an ECS entryPoint override despite the exact image", async () => {
  const result = await runCutover("preflight", { MOCK_TASK_ENTRYPOINT: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /task-definition contract/u);
});

test("cutover rejects NODE_OPTIONS injection despite the exact image", async () => {
  const result = await runCutover("preflight", { MOCK_NODE_OPTIONS: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /environment allowlist/u);
  assert.doesNotMatch(result.log, /ecs run-task/u);
});

test("cutover rejects caller substitution of the Step Functions oracle", async () => {
  const result = await runCutover("preflight", {
    STEP_FUNCTION_ARN:
      "arn:aws:states:us-east-1:123456789012:stateMachine:stale-copy",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /caller-supplied Step Functions identity/u);
  assert.match(result.log, /^sts get-caller-identity /u);
  assert.doesNotMatch(result.log, /^(?:ecs|scheduler|stepfunctions) /mu);
});

test("cutover rejects a caller-account substitution", async () => {
  const result = await runCutover("preflight", {
    MOCK_CALLER_ACCOUNT: "999999999999",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AWS caller account identity/u);
});

test("cutover rejects task definitions sharing a non-canonical database secret", async () => {
  const result = await runCutover("preflight", {
    MOCK_DATABASE_SECRET:
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:staging-database",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /app task-definition contract/u);
});

test("cutover rejects Label Studio URL drift between app and maintenance", async () => {
  const result = await runCutover("preflight", {
    MOCK_MAINTENANCE_LS_URL: "https://labelstudio.other.example.com",
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /LABEL_STUDIO_URL value|app\/maintenance Label Studio provider identity/u,
  );
  assert.doesNotMatch(result.log, /ecs run-task/u);
});

test("cutover rejects Label Studio generation drift between app and maintenance", async () => {
  const result = await runCutover("preflight", {
    MOCK_MAINTENANCE_LS_INSTANCE: "fs-0123456789abcdef0:generation-2",
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /app\/maintenance Label Studio provider identity/u,
  );
  assert.doesNotMatch(result.log, /ecs run-task/u);
});

test("cutover rejects Label Studio API secret drift between app and maintenance", async () => {
  const result = await runCutover("preflight", {
    MOCK_MAINTENANCE_LS_SECRET:
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:beaver/LABEL_STUDIO_API_KEY-ZzYy12",
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /app\/maintenance Label Studio provider identity/u,
  );
  assert.doesNotMatch(result.log, /ecs run-task/u);
});

test("cutover rejects a pinned DATABASE_URL version that is not AWSCURRENT", async () => {
  const result = await runCutover("preflight", {
    MOCK_SECRET_STAGE: "AWSPREVIOUS",
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /DATABASE_URL secret metadata validation failed/u,
  );
  assert.doesNotMatch(result.log, /ecs run-task/u);
});

test("cutover rejects DATABASE_URL session/query overrides", async () => {
  const result = await runCutover("preflight", {
    MOCK_DATABASE_URL:
      "postgresql://beaver_admin:p%40ssword@beaver-db.abc123.us-east-1.rds.amazonaws.com:5432/beaver?options=-csearch_path%3Devil",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_URL identity validation failed/u);
  assert.doesNotMatch(result.log, /ecs run-task/u);
});

test("cutover rejects the postgres alias scheme that production TLS will not admit", async () => {
  const result = await runCutover("preflight", {
    MOCK_DATABASE_URL:
      "postgres://beaver_admin:p%40ssword@beaver-db.abc123.us-east-1.rds.amazonaws.com:5432/beaver",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_URL identity validation failed/u);
  assert.doesNotMatch(result.log, /ecs run-task/u);
});

test("cutover rejects a canonical-looking RDS instance from another account", async () => {
  const result = await runCutover("preflight", {
    MOCK_RDS_ACCOUNT: "999999999999",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /beaver-db metadata validation failed/u);
  assert.doesNotMatch(result.log, /ecs run-task/u);
});

test("cutover rejects a Step Functions target without Fargate platform 1.4.0", async () => {
  const result = await runCutover("preflight", {
    MOCK_SFN_PLATFORM_VERSION: "LATEST",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not resolve CPUProcessing target/u);
});

test("cutover rejects a maintenance target without Fargate platform 1.4.0", async () => {
  const result = await runCutover("preflight", {
    MOCK_SCHEDULE_PLATFORM_VERSION: "LATEST",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /maintenance schedule platform version/u);
});

test("cutover proves read-only readiness before binding and later runs one migrator", async () => {
  const result = await runBoundary();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Schema migration completed/u);
  assert.equal((result.log.match(/ecs run-task/g) ?? []).length, 2);
  assert.equal((result.log.match(/ecs update-service/g) ?? []).length, 1);
  const lines = result.log.split("\n");
  const readiness = lines.findIndex(
    (line) =>
      line.includes("ecs run-task") && line.includes("schema-readiness"),
  );
  const binding = lines.findIndex((line) =>
    line.includes("ecs update-service"),
  );
  const migration = lines.findIndex(
    (line) =>
      line.includes("ecs run-task") &&
      line.includes("BP_SCHEMA_MIGRATION_MODE"),
  );
  assert.ok(readiness >= 0 && readiness < binding);
  assert.ok(binding < migration);
  assert.match(result.log, /--desired-count 0/u);
  assert.match(result.log, /^sleep 300$/mu);
  assert.match(
    result.log,
    /BP_SCHEMA_MIGRATION_MODE.*p2-0037-singleton-quiescent/u,
  );
  assert.match(result.log, /ecs wait services-stable/u);
  assert.match(result.log, /--client-token bp-p2-[0-9a-f]{48}/u);
  assert.match(result.log, /--started-by bp-p2-[0-9a-f]{30}/u);
  assert.equal(
    (result.log.match(/ecs run-task.*--platform-version 1\.4\.0/g) ?? [])
      .length,
    2,
  );
  assert.match(result.log, /^sleep 600$/mu);
  assert.ok(
    (result.log.match(/ecs list-task-definitions/g) ?? []).length >= 12,
  );
});

test("cutover binds, retires old revisions, waits 600 seconds, then migrates", async () => {
  const result = await runBoundary({
    MOCK_OLD_TASK_DEFINITIONS: "1",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    (result.log.match(/ecs deregister-task-definition/g) ?? []).length,
    4,
  );
  assert.ok(
    result.log.indexOf("ecs update-service") <
      result.log.indexOf("ecs deregister-task-definition"),
  );
  assert.ok(
    result.log.indexOf("ecs deregister-task-definition") <
      result.log.indexOf("sleep 600"),
  );
  assert.ok(
    result.log.indexOf("sleep 600") <
      result.log.indexOf("BP_SCHEMA_MIGRATION_MODE"),
  );
});

test("readiness refusal preserves every old revision and service binding", async () => {
  const result = await runBoundary({ MOCK_READINESS_EXIT_CODE: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /terminal response was .*nonzero/u);
  assert.equal((result.log.match(/ecs run-task/g) ?? []).length, 1);
  assert.doesNotMatch(result.log, /ecs update-service/u);
  assert.doesNotMatch(result.log, /ecs deregister-task-definition/u);
  assert.doesNotMatch(result.log, /^sleep 600$/mu);
  assert.doesNotMatch(result.log, /BP_SCHEMA_MIGRATION_MODE/u);
});

test("a partial readiness DescribeTasks response preserves service binding", async () => {
  const result = await runBoundary({ MOCK_DESCRIBE_PARTIAL: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /terminal response was partial/u);
  assert.equal((result.log.match(/ecs run-task/g) ?? []).length, 1);
  assert.doesNotMatch(result.log, /ecs update-service/u);
  assert.doesNotMatch(result.log, /ecs deregister-task-definition/u);
});

test("cutover rejects a bound app service not pinned to platform 1.4.0", async () => {
  const result = await runBoundary({
    MOCK_SERVICE_PLATFORM_VERSION_AFTER_UPDATE: "LATEST",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /app service platform version/u);
  assert.match(result.log, /ecs update-service/u);
  assert.doesNotMatch(result.log, /ecs deregister-task-definition/u);
  assert.doesNotMatch(result.log, /BP_SCHEMA_MIGRATION_MODE/u);
});

test("cutover fails closed if an old writer revision cannot be retired", async () => {
  const witnessPath = path.join(fixtureDir, "p2-deregistration-retry.json");
  await writeCohortWitness(witnessPath);
  const result = await runCutover("run", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_SERVICE_REVISION: "41",
    MOCK_SERVICE_BOUND_IMAGE: BASELINE_IMAGE,
    MOCK_OLD_TASK_DEFINITIONS: "1",
    MOCK_DEREGISTER_FAILURE: "1",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mock deregistration failure/u);
  assert.match(result.log, /ecs update-service/u);
  assert.doesNotMatch(result.log, /^sleep 600$/mu);
  assert.doesNotMatch(result.log, /BP_SCHEMA_MIGRATION_MODE/u);
  assert.equal(
    JSON.parse(await readFile(witnessPath, "utf8")).phase,
    "candidate-admitted",
  );
  const retry = await runCutover("run", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_SERVICE_REVISION: "42",
    MOCK_SERVICE_BOUND_IMAGE: IMAGE,
    MOCK_OLD_TASK_DEFINITIONS: "1",
  });
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(
    JSON.parse(await readFile(witnessPath, "utf8")).phase,
    "quiescent-bound",
  );
});

test("cutover preserves prefix-matched sibling families during retirement", async () => {
  const result = await runBoundary({
    MOCK_OLD_TASK_DEFINITIONS: "1",
    MOCK_SIBLING_TASK_DEFINITION: "1",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.log, /deregister-task-definition.*-sibling/u);
});

test("cutover polls through task-definition deregistration consistency lag", async () => {
  const result = await runBoundary({
    MOCK_OLD_TASK_DEFINITIONS: "1",
    MOCK_DEREGISTRATION_LAG: "1",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /^sleep 1$/mu);
});

test("cutover warns and refuses restoration if the migrator waiter fails", async () => {
  const witnessPath = path.join(fixtureDir, "p2-waiter-retry.json");
  await writeCohortWitness(witnessPath);
  const result = await runCutover("run", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_SERVICE_REVISION: "41",
    MOCK_SERVICE_BOUND_IMAGE: BASELINE_IMAGE,
    MOCK_WAITER_FAILURE: "1",
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /task may still be running.*Do not restore writers/su,
  );
  assert.match(result.log, /ecs update-service/u);
  assert.doesNotMatch(result.stdout, /Schema migration completed/u);
  const admitted = JSON.parse(await readFile(witnessPath, "utf8"));
  assert.equal(admitted.phase, "candidate-admitted");
  const token = `bp-p2-${admitted.nonce.slice(0, 48)}`;
  assert.match(result.log, new RegExp(`--client-token ${token}`, "u"));
  const retry = await runCutover("run", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_SERVICE_REVISION: "42",
    MOCK_SERVICE_BOUND_IMAGE: IMAGE,
  });
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.log, new RegExp(`--client-token ${token}`, "u"));
  assert.equal(
    JSON.parse(await readFile(witnessPath, "utf8")).phase,
    "quiescent-bound",
  );
});

test("cutover reports an ambiguous RunTask outcome and preserves the outage", async () => {
  const result = await runBoundary({ MOCK_RUN_TASK_FAILURE: "1" });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /RunTask outcome is unknown.*do not change writer state/su,
  );
  assert.match(result.log, /ecs update-service/u);
  assert.doesNotMatch(result.stdout, /Schema migration completed/u);
});

test("preflight batches more than 100 recently stopped task candidates", async () => {
  const result = await runCutover("preflight", {
    MOCK_STOPPED_TASK_FAMILY: "beaver-app",
    MOCK_STOPPED_TASK_COUNT: "101",
  });
  assert.equal(result.status, 0, result.stderr);
  // The authoritative preflight observes every writer family, then repeats the
  // no-writer proof after service/baseline binding. Each 101-task observation
  // must be split into a 100-task and a one-task DescribeTasks batch.
  assert.equal((result.log.match(/ecs describe-tasks/g) ?? []).length, 4);
});

test("preflight rejects describe-task failures instead of undercounting writers", async () => {
  const result = await runCutover("preflight", {
    MOCK_RUNNING_TASK_FAMILY: "beaver-app",
    MOCK_DESCRIBE_FAILURE: "1",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /partial\/failed response/u);
});

test("empty bootstrap uses a separately armed singleton mode", async () => {
  const witnessPath = path.join(fixtureDir, "empty-bootstrap-witness.json");
  await rm(witnessPath, { force: true });
  const result = await runCutover("bootstrap-empty", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.log.match(/ecs run-task/g) ?? []).length, 2);
  assert.match(
    result.log,
    /schema-readiness.*empty-database-strict-readiness/u,
  );
  assert.match(
    result.log,
    /BP_SCHEMA_MIGRATION_MODE.*empty-database-singleton-quiescent/u,
  );
  const witness = JSON.parse(await readFile(witnessPath, "utf8"));
  assert.equal(witness.phase, "quiescent-bound");
  assert.equal(witness.baselineDigest, DIGEST);
  assert.equal(witness.candidateDigest, DIGEST);
  assert.equal(witness.expiresAtEpoch, null);
  assert.match(result.log, /--client-token bp-empty-[0-9a-f]{48}/u);
});

test("empty bootstrap arms only after strict readiness and reuses its deterministic migration token", async () => {
  const witnessPath = path.join(fixtureDir, "empty-bootstrap-recovery.json");
  await rm(witnessPath, { force: true });

  const ambiguous = await runCutover("bootstrap-empty", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_RUN_TASK_FAILURE: "1",
  });
  assert.notEqual(ambiguous.status, 0);
  const armed = JSON.parse(await readFile(witnessPath, "utf8"));
  assert.equal(armed.phase, "empty-bootstrap-armed");
  assert.match(
    ambiguous.log,
    /schema-readiness.*empty-database-strict-readiness/u,
  );
  const token = `bp-empty-${armed.nonce.slice(0, 48)}`;
  assert.match(ambiguous.log, new RegExp(`--client-token ${token}`, "u"));

  const retry = await runCutover("bootstrap-empty", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_MIGRATION_RUN_TASK_RESPONSE_MODE: "sparse",
    MOCK_MIGRATION_TASK_ARN_STYLE: "legacy",
  });
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(
    retry.log,
    /schema-readiness.*empty-database-armed-retry-readiness/u,
  );
  assert.match(retry.log, new RegExp(`--client-token ${token}`, "u"));
  assert.match(retry.log, new RegExp(LEGACY_MIGRATOR_TASK_ARN, "u"));
  const migrationRequest = retry.log.lastIndexOf("ecs run-task");
  const terminalWait = retry.log.indexOf(
    "ecs wait tasks-stopped",
    migrationRequest,
  );
  const terminalDescribe = retry.log.indexOf(
    "ecs describe-tasks",
    terminalWait,
  );
  assert.ok(
    migrationRequest >= 0 &&
      migrationRequest < terminalWait &&
      terminalWait < terminalDescribe,
  );
  const bound = JSON.parse(await readFile(witnessPath, "utf8"));
  assert.equal(bound.phase, "quiescent-bound");
  assert.equal(bound.nonce, armed.nonce);
  assert.equal(bound.expiresAtEpoch, null);
});

test("unarmed empty bootstrap refuses before arming when strict database readiness fails", async () => {
  const witnessPath = path.join(fixtureDir, "empty-bootstrap-not-empty.json");
  await rm(witnessPath, { force: true });
  const result = await runCutover("bootstrap-empty", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_READINESS_EXIT_CODE: "1",
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.log,
    /schema-readiness.*empty-database-strict-readiness/u,
  );
  assert.doesNotMatch(result.log, /BP_SCHEMA_MIGRATION_MODE/u);
  await assert.rejects(readFile(witnessPath, "utf8"), { code: "ENOENT" });
});

test("restore waits for stability and checks every running app task revision", async () => {
  const result = await runRestored({
    MOCK_SCHEDULE_STATE: "ENABLED",
    MOCK_DESIRED_COUNT: "1",
    MOCK_RUNNING_COUNT: "1",
    MOCK_MIN_CAPACITY: "1",
    MOCK_AUTOSCALING_SUSPENDED: "False",
    MOCK_SERVICE_TASK_ARNS:
      "arn:aws:ecs:us-east-1:123456789012:task/beaver-cluster/app-test",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /ecs wait services-stable/u);
  assert.match(result.log, /ecs describe-tasks.*--output json/u);
});

test("an old durable quiescent-bound receipt remains verifiable and is consumed", async () => {
  const witnessPath = path.join(fixtureDir, "old-durable-bound.json");
  await writeCohortWitness(witnessPath, "quiescent-bound", {
    issuedAtEpoch: Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60,
    expiresAtEpoch: null,
  });
  const result = await runCutover("verify-restored", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_SCHEDULE_STATE: "ENABLED",
    MOCK_DESIRED_COUNT: "1",
    MOCK_RUNNING_COUNT: "1",
    MOCK_MIN_CAPACITY: "1",
    MOCK_AUTOSCALING_SUSPENDED: "False",
    MOCK_WRITER_MODE: "live",
    MOCK_WRITER_MODE_EPOCH: LIVE_EPOCH,
    MOCK_SERVICE_TASK_ARNS:
      "arn:aws:ecs:us-east-1:123456789012:task/beaver-cluster/app-test",
  });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(witnessPath, "utf8"), { code: "ENOENT" });
});

test("restore rejects zero stable tasks instead of accepting zero/zero", async () => {
  const result = await runRestored({
    MOCK_SCHEDULE_STATE: "ENABLED",
    MOCK_DESIRED_COUNT: "0",
    MOCK_RUNNING_COUNT: "0",
    MOCK_MIN_CAPACITY: "1",
    MOCK_AUTOSCALING_SUSPENDED: "False",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /counts do not match expected 1/u);
  assert.doesNotMatch(result.stdout, /restore verified/u);
});

test("restore rejects an autoscaling maximum above the singleton phase", async () => {
  const result = await runRestored({
    MOCK_SCHEDULE_STATE: "ENABLED",
    MOCK_DESIRED_COUNT: "1",
    MOCK_RUNNING_COUNT: "1",
    MOCK_MIN_CAPACITY: "1",
    MOCK_MAX_CAPACITY: "2",
    MOCK_AUTOSCALING_SUSPENDED: "False",
    MOCK_SERVICE_TASK_ARNS:
      "arn:aws:ecs:us-east-1:123456789012:task/beaver-cluster/app-test",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /autoscaling maximum/u);
  assert.doesNotMatch(result.stdout, /restore verified/u);
});

test("restore rejects an old task revision even when the service binding is new", async () => {
  const result = await runRestored({
    MOCK_SCHEDULE_STATE: "ENABLED",
    MOCK_DESIRED_COUNT: "1",
    MOCK_RUNNING_COUNT: "1",
    MOCK_MIN_CAPACITY: "1",
    MOCK_AUTOSCALING_SUSPENDED: "False",
    MOCK_SERVICE_TASK_ARNS:
      "arn:aws:ecs:us-east-1:123456789012:task/beaver-cluster/app-test",
    MOCK_RUNNING_TASK_DEFINITION:
      "arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-app:41",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /used another revision/u);
});

test("restore rejects a partial describe response for listed app tasks", async () => {
  const result = await runRestored({
    MOCK_SCHEDULE_STATE: "ENABLED",
    MOCK_DESIRED_COUNT: "1",
    MOCK_RUNNING_COUNT: "1",
    MOCK_MIN_CAPACITY: "1",
    MOCK_AUTOSCALING_SUSPENDED: "False",
    MOCK_SERVICE_TASK_ARNS:
      "arn:aws:ecs:us-east-1:123456789012:task/beaver-cluster/app-test",
    MOCK_DESCRIBE_PARTIAL: "1",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /describe response was partial/u);
});

test("restore ignores count override channels and requires exact one/one", async () => {
  const result = await runRestored({
    BP_RESTORED_DESIRED_COUNT: "2",
    BP_RESTORED_MIN_COUNT: "2",
    MOCK_SCHEDULE_STATE: "ENABLED",
    MOCK_DESIRED_COUNT: "2",
    MOCK_RUNNING_COUNT: "2",
    MOCK_MIN_CAPACITY: "2",
    MOCK_AUTOSCALING_SUSPENDED: "False",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /counts do not match expected 1/u);
});

test("candidate rollout proves old outage, binds at zero, then consumes its live witness", async () => {
  const witnessPath = path.join(fixtureDir, "writer-cohort-success.json");
  await rm(witnessPath, { force: true });

  const preflight = await runCutover("preflight-outage", {
    BP_APP_IMAGE_DIGEST: BASELINE_DIGEST,
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_LATEST_IMAGE: BASELINE_IMAGE,
    MOCK_LATEST_REVISION: "41",
    MOCK_SERVICE_REVISION: "41",
  });
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.match(preflight.stdout, /still-bound baseline/u);
  assert.doesNotMatch(preflight.log, /ecs run-task|ecs update-service/u);
  const preflightWitness = JSON.parse(await readFile(witnessPath, "utf8"));
  assert.equal(preflightWitness.phase, "outage-preflight");
  assert.equal(preflightWitness.baselineDigest, BASELINE_DIGEST);
  assert.equal(preflightWitness.candidateDigest, DIGEST);
  assert.match(
    preflightWitness.baselineCpuTaskDefinition,
    /beaver-cpu-pipeline:41$/u,
  );
  assert.match(
    preflightWitness.baselineMaintenanceTaskDefinition,
    /beaver-project-asset-deletions:41$/u,
  );
  assert.match(
    preflightWitness.baselineMigratorTaskDefinition,
    /beaver-schema-migrator:41$/u,
  );
  assert.equal(preflightWitness.candidateCpuTaskDefinition, null);
  assert.equal(preflightWitness.outageEpoch, OUTAGE_EPOCH);
  assert.equal(
    preflightWitness.expiresAtEpoch - preflightWitness.issuedAtEpoch,
    21_600,
  );
  assert.match(preflightWitness.nonce, /^[0-9a-f]{64}$/u);

  const binding = await runCutover("bind-quiescent", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_SERVICE_REVISION: "41",
    MOCK_SERVICE_BOUND_IMAGE: BASELINE_IMAGE,
    MOCK_LAST_MODIFIED: "2021-01-01T00:00:00Z",
  });
  assert.equal(binding.status, 0, binding.stderr);
  assert.match(binding.stdout, /every writer remains quiescent/u);
  assert.equal((binding.log.match(/ecs run-task/g) ?? []).length, 1);
  assert.equal((binding.log.match(/ecs update-service/g) ?? []).length, 1);
  assert.match(binding.log, /schema-check/u);
  assert.match(binding.log, /--desired-count 0/u);
  assert.doesNotMatch(
    binding.log,
    /BP_SCHEMA_MIGRATION_MODE|deregister-task-definition/u,
  );
  const boundWitness = JSON.parse(await readFile(witnessPath, "utf8"));
  assert.equal(boundWitness.phase, "quiescent-bound");
  assert.equal(boundWitness.baselineDigest, BASELINE_DIGEST);
  assert.equal(boundWitness.candidateDigest, DIGEST);
  assert.equal(boundWitness.expiresAtEpoch, null);
  assert.equal(boundWitness.scheduleGeneration, "2021-01-01T00:00:00.000Z");

  const restored = await runCutover("verify-restored", {
    BP_REQUIRE_COHORT_WITNESS: "1",
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_SCHEDULE_STATE: "ENABLED",
    MOCK_DESIRED_COUNT: "1",
    MOCK_RUNNING_COUNT: "1",
    MOCK_MIN_CAPACITY: "1",
    MOCK_AUTOSCALING_SUSPENDED: "False",
    MOCK_WRITER_MODE: "live",
    MOCK_WRITER_MODE_EPOCH: LIVE_EPOCH,
    MOCK_SERVICE_TASK_ARNS:
      "arn:aws:ecs:us-east-1:123456789012:task/beaver-cluster/app-test",
  });
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /witness was consumed/u);
  await assert.rejects(readFile(witnessPath, "utf8"), { code: "ENOENT" });
});

test("bind-quiescent recovers an ambiguous UpdateService from its full candidate admission", async () => {
  const witnessPath = path.join(fixtureDir, "bind-update-crash.json");
  await writeCohortWitness(witnessPath);

  const interrupted = await runCutover("bind-quiescent", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_SERVICE_REVISION: "41",
    MOCK_SERVICE_BOUND_IMAGE: BASELINE_IMAGE,
    MOCK_UPDATE_SERVICE_FAILURE_AFTER_MUTATION: "1",
  });
  assert.notEqual(interrupted.status, 0);
  assert.match(interrupted.stderr, /ambiguous UpdateService/u);
  const admitted = JSON.parse(await readFile(witnessPath, "utf8"));
  assert.equal(admitted.phase, "candidate-admitted");
  assert.equal(admitted.candidateDigest, DIGEST);
  assert.match(admitted.candidateTaskDefinition, /beaver-app:42$/u);
  assert.match(admitted.candidateCpuTaskDefinition, /beaver-cpu-pipeline:42$/u);
  assert.match(
    admitted.candidateMaintenanceTaskDefinition,
    /beaver-project-asset-deletions:42$/u,
  );
  assert.match(
    admitted.candidateMigratorTaskDefinition,
    /beaver-schema-migrator:42$/u,
  );
  assert.equal(admitted.databaseSecret, SECRET_SELECTOR);
  assert.equal(admitted.outageEpoch, OUTAGE_EPOCH);
  assert.equal(admitted.expiresAtEpoch - admitted.issuedAtEpoch, 21_600);

  const retry = await runCutover("bind-quiescent", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_SERVICE_REVISION: "42",
    MOCK_SERVICE_BOUND_IMAGE: IMAGE,
  });
  assert.equal(retry.status, 0, retry.stderr);
  const durable = JSON.parse(await readFile(witnessPath, "utf8"));
  assert.equal(durable.phase, "quiescent-bound");
  assert.equal(durable.expiresAtEpoch, null);
  assert.equal(durable.nonce, admitted.nonce);
});

test("P2 run recovers an ambiguous UpdateService from candidate admission", async () => {
  const witnessPath = path.join(fixtureDir, "p2-update-crash.json");
  await writeCohortWitness(witnessPath);

  const interrupted = await runCutover("run", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_SERVICE_REVISION: "41",
    MOCK_SERVICE_BOUND_IMAGE: BASELINE_IMAGE,
    MOCK_UPDATE_SERVICE_FAILURE_AFTER_MUTATION: "1",
  });
  assert.notEqual(interrupted.status, 0);
  assert.match(interrupted.stderr, /ambiguous UpdateService/u);
  const admitted = JSON.parse(await readFile(witnessPath, "utf8"));
  assert.equal(admitted.phase, "candidate-admitted");
  assert.equal(admitted.expiresAtEpoch - admitted.issuedAtEpoch, 21_600);

  const retry = await runCutover("run", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_SERVICE_REVISION: "42",
    MOCK_SERVICE_BOUND_IMAGE: IMAGE,
  });
  assert.equal(retry.status, 0, retry.stderr);
  const durable = JSON.parse(await readFile(witnessPath, "utf8"));
  assert.equal(durable.phase, "quiescent-bound");
  assert.equal(durable.expiresAtEpoch, null);
  assert.equal(durable.nonce, admitted.nonce);
});

test("P2 retry reuses its admitted deterministic token after ambiguous RunTask", async () => {
  const witnessPath = path.join(fixtureDir, "p2-runtask-ambiguous.json");
  await writeCohortWitness(witnessPath);

  const ambiguous = await runCutover("run", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_SERVICE_REVISION: "41",
    MOCK_SERVICE_BOUND_IMAGE: BASELINE_IMAGE,
    MOCK_RUN_TASK_FAILURE: "1",
  });
  assert.notEqual(ambiguous.status, 0);
  const admitted = JSON.parse(await readFile(witnessPath, "utf8"));
  assert.equal(admitted.phase, "candidate-admitted");
  const token = `bp-p2-${admitted.nonce.slice(0, 48)}`;
  assert.match(ambiguous.log, new RegExp(`--client-token ${token}`, "u"));

  const retry = await runCutover("run", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_SERVICE_REVISION: "42",
    MOCK_SERVICE_BOUND_IMAGE: IMAGE,
    MOCK_MIGRATION_RUN_TASK_RESPONSE_MODE: "sparse",
  });
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.log, new RegExp(`--client-token ${token}`, "u"));
  assert.match(retry.log, new RegExp(MIGRATOR_TASK_ARN, "u"));
  const migrationRequest = retry.log.lastIndexOf("ecs run-task");
  const terminalWait = retry.log.indexOf(
    "ecs wait tasks-stopped",
    migrationRequest,
  );
  const terminalDescribe = retry.log.indexOf(
    "ecs describe-tasks",
    terminalWait,
  );
  assert.ok(
    migrationRequest >= 0 &&
      migrationRequest < terminalWait &&
      terminalWait < terminalDescribe,
  );
  const durable = JSON.parse(await readFile(witnessPath, "utf8"));
  assert.equal(durable.phase, "quiescent-bound");
  assert.equal(durable.nonce, admitted.nonce);
});

test("a fresh readiness token cannot admit a sparse stopped RunTask response", async () => {
  const witnessPath = path.join(
    fixtureDir,
    "readiness-sparse-fresh-token.json",
  );
  await writeCohortWitness(witnessPath);
  const result = await runCutover("run", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_SERVICE_REVISION: "41",
    MOCK_SERVICE_BOUND_IMAGE: BASELINE_IMAGE,
    MOCK_READINESS_RUN_TASK_RESPONSE_MODE: "sparse",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RunTask response is partial or mismatched/u);
  assert.doesNotMatch(result.log, /ecs update-service/u);
  assert.equal(
    JSON.parse(await readFile(witnessPath, "utf8")).phase,
    "outage-preflight",
  );
});

for (const [name, responseMode] of [
  ["half-sparse identity", "half-sparse"],
  ["null identities", "null-identities"],
  ["contradictory task definition", "wrong-task-definition"],
  ["non-stopped sparse identity", "sparse-running"],
  ["malformed task ARN", "malformed-task-arn"],
]) {
  test(`P2 deterministic retry rejects a ${name} RunTask response`, async () => {
    const witnessPath = path.join(
      fixtureDir,
      `p2-runtask-reject-${responseMode}.json`,
    );
    await writeCohortWitness(witnessPath, "candidate-admitted");
    const result = await runCutover("run", {
      BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
      MOCK_SERVICE_REVISION: "42",
      MOCK_SERVICE_BOUND_IMAGE: IMAGE,
      MOCK_MIGRATION_RUN_TASK_RESPONSE_MODE: responseMode,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /RunTask response is partial or mismatched/u);
    const migrationRequest = result.log.lastIndexOf("ecs run-task");
    assert.ok(migrationRequest >= 0);
    assert.doesNotMatch(
      result.log.slice(migrationRequest),
      /ecs wait tasks-stopped/u,
    );
    assert.equal(
      JSON.parse(await readFile(witnessPath, "utf8")).phase,
      "candidate-admitted",
    );
  });
}

test("a sparse replay still requires the authoritative terminal task identity", async () => {
  const witnessPath = path.join(fixtureDir, "p2-sparse-terminal-drift.json");
  await writeCohortWitness(witnessPath, "candidate-admitted");
  const result = await runCutover("run", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_SERVICE_REVISION: "42",
    MOCK_SERVICE_BOUND_IMAGE: IMAGE,
    MOCK_MIGRATION_RUN_TASK_RESPONSE_MODE: "sparse",
    MOCK_TERMINAL_TASK_DEFINITION:
      "arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-schema-migrator:41",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /terminal response was partial, mismatched/u);
  const migrationRequest = result.log.lastIndexOf("ecs run-task");
  const terminalWait = result.log.indexOf(
    "ecs wait tasks-stopped",
    migrationRequest,
  );
  const terminalDescribe = result.log.indexOf(
    "ecs describe-tasks",
    terminalWait,
  );
  assert.ok(
    migrationRequest >= 0 &&
      migrationRequest < terminalWait &&
      terminalWait < terminalDescribe,
  );
  assert.equal(
    JSON.parse(await readFile(witnessPath, "utf8")).phase,
    "candidate-admitted",
  );
});

test("P2 boundary run requires the old-digest outage witness", async () => {
  const witnessPath = path.join(fixtureDir, "boundary-missing-witness.json");
  await rm(witnessPath, { force: true });
  const result = await runCutover("run", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_SERVICE_REVISION: "41",
    MOCK_SERVICE_BOUND_IMAGE: BASELINE_IMAGE,
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /missing or invalid owner-local writer outage witness/u,
  );
  assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
});

test("P2 boundary run rejects a witness for another intended candidate", async () => {
  const witnessPath = path.join(fixtureDir, "boundary-wrong-candidate.json");
  await writeCohortWitness(witnessPath, "outage-preflight", {
    candidateDigest: `sha256:${"d".repeat(64)}`,
  });
  const result = await runCutover("run", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_SERVICE_REVISION: "41",
    MOCK_SERVICE_BOUND_IMAGE: BASELINE_IMAGE,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /intended candidate digest/u);
  assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
});

test("P2 retry rejects drift from any admitted candidate task definition", async () => {
  const witnessPath = path.join(
    fixtureDir,
    "candidate-admission-td-drift.json",
  );
  await writeCohortWitness(witnessPath, "candidate-admitted", {
    candidateCpuTaskDefinition:
      "arn:aws:ecs:us-east-1:123456789012:task-definition/beaver-cpu-pipeline:43",
  });
  const result = await runCutover("run", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_SERVICE_REVISION: "42",
    MOCK_SERVICE_BOUND_IMAGE: IMAGE,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /admitted candidate CPU task definition/u);
  assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
});

for (const [name, phase, mode] of [
  ["outage preflight", "outage-preflight", "run"],
  ["candidate admission", "candidate-admitted", "run"],
  ["empty-bootstrap arm", "empty-bootstrap-armed", "bootstrap-empty"],
]) {
  test(`expired ${name} witness cannot authorize mutation`, async () => {
    const witnessPath = path.join(fixtureDir, `expired-${phase}.json`);
    const issuedAtEpoch = Math.floor(Date.now() / 1000) - 30_000;
    await writeCohortWitness(witnessPath, phase, {
      issuedAtEpoch,
      expiresAtEpoch: issuedAtEpoch + 21_600,
    });
    const result = await runCutover(mode, {
      BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
      MOCK_SERVICE_REVISION: phase === "outage-preflight" ? "41" : "42",
      MOCK_SERVICE_BOUND_IMAGE:
        phase === "outage-preflight" ? BASELINE_IMAGE : IMAGE,
    });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /missing or invalid owner-local writer outage witness/u,
    );
    assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
  });
}

test("witness validation rejects a missing exact field", async () => {
  const witnessPath = path.join(fixtureDir, "boundary-missing-field.json");
  await writeCohortWitness(witnessPath);
  const witness = JSON.parse(await readFile(witnessPath, "utf8"));
  delete witness.nonce;
  await writeFile(witnessPath, `${JSON.stringify(witness)}\n`, { mode: 0o600 });
  await chmod(witnessPath, 0o600);
  const result = await runCutover("run", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_SERVICE_REVISION: "41",
    MOCK_SERVICE_BOUND_IMAGE: BASELINE_IMAGE,
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /missing or invalid owner-local writer outage witness/u,
  );
  assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
});

test("restored-then-disabled outage epoch rotation invalidates a copied witness", async () => {
  const witnessPath = path.join(fixtureDir, "boundary-replayed-epoch.json");
  await writeCohortWitness(witnessPath);
  const result = await runCutover("run", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_WRITER_MODE_EPOCH: "3".repeat(64),
    MOCK_SERVICE_REVISION: "41",
    MOCK_SERVICE_BOUND_IMAGE: BASELINE_IMAGE,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /writer witness outage epoch/u);
  assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
});

test("writer epoch lookup refuses a foreign service ARN", async () => {
  const result = await runCutover("preflight", {
    MOCK_SERVICE_ARN:
      "arn:aws:ecs:us-east-1:123456789012:service/other/beaver-app",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /writer-mode epoch service ARN/u);
  assert.doesNotMatch(result.log, /ecs list-tags-for-resource/u);
});

test("P2 boundary run rejects a combined outage and candidate apply", async () => {
  const witnessPath = path.join(fixtureDir, "boundary-combined-apply.json");
  await writeCohortWitness(witnessPath);
  const result = await runCutover("run", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /preflight baseline service task definition/u);
  assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
});

test("restore always requires a quiescent-bound witness", async () => {
  const witnessPath = path.join(fixtureDir, "restore-missing-witness.json");
  await rm(witnessPath, { force: true });
  const result = await runCutover("verify-restored", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_SCHEDULE_STATE: "ENABLED",
    MOCK_DESIRED_COUNT: "1",
    MOCK_RUNNING_COUNT: "1",
    MOCK_MIN_CAPACITY: "1",
    MOCK_AUTOSCALING_SUSPENDED: "False",
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /missing or invalid owner-local writer outage witness/u,
  );
  assert.doesNotMatch(result.stdout, /restore verified/u);
});

test("combined candidate registration and outage cannot forge the old-digest preflight", async () => {
  const witnessPath = path.join(fixtureDir, "writer-cohort-combined.json");
  await rm(witnessPath, { force: true });
  const result = await runCutover("preflight-outage", {
    BP_CANDIDATE_IMAGE_DIGEST: `sha256:${"d".repeat(64)}`,
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
    MOCK_SERVICE_REVISION: "41",
    MOCK_SERVICE_BOUND_IMAGE: BASELINE_IMAGE,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outage service\/latest app task definition/u);
  assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
  await assert.rejects(readFile(witnessPath, "utf8"), { code: "ENOENT" });
});

test("bind-quiescent refuses a missing or owner-readable witness before AWS mutation", async () => {
  const witnessPath = path.join(fixtureDir, "writer-cohort-invalid.json");
  await rm(witnessPath, { force: true });
  let result = await runCutover("bind-quiescent", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /missing or invalid owner-local writer outage witness/u,
  );
  assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);

  await writeFile(witnessPath, "{}\n", { mode: 0o644 });
  result = await runCutover("bind-quiescent", {
    BP_WRITER_OUTAGE_WITNESS_FILE: witnessPath,
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /missing or invalid owner-local writer outage witness/u,
  );
  assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
});

test("cutover rejects permission drift on the policy-free migrator role", async () => {
  const result = await runCutover("preflight", {
    MOCK_MIGRATOR_INLINE_POLICIES: '["UnexpectedInlinePolicy"]',
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /must have no inline or attached permission policies/u,
  );
  assert.doesNotMatch(result.log, /ecs run-task|ecs update-service/u);
});
