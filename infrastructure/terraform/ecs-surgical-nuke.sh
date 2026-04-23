#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# ECS Surgical Nuke — rebuild the beaver-app service without touching data.
#
# Use when Terraform state is wedged on ECS/autoscaling resources (partial
# apply, failed rename migration, drift) but RDS / S3 / ECR / IAM / VPC are
# healthy and should stay put.
#
# What this DOES:
#   1. Pre-flight: force-delete any lingering DRAINING/INACTIVE beaver-app
#      service from AWS so we can create a fresh one with the same name
#   2. Removes beaver-app ECS service + autoscaling entries from Terraform
#      state (state rm = tell Terraform to forget; does NOT touch AWS)
#   3. Runs a targeted apply so Terraform re-creates them from ecs.tf
#
# What this DOES NOT TOUCH:
#   - RDS (beaver-db)            — your entire database is safe
#   - S3 (beaver-data-*)         — all uploaded PDFs safe
#   - EFS + Label Studio         — untouched (LS can be recovered later)
#   - ECR repos                  — Docker images safe
#   - IAM roles                  — auth surface safe
#   - VPC / subnets / SGs        — networking safe
#   - Secrets Manager            — secrets safe
#   - CloudFront                 — DNS / caching safe
#   - Target groups, ALB, listeners — routing intact, just missing its ECS target
#
# After this runs, the ECS service is rebuilt from the ecs.tf spec —
# which is currently 2 vCPU / 4 GB per task (the "Balanced" tier). If you
# previously bumped to 4 vCPU / 8 GB via ecs-tune.sh, RE-RUN ECS-TUNE.SH
# after this script finishes to restore that sizing.
#
# Reads the same .deploy.env as the other scripts. Requires terraform + aws
# CLI authenticated against the beaver AWS account. jq is optional.
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

# Source .deploy.env from parent (infrastructure/terraform/../../.deploy.env)
DEPLOY_ENV="$(cd "${SCRIPT_DIR}/../.." && pwd)/.deploy.env"
[ -f "${DEPLOY_ENV}" ] && source "${DEPLOY_ENV}"

: "${AWS_REGION:=us-east-1}"
ECS_CLUSTER="${ECS_CLUSTER:-beaver-cluster}"
ECS_SERVICE="${ECS_SERVICE:-beaver-app}"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ─── Resources to forget + recreate ────────────────────────────────────────
# Only the beaver-app service + its autoscaling. Label Studio is left alone
# because its dependencies (EFS mount targets, LS target group, LS SG,
# listener rule, LS task def) are all on the "will be created" list —
# restoring LS would cascade and likely fail. LS is non-critical; recover
# separately if needed.
RESOURCES_TO_FORGET=(
  "aws_ecs_service.beaver_app"
  "aws_appautoscaling_target.beaver_ecs"
  "aws_appautoscaling_policy.beaver_cpu"
  "aws_appautoscaling_policy.beaver_memory"
)

# ─── Banner + confirmation ────────────────────────────────────────────────
printf '\n'
printf '%b━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%b\n' "${CYAN}" "${NC}"
printf '%b  ECS Surgical Nuke — rebuild beaver-app service (data-safe)%b\n' "${BOLD}" "${NC}"
printf '%b━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%b\n' "${CYAN}" "${NC}"
printf '\n'

printf '%bCluster:%b %s\n' "${BOLD}" "${NC}" "${ECS_CLUSTER}"
printf '%bService:%b %s\n' "${BOLD}" "${NC}" "${ECS_SERVICE}"
printf '%bRegion:%b  %s\n' "${BOLD}" "${NC}" "${AWS_REGION}"
printf '\n'

printf '%bWill do:%b\n' "${BOLD}" "${NC}"
printf '  0. Pre-flight check: any lingering DRAINING service → force-delete\n'
printf '  1. terraform state rm ... (x%d resources)\n' "${#RESOURCES_TO_FORGET[@]}"
printf '  2. terraform apply -target=... (recreate the same resources)\n\n'

printf '%bResources being forgotten + recreated:%b\n' "${BOLD}" "${NC}"
for r in "${RESOURCES_TO_FORGET[@]}"; do
  printf '  • %s\n' "${r}"
done
printf '\n'

printf '%bData-bearing resources NOT touched:%b RDS, S3, EFS, ECR, IAM, VPC, Secrets, CloudFront\n' "${GREEN}" "${NC}"
printf '%bLabel Studio service:%b skipped (recover separately if needed)\n\n' "${YELLOW}" "${NC}"

printf '%b⚠  After this runs, re-run ./ecs-tune.sh to restore your task size if%b\n' "${YELLOW}" "${NC}"
printf '%b   you previously bumped above the Balanced (2 vCPU / 4 GB) default.%b\n\n' "${YELLOW}" "${NC}"

read -p "$(printf '%bType yes to proceed:%b ' "${BOLD}" "${NC}")" CONFIRM
if [[ "${CONFIRM}" != "yes" ]]; then
  printf '%b↺ Cancelled.%b\n' "${YELLOW}" "${NC}"
  exit 0
fi
printf '\n'

# ─── Step 0: Pre-flight — check AWS for lingering service ──────────────────
printf '%b▶ Step 0/2: Pre-flight check on AWS-side service state...%b\n\n' "${GREEN}" "${NC}"

CURRENT_STATUS=$(aws ecs describe-services \
    --cluster "${ECS_CLUSTER}" \
    --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" \
    --query "services[0].status" \
    --output text 2>/dev/null || echo "MISSING")

printf '  Current status of %s in %s: %b%s%b\n\n' "${ECS_SERVICE}" "${ECS_CLUSTER}" "${BOLD}" "${CURRENT_STATUS}" "${NC}"

case "${CURRENT_STATUS}" in
  MISSING|None|INACTIVE)
    printf '  %b✔ Service slot is free. Safe to recreate.%b\n\n' "${GREEN}" "${NC}"
    ;;
  ACTIVE)
    printf '  %b✗ Service is currently ACTIVE!%b\n' "${RED}" "${NC}"
    printf '  %b  Aborting — this script is for recovery, not for replacing a healthy service.%b\n' "${RED}" "${NC}"
    printf '  %b  Use ./ecs-tune.sh for sizing changes, or ./deploy.sh for image updates.%b\n\n' "${DIM}" "${NC}"
    exit 1
    ;;
  DRAINING)
    printf '  %b⚠ Service is DRAINING. Force-deleting so the name slot frees up.%b\n' "${YELLOW}" "${NC}"
    aws ecs delete-service \
        --cluster "${ECS_CLUSTER}" \
        --service "${ECS_SERVICE}" \
        --region "${AWS_REGION}" \
        --force \
        --query "service.{status:status,runningCount:runningCount}" \
        --output table
    printf '  Waiting 10s for AWS to propagate the deletion...\n'
    sleep 10
    ;;
  *)
    printf '  %b? Unexpected status: %s. Proceeding anyway.%b\n\n' "${YELLOW}" "${CURRENT_STATUS}" "${NC}"
    ;;
esac
printf '\n'

# ─── Step 1: state rm each resource ────────────────────────────────────────
printf '%b▶ Step 1/2: Removing resources from Terraform state...%b\n\n' "${GREEN}" "${NC}"

for r in "${RESOURCES_TO_FORGET[@]}"; do
  printf '  → terraform state rm %s\n' "${r}"
  if terraform state rm "${r}" 2>/dev/null; then
    printf '    %b✔ removed%b\n' "${GREEN}" "${NC}"
  else
    printf '    %b↺ not in state (already gone)%b\n' "${DIM}" "${NC}"
  fi
done
printf '\n'

# ─── Step 2: targeted apply to recreate ────────────────────────────────────
printf '%b▶ Step 2/2: Running targeted terraform apply to recreate...%b\n' "${GREEN}" "${NC}"
printf '%b   (Terraform will show the plan and prompt for final confirmation.)%b\n\n' "${DIM}" "${NC}"

TARGET_ARGS=()
for r in "${RESOURCES_TO_FORGET[@]}"; do
  TARGET_ARGS+=("-target=${r}")
done

terraform apply "${TARGET_ARGS[@]}"

# ─── Done ──────────────────────────────────────────────────────────────────
printf '\n%b━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%b\n' "${CYAN}" "${NC}"
printf '%b✔ ECS Surgical Nuke complete.%b\n\n' "${GREEN}" "${NC}"

printf '%bNext steps:%b\n' "${BOLD}" "${NC}"
printf '  1. Verify the service is running (wait ~2-3 min for tasks to reach steady state):\n'
printf '     %baws ecs describe-services --cluster %s --services %s --query "services[0].{status:status,running:runningCount,desired:desiredCount}"%b\n\n' "${DIM}" "${ECS_CLUSTER}" "${ECS_SERVICE}" "${NC}"

printf '  2. Restore task size via ecs-tune.sh (if you had bumped it above Balanced tier):\n'
printf '     %bcd .. && ./ecs-tune.sh%b\n\n' "${DIM}" "${NC}"

printf '  3. Push latest Docker image to force fresh deployment:\n'
printf '     %bcd .. && ./deploy.sh%b\n\n' "${DIM}" "${NC}"

printf '  4. Smoke test the app in a browser. Expect HTTP 200.\n\n'

printf '%bIf the app is still 503 after a few minutes:%b\n' "${BOLD}" "${NC}"
printf '  aws ecs describe-services --cluster %s --services %s --query "services[0].events[0:5]"\n' "${ECS_CLUSTER}" "${ECS_SERVICE}"
printf '  (shows the last 5 events — look for task failures, image pull errors, health check fails.)\n\n'
