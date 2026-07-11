#!/usr/bin/env bash
# BlueprintParser AWS Operations TUI
#
# Purpose:
#   1. Explain an ALB 503 using ECS, target-health, log, metric, WAF, and RDS evidence.
#   2. Pause/resume the public ECS web service without losing the autoscaling configuration.
#   3. Provide guarded recovery actions (health-check grace and force deployment).
#
# Safety model:
#   - Diagnosis is read-only and is always the default.
#   - Every mutation prints the AWS account/region/resource and requires a typed confirmation.
#   - `--dry-run` prints mutations without sending them.
#   - This tool NEVER renders ECS environment/secrets, changes IAM, edits WAF rules, stops RDS,
#     applies Terraform, or runs deploy.sh/hardening.sh.
#   - Application-log output is best-effort redacted and explicitly warns that logs can be sensitive.
#
# [refactor jul11 ops] Built after a production incident reported desired=1/running=0,
# rollout=FAILED, and ALB targets=0/0. That state explains an ALB-generated 503 by itself;
# traffic metrics are still included so an operator can distinguish outage from abuse.

set -Eeuo pipefail

VERSION="0.2.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

load_deploy_env() {
  local path="$1" line key value
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ -z "${line}" || "${line}" == \#* || "${line}" != *=* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key#export }"
    value="${value%$'\r'}"
    case "${value}" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac

    # [refactor jul11 ops] Read only non-secret routing identifiers and never eval/source config.
    # Existing process environment wins over the file; explicit CLI flags win later.
    case "${key}" in
      AWS_ACCOUNT) if [[ -z "${AWS_ACCOUNT:-}" ]]; then AWS_ACCOUNT="${value}"; fi ;;
      AWS_REGION) if [[ -z "${AWS_REGION:-}" ]]; then AWS_REGION="${value}"; fi ;;
      AWS_DEFAULT_REGION) if [[ -z "${AWS_DEFAULT_REGION:-}" ]]; then AWS_DEFAULT_REGION="${value}"; fi ;;
      AWS_PROFILE) if [[ -z "${AWS_PROFILE:-}" ]]; then AWS_PROFILE="${value}"; fi ;;
      ECS_CLUSTER) if [[ -z "${ECS_CLUSTER:-}" ]]; then ECS_CLUSTER="${value}"; fi ;;
      ECS_SERVICE) if [[ -z "${ECS_SERVICE:-}" ]]; then ECS_SERVICE="${value}"; fi ;;
      ALB_NAME) if [[ -z "${ALB_NAME:-}" ]]; then ALB_NAME="${value}"; fi ;;
      RDS_ID) if [[ -z "${RDS_ID:-}" ]]; then RDS_ID="${value}"; fi ;;
      LOG_GROUP) if [[ -z "${LOG_GROUP:-}" ]]; then LOG_GROUP="${value}"; fi ;;
      DOMAIN) if [[ -z "${DOMAIN:-}" ]]; then DOMAIN="${value}"; fi ;;
    esac
  done <"${path}"
}

if [[ -f "${SCRIPT_DIR}/.deploy.env" ]]; then
  load_deploy_env "${SCRIPT_DIR}/.deploy.env"
fi

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
CLUSTER="${ECS_CLUSTER:-beaver-cluster}"
SERVICE="${ECS_SERVICE:-beaver-app}"
ALB_NAME="${ALB_NAME:-beaver-alb}"
RDS_ID="${RDS_ID:-beaver-db}"
CONFIGURED_LOG_GROUP="${LOG_GROUP:-}"
DOMAIN="${DOMAIN:-}"
PROFILE="${AWS_PROFILE:-}"
METRIC_MINUTES=60
DRY_RUN=0
ASSUME_YES=0
EXPECTED_ACCOUNT="${AWS_TOOLS_EXPECTED_ACCOUNT:-${AWS_ACCOUNT:-}}"
ACTION="interactive"

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  RED=$'\033[0;31m'
  GREEN=$'\033[0;32m'
  YELLOW=$'\033[1;33m'
  CYAN=$'\033[0;36m'
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  NC=$'\033[0m'
else
  RED="" GREEN="" YELLOW="" CYAN="" BOLD="" DIM="" NC=""
fi

AWS_PROFILE_ARGS=()
ACCOUNT_ID=""
CALLER_ARN=""
SERVICE_JSON=""
SERVICE_STATUS="UNKNOWN"
DESIRED_COUNT=0
RUNNING_COUNT=0
PENDING_COUNT=0
HEALTH_GRACE=0
ROLLOUT_STATE="UNKNOWN"
SERVICE_ARN=""
TASK_DEFINITION_ARN=""
TARGET_GROUP_ARN=""
CONTAINER_NAME=""
ALB_ARN=""
ALB_DIMENSION=""
TARGET_GROUP_DIMENSION=""
DISCOVERED_LOG_GROUP=""
WAF_ARN=""
WAF_QUERY_OK=1
TARGET_TOTAL=0
TARGET_HEALTHY=0
TARGET_UNHEALTHY=0
TARGET_QUERY_OK=1
AS_PRESENT=0
AS_MIN=0
AS_MAX=0
AS_IN_SUSPENDED=false
AS_OUT_SUSPENDED=false
AS_SCHEDULED_SUSPENDED=false

section() { printf '\n%b━━━ %s ━━━%b\n' "${CYAN}" "$1" "${NC}"; }
ok()      { printf '  %b✔%b %s\n' "${GREEN}" "${NC}" "$1"; }
warn()    { printf '  %b⚠%b %s\n' "${YELLOW}" "${NC}" "$1"; }
fail()    { printf '  %b✘%b %s\n' "${RED}" "${NC}" "$1"; }
info()    { printf '  %b%s%b\n' "${DIM}" "$1" "${NC}"; }

usage() {
  cat <<'EOF'
BlueprintParser AWS Operations TUI

Usage:
  ./aws_tools.sh                         Interactive TUI (read-only status first)
  ./aws_tools.sh status                  Quick status + likely 503 cause
  ./aws_tools.sh diagnose                Full ECS/ALB/task/log/RDS diagnosis
  ./aws_tools.sh metrics [--minutes N]   ALB/ECS/RDS traffic and pressure metrics
  ./aws_tools.sh security                WAF samples, WAF metrics, GuardDuty findings
  ./aws_tools.sh logs                    Recent application logs
  ./aws_tools.sh tail                    Follow application logs (Ctrl-C to stop)
  ./aws_tools.sh pause                   Pause web ECS safely (autoscaling snapshot+suspend)
  ./aws_tools.sh resume                  Restore the exact pre-pause state
  ./aws_tools.sh grace                   Set ECS health-check grace period to 120 seconds
  ./aws_tools.sh redeploy                Force a new deployment of the current task definition

Options:
  --profile NAME     AWS CLI profile (otherwise AWS_PROFILE/default credential chain)
  --region REGION    AWS region
  --cluster NAME     ECS cluster
  --service NAME     ECS service
  --alb NAME         ALB fallback name (normally discovered from ECS target group)
  --rds NAME         RDS instance identifier
  --minutes N        Metrics window, 5-180 minutes (default 60)
  --dry-run          Print mutating AWS commands; do not execute them
  --yes              Skip typed confirmation (requires an expected-account option/config guard)
  --expected-account 12_DIGITS
                     Refuse to run if STS resolves a different account
  -h, --help         Show this help

Pause scope:
  Only the public ECS web service is paused. ALB, RDS, S3, Lambda, Step Functions,
  SageMaker, and already-running processing jobs are NOT stopped. This is deliberate:
  the tool does not pretend a web-service scale-to-zero is a full account kill switch.

Account guard: --expected-account overrides AWS_TOOLS_EXPECTED_ACCOUNT/AWS_ACCOUNT.
Required: AWS CLI v2 and python3. No jq dependency.
EOF
}

is_action() {
  case "$1" in
    interactive|status|diagnose|metrics|security|logs|tail|pause|resume|grace|redeploy|help) return 0 ;;
    *) return 1 ;;
  esac
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --profile) PROFILE="${2:?--profile needs a value}"; shift 2 ;;
      --region) REGION="${2:?--region needs a value}"; shift 2 ;;
      --cluster) CLUSTER="${2:?--cluster needs a value}"; shift 2 ;;
      --service) SERVICE="${2:?--service needs a value}"; shift 2 ;;
      --alb) ALB_NAME="${2:?--alb needs a value}"; shift 2 ;;
      --rds) RDS_ID="${2:?--rds needs a value}"; shift 2 ;;
      --minutes) METRIC_MINUTES="${2:?--minutes needs a value}"; shift 2 ;;
      --dry-run) DRY_RUN=1; shift ;;
      --yes) ASSUME_YES=1; shift ;;
      --expected-account) EXPECTED_ACCOUNT="${2:?--expected-account needs a value}"; shift 2 ;;
      -h|--help) ACTION="help"; shift ;;
      *)
        if is_action "$1"; then
          ACTION="$1"
          shift
        else
          printf 'Unknown argument: %s\n\n' "$1" >&2
          usage >&2
          exit 2
        fi
        ;;
    esac
  done

  if ! [[ "${METRIC_MINUTES}" =~ ^[0-9]+$ ]] || (( METRIC_MINUTES < 5 || METRIC_MINUTES > 180 )); then
    printf 'ERROR: --minutes must be an integer from 5 through 180.\n' >&2
    exit 2
  fi
  if [[ -n "${EXPECTED_ACCOUNT}" && ! "${EXPECTED_ACCOUNT}" =~ ^[0-9]{12}$ ]]; then
    printf 'ERROR: --expected-account must be exactly 12 digits.\n' >&2
    exit 2
  fi
  if (( ASSUME_YES )) && [[ -z "${EXPECTED_ACCOUNT}" ]]; then
    printf 'ERROR: --yes requires --expected-account, AWS_TOOLS_EXPECTED_ACCOUNT, or AWS_ACCOUNT.\n' >&2
    exit 2
  fi

  if [[ -n "${PROFILE}" ]]; then
    AWS_PROFILE_ARGS=(--profile "${PROFILE}")
  fi
}

aws_cli() {
  AWS_PAGER="" aws "${AWS_PROFILE_ARGS[@]}" --no-cli-pager "$@" --region "${REGION}"
}

print_command() {
  printf '  %bDRY RUN:%b aws' "${YELLOW}" "${NC}"
  local arg
  for arg in "${AWS_PROFILE_ARGS[@]}" --no-cli-pager "$@" --region "${REGION}"; do
    printf ' %q' "${arg}"
  done
  printf '\n'
}

aws_mutate() {
  if (( DRY_RUN )); then
    print_command "$@"
    return 0
  fi
  aws_cli "$@"
}

iso_now() {
  python3 -c 'from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))'
}

iso_minutes_ago() {
  python3 - "$1" <<'PY'
from datetime import datetime, timedelta, timezone
import sys
print((datetime.now(timezone.utc) - timedelta(minutes=int(sys.argv[1]))).strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
}

epoch_ms_minutes_ago() {
  python3 - "$1" <<'PY'
from datetime import datetime, timedelta, timezone
import sys
dt = datetime.now(timezone.utc) - timedelta(minutes=int(sys.argv[1]))
print(int(dt.timestamp() * 1000))
PY
}

preflight() {
  command -v aws >/dev/null 2>&1 || {
    fail "AWS CLI not found. Install AWS CLI v2 before running this tool."
    exit 1
  }
  command -v python3 >/dev/null 2>&1 || {
    fail "python3 not found (used only for portable UTC timestamps/JSON parsing)."
    exit 1
  }

  local identity
  if ! identity="$(aws_cli sts get-caller-identity --query '[Account,Arn]' --output text 2>/dev/null)"; then
    fail "AWS credentials are unavailable or invalid for profile '${PROFILE:-default}'."
    exit 1
  fi
  ACCOUNT_ID="${identity%%$'\t'*}"
  CALLER_ARN="${identity#*$'\t'}"

  if [[ -z "${ACCOUNT_ID}" || "${ACCOUNT_ID}" == "None" ]]; then
    fail "Could not identify the AWS account."
    exit 1
  fi
  if [[ -n "${EXPECTED_ACCOUNT}" && "${EXPECTED_ACCOUNT}" != "${ACCOUNT_ID}" ]]; then
    fail "Expected AWS account ${EXPECTED_ACCOUNT}, but STS resolved ${ACCOUNT_ID}."
    exit 1
  fi
}

load_service_snapshot() {
  if ! SERVICE_JSON="$(aws_cli ecs describe-services \
    --cluster "${CLUSTER}" --services "${SERVICE}" --output json 2>/dev/null)"; then
    fail "Could not describe ECS service ${CLUSTER}/${SERVICE}."
    return 1
  fi

  local parsed
  parsed="$(python3 -c '
import json, sys
d=json.load(sys.stdin)
s=(d.get("services") or [None])[0]
if not s:
    print("MISSING|0|0|0|0|UNKNOWN||||")
    raise SystemExit
primary=next((x for x in s.get("deployments",[]) if x.get("status")=="PRIMARY"), {})
lb=(s.get("loadBalancers") or [{}])[0]
vals=[
    s.get("status","UNKNOWN"), s.get("desiredCount",0), s.get("runningCount",0),
    s.get("pendingCount",0), s.get("healthCheckGracePeriodSeconds",0),
    primary.get("rolloutState","UNKNOWN"), s.get("serviceArn","") or "",
    s.get("taskDefinition","") or "", lb.get("targetGroupArn","") or "",
    lb.get("containerName","") or "",
]
print("|".join(str(v).replace("|","/") for v in vals))
' <<<"${SERVICE_JSON}")"

  local old_ifs="${IFS}"
  IFS='|' read -r SERVICE_STATUS DESIRED_COUNT RUNNING_COUNT PENDING_COUNT HEALTH_GRACE \
    ROLLOUT_STATE SERVICE_ARN TASK_DEFINITION_ARN TARGET_GROUP_ARN CONTAINER_NAME <<<"${parsed}"
  IFS="${old_ifs}"

  if [[ "${SERVICE_STATUS}" == "MISSING" ]]; then
    fail "ECS returned no service named '${SERVICE}' in cluster '${CLUSTER}'."
    return 1
  fi
}

discover_resources() {
  load_service_snapshot || return 1

  if [[ -n "${TARGET_GROUP_ARN}" && "${TARGET_GROUP_ARN}" != "None" ]]; then
    ALB_ARN="$(aws_cli elbv2 describe-target-groups \
      --target-group-arns "${TARGET_GROUP_ARN}" \
      --query 'TargetGroups[0].LoadBalancerArns[0]' --output text 2>/dev/null || true)"
  fi
  if [[ -z "${ALB_ARN}" || "${ALB_ARN}" == "None" ]]; then
    ALB_ARN="$(aws_cli elbv2 describe-load-balancers --names "${ALB_NAME}" \
      --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || true)"
  fi

  if [[ -n "${ALB_ARN}" && "${ALB_ARN}" != "None" ]]; then
    ALB_DIMENSION="${ALB_ARN#*loadbalancer/}"
    if ! WAF_ARN="$(aws_cli wafv2 get-web-acl-for-resource --resource-arn "${ALB_ARN}" \
      --query 'WebACL.ARN' --output text 2>/dev/null)"; then
      WAF_QUERY_OK=0
      WAF_ARN=""
    fi
  fi
  if [[ -n "${TARGET_GROUP_ARN}" && "${TARGET_GROUP_ARN}" != "None" ]]; then
    TARGET_GROUP_DIMENSION="targetgroup/${TARGET_GROUP_ARN#*targetgroup/}"
  fi

  if [[ -n "${TASK_DEFINITION_ARN}" && "${TASK_DEFINITION_ARN}" != "None" ]]; then
    local container_logs_json
    if container_logs_json="$(aws_cli ecs describe-task-definition \
      --task-definition "${TASK_DEFINITION_ARN}" \
      --query 'taskDefinition.containerDefinitions[*].[name,logConfiguration.options."awslogs-group"]' \
      --output json 2>/dev/null)"; then
      DISCOVERED_LOG_GROUP="$(python3 -c '
import json
import sys
rows = json.load(sys.stdin) or []
wanted = sys.argv[1]
match = next((row for row in rows if row and row[0] == wanted and len(row) > 1 and row[1]), None)
fallback = next((row for row in rows if row and len(row) > 1 and row[1]), None)
print((match or fallback or ["", ""])[1] or "")
' "${CONTAINER_NAME}" <<<"${container_logs_json}" 2>/dev/null || true)"
    fi
  fi
  if [[ -z "${DISCOVERED_LOG_GROUP}" || "${DISCOVERED_LOG_GROUP}" == "None" ]]; then
    DISCOVERED_LOG_GROUP="${CONFIGURED_LOG_GROUP:-/ecs/blueprintparser-app}"
  fi
}

load_target_snapshot() {
  TARGET_TOTAL=0 TARGET_HEALTHY=0 TARGET_UNHEALTHY=0
  TARGET_QUERY_OK=1
  if [[ -z "${TARGET_GROUP_ARN}" || "${TARGET_GROUP_ARN}" == "None" ]]; then
    return 0
  fi

  local parsed
  if ! parsed="$(aws_cli elbv2 describe-target-health --target-group-arn "${TARGET_GROUP_ARN}" \
    --query '[length(TargetHealthDescriptions), length(TargetHealthDescriptions[?TargetHealth.State==`healthy`]), length(TargetHealthDescriptions[?TargetHealth.State==`unhealthy`])]' \
    --output text 2>/dev/null)"; then
    TARGET_QUERY_OK=0
    return 0
  fi
  local old_ifs="${IFS}"
  IFS=$'\t' read -r TARGET_TOTAL TARGET_HEALTHY TARGET_UNHEALTHY <<<"${parsed}"
  IFS="${old_ifs}"
}

context_header() {
  printf '\n%bBlueprintParser AWS Operations%b  v%s\n' "${BOLD}" "${NC}" "${VERSION}"
  printf '%bAccount %s | Region %s | %s/%s%b\n' \
    "${DIM}" "${ACCOUNT_ID}" "${REGION}" "${CLUSTER}" "${SERVICE}" "${NC}"
  printf '%bCaller: %s%b\n' "${DIM}" "${CALLER_ARN}" "${NC}"
  if (( DRY_RUN )); then
    warn "DRY RUN: mutations will only be printed."
  fi
  return 0
}

show_quick_status() {
  load_service_snapshot || return 1
  load_target_snapshot
  context_header
  section "ECS service"

  if [[ "${DESIRED_COUNT}" == "0" ]]; then
    warn "Service is intentionally/offline configured at desired count 0."
  elif [[ "${SERVICE_STATUS}" == "ACTIVE" && "${RUNNING_COUNT}" == "${DESIRED_COUNT}" && "${PENDING_COUNT}" == "0" ]]; then
    ok "ACTIVE — ${RUNNING_COUNT}/${DESIRED_COUNT} running, 0 pending"
  else
    fail "${SERVICE_STATUS} — ${RUNNING_COUNT}/${DESIRED_COUNT} running, ${PENDING_COUNT} pending"
  fi
  [[ "${ROLLOUT_STATE}" == "COMPLETED" ]] && ok "Primary rollout: COMPLETED" || fail "Primary rollout: ${ROLLOUT_STATE}"
  if [[ "${HEALTH_GRACE}" == "0" || "${HEALTH_GRACE}" == "None" ]]; then
    warn "ECS health-check grace is 0 seconds. Slow startup/migrations can be killed early."
  else
    ok "ECS health-check grace: ${HEALTH_GRACE}s"
  fi

  section "ALB target health"
  if [[ -z "${TARGET_GROUP_ARN}" || "${TARGET_GROUP_ARN}" == "None" ]]; then
    fail "No ECS target group was discovered."
  elif (( TARGET_QUERY_OK == 0 )); then
    warn "Target group was discovered, but target health could not be queried."
  elif (( TARGET_TOTAL == 0 )); then
    fail "0/0 registered targets — an ALB-generated HTTP 503 is expected."
  elif (( TARGET_HEALTHY == TARGET_TOTAL )); then
    ok "${TARGET_HEALTHY}/${TARGET_TOTAL} targets healthy"
  else
    fail "${TARGET_HEALTHY}/${TARGET_TOTAL} targets healthy (${TARGET_UNHEALTHY} unhealthy)"
  fi

  section "Likely cause"
  if (( DESIRED_COUNT == 0 )); then
    warn "The web service is paused/scaled to zero. This is an intentional availability state."
  elif (( RUNNING_COUNT == 0 && DESIRED_COUNT > 0 )); then
    fail "ECS has no running app task, so the ALB has nothing to route to."
    info "This points first to task launch, deployment rollback, startup, image, IAM, network, or health-check failure."
    info "It is NOT evidence of DDoS by itself. Use [metrics] and [security] to evaluate traffic separately."
  elif (( RUNNING_COUNT > 0 && TARGET_QUERY_OK == 0 )); then
    warn "Tasks run, but target health could not be queried; the ALB conclusion is unknown."
  elif (( RUNNING_COUNT > 0 && TARGET_HEALTHY == 0 )); then
    fail "Tasks run but none pass target health. Check /api/health, startup time, container logs, and security groups."
  elif (( TARGET_HEALTHY > 0 )); then
    ok "At least one healthy target exists. If 503 persists, inspect listener/rule routing and ELB metrics."
  else
    warn "The snapshot is inconclusive. Run full diagnosis."
  fi

  if [[ "${ROLLOUT_STATE}" == "FAILED" ]]; then
    fail "Deployment circuit breaker reports FAILED. ECS events and rolloutStateReason are the highest-value evidence."
  fi
}

show_service_and_deployments() {
  section "Service and deployments"
  aws_cli ecs describe-services --cluster "${CLUSTER}" --services "${SERVICE}" \
    --query 'services[0].{status:status,desired:desiredCount,running:runningCount,pending:pendingCount,graceSeconds:healthCheckGracePeriodSeconds,taskDefinition:taskDefinition,deployments:deployments[*].{status:status,rollout:rolloutState,reason:rolloutStateReason,desired:desiredCount,running:runningCount,pending:pendingCount,failed:failedTasks,created:createdAt,updated:updatedAt}}' \
    --output json || warn "Could not render service deployments."
}

show_service_events() {
  section "Recent ECS service events"
  aws_cli ecs describe-services --cluster "${CLUSTER}" --services "${SERVICE}" \
    --query 'services[0].events[0:15].[createdAt,message]' --output table \
    || warn "Could not read ECS service events."
}

show_task_definition() {
  section "Current task definition (secrets/environment intentionally omitted)"
  if [[ -z "${TASK_DEFINITION_ARN}" || "${TASK_DEFINITION_ARN}" == "None" ]]; then
    warn "No task definition ARN was discovered."
    return
  fi
  aws_cli ecs describe-task-definition --task-definition "${TASK_DEFINITION_ARN}" \
    --query 'taskDefinition.{family:family,revision:revision,cpu:cpu,memory:memory,registeredAt:registeredAt,runtime:runtimePlatform,containers:containerDefinitions[*].{name:name,image:image,essential:essential,portMappings:portMappings,healthCheck:{interval:healthCheck.interval,timeout:healthCheck.timeout,retries:healthCheck.retries,startPeriod:healthCheck.startPeriod},logGroup:logConfiguration.options."awslogs-group"}}' \
    --output json || warn "Could not read task definition."
}

task_arns_for_status() {
  local desired_status="$1"
  aws_cli ecs list-tasks --cluster "${CLUSTER}" --service-name "${SERVICE}" \
    --desired-status "${desired_status}" --query 'taskArns' --output text 2>/dev/null \
    | tr '\t' '\n' | sed '/^$/d;/^None$/d'
}

show_tasks_for_status() {
  local desired_status="$1"
  local title="$2"
  local arns=()
  local arn
  while IFS= read -r arn; do
    [[ -n "${arn}" ]] && arns+=("${arn}")
  done < <(task_arns_for_status "${desired_status}" || true)

  section "${title}"
  if (( ${#arns[@]} == 0 )); then
    info "No ${desired_status} tasks retained/returned for this service. ECS service events may still contain the failure."
    return
  fi

  aws_cli ecs describe-tasks --cluster "${CLUSTER}" --tasks "${arns[@]}" \
    --query 'tasks[*].{task:taskArn,last:lastStatus,health:healthStatus,created:createdAt,started:startedAt,stopped:stoppedAt,stopCode:stopCode,reason:stoppedReason,containers:containers[*].{name:name,last:lastStatus,health:healthStatus,exit:exitCode,reason:reason}}' \
    --output json || warn "Could not describe ${desired_status} tasks."
}

show_target_health() {
  section "ALB target health"
  if [[ -z "${TARGET_GROUP_ARN}" || "${TARGET_GROUP_ARN}" == "None" ]]; then
    fail "No target group discovered from ECS service loadBalancers[0]."
    return
  fi
  info "Target group: ${TARGET_GROUP_ARN}"
  aws_cli elbv2 describe-target-health --target-group-arn "${TARGET_GROUP_ARN}" \
    --query 'TargetHealthDescriptions[*].{target:Target.Id,port:Target.Port,state:TargetHealth.State,reason:TargetHealth.Reason,description:TargetHealth.Description}' \
    --output table || warn "Could not read target health."
}

redact_log_events_json() {
  python3 -c '
import datetime as dt
import json
import re
import sys

data = json.load(sys.stdin)
patterns = [
    (re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*"), "Bearer <redacted>"),
    (re.compile(r"(?i)\b(Basic)\s+[A-Za-z0-9+/]+=*"), r"\1 <redacted>"),
    (re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"), "<aws-access-key-redacted>"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"), "<jwt-redacted>"),
    (re.compile(r"(?i)(https?://[^:/\s]+:)[^@/\s]+@"), r"\1<redacted>@"),
    (re.compile(r"(?i)(password|passwd|secret|token|api[_-]?key|authorization|cookie|set-cookie|database[_-]?url|db[_-]?url|dsn)([\"\x27]?\s*[:=]\s*[\"\x27]?)([^\s,;\"\x27}]+)"), r"\1\2<redacted>"),
]

def clean(value):
    value = str(value).replace("\r", " ").replace("\n", " ")
    for pattern, replacement in patterns:
        value = pattern.sub(replacement, value)
    return value[:1200] + ("…<truncated>" if len(value) > 1200 else "")

for event in data.get("events", [])[-60:]:
    stamp = event.get("timestamp", 0)
    try:
        rendered = dt.datetime.fromtimestamp(stamp / 1000, dt.timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        rendered = str(stamp)
    stream = clean(event.get("logStreamName", ""))
    message = clean(event.get("message", ""))
    print(f"{rendered}\t{stream}\t{message}")
'
}

redact_log_lines() {
  python3 -c '
import re
import sys
patterns = [
    (re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*"), "Bearer <redacted>"),
    (re.compile(r"(?i)\b(Basic)\s+[A-Za-z0-9+/]+=*"), r"\1 <redacted>"),
    (re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"), "<aws-access-key-redacted>"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"), "<jwt-redacted>"),
    (re.compile(r"(?i)(https?://[^:/\s]+:)[^@/\s]+@"), r"\1<redacted>@"),
    (re.compile(r"(?i)(password|passwd|secret|token|api[_-]?key|authorization|cookie|set-cookie|database[_-]?url|db[_-]?url|dsn)([\"\x27]?\s*[:=]\s*[\"\x27]?)([^\s,;\"\x27}]+)"), r"\1\2<redacted>"),
]
for line in sys.stdin:
    for pattern, replacement in patterns:
        line = pattern.sub(replacement, line)
    print(line[:2000].rstrip("\n") + ("…<truncated>" if len(line) > 2000 else ""), flush=True)
'
}

show_recent_logs() {
  local minutes="${1:-60}"
  section "Application logs (last ${minutes} minutes; max 60 events, best-effort redacted)"
  info "Discovered log group: ${DISCOVERED_LOG_GROUP}"
  warn "Application logs can contain sensitive data; common credentials are redacted, but review terminal capture handling."
  local start_ms
  start_ms="$(epoch_ms_minutes_ago "${minutes}")"
  local events_json
  if ! events_json="$(aws_cli logs filter-log-events --log-group-name "${DISCOVERED_LOG_GROUP}" \
    --start-time "${start_ms}" --max-items 60 --output json)"; then
    warn "Could not read logs. Verify the discovered log group and IAM logs permissions."
    return 0
  fi
  printf '%s' "${events_json}" | redact_log_events_json
}

tail_logs() {
  section "Following ${DISCOVERED_LOG_GROUP} (best-effort redacted; Ctrl-C to stop)"
  warn "Application logs can contain sensitive data even after pattern-based redaction."
  aws_cli logs tail "${DISCOVERED_LOG_GROUP}" --since 30m --follow --format short 2>&1 \
    | redact_log_lines \
    || warn "Log tail ended or AWS CLI v2 'logs tail' is unavailable."
}

show_rds() {
  section "RDS status"
  # [refactor jul11 ops] Bash + db_status naming avoids ecs-health.sh's zsh readonly `$status` crash.
  local db_status
  db_status="$(aws_cli rds describe-db-instances --db-instance-identifier "${RDS_ID}" \
    --query 'DBInstances[0].DBInstanceStatus' --output text 2>/dev/null || true)"
  if [[ "${db_status}" == "available" ]]; then
    ok "${RDS_ID}: available"
  elif [[ -z "${db_status}" || "${db_status}" == "None" ]]; then
    warn "RDS '${RDS_ID}' was not found or cannot be described."
  else
    fail "${RDS_ID}: ${db_status}"
  fi
  aws_cli rds describe-db-instances --db-instance-identifier "${RDS_ID}" \
    --query 'DBInstances[0].{status:DBInstanceStatus,class:DBInstanceClass,engine:EngineVersion,storageGiB:AllocatedStorage,maxStorageGiB:MaxAllocatedStorage,multiAZ:MultiAZ,performanceInsights:PerformanceInsightsEnabled}' \
    --output table 2>/dev/null || true
}

show_alarms() {
  section "CloudWatch alarms currently in ALARM"
  local alarm_count
  alarm_count="$(aws_cli cloudwatch describe-alarms --state-value ALARM \
    --query 'length(MetricAlarms)' --output text 2>/dev/null || printf 'unknown')"
  if [[ "${alarm_count}" == "0" ]]; then
    ok "No metric alarms are in ALARM."
  else
    aws_cli cloudwatch describe-alarms --state-value ALARM \
      --query 'MetricAlarms[*].{name:AlarmName,reason:StateReason,updated:StateUpdatedTimestamp}' \
      --output table || warn "Could not read alarms."
  fi
}

show_autoscaling() {
  local resource_id
  resource_id="$(scalable_resource_id)"
  section "Application Auto Scaling"
  aws_cli application-autoscaling describe-scalable-targets \
    --service-namespace ecs --resource-ids "${resource_id}" \
    --scalable-dimension ecs:service:DesiredCount \
    --query 'ScalableTargets[*].{min:MinCapacity,max:MaxCapacity,suspended:SuspendedState,created:CreationTime}' \
    --output table || warn "Could not read the ECS scalable target."
  aws_cli application-autoscaling describe-scaling-policies \
    --service-namespace ecs --resource-id "${resource_id}" \
    --scalable-dimension ecs:service:DesiredCount \
    --query 'ScalingPolicies[*].{name:PolicyName,type:PolicyType,target:TargetTrackingScalingPolicyConfiguration.TargetValue,scaleInDisabled:TargetTrackingScalingPolicyConfiguration.DisableScaleIn}' \
    --output table || warn "Could not read scaling policies."
  aws_cli application-autoscaling describe-scheduled-actions \
    --service-namespace ecs --resource-id "${resource_id}" \
    --scalable-dimension ecs:service:DesiredCount \
    --query 'ScheduledActions[*].{name:ScheduledActionName,schedule:Schedule,start:StartTime,end:EndTime,min:ScalableTargetAction.MinCapacity,max:ScalableTargetAction.MaxCapacity}' \
    --output table || warn "Could not read scheduled scaling actions."
  aws_cli application-autoscaling describe-scaling-activities \
    --service-namespace ecs --resource-id "${resource_id}" \
    --scalable-dimension ecs:service:DesiredCount --max-items 10 \
    --query 'ScalingActivities[*].{time:StartTime,status:StatusCode,cause:Cause,detail:StatusMessage}' \
    --output table || warn "Could not read recent scaling activity."
}

show_full_diagnosis() {
  # show_quick_status refreshes the service/target snapshots and prints the one context header.
  show_quick_status
  show_service_and_deployments
  show_service_events
  show_autoscaling
  show_task_definition
  show_tasks_for_status RUNNING "Running ECS tasks"
  show_tasks_for_status PENDING "Pending ECS tasks"
  show_tasks_for_status STOPPED "Recently stopped ECS tasks"
  show_target_health
  show_recent_logs 120
  show_rds
  show_alarms

  section "Next evidence"
  info "Run: ./aws_tools.sh metrics   # request/503/target-5xx/CPU evidence"
  info "Run: ./aws_tools.sh security  # WAF samples and GuardDuty findings"
  info "If startup is slow and grace=0, inspect logs first; then use guarded [grace] + [redeploy]."
}

cw_sum() {
  local namespace="$1" metric="$2"
  shift 2
  local start end period
  start="$(iso_minutes_ago "${METRIC_MINUTES}")"
  end="$(iso_now)"
  period=300
  (( METRIC_MINUTES <= 15 )) && period=60
  aws_cli cloudwatch get-metric-statistics --namespace "${namespace}" --metric-name "${metric}" \
    --start-time "${start}" --end-time "${end}" --period "${period}" --statistics Sum \
    --dimensions "$@" --query 'sum(Datapoints[].Sum)' --output text 2>/dev/null || printf 'n/a'
}

cw_latest_average_extreme() {
  local namespace="$1" metric="$2" extreme="$3"
  shift 3
  local start end period datapoints
  start="$(iso_minutes_ago "${METRIC_MINUTES}")"
  end="$(iso_now)"
  period=300
  (( METRIC_MINUTES <= 15 )) && period=60
  if ! datapoints="$(aws_cli cloudwatch get-metric-statistics --namespace "${namespace}" --metric-name "${metric}" \
    --start-time "${start}" --end-time "${end}" --period "${period}" --statistics Average "${extreme}" \
    --dimensions "$@" --output json 2>/dev/null)"; then
    printf 'n/a'
    return 0
  fi
  python3 -c '
import json
import sys
d = json.load(sys.stdin).get("Datapoints") or []
kind = sys.argv[1]
if not d:
    print("n/a")
    raise SystemExit
d.sort(key=lambda p: p.get("Timestamp", ""))
latest = d[-1]
latest_avg = latest.get("Average", "n/a")
latest_time = latest.get("Timestamp", "?")
usable = [p for p in d if kind in p]
if not usable:
    print(f"latest_avg={latest_avg} @ {latest_time}; window_{kind.lower()}=n/a")
    raise SystemExit
chosen = (max if kind == "Maximum" else min)(usable, key=lambda p: p[kind])
chosen_value = chosen[kind]
chosen_time = chosen.get("Timestamp", "?")
print(f"latest_avg={latest_avg} @ {latest_time}; window_{kind.lower()}={chosen_value} @ {chosen_time}")
' "${extreme}" <<<"${datapoints}" 2>/dev/null || printf 'n/a'
}

metric_row() {
  printf '  %-34s %s\n' "$1" "$2"
}

show_metrics() {
  context_header
  section "CloudWatch traffic window: last ${METRIC_MINUTES} minutes"
  if [[ -z "${ALB_DIMENSION}" ]]; then
    fail "ALB was not discovered; cannot query ALB metrics."
  else
    local lb_dim="Name=LoadBalancer,Value=${ALB_DIMENSION}"
    info "Shared-ALB totals below include BlueprintParser and Label Studio routes."
    metric_row "Shared ALB requests (sum)" "$(cw_sum AWS/ApplicationELB RequestCount "${lb_dim}")"
    metric_row "Shared ALB new connections" "$(cw_sum AWS/ApplicationELB NewConnectionCount "${lb_dim}")"
    metric_row "Shared ALB active connections" "$(cw_sum AWS/ApplicationELB ActiveConnectionCount "${lb_dim}")"
    metric_row "Shared ALB-originated 4xx" "$(cw_sum AWS/ApplicationELB HTTPCode_ELB_4XX_Count "${lb_dim}")"
    metric_row "Shared ALB-originated 503" "$(cw_sum AWS/ApplicationELB HTTPCode_ELB_503_Count "${lb_dim}")"
    metric_row "Shared ALB-originated 504" "$(cw_sum AWS/ApplicationELB HTTPCode_ELB_504_Count "${lb_dim}")"
    metric_row "Shared ALB-originated all 5xx" "$(cw_sum AWS/ApplicationELB HTTPCode_ELB_5XX_Count "${lb_dim}")"
    metric_row "Shared rejected connections" "$(cw_sum AWS/ApplicationELB RejectedConnectionCount "${lb_dim}")"
    metric_row "Shared low-reputation denied" "$(cw_sum AWS/ApplicationELB LowReputationRequestsDenied "${lb_dim}")"
    metric_row "Shared reputation packets drop" "$(cw_sum AWS/ApplicationELB LowReputationPacketsDropped "${lb_dim}")"

    if [[ -n "${TARGET_GROUP_DIMENSION}" ]]; then
      local tg_dim="Name=TargetGroup,Value=${TARGET_GROUP_DIMENSION}"
      info "BlueprintParser target-group metrics:"
      metric_row "App requests (sum)" "$(cw_sum AWS/ApplicationELB RequestCount "${tg_dim}" "${lb_dim}")"
      metric_row "Target 4xx (sum)" "$(cw_sum AWS/ApplicationELB HTTPCode_Target_4XX_Count "${tg_dim}" "${lb_dim}")"
      metric_row "Target 5xx (sum)" "$(cw_sum AWS/ApplicationELB HTTPCode_Target_5XX_Count "${tg_dim}" "${lb_dim}")"
      metric_row "Target connection errors (sum)" "$(cw_sum AWS/ApplicationELB TargetConnectionErrorCount "${tg_dim}" "${lb_dim}")"
      metric_row "Target latency latest/window max" "$(cw_latest_average_extreme AWS/ApplicationELB TargetResponseTime Maximum "${tg_dim}" "${lb_dim}")"
      metric_row "Healthy hosts latest/window min" "$(cw_latest_average_extreme AWS/ApplicationELB HealthyHostCount Minimum "${tg_dim}" "${lb_dim}")"
      metric_row "Unhealthy hosts latest/window max" "$(cw_latest_average_extreme AWS/ApplicationELB UnHealthyHostCount Maximum "${tg_dim}" "${lb_dim}")"
    fi
  fi

  section "ECS pressure"
  local cluster_dim="Name=ClusterName,Value=${CLUSTER}"
  local service_dim="Name=ServiceName,Value=${SERVICE}"
  metric_row "CPU latest avg/window max" "$(cw_latest_average_extreme AWS/ECS CPUUtilization Maximum "${cluster_dim}" "${service_dim}")"
  metric_row "Memory latest avg/window max" "$(cw_latest_average_extreme AWS/ECS MemoryUtilization Maximum "${cluster_dim}" "${service_dim}")"

  section "RDS pressure"
  local rds_dim="Name=DBInstanceIdentifier,Value=${RDS_ID}"
  metric_row "RDS CPU latest avg/window max" "$(cw_latest_average_extreme AWS/RDS CPUUtilization Maximum "${rds_dim}")"
  metric_row "RDS conn latest avg/window max" "$(cw_latest_average_extreme AWS/RDS DatabaseConnections Maximum "${rds_dim}")"
  metric_row "RDS memory latest avg/window min" "$(cw_latest_average_extreme AWS/RDS FreeableMemory Minimum "${rds_dim}")"

  section "How to read this"
  info "ALB 503 + 0 healthy hosts means availability failure, not proof of attack."
  info "RequestCount/NewConnectionCount spikes plus WAF blocks or reputation drops support an abuse hypothesis."
  info "Shared-ALB/WAF evidence includes Label Studio; target-group metrics are the app-specific slice."
  info "Target 5xx means the application generated errors; ALB-originated 503 means the load balancer lacked a ready target."
  info "RequestCount is reported only when the ALB can choose a target; use ELB 503/new connections/WAF for zero-target traffic evidence."
  info "Missing ECS CPU/memory datapoints are expected when no tasks are running."
}

show_waf_and_guardduty() {
  context_header
  section "AWS WAF association"
  if [[ -z "${ALB_ARN}" || "${ALB_ARN}" == "None" ]]; then
    warn "ALB was not discovered, so WAF association cannot be determined."
  elif (( WAF_QUERY_OK == 0 )); then
    warn "Unable to query the ALB's WAF association (API/permission failure); association is unknown."
  elif [[ -z "${WAF_ARN}" || "${WAF_ARN}" == "None" ]]; then
    warn "No regional WAF Web ACL is associated with the discovered ALB."
  else
    local waf_id waf_prefix waf_name waf_metric
    waf_id="${WAF_ARN##*/}"
    waf_prefix="${WAF_ARN%/*}"
    waf_name="${waf_prefix##*/}"
    ok "Associated Web ACL: ${waf_name}"
    info "${WAF_ARN}"
    waf_metric="$(aws_cli wafv2 get-web-acl --scope REGIONAL --name "${waf_name}" --id "${waf_id}" \
      --query 'WebACL.VisibilityConfig.MetricName' --output text 2>/dev/null || true)"
    aws_cli wafv2 get-web-acl --scope REGIONAL --name "${waf_name}" --id "${waf_id}" \
      --query 'WebACL.{defaultAction:DefaultAction,metric:VisibilityConfig.MetricName,rules:Rules[*].{priority:Priority,name:Name,metric:VisibilityConfig.MetricName}}' \
      --output json || warn "Could not read WAF rules."

    if [[ -n "${waf_metric}" && "${waf_metric}" != "None" ]]; then
      # WAF's WebACL CloudWatch dimension is the configured metric name, not the ACL display name.
      local webacl_dim="Name=WebACL,Value=${waf_metric}"
      local region_dim="Name=Region,Value=${REGION}"
      local all_rule_dim="Name=Rule,Value=ALL"
      local default_action_dim="Name=Rule,Value=Default_Action"
      metric_row "WAF rules allowed (sum)" "$(cw_sum AWS/WAFV2 AllowedRequests "${webacl_dim}" "${region_dim}" "${all_rule_dim}")"
      metric_row "WAF rules blocked (sum)" "$(cw_sum AWS/WAFV2 BlockedRequests "${webacl_dim}" "${region_dim}" "${all_rule_dim}")"
      metric_row "WAF default allowed (sum)" "$(cw_sum AWS/WAFV2 AllowedRequests "${webacl_dim}" "${region_dim}" "${default_action_dim}")"
      metric_row "WAF default blocked (sum)" "$(cw_sum AWS/WAFV2 BlockedRequests "${webacl_dim}" "${region_dim}" "${default_action_dim}")"
    else
      warn "Could not discover the Web ACL CloudWatch metric name."
    fi

    section "WAF sampled requests (safe fields only, previous ${METRIC_MINUTES} minutes)"
    local start end metrics metric rule_metrics
    start="$(iso_minutes_ago "${METRIC_MINUTES}")"
    end="$(iso_now)"
    rule_metrics="$(aws_cli wafv2 get-web-acl --scope REGIONAL --name "${waf_name}" --id "${waf_id}" \
      --query 'WebACL.Rules[*].VisibilityConfig.MetricName' --output text 2>/dev/null || true)"
    metrics="${rule_metrics}"
    if [[ -n "${waf_metric}" && "${waf_metric}" != "None" ]]; then
      metrics="${waf_metric} ${metrics}"
    fi
    if [[ -z "${metrics}" || "${metrics}" == "None" ]]; then
      info "No sampled-request metric names were returned."
    else
      for metric in ${metrics}; do
        printf '\n  Rule metric: %s\n' "${metric}"
        aws_cli wafv2 get-sampled-requests --web-acl-arn "${WAF_ARN}" \
          --rule-metric-name "${metric}" --scope REGIONAL \
          --time-window "StartTime=${start},EndTime=${end}" --max-items 25 \
          --query 'SampledRequests[*].[Timestamp,Action,Request.ClientIP,Request.Country,Request.Method,Request.URI,Weight]' \
          --output table 2>/dev/null || info "No sample or insufficient permission for ${metric}."
      done
    fi
  fi

  section "ALB access-log configuration"
  if [[ -n "${ALB_ARN}" && "${ALB_ARN}" != "None" ]]; then
    aws_cli elbv2 describe-load-balancer-attributes --load-balancer-arn "${ALB_ARN}" \
      --query 'Attributes[?starts_with(Key, `access_logs.s3`)]' --output table \
      || warn "Could not read ALB attributes."
  else
    warn "ALB not discovered."
  fi

  section "GuardDuty findings (severity >= 4)"
  local detector finding_ids
  if ! detector="$(aws_cli guardduty list-detectors --query 'DetectorIds[0]' --output text 2>/dev/null)"; then
    warn "Unable to query GuardDuty detectors (API/permission failure); GuardDuty evidence is unknown."
  elif [[ -z "${detector}" || "${detector}" == "None" ]]; then
    info "No GuardDuty detector found in ${REGION}."
  else
    if ! finding_ids="$(aws_cli guardduty list-findings --detector-id "${detector}" \
      --finding-criteria '{"Criterion":{"severity":{"Gte":4}}}' --max-items 20 \
      --query 'FindingIds' --output text 2>/dev/null)"; then
      warn "Unable to query GuardDuty findings (API/permission failure); finding status is unknown."
    elif [[ -z "${finding_ids}" || "${finding_ids}" == "None" ]]; then
      ok "No retained GuardDuty findings with severity >= 4."
    else
      # shellcheck disable=SC2086 -- AWS CLI expects one argument per finding id from its text output.
      aws_cli guardduty get-findings --detector-id "${detector}" --finding-ids ${finding_ids} \
        --query 'Findings[*].{severity:Severity,title:Title,type:Type,updated:UpdatedAt,archived:Service.Archived}' \
        --output table || warn "Could not read GuardDuty finding details."
    fi
  fi

  section "Security interpretation"
  info "WAF samples are sampled evidence, not a complete access log."
  info "High request volume alone is not a DDoS verdict; correlate request rate, WAF blocks, reputation drops, and target health."
  info "This tool intentionally does not auto-edit WAF rules or IAM policies during an incident."
}

scalable_resource_id() {
  printf 'service/%s/%s' "${CLUSTER}" "${SERVICE}"
}

state_file_path() {
  local safe_account safe_region safe_cluster safe_service base
  safe_account="${ACCOUNT_ID//[^A-Za-z0-9_.-]/_}"
  safe_region="${REGION//[^A-Za-z0-9_.-]/_}"
  safe_cluster="${CLUSTER//[^A-Za-z0-9_.-]/_}"
  safe_service="${SERVICE//[^A-Za-z0-9_.-]/_}"
  base="${XDG_STATE_HOME:-${HOME}/.local/state}/blueprintparser"
  printf '%s/aws-tools-pause-%s-%s-%s-%s.tsv' \
    "${base}" "${safe_account}" "${safe_region}" "${safe_cluster}" "${safe_service}"
}

load_autoscaling_snapshot() {
  local resource_id json parsed
  resource_id="$(scalable_resource_id)"
  if ! json="$(aws_cli application-autoscaling describe-scalable-targets \
    --service-namespace ecs --resource-ids "${resource_id}" \
    --scalable-dimension ecs:service:DesiredCount --output json 2>/dev/null)"; then
    fail "Could not inspect Application Auto Scaling for ${resource_id}."
    return 1
  fi
  if ! parsed="$(python3 -c '
import json,sys
t=(json.load(sys.stdin).get("ScalableTargets") or [None])[0]
if not t:
    print("0|0|0|false|false|false")
else:
    s=t.get("SuspendedState") or {}
    vals=[1,t.get("MinCapacity",0),t.get("MaxCapacity",0),
          str(bool(s.get("DynamicScalingInSuspended",False))).lower(),
          str(bool(s.get("DynamicScalingOutSuspended",False))).lower(),
          str(bool(s.get("ScheduledScalingSuspended",False))).lower()]
    print("|".join(map(str,vals)))
' <<<"${json}")"; then
    fail "Application Auto Scaling returned data this tool could not parse."
    return 1
  fi
  local old_ifs="${IFS}"
  IFS='|' read -r AS_PRESENT AS_MIN AS_MAX AS_IN_SUSPENDED AS_OUT_SUSPENDED AS_SCHEDULED_SUSPENDED <<<"${parsed}"
  IFS="${old_ifs}"
}

write_pause_state() {
  local path="$1" previous_desired="$2" pause_complete="${3:-0}" tmp
  mkdir -p "$(dirname "${path}")"
  umask 077
  tmp="${path}.tmp.$$"
  {
    printf 'version\t%s\n' "1"
    printf 'account_id\t%s\n' "${ACCOUNT_ID}"
    printf 'region\t%s\n' "${REGION}"
    printf 'cluster\t%s\n' "${CLUSTER}"
    printf 'service\t%s\n' "${SERVICE}"
    printf 'previous_desired\t%s\n' "${previous_desired}"
    printf 'as_present\t%s\n' "${AS_PRESENT}"
    printf 'as_min\t%s\n' "${AS_MIN}"
    printf 'as_max\t%s\n' "${AS_MAX}"
    printf 'as_in_suspended\t%s\n' "${AS_IN_SUSPENDED}"
    printf 'as_out_suspended\t%s\n' "${AS_OUT_SUSPENDED}"
    printf 'as_scheduled_suspended\t%s\n' "${AS_SCHEDULED_SUSPENDED}"
    printf 'pause_complete\t%s\n' "${pause_complete}"
    printf 'saved_at\t%s\n' "$(iso_now)"
  } >"${tmp}"
  chmod 600 "${tmp}"
  mv "${tmp}" "${path}"
}

load_pause_state() {
  local path="$1" key value
  STATE_VERSION="" STATE_ACCOUNT_ID="" STATE_REGION="" STATE_CLUSTER="" STATE_SERVICE=""
  STATE_PREVIOUS_DESIRED="" STATE_AS_PRESENT="" STATE_AS_MIN="" STATE_AS_MAX=""
  STATE_AS_IN_SUSPENDED="" STATE_AS_OUT_SUSPENDED="" STATE_AS_SCHEDULED_SUSPENDED=""
  STATE_PAUSE_COMPLETE="" STATE_SAVED_AT=""

  # [refactor jul11 ops] Parse an allowlisted TSV format; never `source` incident state as shell code.
  while IFS=$'\t' read -r key value; do
    case "${key}" in
      version) STATE_VERSION="${value}" ;;
      account_id) STATE_ACCOUNT_ID="${value}" ;;
      region) STATE_REGION="${value}" ;;
      cluster) STATE_CLUSTER="${value}" ;;
      service) STATE_SERVICE="${value}" ;;
      previous_desired) STATE_PREVIOUS_DESIRED="${value}" ;;
      as_present) STATE_AS_PRESENT="${value}" ;;
      as_min) STATE_AS_MIN="${value}" ;;
      as_max) STATE_AS_MAX="${value}" ;;
      as_in_suspended) STATE_AS_IN_SUSPENDED="${value}" ;;
      as_out_suspended) STATE_AS_OUT_SUSPENDED="${value}" ;;
      as_scheduled_suspended) STATE_AS_SCHEDULED_SUSPENDED="${value}" ;;
      pause_complete) STATE_PAUSE_COMPLETE="${value}" ;;
      saved_at) STATE_SAVED_AT="${value}" ;;
      "") ;;
      *) fail "Pause state contains unknown field '${key}'."; return 1 ;;
    esac
  done <"${path}"

  if [[ "${STATE_VERSION}" != "1" || ! "${STATE_ACCOUNT_ID}" =~ ^[0-9]{12}$ || \
        ! "${STATE_PREVIOUS_DESIRED}" =~ ^[0-9]+$ || ! "${STATE_AS_PRESENT}" =~ ^[01]$ || \
        ! "${STATE_AS_MIN}" =~ ^[0-9]+$ || ! "${STATE_AS_MAX}" =~ ^[0-9]+$ || \
        ! "${STATE_PAUSE_COMPLETE}" =~ ^[01]$ ]]; then
    fail "Pause state is incomplete or malformed: ${path}"
    return 1
  fi
  if [[ "${STATE_AS_PRESENT}" == "1" ]] && (( STATE_AS_MIN > STATE_AS_MAX )); then
    fail "Pause state has an autoscaling minimum greater than its maximum."
    return 1
  fi
  case "${STATE_AS_IN_SUSPENDED}/${STATE_AS_OUT_SUSPENDED}/${STATE_AS_SCHEDULED_SUSPENDED}" in
    true/true/true|true/true/false|true/false/true|true/false/false|false/true/true|false/true/false|false/false/true|false/false/false) ;;
    *) fail "Pause state has invalid autoscaling suspension flags."; return 1 ;;
  esac
}

restore_autoscaling_values() {
  local min="$1" max="$2" in_suspended="$3" out_suspended="$4" scheduled_suspended="$5"
  aws_mutate application-autoscaling register-scalable-target \
    --service-namespace ecs --resource-id "$(scalable_resource_id)" \
    --scalable-dimension ecs:service:DesiredCount \
    --min-capacity "${min}" --max-capacity "${max}" \
    --suspended-state "DynamicScalingInSuspended=${in_suspended},DynamicScalingOutSuspended=${out_suspended},ScheduledScalingSuspended=${scheduled_suspended}" \
    --output text
}

confirm_mutation() {
  local expected="$1"
  section "Mutation confirmation"
  warn "AWS account: ${ACCOUNT_ID}"
  warn "Region: ${REGION}"
  warn "ECS service: ${CLUSTER}/${SERVICE}"
  if (( ASSUME_YES )); then
    warn "--yes supplied; typed confirmation skipped."
    return 0
  fi
  printf '  Type %b%s%b to continue: ' "${BOLD}" "${expected}" "${NC}"
  local answer
  read -r answer
  [[ "${answer}" == "${expected}" ]]
}

wait_for_service_stopped() {
  local timeout_seconds="${1:-180}"
  local deadline=$((SECONDS + timeout_seconds))
  section "Waiting for ECS to drain"
  while (( SECONDS < deadline )); do
    if load_service_snapshot; then
      info "desired/running/pending: ${DESIRED_COUNT}/${RUNNING_COUNT}/${PENDING_COUNT}"
      if (( DESIRED_COUNT == 0 && RUNNING_COUNT == 0 && PENDING_COUNT == 0 )); then
        return 0
      fi
    fi
    sleep 5
  done
  return 1
}

wait_for_service_ready() {
  local expected_desired="$1" timeout_seconds="${2:-300}"
  local deadline=$((SECONDS + timeout_seconds))
  section "Waiting for ECS and ALB readiness"
  while (( SECONDS < deadline )); do
    if load_service_snapshot; then
      load_target_snapshot
      info "desired/running/pending=${DESIRED_COUNT}/${RUNNING_COUNT}/${PENDING_COUNT}; targets healthy/total=${TARGET_HEALTHY}/${TARGET_TOTAL}"
      if (( DESIRED_COUNT == expected_desired && RUNNING_COUNT == expected_desired && PENDING_COUNT == 0 )); then
        if (( expected_desired == 0 )); then
          return 0
        fi
        if [[ -n "${TARGET_GROUP_ARN}" && "${TARGET_GROUP_ARN}" != "None" ]] && \
           (( TARGET_QUERY_OK == 1 && TARGET_HEALTHY >= expected_desired )); then
          return 0
        fi
      fi
    fi
    sleep 5
  done
  return 1
}

pause_web_service() {
  load_service_snapshot || return 1
  load_autoscaling_snapshot || {
    fail "Refusing to pause without knowing whether autoscaling can restore desired count."
    return 1
  }
  context_header
  section "Pause plan"
  info "Current desired/running/pending: ${DESIRED_COUNT}/${RUNNING_COUNT}/${PENDING_COUNT}"
  if [[ "${AS_PRESENT}" == "1" ]]; then
    info "Autoscaling target: min=${AS_MIN}, max=${AS_MAX}, suspended(in/out/scheduled)=${AS_IN_SUSPENDED}/${AS_OUT_SUSPENDED}/${AS_SCHEDULED_SUSPENDED}"
    info "Pause will snapshot it and suspend all scaling before desired=0; min/max stay unchanged."
  else
    info "No Application Auto Scaling target is registered for this service."
  fi
  warn "Scope: web ECS only. RDS/Lambda/SFN/SageMaker/background jobs keep running."
  warn "Terraform apply can restore the Terraform-managed desired/min/max values; resume before applying Terraform."

  local state_file previous_desired
  state_file="$(state_file_path)"
  previous_desired="${DESIRED_COUNT}"

  if (( DESIRED_COUNT == 0 )); then
    warn "Service already has desired count 0. No mutation sent."
    [[ -f "${state_file}" ]] && info "A saved pause state exists; use ./aws_tools.sh resume when ready."
    return 0
  fi
  if (( DRY_RUN == 0 )) && [[ -e "${state_file}" ]]; then
    fail "A prior pause-state file already exists: ${state_file}"
    info "Refusing to overwrite recovery evidence. Resume it or inspect/remove it deliberately."
    return 1
  fi
  if ! confirm_mutation "PAUSE ${SERVICE} IN ${ACCOUNT_ID}"; then
    info "Cancelled."
    return 0
  fi

  if (( DRY_RUN == 0 )); then
    write_pause_state "${state_file}" "${previous_desired}" 0
    info "Recovery state saved with mode 0600: ${state_file}"
  fi

  if [[ "${AS_PRESENT}" == "1" ]]; then
    if ! aws_mutate application-autoscaling register-scalable-target \
      --service-namespace ecs --resource-id "$(scalable_resource_id)" \
      --scalable-dimension ecs:service:DesiredCount \
      --min-capacity "${AS_MIN}" --max-capacity "${AS_MAX}" \
      --suspended-state DynamicScalingInSuspended=true,DynamicScalingOutSuspended=true,ScheduledScalingSuspended=true \
      --output text; then
      fail "Could not suspend autoscaling; ECS desired count was NOT changed."
      return 1
    fi
    ok "Autoscaling suspended; configured min/max preserved."
  fi

  if ! aws_mutate ecs update-service --cluster "${CLUSTER}" --service "${SERVICE}" \
    --desired-count 0 --query 'service.{name:serviceName,desired:desiredCount}' --output table; then
    fail "ECS pause failed. Attempting to restore the autoscaling snapshot."
    if [[ "${AS_PRESENT}" == "1" ]]; then
      restore_autoscaling_values "${AS_MIN}" "${AS_MAX}" "${AS_IN_SUSPENDED}" "${AS_OUT_SUSPENDED}" "${AS_SCHEDULED_SUSPENDED}" || true
    fi
    return 1
  fi

  if (( DRY_RUN )); then
    ok "Dry-run pause plan completed; no AWS or local state was changed."
    return 0
  fi

  if wait_for_service_stopped 180; then
    write_pause_state "${state_file}" "${previous_desired}" 1
    ok "Web ECS is at desired/running/pending 0/0/0. The ALB will return 503 while paused."
  else
    fail "ECS did not reach 0/0/0 within 180 seconds. Recovery state is retained."
    info "Run status/events, then use resume if you want to reverse the pause."
    return 1
  fi
  info "Resume with: ./aws_tools.sh resume${PROFILE:+ --profile ${PROFILE}}"
}

resume_web_service() {
  local state_file
  state_file="$(state_file_path)"
  context_header
  section "Resume plan"

  if [[ ! -f "${state_file}" ]]; then
    fail "No pause-state file found at ${state_file}."
    info "Refusing to guess the former autoscaling min/max/suspension values."
    info "Use AWS/Terraform evidence to restore them, or run the original machine's aws_tools.sh resume."
    return 1
  fi

  if [[ -L "${state_file}" ]]; then
    fail "Pause state is a symbolic link; refusing to read it."
    return 1
  fi
  load_pause_state "${state_file}" || return 1
  if [[ "${STATE_ACCOUNT_ID:-}" != "${ACCOUNT_ID}" || "${STATE_REGION:-}" != "${REGION}" || \
        "${STATE_CLUSTER:-}" != "${CLUSTER}" || "${STATE_SERVICE:-}" != "${SERVICE}" ]]; then
    fail "Pause state does not match the current AWS account/region/service."
    return 1
  fi

  info "Saved at: ${STATE_SAVED_AT:-unknown}"
  [[ "${STATE_PAUSE_COMPLETE}" == "1" ]] || warn "The saved pause did not confirm a complete 0/0/0 drain."
  info "Restore desired count: ${STATE_PREVIOUS_DESIRED}"
  if [[ "${STATE_AS_PRESENT}" == "1" ]]; then
    info "Restore autoscaling: min=${STATE_AS_MIN}, max=${STATE_AS_MAX}, suspended=${STATE_AS_IN_SUSPENDED}/${STATE_AS_OUT_SUSPENDED}/${STATE_AS_SCHEDULED_SUSPENDED}"
  fi
  if ! confirm_mutation "RESUME ${SERVICE} IN ${ACCOUNT_ID} TO ${STATE_PREVIOUS_DESIRED}"; then
    info "Cancelled."
    return 0
  fi

  local service_ok=0 ready_ok=0 autoscaling_ok=0
  if aws_mutate ecs update-service --cluster "${CLUSTER}" --service "${SERVICE}" \
    --desired-count "${STATE_PREVIOUS_DESIRED}" \
    --query 'service.{name:serviceName,desired:desiredCount}' --output table; then
    service_ok=1
    ok "ECS desired count restored to ${STATE_PREVIOUS_DESIRED}."
  else
    fail "Could not restore ECS desired count."
  fi

  if (( DRY_RUN && service_ok )); then
    ready_ok=1
    info "Dry run: readiness wait skipped."
  elif (( service_ok )) && wait_for_service_ready "${STATE_PREVIOUS_DESIRED}" 300; then
    ready_ok=1
    ok "ECS desired count is restored and the ALB has a healthy target."
  elif (( service_ok )); then
    fail "Service did not become stable with a healthy ALB target within 300 seconds."
    info "Autoscaling remains suspended and the state file is retained; inspect status/logs/events, then retry resume."
  fi

  if (( ready_ok )) && [[ "${STATE_AS_PRESENT}" == "1" ]]; then
    if restore_autoscaling_values "${STATE_AS_MIN}" "${STATE_AS_MAX}" \
      "${STATE_AS_IN_SUSPENDED}" "${STATE_AS_OUT_SUSPENDED}" "${STATE_AS_SCHEDULED_SUSPENDED}"; then
      autoscaling_ok=1
      ok "Exact autoscaling target state restored."
    else
      fail "Could not restore autoscaling. State file retained for retry."
    fi
  elif (( ready_ok )); then
    autoscaling_ok=1
  fi

  if (( DRY_RUN )); then
    info "Dry run complete; state file retained."
  elif (( service_ok && ready_ok && autoscaling_ok )); then
    rm -f "${state_file}"
    ok "Resume complete; pause-state file removed."
    info "Use status/logs to watch startup."
  else
    return 1
  fi
}

set_health_grace() {
  context_header
  section "Set health-check grace"
  info "Current grace: ${HEALTH_GRACE}s; proposed: 120s. This does not deploy by itself."
  warn "This is an out-of-band ECS change. A later Terraform apply can revert it unless ecs.tf also declares 120s."
  if ! confirm_mutation "GRACE ${SERVICE} IN ${ACCOUNT_ID} 120"; then
    info "Cancelled."
    return 0
  fi
  aws_mutate ecs update-service --cluster "${CLUSTER}" --service "${SERVICE}" \
    --health-check-grace-period-seconds 120 \
    --query 'service.{name:serviceName,grace:healthCheckGracePeriodSeconds}' --output table
}

force_redeployment() {
  context_header
  section "Force new deployment"
  warn "This restarts the current task-definition revision; it does not build or push an image."
  info "Current task definition: ${TASK_DEFINITION_ARN}"
  if ! confirm_mutation "DEPLOY ${SERVICE} IN ${ACCOUNT_ID}"; then
    info "Cancelled."
    return 0
  fi
  aws_mutate ecs update-service --cluster "${CLUSTER}" --service "${SERVICE}" \
    --force-new-deployment \
    --query 'service.{name:serviceName,desired:desiredCount,taskDefinition:taskDefinition}' --output table
}

show_menu() {
  printf '\n%b━━━ Menu ━━━%b\n' "${BOLD}" "${NC}"
  printf '  %b1%b  Quick status + likely 503 cause       %b(read-only)%b\n' "${CYAN}" "${NC}" "${DIM}" "${NC}"
  printf '  %b2%b  Full ECS/ALB/task/log/RDS diagnosis  %b(read-only)%b\n' "${CYAN}" "${NC}" "${DIM}" "${NC}"
  printf '  %b3%b  Traffic and pressure metrics         %b(read-only)%b\n' "${CYAN}" "${NC}" "${DIM}" "${NC}"
  printf '  %b4%b  WAF samples + GuardDuty              %b(read-only)%b\n' "${CYAN}" "${NC}" "${DIM}" "${NC}"
  printf '  %b5%b  Recent application logs              %b(read-only)%b\n' "${CYAN}" "${NC}" "${DIM}" "${NC}"
  printf '  %b6%b  Follow application logs              %b(read-only; Ctrl-C)%b\n' "${CYAN}" "${NC}" "${DIM}" "${NC}"
  printf '\n'
  printf '  %bP%b  PAUSE web ECS safely                 %b(mutates; typed confirm)%b\n' "${RED}" "${NC}" "${YELLOW}" "${NC}"
  printf '  %bR%b  RESUME exact pre-pause state          %b(mutates; typed confirm)%b\n' "${GREEN}" "${NC}" "${YELLOW}" "${NC}"
  printf '  %bG%b  Set ECS health grace to 120s          %b(mutates; typed confirm)%b\n' "${YELLOW}" "${NC}" "${YELLOW}" "${NC}"
  printf '  %bD%b  Force current task revision redeploy  %b(mutates; typed confirm)%b\n' "${YELLOW}" "${NC}" "${YELLOW}" "${NC}"
  printf '\n'
  printf '  %bH%b  Help / safety scope\n' "${DIM}" "${NC}"
  printf '  %bQ%b  Quit\n\n' "${DIM}" "${NC}"
}

interactive_loop() {
  show_quick_status
  while true; do
    show_menu
    printf '%b> %b' "${BOLD}" "${NC}"
    local choice
    if ! read -r choice; then
      printf '\n'
      return 0
    fi
    case "${choice}" in
      1) show_quick_status ;;
      2) show_full_diagnosis ;;
      3) show_metrics ;;
      4) show_waf_and_guardduty ;;
      5) show_recent_logs 60 ;;
      6) tail_logs ;;
      p|P) pause_web_service ;;
      r|R) resume_web_service ;;
      g|G) load_service_snapshot && set_health_grace ;;
      d|D) load_service_snapshot && force_redeployment ;;
      h|H) usage ;;
      q|Q|0) info "Done."; return 0 ;;
      *) info "Unknown option." ;;
    esac
  done
}

main() {
  parse_args "$@"
  if [[ "${ACTION}" == "help" ]]; then
    usage
    return 0
  fi

  preflight
  discover_resources

  case "${ACTION}" in
    interactive) interactive_loop ;;
    status) show_quick_status ;;
    diagnose) show_full_diagnosis ;;
    metrics) show_metrics ;;
    security) show_waf_and_guardduty ;;
    logs) context_header; show_recent_logs 60 ;;
    tail) context_header; tail_logs ;;
    pause) pause_web_service ;;
    resume) resume_web_service ;;
    grace) load_service_snapshot && set_health_grace ;;
    redeploy) load_service_snapshot && force_redeployment ;;
    *) usage; return 2 ;;
  esac
}

main "$@"
