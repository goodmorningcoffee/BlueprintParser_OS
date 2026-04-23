#!/usr/bin/env bash
set -uo pipefail  # NOT set -e — we want to continue through checks even when one fails

# ─────────────────────────────────────────────────────────────────────────────
# Pre-Reddit Final Check — F1 through F6 from LAUNCH.md
#
# Runs the remaining pre-launch verification checks in order. Each step
# prints a green ✔ (pass), amber ⚠ (warning, launch-OK), or red ✗ (fail,
# block launch).
#
# Exit code: 0 if all checks pass, 1 if any fail.
#
# Human-interaction steps remain:
#   - Clicking the SNS email confirmation link (if still pending)
#   - The 30-min CloudWatch baseline watch (F6)
#   - Posting to Reddit (F7)
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TERRAFORM_DIR="${SCRIPT_DIR}/infrastructure/terraform"
DEPLOY_ENV="${SCRIPT_DIR}/.deploy.env"
[ -f "${DEPLOY_ENV}" ] && source "${DEPLOY_ENV}"

: "${AWS_ACCOUNT:?ERROR: Set AWS_ACCOUNT in .deploy.env or environment}"
: "${AWS_REGION:=us-east-1}"
ECS_CLUSTER="${ECS_CLUSTER:-beaver-cluster}"
ECS_SERVICE="${ECS_SERVICE:-beaver-app}"
APP_URL="${APP_URL:-https://app.blueprintparser.com}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

pass() { printf '  %b✔ %s%b\n' "${GREEN}" "$1" "${NC}"; PASS_COUNT=$((PASS_COUNT + 1)); }
warn() { printf '  %b⚠ %s%b\n' "${YELLOW}" "$1" "${NC}"; WARN_COUNT=$((WARN_COUNT + 1)); }
fail() { printf '  %b✗ %s%b\n' "${RED}" "$1" "${NC}"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

section() {
  printf '\n%b━━━ %s ━━━%b\n' "${CYAN}" "$1" "${NC}"
}

# ─── Header ────────────────────────────────────────────────────────────────
printf '\n'
printf '%b━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%b\n' "${CYAN}" "${NC}"
printf '%b  Pre-Reddit Launch Check%b\n' "${BOLD}" "${NC}"
printf '%b━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%b\n' "${CYAN}" "${NC}"
printf '\n'
printf '%bCluster:%b %s\n' "${BOLD}" "${NC}" "${ECS_CLUSTER}"
printf '%bService:%b %s\n' "${BOLD}" "${NC}" "${ECS_SERVICE}"
printf '%bRegion:%b  %s\n' "${BOLD}" "${NC}" "${AWS_REGION}"
printf '%bApp URL:%b %s\n' "${BOLD}" "${NC}" "${APP_URL}"
printf '\n'

# ─── F1: ECS task count 2/2 ────────────────────────────────────────────────
section "F1 — ECS service healthy (running == desired)"

MAX_WAIT_SEC=600   # 10 minute cap
POLL_SEC=15
START_TS=$(date +%s)

while true; do
  STATUS_JSON=$(aws ecs describe-services \
      --cluster "${ECS_CLUSTER}" \
      --services "${ECS_SERVICE}" \
      --region "${AWS_REGION}" \
      --query "services[0].{status:status,running:runningCount,desired:desiredCount,pending:pendingCount}" \
      --output json 2>/dev/null)

  STATUS=$(echo "${STATUS_JSON}" | grep -o '"status":[^,}]*' | cut -d'"' -f4)
  RUNNING=$(echo "${STATUS_JSON}" | grep -o '"running":[^,}]*' | cut -d':' -f2 | tr -d ' ')
  DESIRED=$(echo "${STATUS_JSON}" | grep -o '"desired":[^,}]*' | cut -d':' -f2 | tr -d ' ')
  PENDING=$(echo "${STATUS_JSON}" | grep -o '"pending":[^,}]*' | cut -d':' -f2 | tr -d ' ')

  ELAPSED=$(($(date +%s) - START_TS))

  printf '  [%ds] status=%s running=%s/%s pending=%s\n' "${ELAPSED}" "${STATUS:-?}" "${RUNNING:-?}" "${DESIRED:-?}" "${PENDING:-?}"

  if [[ "${STATUS}" == "ACTIVE" && "${RUNNING}" == "${DESIRED}" && "${RUNNING}" != "0" ]]; then
    pass "${ECS_SERVICE} is ACTIVE with ${RUNNING}/${DESIRED} tasks running"
    break
  fi

  if [[ "${ELAPSED}" -ge "${MAX_WAIT_SEC}" ]]; then
    fail "Timed out after ${MAX_WAIT_SEC}s waiting for tasks to reach steady state"
    printf '  %bRecent events:%b\n' "${DIM}" "${NC}"
    aws ecs describe-services \
        --cluster "${ECS_CLUSTER}" \
        --services "${ECS_SERVICE}" \
        --region "${AWS_REGION}" \
        --query "services[0].events[0:5].message" \
        --output text 2>/dev/null | head -5 | sed 's/^/    /'
    break
  fi

  sleep "${POLL_SEC}"
done

# ─── F2: hardening resources exist ─────────────────────────────────────────
section "F2 — Hardening resources landed (alarms + Budget + SNS)"

ALARM_COUNT=$(aws cloudwatch describe-alarms \
    --alarm-name-prefix blueprintparser- \
    --region "${AWS_REGION}" \
    --query "length(MetricAlarms)" \
    --output text 2>/dev/null || echo "0")

if [[ "${ALARM_COUNT}" -ge 4 ]]; then
  pass "CloudWatch alarms: ${ALARM_COUNT} present (expected 4)"
elif [[ "${ALARM_COUNT}" -gt 0 ]]; then
  warn "CloudWatch alarms: ${ALARM_COUNT} present (expected 4 — some missing)"
else
  fail "CloudWatch alarms: none found — run F3 target-apply to create them"
fi

BUDGET_COUNT=$(aws budgets describe-budgets \
    --account-id "${AWS_ACCOUNT}" \
    --query "length(Budgets[?BudgetName=='blueprintparser-monthly-cost-cap'])" \
    --output text 2>/dev/null || echo "0")

if [[ "${BUDGET_COUNT}" -ge 1 ]]; then
  pass "AWS Budget blueprintparser-monthly-cost-cap exists"
else
  fail "AWS Budget missing — run F3 target-apply"
fi

SNS_ARN=$(aws sns list-topics \
    --region "${AWS_REGION}" \
    --query "Topics[?contains(TopicArn,'blueprintparser-alerts')].TopicArn" \
    --output text 2>/dev/null | head -1)

if [[ -n "${SNS_ARN}" ]]; then
  pass "SNS topic exists: ${SNS_ARN}"
else
  fail "SNS topic missing — run F3 target-apply"
fi

# ─── F3: offer to fix if F2 had failures ───────────────────────────────────
if [[ "${ALARM_COUNT}" -lt 4 || "${BUDGET_COUNT}" -lt 1 || -z "${SNS_ARN}" ]]; then
  section "F3 — Auto-fix missing hardening resources"
  printf '  Some hardening resources are missing.\n'
  read -p "$(printf '  %bRun terraform target-apply to create them? [y/N]:%b ' "${BOLD}" "${NC}")" DO_FIX
  if [[ "${DO_FIX}" == "y" || "${DO_FIX}" == "Y" ]]; then
    cd "${TERRAFORM_DIR}"
    terraform apply \
      -target=aws_sns_topic.beaver_alerts \
      -target=aws_sns_topic_policy.beaver_alerts \
      -target=aws_cloudwatch_metric_alarm.beaver_ecs_cpu_high \
      -target=aws_cloudwatch_metric_alarm.beaver_lambda_cv_high_invocations \
      -target=aws_cloudwatch_metric_alarm.beaver_lambda_cv_throttles \
      -target=aws_cloudwatch_metric_alarm.beaver_rds_connections_high \
      -target=aws_budgets_budget.beaver_monthly_cap
    cd "${SCRIPT_DIR}"
    pass "Target apply complete — re-run this script to re-check F2"
  else
    warn "Skipped — alarms/budget still incomplete. Monitoring coverage degraded during launch."
  fi
fi

# ─── F4: SNS email subscription confirmed ──────────────────────────────────
section "F4 — SNS email subscription confirmed"

if [[ -z "${SNS_ARN}" ]]; then
  warn "Skipped — SNS topic doesn't exist yet"
else
  SUB_ARN=$(aws sns list-subscriptions-by-topic \
      --topic-arn "${SNS_ARN}" \
      --region "${AWS_REGION}" \
      --query "Subscriptions[].SubscriptionArn" \
      --output text 2>/dev/null | head -1)

  if [[ "${SUB_ARN}" == "PendingConfirmation" ]]; then
    fail "Subscription is PendingConfirmation — check your email and click the AWS confirmation link, then re-run"
  elif [[ -n "${SUB_ARN}" && "${SUB_ARN}" != "None" ]]; then
    pass "Subscription confirmed: ${SUB_ARN##*/}"
  else
    warn "No subscription found — add via: aws sns subscribe --topic-arn ${SNS_ARN} --protocol email --notification-endpoint <your-email>"
  fi
fi

# ─── F5: smoke tests ───────────────────────────────────────────────────────
section "F5 — Smoke tests"

check_http() {
  local name="$1"
  local expected="$2"
  local method="$3"
  local path="$4"
  local actual
  if [[ "${method}" == "POST" ]]; then
    actual=$(curl -s -X POST "${APP_URL}${path}" -H "Content-Type: application/json" -d '{}' -o /dev/null -w "%{http_code}")
  else
    actual=$(curl -s "${APP_URL}${path}" -o /dev/null -w "%{http_code}")
  fi
  if [[ "${actual}" == "${expected}" ]]; then
    pass "${name}: HTTP ${actual} (expected ${expected})"
  else
    fail "${name}: HTTP ${actual} (expected ${expected})"
  fi
}

check_http "Homepage"          "200" "GET"  "/"
check_http "LS creds deleted"  "404" "GET"  "/api/demo/labeling/credentials"
check_http "Model upload env gate" "403" "POST" "/api/admin/models"

# ─── Summary ───────────────────────────────────────────────────────────────
printf '\n%b━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%b\n' "${CYAN}" "${NC}"
printf '%b  Summary%b\n' "${BOLD}" "${NC}"
printf '%b━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%b\n\n' "${CYAN}" "${NC}"

printf '  %b✔ Passed:%b   %d\n' "${GREEN}" "${NC}" "${PASS_COUNT}"
printf '  %b⚠ Warnings:%b %d\n' "${YELLOW}" "${NC}" "${WARN_COUNT}"
printf '  %b✗ Failed:%b   %d\n\n' "${RED}" "${NC}" "${FAIL_COUNT}"

if [[ "${FAIL_COUNT}" -eq 0 ]]; then
  printf '  %b✔ SAFE TO POST TO REDDIT.%b\n\n' "${GREEN}" "${NC}"
  printf '  Remaining human steps:\n'
  printf '    F6: 30-min CloudWatch baseline watch (open AWS Console → CloudWatch dashboards)\n'
  printf '    F7: Post to Reddit; keep /admin Logs tab open for in-flight monitoring\n\n'
  exit 0
else
  printf '  %b✗ DO NOT POST YET — resolve the failures above first.%b\n\n' "${RED}" "${NC}"
  exit 1
fi
