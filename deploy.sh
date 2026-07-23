#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/lib/ecs-schema-tools.sh
source "${PROJECT_DIR}/scripts/lib/ecs-schema-tools.sh"
# [refactor jul23 P5.1-β] shared owner-local deploy state (ledger + battery-green marker).
# shellcheck source=scripts/lib/deploy-state.sh
source "${PROJECT_DIR}/scripts/lib/deploy-state.sh"
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
  ./deploy.sh preflight
  ./deploy.sh publish
  ./deploy.sh activate sha256:<64 lowercase hex characters>
  ./deploy.sh preflight-outage sha256:<currently bound digest> sha256:<intended candidate digest>
  ./deploy.sh bind-quiescent sha256:<candidate digest>
  ./deploy.sh verify-restored sha256:<candidate digest>

preflight:
  Fast, hermetic, no-DB local gate (also auto-invoked at the top of publish):
  git working-tree state (known owner-dirt allowlisted; BP_ALLOW_DIRTY=1 overrides
  the rest), then check:architecture, check:project-security-policy,
  check:schema-cutover, check:lint-baseline, test:scripts, and tsc --noEmit. It
  then asserts the recorded battery-green marker is pinned to the current HEAD for
  the heavy DB/build gates (vitest + next build) without re-running them; record
  that marker via scripts/record-battery-green.sh after the battery is green.
  BP_SKIP_PREFLIGHT=1 bypasses the whole gate (loud; owner escape hatch only).

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

# [refactor jul23 P5.1-γ] Known owner-dirt: the deploy clone deliberately carries these two
# uncommitted paths (P_LAND_PLAN L1). They are allowlisted so a strict clean check does not
# false-positive; anything else requires a committed tree or an explicit BP_ALLOW_DIRTY=1.
readonly BP_OWNER_DIRT_ALLOWLIST=".gitignore perf/private-gateway-baseline.json"

preflight_git_state() {
  local head status_output unexpected
  head=$(bp_current_head)
  if [ "${head}" = unknown ] || [[ ! "${head}" =~ ^[0-9a-f]{40}$ ]]; then
    bp_die "preflight: cannot resolve a concrete git HEAD (is this a git clone?)"
    return 1
  fi
  if ! status_output=$(git -C "${PROJECT_DIR}" status --porcelain); then
    bp_die "preflight: git status --porcelain failed"
    return 1
  fi
  if [ -z "${status_output}" ]; then
    return 0
  fi
  unexpected=$(printf '%s' "${status_output}" | node -e '
let input = "";
const allow = new Set(process.argv.slice(1));
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const unexpected = [];
  for (const line of input.split("\n")) {
    if (!line.trim()) continue;
    let entry = line.slice(3);                       // drop the two-column status + space
    const arrow = entry.indexOf(" -> ");
    if (arrow !== -1) entry = entry.slice(arrow + 4); // renames: classify the destination path
    entry = entry.replace(/^"(.*)"$/u, "$1");         // unquote paths with special characters
    if (!allow.has(entry)) unexpected.push(entry);
  }
  process.stdout.write(unexpected.join("\n"));
});
' ${BP_OWNER_DIRT_ALLOWLIST}) || {
    bp_die "preflight: could not classify git working-tree state"
    return 1
  }
  if [ -n "${unexpected}" ]; then
    if [ "${BP_ALLOW_DIRTY:-0}" = 1 ]; then
      echo "WARNING: preflight: uncommitted changes beyond known owner-dirt; proceeding under BP_ALLOW_DIRTY=1:" >&2
      printf '%s\n' "${unexpected}" | while IFS= read -r line; do echo "  ${line}" >&2; done
      return 0
    fi
    bp_die "preflight: uncommitted changes outside the known owner-dirt allowlist; commit them or set BP_ALLOW_DIRTY=1 to override. Offending paths: $(printf '%s' "${unexpected}" | tr '\n' ' ')"
    return 1
  fi
  echo "WARNING: preflight: working tree carries only known owner-dirt (allowed): $(printf '%s' "${status_output}" | tr '\n' ';')" >&2
  return 0
}

preflight_fast_gates() {
  local gate
  # Fast, hermetic, no-DB gates — the exact set CI proves green without the postgres service.
  for gate in \
    check:architecture \
    check:project-security-policy \
    check:schema-cutover \
    check:lint-baseline \
    test:scripts; do
    echo "preflight: npm run ${gate}"
    if ! ( cd "${PROJECT_DIR}" && npm run "${gate}" ); then
      bp_die "preflight gate failed: npm run ${gate}"
      return 1
    fi
  done
  echo "preflight: npx tsc --noEmit"
  if ! ( cd "${PROJECT_DIR}" && npx tsc --noEmit ); then
    bp_die "preflight gate failed: tsc --noEmit"
    return 1
  fi
}

preflight_gates() {
  local head
  head=$(bp_current_head)
  preflight_git_state || return 1
  preflight_fast_gates || return 1
  # Heavy DB/build gates (vitest + next build) are proven via the recorded marker, not re-run.
  bp_battery_green_assert_head "${head}" || return 1
}

run_preflight_command() {
  echo "Running deploy preflight gates for $(bp_current_head)..."
  preflight_gates || bp_die "deploy preflight failed"
  echo "Deploy preflight passed: fast gates green and battery-green marker pinned to HEAD."
}

# Auto-invoked at the top of publish. BP_SKIP_PREFLIGHT=1 is a loud owner-only escape hatch
# (e.g. re-publishing after a manual preflight, or the hermetic dry-lint harness).
run_publish_preflight() {
  if [ "${BP_SKIP_PREFLIGHT:-0}" = 1 ]; then
    echo "WARNING: BP_SKIP_PREFLIGHT=1 — skipping deploy preflight (fast hermetic gates AND the recorded battery-green marker assertion). Escape hatch only." >&2
    return 0
  fi
  echo "Running deploy preflight before publish..."
  preflight_gates || bp_die "deploy preflight failed; refusing to publish"
}

# [refactor jul23 P5.1-δ] Post-deploy application-layer health poll. ECS stability
# (bp_assert_service_revision_stable) already gates correctness at the orchestration layer; this
# adds an HTTP confirmation that the app answers {status:"ok"} at /api/health. It is deliberately
# NON-FATAL — it always returns 0 and only warns loudly on failure — so a health-endpoint blip
# never reverses a rollout ECS already proved stable. BP_SKIP_HEALTH_POLL=1 skips it; the curl
# binary and retry budget are overridable for hermetic dry-lint.
post_deploy_health_poll() {
  local context="$1" curl_bin url attempts delay attempt body
  if [ "${BP_SKIP_HEALTH_POLL:-0}" = 1 ]; then
    echo "Skipping post-deploy health poll for ${context} (BP_SKIP_HEALTH_POLL=1)." >&2
    return 0
  fi
  if [ -z "${DOMAIN:-}" ]; then
    echo "WARNING: post-deploy health poll skipped for ${context}: DOMAIN is unset." >&2
    return 0
  fi
  curl_bin="${BP_HEALTH_CURL_BIN:-curl}"
  if ! command -v "${curl_bin}" >/dev/null 2>&1; then
    echo "WARNING: post-deploy health poll skipped for ${context}: '${curl_bin}' is unavailable." >&2
    return 0
  fi
  attempts="${BP_HEALTH_POLL_ATTEMPTS:-5}"
  delay="${BP_HEALTH_POLL_DELAY_SECONDS:-6}"
  [[ "${attempts}" =~ ^[1-9][0-9]*$ ]] || attempts=5
  [[ "${delay}" =~ ^[0-9]+$ ]] || delay=6
  url="https://app.${DOMAIN}/api/health"
  echo "Polling ${url} for post-deploy application health (up to ${attempts} attempts)..."
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if body=$("${curl_bin}" --fail --silent --show-error --max-time 10 "${url}" 2>/dev/null) &&
       printf '%s' "${body}" | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(input);
    process.exit(parsed && parsed.status === "ok" ? 0 : 1);
  } catch {
    process.exit(1);
  }
});
'; then
      echo "Post-deploy health check passed for ${context} (${url})."
      return 0
    fi
    if [ "${attempt}" -lt "${attempts}" ]; then
      sleep "${delay}"
    fi
  done
  echo "WARNING: post-deploy health poll did NOT observe {\"status\":\"ok\"} at ${url} after ${attempts} attempts for ${context}. ECS reported the service stable, so the rollout stands; investigate the application health endpoint. This is non-fatal." >&2
  return 0
}

publish_image() {
  run_publish_preflight
  bp_require_env AWS_ACCOUNT AWS_REGION ECR_REPO
  bp_assert_caller_account
  [ "${ECR_REPO}" = "beaver-app" ] || bp_die "ECR_REPO must be the canonical beaver-app repository"
  command -v docker >/dev/null 2>&1 || bp_die "docker is required"

  # [refactor jul23 P5.1-β] Previous-digest visibility (read-only, best-effort). The service is
  # still on the outgoing digest at publish time, so this is exactly the digest a later rollback
  # would target. Not resolvable from a bare publish env (no ECS coordinates) — that is fine.
  local previous_digest=""
  if previous_digest=$(bp_current_bound_digest 2>/dev/null) && [ -n "${previous_digest}" ]; then
    echo "Previously bound app digest: ${previous_digest}"
  else
    previous_digest=""
    echo "Previously bound app digest: unknown (service coordinates unavailable in this environment)"
  fi

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

  # [refactor jul23 P5.1-β] Append-only audit record of this publish transition (new candidate
  # digest + the digest it would supersede). Best-effort: never fails the publish.
  bp_deploy_ledger_append publish "${digest}" "${previous_digest:--}" "$(bp_current_head)"

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
  # [refactor jul23 P5.1-δ] Application-layer confirmation after the ECS-stable rollout.
  post_deploy_health_poll activate
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
  preflight)
    [ "$#" -eq 1 ] || usage
    run_preflight_command
    ;;
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
  bind-quiescent)
    [ "$#" -eq 2 ] || usage
    run_writer_cohort_mode "$1" "$2"
    ;;
  verify-restored)
    [ "$#" -eq 2 ] || usage
    run_writer_cohort_mode "$1" "$2"
    # [refactor jul23 P5.1-δ] The live tuple is restored (desired 1); confirm app health.
    post_deploy_health_poll verify-restored
    ;;
  *) usage ;;
esac
