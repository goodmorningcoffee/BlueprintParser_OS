#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/lib/ecs-schema-tools.sh
source "${PROJECT_DIR}/scripts/lib/ecs-schema-tools.sh"
DEPLOY_ENV_FILE="${BP_DEPLOY_ENV_FILE:-${PROJECT_DIR}/.deploy.env}"
[ -f "${DEPLOY_ENV_FILE}" ] && source "${DEPLOY_ENV_FILE}"

readonly APP_FAMILY="beaver-app"
readonly CPU_FAMILY="beaver-cpu-pipeline"
readonly MAINTENANCE_FAMILY="beaver-project-asset-deletions"
readonly MIGRATOR_FAMILY="beaver-schema-migrator"
readonly MAINTENANCE_SCHEDULE_GROUP="beaver-maintenance"
readonly MAINTENANCE_SCHEDULE_NAME="beaver-project-asset-deletions"

usage() {
  cat >&2 <<'EOF'
Usage:
  ./deploy.sh publish
  ./deploy.sh activate sha256:<64 lowercase hex characters>
  ./deploy.sh preflight-outage sha256:<currently bound digest> sha256:<intended candidate digest>
  ./deploy.sh bind-quiescent sha256:<candidate digest>
  ./deploy.sh verify-restored sha256:<candidate digest>

publish:
  Builds and pushes one fresh immutable tag, resolves its ECR digest, and stops.
  Apply Terraform with TF_VAR_beaver_app_image_digest=<printed digest> so app,
  CPU worker, maintenance worker, and migrator task definitions all pin it.

activate:
  Verifies all four latest task definitions and the maintenance schedule target
  use that digest, verifies the live Step Functions CPU target, runs a read-only
  schema-current task, then completes and verifies a normal app deployment.
  It is deliberately same-digest only (configuration/secret restart).

candidate rollout:
  `preflight-outage` proves the exact outage while the explicit baseline digest
  is still bound and seals the explicit intended candidate into a short-lived
  owner-local witness. `bind-quiescent` seals all four candidate definitions in a
  write-ahead admission before binding exactly that candidate at desired count zero;
  retry it after an ambiguous update. `verify-restored` proves the exact live tuple
  and consumes the final durable witness.

The one-time 0037/0038 boundary must use scripts/p2-schema-cutover.sh, never
activate, because every old writer must be stopped before the singleton migration.
EOF
  exit 64
}

publish_image() {
  bp_require_env AWS_ACCOUNT AWS_REGION ECR_REPO
  bp_assert_caller_account
  [ "${ECR_REPO}" = "beaver-app" ] || bp_die "ECR_REPO must be the canonical beaver-app repository"
  command -v docker >/dev/null 2>&1 || bp_die "docker is required"

  local ecr_base image_tag local_image ecr_tag digest
  ecr_base="${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com"
  image_tag="${BP_IMAGE_TAG:-deploy-$(git -C "${PROJECT_DIR}" rev-parse --short=12 HEAD)-$(date -u +%Y%m%d%H%M%S)}"
  local_image="${ECR_REPO}:${image_tag}"
  ecr_tag="${ecr_base}/${ECR_REPO}:${image_tag}"

  if bp_aws ecr describe-images \
    --repository-name "${ECR_REPO}" \
    --image-ids "imageTag=${image_tag}" \
    --region "${AWS_REGION}" >/dev/null 2>&1; then
    bp_die "refusing to reuse existing ECR tag ${image_tag}"
    return 1
  fi

  export DOCKER_BUILDKIT=1
  bp_aws ecr get-login-password --region "${AWS_REGION}" |
    docker login --username AWS --password-stdin "${ecr_base}" >/dev/null
  docker build --platform linux/amd64 -t "${local_image}" "${PROJECT_DIR}"
  docker tag "${local_image}" "${ecr_tag}"
  docker push "${ecr_tag}"

  digest=$(bp_aws ecr describe-images \
    --repository-name "${ECR_REPO}" \
    --image-ids "imageTag=${image_tag}" \
    --region "${AWS_REGION}" \
    --query 'imageDetails[0].imageDigest' \
    --output text)
  bp_validate_digest "${digest}"

  cat <<EOF
Published immutable application image:
  ${ecr_base}/${ECR_REPO}@${digest}

For an ordinary candidate rollout, do not apply this digest while disabling
writers in the same Terraform apply. First apply the exact outage tuple with the
currently bound digest unchanged, then run:
  ./deploy.sh preflight-outage <currently-bound-digest> ${digest}
Only then apply this candidate while preserving the outage and run:
  ./deploy.sh bind-quiescent ${digest}
Restore the exact live tuple with this same digest and finish with:
  ./deploy.sh verify-restored ${digest}

`activate` is reserved for a same-digest configuration/secret restart.
For an existing database at the one-time P2 boundary, follow README.md: create
the old-digest `preflight-outage` witness before applying this candidate, then
run scripts/p2-schema-cutover.sh with this digest while the outage remains exact.
Only a proven-empty new database may use the documented `bootstrap-empty`
exception without an old-digest witness.
EOF
}

activate_image() {
  local digest="$1"
  bp_require_env AWS_ACCOUNT AWS_REGION ECR_REPO ECS_CLUSTER ECS_SERVICE \
    DOMAIN CLOUDFRONT_DISTRIBUTION_ID
  bp_require_set ROOT_ADMIN_EMAIL
  bp_assert_caller_account
  bp_validate_digest "${digest}"
  local expected_image current_service_td current_service_image
  local app_td cpu_td maintenance_td migrator_td overrides
  local app_step_function_arn canonical_step_function_arn
  local canonical_cluster_arn app_database cpu_database maintenance_database migrator_database
  local app_provider_identity maintenance_provider_identity
  [ "${ECR_REPO}" = "beaver-app" ] || bp_die "ECR_REPO must be the canonical beaver-app repository"
  [ "${ECS_CLUSTER}" = "beaver-cluster" ] || bp_die "ECS_CLUSTER must be beaver-cluster"
  [ "${ECS_SERVICE}" = "beaver-app" ] || bp_die "ECS_SERVICE must be beaver-app"
  expected_image=$(bp_expected_image_uri "${digest}")

  current_service_td=$(bp_service_task_definition)
  current_service_image=$(bp_task_definition_image "${current_service_td}")
  if [ "${current_service_image}" != "${expected_image}" ]; then
    bp_die "activate is same-digest only: service ${current_service_td##*/} uses ${current_service_image}; use preflight-outage, bind-quiescent, and verify-restored for a candidate digest"
    return 1
  fi

  app_td=$(bp_assert_task_definition_image "${APP_FAMILY}" "${expected_image}")
  cpu_td=$(bp_assert_task_definition_image "${CPU_FAMILY}" "${expected_image}")
  maintenance_td=$(bp_assert_task_definition_image "${MAINTENANCE_FAMILY}" "${expected_image}")
  migrator_td=$(bp_assert_task_definition_image "${MIGRATOR_FAMILY}" "${expected_image}")

  app_database=$(bp_assert_task_definition_contract "${app_td}" app)
  cpu_database=$(bp_assert_task_definition_contract "${cpu_td}" cpu)
  maintenance_database=$(bp_assert_task_definition_contract "${maintenance_td}" maintenance)
  migrator_database=$(bp_assert_task_definition_contract "${migrator_td}" migrator)
  [ "${cpu_database}" = "${app_database}" ] || bp_die "CPU task uses another database secret"
  [ "${maintenance_database}" = "${app_database}" ] || bp_die "maintenance task uses another database secret"
  [ "${migrator_database}" = "${app_database}" ] || bp_die "migrator task uses another database secret"
  bp_assert_task_role_has_no_permissions "beaver-schema-migrator-task-role"
  bp_assert_database_secret_identity "${app_database}"
  app_provider_identity=$(bp_task_definition_label_studio_identity "${app_td}")
  maintenance_provider_identity=$(bp_task_definition_label_studio_identity "${maintenance_td}")
  [ "${maintenance_provider_identity}" = "${app_provider_identity}" ] ||
    bp_die "app and maintenance tasks use different Label Studio provider identities"

  canonical_step_function_arn="arn:aws:states:${AWS_REGION}:${AWS_ACCOUNT}:stateMachine:beaver-process-blueprint"
  canonical_cluster_arn="arn:aws:ecs:${AWS_REGION}:${AWS_ACCOUNT}:cluster/beaver-cluster"
  app_step_function_arn=$(bp_task_definition_environment_value "${app_td}" STEP_FUNCTION_ARN)
  if [ "${app_step_function_arn}" != "${canonical_step_function_arn}" ]; then
    bp_die "app task definition references ${app_step_function_arn}, expected ${canonical_step_function_arn}"
    return 1
  fi
  STEP_FUNCTION_ARN="${app_step_function_arn}"
  export STEP_FUNCTION_ARN
  bp_assert_state_machine_task_definition "${cpu_td}" "${canonical_cluster_arn}"

  bp_assert_maintenance_schedule_contract \
    "${maintenance_td}" "${canonical_cluster_arn}" \
    "${MAINTENANCE_SCHEDULE_GROUP}" "${MAINTENANCE_SCHEDULE_NAME}" \
    ENABLED
  bp_assert_service_autoscaling_state 1 1 false

  # Use the migrator image and network, but override its command with a strictly
  # read-only equality check. A pre-cutover DB therefore stops before update-service.
  overrides='{"containerOverrides":[{"name":"beaver-schema-migrator","command":["./entrypoint.sh","schema-check"]}]}'
  echo "Verifying the exact database schema from ${migrator_td}..."
  bp_run_one_off_task "${migrator_td}" "${overrides}" >/dev/null

  bp_aws ecs update-service \
    --cluster "${ECS_CLUSTER}" \
    --service "${ECS_SERVICE}" \
    --task-definition "${app_td}" \
    --force-new-deployment \
    --region "${AWS_REGION}" \
    --query 'service.serviceName' \
    --output text >/dev/null
  bp_assert_service_revision_stable "${app_td}" 1
  bp_assert_maintenance_schedule_contract \
    "${maintenance_td}" "${canonical_cluster_arn}" \
    "${MAINTENANCE_SCHEDULE_GROUP}" "${MAINTENANCE_SCHEDULE_NAME}" \
    ENABLED
  bp_assert_service_autoscaling_state 1 1 false
  echo "Deployment completed with ${app_td##*/} after schema and writer-target checks."
}

run_writer_cohort_mode() {
  local mode="$1" digest="$2"
  bp_validate_digest "${digest}"
  BP_APP_IMAGE_DIGEST="${digest}" \
    "${PROJECT_DIR}/scripts/p2-schema-cutover.sh" "${mode}"
}

preflight_writer_cohort() {
  local baseline_digest="$1" candidate_digest="$2"
  bp_validate_digest "${baseline_digest}"
  bp_validate_digest "${candidate_digest}"
  BP_APP_IMAGE_DIGEST="${baseline_digest}" \
    BP_CANDIDATE_IMAGE_DIGEST="${candidate_digest}" \
    "${PROJECT_DIR}/scripts/p2-schema-cutover.sh" preflight-outage
}

case "${1:-}" in
  publish)
    [ "$#" -eq 1 ] || usage
    publish_image
    ;;
  activate)
    [ "$#" -eq 2 ] || usage
    activate_image "$2"
    ;;
  preflight-outage)
    [ "$#" -eq 3 ] || usage
    preflight_writer_cohort "$2" "$3"
    ;;
  bind-quiescent|verify-restored)
    [ "$#" -eq 2 ] || usage
    run_writer_cohort_mode "$1" "$2"
    ;;
  *) usage ;;
esac
