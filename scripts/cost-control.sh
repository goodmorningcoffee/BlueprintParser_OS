#!/usr/bin/env bash
set -euo pipefail

# Read-only production cost and writer-state report. Writer counts are owned by
# Terraform and app activation is owned by deploy.sh / p2-schema-cutover.sh.

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/ecs-schema-tools.sh
source "${PROJECT_DIR}/scripts/lib/ecs-schema-tools.sh"

DEPLOY_ENV_FILE="${BP_DEPLOY_ENV_FILE:-${PROJECT_DIR}/.deploy.env}"
[ -f "${DEPLOY_ENV_FILE}" ] && source "${DEPLOY_ENV_FILE}"

readonly CANONICAL_ECS_CLUSTER="beaver-cluster"
readonly CANONICAL_ECS_SERVICE="beaver-app"

usage() {
  cat >&2 <<'EOF'
Usage: scripts/cost-control.sh [status]

Prints a read-only production status and cost report. This command never scales
ECS, changes IAM, or claims that a state-machine execution role blocks callers.
EOF
  exit 64
}

case "${1:-status}" in
  status) [ "$#" -le 1 ] || usage ;;
  *) usage ;;
esac

bp_require_env AWS_ACCOUNT AWS_REGION ECS_CLUSTER ECS_SERVICE
[ "${ECS_CLUSTER}" = "${CANONICAL_ECS_CLUSTER}" ] ||
  bp_die "ECS_CLUSTER must be ${CANONICAL_ECS_CLUSTER}"
[ "${ECS_SERVICE}" = "${CANONICAL_ECS_SERVICE}" ] ||
  bp_die "ECS_SERVICE must be ${CANONICAL_ECS_SERVICE}"
bp_assert_caller_account

task_definition=$(bp_aws ecs describe-services \
  --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
  --region "${AWS_REGION}" --query 'services[0].taskDefinition' --output text)
desired_count=$(bp_aws ecs describe-services \
  --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
  --region "${AWS_REGION}" --query 'services[0].desiredCount' --output text)
running_count=$(bp_aws ecs describe-services \
  --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
  --region "${AWS_REGION}" --query 'services[0].runningCount' --output text)
pending_count=$(bp_aws ecs describe-services \
  --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
  --region "${AWS_REGION}" --query 'services[0].pendingCount' --output text)
platform_version=$(bp_aws ecs describe-services \
  --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
  --region "${AWS_REGION}" --query 'services[0].platformVersion' --output text)

state_machine_arn="arn:aws:states:${AWS_REGION}:${AWS_ACCOUNT}:stateMachine:beaver-process-blueprint"
running_executions=$(bp_aws stepfunctions list-executions \
  --state-machine-arn "${state_machine_arn}" --status-filter RUNNING \
  --region "${AWS_REGION}" --query 'length(executions)' --output text)

cat <<EOF
BlueprintParser read-only production report

App task definition:       ${task_definition}
App desired/running/pending: ${desired_count}/${running_count}/${pending_count}
App Fargate platform:      ${platform_version}
Running Step Functions:    ${running_executions}
EOF

echo
echo "Recent SageMaker processing jobs (read-only):"
bp_aws sagemaker list-processing-jobs \
  --region "${AWS_REGION}" \
  --sort-by CreationTime \
  --sort-order Descending \
  --max-results 10 \
  --query 'ProcessingJobSummaries[].{Name:ProcessingJobName,Status:ProcessingJobStatus,Created:CreationTime}' \
  --output table

cat <<'EOF'

This report does not mutate writer state. Change app desired/minimum counts and
the maintenance schedule only through reviewed Terraform plan/apply. Use
deploy.sh activate for an ordinary digest rollout. During the P2 boundary,
follow scripts/p2-schema-cutover.sh and run verify-restored before reopening
labeling.

Step Functions start authorization belongs to callers, not the state-machine
execution role. This report therefore shows observed executions but never
reports the state machine as blocked; emergency admission control must be
applied to every caller principal and verified separately.
EOF
