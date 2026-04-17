#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# BlueprintParser 2 — ECS Task Tuning TUI
#
# Interactively pick a Fargate CPU / RAM tier for the beaver-app ECS task
# definition, register a new revision, and (optionally) force a new
# deployment of the service. Also offers to bump Lambda CV memory at the
# end so both knobs can be turned from one place.
#
# Reads the same .deploy.env as deploy.sh (AWS_REGION, ECS_CLUSTER,
# ECS_SERVICE) and uses only AWS CLI + jq — no Terraform, no ECR rebuild.
#
# Fargate us-east-1 pricing (effective 2026-04):
#   vCPU: $0.04048 / hour
#   RAM : $0.004445 / GB-hour
#   Monthly estimate = rate × 730 hours × 1 task
# ─────────────────────────────────────────────────────────────────────────────

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "${PROJECT_DIR}/.deploy.env" ] && source "${PROJECT_DIR}/.deploy.env"

: "${AWS_REGION:?ERROR: Set AWS_REGION in .deploy.env or environment}"
: "${ECS_CLUSTER:?ERROR: Set ECS_CLUSTER in .deploy.env or environment}"
: "${ECS_SERVICE:?ERROR: Set ECS_SERVICE in .deploy.env or environment}"

command -v aws >/dev/null || { echo "ERROR: aws CLI not found"; exit 1; }
command -v jq  >/dev/null || { echo "ERROR: jq not found. Install with 'brew install jq' (macOS) or 'apt-get install jq' (linux)."; exit 1; }

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ── Tier definitions ────────────────────────────────────────────────────────
# Each tier = (label, cpu_units, mem_mib). Fargate CPU is in 1024-ths of a
# vCPU; memory in MiB. All combos below are valid Fargate pairs.
TIER_LABELS=("Cheap"        "Balanced"     "Performance"  "Overpowered")
TIER_CPU=(   "1024"         "2048"         "4096"         "8192")
TIER_MEM=(   "2048"         "4096"         "8192"         "16384")
TIER_DESC=(  "1 vCPU / 2 GB"  "2 vCPU / 4 GB"  "4 vCPU / 8 GB"  "8 vCPU / 16 GB")

# ── Cost calculator (integer arithmetic to avoid bc dependency on macOS) ────
# Cents per hour = cpu_vcpu * 4048 + mem_gb * 4445 / 1000 (truncated)
# Monthly ($ × 100) = cents_per_hour * 730
fmt_month_cost () {
  # Returns estimated monthly $ (integer, rounded down) for a Fargate task
  # running 24/7 in us-east-1.
  #   vCPU rate: $0.04048/hour
  #   RAM  rate: $0.004445/GB/hour
  # Hours/month assumed: 730.
  # Precision trick: scale rates by 1e6 so integer math doesn't lose cents.
  #   $0.04048  × 1e6 = 40480 per-vCPU per-hour
  #   $0.004445 × 1e6 = 4445  per-GB per-hour
  # Then divide by 1e6 at the end to get dollars.
  local cpu_units="$1"
  local mem_mib="$2"
  local cpu_x=$(( (cpu_units * 40480) / 1024 ))   # dollars × 1e6 per hour
  local mem_x=$(( (mem_mib  *  4445) / 1024 ))    # dollars × 1e6 per hour
  local hour_x=$(( cpu_x + mem_x ))
  local month_x=$(( hour_x * 730 ))
  local dollars=$(( month_x / 1000000 ))
  printf '%s' "${dollars}"
}

# ── Header ─────────────────────────────────────────────────────────────────
printf '\n'
printf '%b━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%b\n' "${CYAN}" "${NC}"
printf '%b  ECS Task Tuning — %s%b\n' "${BOLD}" "${ECS_SERVICE}" "${NC}"
printf '%b━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%b\n' "${CYAN}" "${NC}"
printf '\n'

# ── Fetch current task def ─────────────────────────────────────────────────
printf '%b▶%b Fetching current task definition...\n' "${GREEN}" "${NC}"
TMPDIR="${TMPDIR:-/tmp}"
TD_FILE="${TMPDIR}/bp-taskdef-${RANDOM}.json"
aws ecs describe-task-definition \
    --task-definition "${ECS_SERVICE}" \
    --region "${AWS_REGION}" \
    --query 'taskDefinition' \
    --output json > "${TD_FILE}"

FAMILY=$(jq -r '.family' "${TD_FILE}")
CURRENT_REV=$(jq -r '.revision' "${TD_FILE}")
CURRENT_CPU=$(jq -r '.cpu' "${TD_FILE}")
CURRENT_MEM=$(jq -r '.memory' "${TD_FILE}")
CURRENT_ARN=$(jq -r '.taskDefinitionArn' "${TD_FILE}")

CURRENT_VCPU_INT=$(( CURRENT_CPU / 1024 ))
CURRENT_GB_INT=$(( CURRENT_MEM / 1024 ))
CURRENT_COST=$(fmt_month_cost "${CURRENT_CPU}" "${CURRENT_MEM}")

printf '%b✔%b Family: %s | Revision: %s | CPU: %s (%s vCPU) | RAM: %s MiB (%s GB) | ~$%s/mo\n\n' \
  "${GREEN}" "${NC}" "${FAMILY}" "${CURRENT_REV}" "${CURRENT_CPU}" "${CURRENT_VCPU_INT}" "${CURRENT_MEM}" "${CURRENT_GB_INT}" "${CURRENT_COST}"

# ── Show tier options ──────────────────────────────────────────────────────
printf '%bChoose a tier:%b\n\n' "${BOLD}" "${NC}"
printf '  %-3s %-14s %-18s %-12s\n' "#" "Label" "Size" "Monthly (24/7)"
printf '  %-3s %-14s %-18s %-12s\n' "---" "-------------" "-----------------" "-------------"

for i in "${!TIER_LABELS[@]}"; do
  tier_cost=$(fmt_month_cost "${TIER_CPU[$i]}" "${TIER_MEM[$i]}")
  marker=""
  if [[ "${TIER_CPU[$i]}" == "${CURRENT_CPU}" && "${TIER_MEM[$i]}" == "${CURRENT_MEM}" ]]; then
    marker=" ${DIM}(current)${NC}"
  fi
  printf "  %-3s %-14s %-18s ~\$%-10s%b\n" \
    "$((i+1))." "${TIER_LABELS[$i]}" "${TIER_DESC[$i]}" "${tier_cost}" "${marker}"
done

printf '\n'
read -p "$(printf '%bTier [1-4, q to cancel]:%b ' "${BOLD}" "${NC}")" TIER_CHOICE

case "${TIER_CHOICE}" in
  q|Q|quit|"")
    printf '%b↺%b Cancelled.\n' "${YELLOW}" "${NC}"
    rm -f "${TD_FILE}"
    exit 0
    ;;
  1|2|3|4)
    IDX=$((TIER_CHOICE - 1))
    NEW_CPU="${TIER_CPU[$IDX]}"
    NEW_MEM="${TIER_MEM[$IDX]}"
    NEW_LABEL="${TIER_LABELS[$IDX]}"
    ;;
  *)
    printf '%b✗%b Invalid choice: %s\n' "${YELLOW}" "${NC}" "${TIER_CHOICE}"
    rm -f "${TD_FILE}"
    exit 1
    ;;
esac

if [[ "${NEW_CPU}" == "${CURRENT_CPU}" && "${NEW_MEM}" == "${CURRENT_MEM}" ]]; then
  printf '\n%b!%b Chosen tier matches current task size — nothing to register.\n' "${YELLOW}" "${NC}"
  rm -f "${TD_FILE}"
  SKIP_ECS=1
else
  SKIP_ECS=0
fi

# ── Register new task def revision ─────────────────────────────────────────
if [[ "${SKIP_ECS}" != "1" ]]; then
  printf '\n%b▶%b Registering new task definition revision (%s)...\n' "${GREEN}" "${NC}" "${NEW_LABEL}"

  TD_NEW_FILE="${TMPDIR}/bp-taskdef-new-${RANDOM}.json"
  # Strip read-only fields. Keep requiresCompatibilities (input).
  jq --arg cpu "${NEW_CPU}" --arg mem "${NEW_MEM}" '
    .cpu = $cpu |
    .memory = $mem |
    del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
        .compatibilities, .registeredAt, .registeredBy)
  ' "${TD_FILE}" > "${TD_NEW_FILE}"

  REG_OUTPUT=$(aws ecs register-task-definition \
      --cli-input-json "file://${TD_NEW_FILE}" \
      --region "${AWS_REGION}" \
      --query 'taskDefinition.{family:family,revision:revision,cpu:cpu,memory:memory}' \
      --output json)

  NEW_REV=$(jq -r '.revision' <<<"${REG_OUTPUT}")
  printf '%b✔%b Registered %s:%s (cpu=%s, mem=%s)\n' \
    "${GREEN}" "${NC}" "${FAMILY}" "${NEW_REV}" "${NEW_CPU}" "${NEW_MEM}"

  rm -f "${TD_FILE}" "${TD_NEW_FILE}"

  printf '\n'
  read -p "$(printf '%bDeploy now (force-new-deployment of %s)? [y/N]:%b ' "${BOLD}" "${ECS_SERVICE}" "${NC}")" DEPLOY_CHOICE
  case "${DEPLOY_CHOICE}" in
    y|Y|yes)
      printf '%b▶%b Updating service...\n' "${GREEN}" "${NC}"
      aws ecs update-service \
          --cluster "${ECS_CLUSTER}" \
          --service "${ECS_SERVICE}" \
          --task-definition "${FAMILY}:${NEW_REV}" \
          --force-new-deployment \
          --region "${AWS_REGION}" \
          --output text \
          --query 'service.{name:serviceName,desired:desiredCount,task:taskDefinition}' > /dev/null
      printf '%b✔%b Service rolling to %s:%s\n' "${GREEN}" "${NC}" "${FAMILY}" "${NEW_REV}"
      printf '%b  Monitor:%b aws ecs describe-services --cluster %s --services %s --region %s --query "services[0].deployments"\n' \
        "${DIM}" "${NC}" "${ECS_CLUSTER}" "${ECS_SERVICE}" "${AWS_REGION}"
      ;;
    *)
      printf '%b↺%b Skipped service update. Revision %s:%s is registered but not yet live.\n' \
        "${YELLOW}" "${NC}" "${FAMILY}" "${NEW_REV}"
      printf '%b  To deploy later:%b aws ecs update-service --cluster %s --service %s --task-definition %s:%s --force-new-deployment --region %s\n' \
        "${DIM}" "${NC}" "${ECS_CLUSTER}" "${ECS_SERVICE}" "${FAMILY}" "${NEW_REV}" "${AWS_REGION}"
      ;;
  esac

  printf '\n%b  Roll back anytime:%b aws ecs update-service --cluster %s --service %s --task-definition %s:%s --force-new-deployment --region %s\n' \
    "${DIM}" "${NC}" "${ECS_CLUSTER}" "${ECS_SERVICE}" "${FAMILY}" "${CURRENT_REV}" "${AWS_REGION}"
else
  rm -f "${TD_FILE}" 2>/dev/null || true
fi

# ── Bonus: Lambda memory bump ──────────────────────────────────────────────
LAMBDA_FN="${LAMBDA_CV_FUNCTION_NAME:-beaver-cv-pipeline}"
printf '\n%b━━━ Lambda CV memory ━━━%b\n' "${CYAN}" "${NC}"

LAMBDA_CURRENT_MEM=$(aws lambda get-function-configuration \
    --function-name "${LAMBDA_FN}" \
    --region "${AWS_REGION}" \
    --query 'MemorySize' \
    --output text 2>/dev/null || echo "")

if [[ -z "${LAMBDA_CURRENT_MEM}" ]]; then
  printf '%b!%b Could not fetch Lambda memory (function %s not found in %s). Skipping.\n' \
    "${YELLOW}" "${NC}" "${LAMBDA_FN}" "${AWS_REGION}"
else
  printf 'Current Lambda (%s): %s MB\n' "${LAMBDA_FN}" "${LAMBDA_CURRENT_MEM}"
  printf '\nRecommended: 4096 MB (doubles CPU allotment for CV work).\n'
  read -p "$(printf '%bBump to [1024/2048/4096/6144/8192/skip]:%b ' "${BOLD}" "${NC}")" LAMBDA_CHOICE

  case "${LAMBDA_CHOICE}" in
    1024|2048|4096|6144|8192)
      if [[ "${LAMBDA_CHOICE}" == "${LAMBDA_CURRENT_MEM}" ]]; then
        printf '%b!%b Already at %s MB. Skipping.\n' "${YELLOW}" "${NC}" "${LAMBDA_CHOICE}"
      else
        printf '%b▶%b Updating Lambda memory...\n' "${GREEN}" "${NC}"
        aws lambda update-function-configuration \
            --function-name "${LAMBDA_FN}" \
            --memory-size "${LAMBDA_CHOICE}" \
            --region "${AWS_REGION}" \
            --query '{name:FunctionName,memory:MemorySize,lastUpdate:LastUpdateStatus}' \
            --output table
        printf '%b✔%b Lambda memory set to %s MB. Update propagates in ~30s.\n' \
          "${GREEN}" "${NC}" "${LAMBDA_CHOICE}"
      fi
      ;;
    *)
      printf '%b↺%b Skipped Lambda memory change.\n' "${YELLOW}" "${NC}"
      ;;
  esac
fi

printf '\n%b✔ Done.%b\n\n' "${GREEN}" "${NC}"
