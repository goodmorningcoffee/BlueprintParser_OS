#!/usr/bin/env bash
# [refactor jul23 P5.1-ε] rollback.sh v1 — READ-ONLY / ADVISORY. Prints the exact owner command
# sequence to roll the app back to a prior digest; it NEVER mutates AWS, Docker, Terraform, or
# the database.
#
# Why advisory, not executing: in this immutable-digest architecture a true image rollback is
# NOT a simple deploy.sh call. Binding a prior digest re-registers all four task-definition
# families (Terraform, TF_VAR_beaver_app_image_digest) and then runs the witness-backed writer
# cohort; `deploy.sh activate` is same-digest only. Rebinding one tier alone would break the
# "one digest everywhere" invariant. Mutating rollback is therefore owner-gated (Terraform +
# cohort) and deferred to the owner deploy sitting. This tool resolves the digests, verifies the
# target is real and additive-safe, and prints the precise commands for the owner to run.
#
# Usage:
#   scripts/rollback.sh                     # target = previous digest from the deploy ledger
#   scripts/rollback.sh sha256:<target>     # explicit rollback-to digest
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/ecs-schema-tools.sh
source "${PROJECT_DIR}/scripts/lib/ecs-schema-tools.sh"
# shellcheck source=scripts/lib/deploy-state.sh
source "${PROJECT_DIR}/scripts/lib/deploy-state.sh"
DEPLOY_ENV_FILE="${BP_DEPLOY_ENV_FILE:-${PROJECT_DIR}/.deploy.env}"
[ -f "${DEPLOY_ENV_FILE}" ] && source "${DEPLOY_ENV_FILE}"

readonly APP_FAMILY="beaver-app"
readonly CPU_FAMILY="beaver-cpu-pipeline"
readonly MAINTENANCE_FAMILY="beaver-project-asset-deletions"
readonly MIGRATOR_FAMILY="beaver-schema-migrator"

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/rollback.sh                  Advise a rollback to the previous ledger digest.
  scripts/rollback.sh sha256:<digest>  Advise a rollback to an explicit prior digest.

READ-ONLY: prints the exact owner command sequence; performs no mutation.
EOF
  exit 64
}

target_arg=""
case "$#" in
  0) ;;
  1) target_arg="$1" ;;
  *) usage ;;
esac

bp_require_env AWS_ACCOUNT AWS_REGION ECR_REPO ECS_CLUSTER ECS_SERVICE
[ "${ECR_REPO}" = "beaver-app" ] || bp_die "ECR_REPO must be the canonical beaver-app repository"
[ "${ECS_CLUSTER}" = "beaver-cluster" ] || bp_die "ECS_CLUSTER must be beaver-cluster"
[ "${ECS_SERVICE}" = "beaver-app" ] || bp_die "ECS_SERVICE must be beaver-app"
bp_assert_caller_account

# 1. Current live digest (read-only).
current_digest=$(bp_current_bound_digest) ||
  bp_die "could not resolve the currently bound app digest (read-only)"

# 2. Rollback target: explicit arg, else the previous digest from the ledger.
target_digest=""
if [ -n "${target_arg}" ]; then
  bp_validate_digest "${target_arg}"
  target_digest="${target_arg}"
else
  if ! target_digest=$(bp_ledger_previous_digest "${current_digest}"); then
    bp_die "could not determine a rollback target from the deploy ledger $(bp_deploy_ledger_path); pass an explicit sha256:<digest>"
  fi
  bp_validate_digest "${target_digest}"
fi

# 3. Nothing to do if already on the target.
if [ "${current_digest}" = "${target_digest}" ]; then
  bp_die "the app is already bound to ${target_digest}; nothing to roll back"
fi

# 4. The target image must still exist in ECR (read-only). This is the load-bearing gate: a
#    non-existent target must never yield a go-ahead plan.
if ! bp_ecr_digest_exists "${target_digest}"; then
  bp_die "rollback target ${target_digest} is not present in the ${ECR_REPO} ECR repository; refusing to advise a rollback to a missing image"
fi

# 5. Re-affirm the additive-migration guarantee (L4): rollback stays code-only only while the
#    landing migrations are additive. Read-only policy check.
echo "Re-affirming the additive-migration (schema-cutover) guarantee..."
if ! ( cd "${PROJECT_DIR}" && npm run check:schema-cutover ); then
  bp_die "schema-cutover policy is not green; the additive/code-only rollback guarantee cannot be affirmed. Resolve before rolling back."
fi

# 6. Read-only survey: is the target digest already registered as each family's latest revision?
#    (After a forward deploy it usually is not — Terraform re-registration is then required.)
registered_count=0
missing_families=""
for family in "${APP_FAMILY}" "${CPU_FAMILY}" "${MAINTENANCE_FAMILY}" "${MIGRATOR_FAMILY}"; do
  family_digest=$(bp_family_latest_digest "${family}" 2>/dev/null) || family_digest=""
  if [ "${family_digest}" = "${target_digest}" ]; then
    registered_count=$((registered_count + 1))
  else
    missing_families="${missing_families} ${family}"
  fi
done

# 7. Advisory ledger note (best-effort, append-only) + the printed owner plan. No mutation.
bp_deploy_ledger_append rollback-advisory "${target_digest}" "${current_digest}" "$(bp_current_head)"

cat <<EOF

============================================================
ROLLBACK PLAN (ADVISORY — this script performed NO mutation)
============================================================
  current bound digest : ${current_digest}
  rollback-to digest   : ${target_digest}
  target present in ECR : yes
  additive guarantee    : re-affirmed (schema-cutover policy green)
  target registered as latest across families: ${registered_count}/4
EOF

if [ "${registered_count}" -eq 4 ]; then
  cat <<EOF

All four task-definition families already have their latest ACTIVE revision pinned to the target
digest. Roll back with the witness-backed writer cohort (OWNER runs; each step is same-digest or
Terraform-gated as usual):

  ./deploy.sh preflight-outage ${current_digest} ${target_digest}
  # apply the Terraform outage tuple (writers disabled) while the outage stays exact, then:
  ./deploy.sh bind-quiescent ${target_digest}
  # restore the live tuple with TF_VAR_beaver_app_image_digest=${target_digest}, then:
  ./deploy.sh verify-restored ${target_digest}
EOF
else
  cat <<EOF

The target digest is NOT currently registered across all four families (missing:${missing_families}).
Re-register it via Terraform FIRST, then run the witness-backed cohort (OWNER runs):

  # 1. Terraform (owner) — re-register app/cpu/maintenance/migrator at the target digest:
  TF_VAR_beaver_app_image_digest=${target_digest}   # terraform apply
  # 2. While the current digest is still bound, prove the outage:
  ./deploy.sh preflight-outage ${current_digest} ${target_digest}
  # 3. Apply the Terraform outage tuple (writers disabled), then bind the target:
  ./deploy.sh bind-quiescent ${target_digest}
  # 4. Restore the live tuple with TF_VAR_beaver_app_image_digest=${target_digest}, then:
  ./deploy.sh verify-restored ${target_digest}
EOF
fi

cat <<'EOF'

NOTE: A true image rollback is intentionally owner-gated (Terraform + witness cohort) in this
immutable-digest architecture; it is NOT a single deploy.sh call. This script never mutates.
EOF
