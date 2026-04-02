#!/bin/zsh
set -uo pipefail

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  BlueprintParser — ECS Health Check & Recovery TUI
#  Run: ./ecs-health.sh
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "${SCRIPT_DIR}/.deploy.env" ] && source "${SCRIPT_DIR}/.deploy.env"

REGION="${AWS_REGION:-us-east-1}"
CLUSTER="${ECS_CLUSTER:?ERROR: Set ECS_CLUSTER in .deploy.env or environment}"
SERVICE="${ECS_SERVICE:?ERROR: Set ECS_SERVICE in .deploy.env or environment}"
LOG_GROUP="${LOG_GROUP:-/ecs/${SERVICE}}"
ALB_NAME="${ALB_NAME:?ERROR: Set ALB_NAME in .deploy.env or environment}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

header() { echo ""; echo -e "${CYAN}━━━ $1 ━━━${NC}"; }
ok()     { echo -e "  ${GREEN}✔${NC} $1"; }
warn()   { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail()   { echo -e "  ${RED}✘${NC} $1"; }
info()   { echo -e "  ${DIM}$1${NC}"; }

# ════════════════════════════════════════════════════════════════
# 1. Service Status
# ════════════════════════════════════════════════════════════════
check_service() {
  header "Service Status"

  local result
  result=$(aws ecs describe-services \
    --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
    --query 'services[0].{status:status,running:runningCount,desired:desiredCount,pending:pendingCount,healthGrace:healthCheckGracePeriodSeconds}' \
    --output json 2>/dev/null || echo '{}')

  local svc_status running desired pending grace
  svc_status=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','UNKNOWN'))" 2>/dev/null || echo "UNKNOWN")
  running=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('running',0))" 2>/dev/null || echo "0")
  desired=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('desired',0))" 2>/dev/null || echo "0")
  pending=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('pending',0))" 2>/dev/null || echo "0")
  grace=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('healthGrace',0))" 2>/dev/null || echo "0")

  if [ "$svc_status" = "ACTIVE" ] && [ "$running" = "$desired" ] && [ "$pending" = "0" ]; then
    ok "Service ACTIVE — $running/$desired running, 0 pending"
  elif [ "$pending" != "0" ]; then
    warn "Service ACTIVE — $running/$desired running, ${YELLOW}$pending pending${NC} (deploying)"
  elif [ "$running" != "$desired" ]; then
    fail "Service ACTIVE — ${RED}$running/$desired running${NC} (tasks failing)"
  else
    fail "Service status: $svc_status"
  fi

  if [ "$grace" = "0" ] || [ "$grace" = "null" ]; then
    fail "Health check grace period: ${RED}0 seconds${NC} — tasks may die before app starts"
    echo -e "    ${DIM}Fix: select option [F] below to set grace period to 120s${NC}"
  else
    ok "Health check grace period: ${grace}s"
  fi
}

# ════════════════════════════════════════════════════════════════
# 2. Deployments
# ════════════════════════════════════════════════════════════════
check_deployments() {
  header "Deployments"

  aws ecs describe-services \
    --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
    --query 'services[0].deployments[*].{status:status,running:runningCount,desired:desiredCount,rollout:rolloutState,created:createdAt}' \
    --output table 2>/dev/null || fail "Could not fetch deployments"

  local count
  count=$(aws ecs describe-services \
    --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
    --query 'length(services[0].deployments)' --output text 2>/dev/null || echo "0")

  if [ "$count" -gt 1 ]; then
    warn "$count deployments active — rolling update in progress"
  else
    ok "Single deployment (stable)"
  fi
}

# ════════════════════════════════════════════════════════════════
# 3. Recent Task Failures
# ════════════════════════════════════════════════════════════════
check_stopped_tasks() {
  header "Recent Task Failures (last 3)"

  local tasks
  tasks=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" \
    --desired-status STOPPED --region "$REGION" \
    --query 'taskArns[0:3]' --output text 2>/dev/null || echo "")

  if [ -z "$tasks" ] || [ "$tasks" = "None" ]; then
    ok "No recently stopped tasks"
    return
  fi

  for task_arn in $tasks; do
    local task_info
    task_info=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_arn" --region "$REGION" \
      --query 'tasks[0].{reason:stoppedReason,exit:containers[0].exitCode,status:lastStatus,started:startedAt,stopped:stoppedAt}' \
      --output json 2>/dev/null || echo '{}')

    local reason exit_code
    reason=$(echo "$task_info" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason','unknown'))" 2>/dev/null || echo "unknown")
    exit_code=$(echo "$task_info" | python3 -c "import sys,json; print(json.load(sys.stdin).get('exit','?'))" 2>/dev/null || echo "?")

    if echo "$reason" | grep -qi "health"; then
      fail "Health check failure (exit $exit_code): $reason"
    elif [ "$exit_code" != "0" ] && [ "$exit_code" != "?" ] && [ "$exit_code" != "None" ]; then
      fail "Crashed (exit $exit_code): $reason"
    else
      warn "Stopped: $reason"
    fi
  done
}

# ════════════════════════════════════════════════════════════════
# 4. ALB Target Health
# ════════════════════════════════════════════════════════════════
check_alb_targets() {
  header "ALB Target Health"

  local alb_arn
  alb_arn=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" --region "$REGION" \
    --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || echo "")

  if [ -z "$alb_arn" ] || [ "$alb_arn" = "None" ]; then
    fail "Could not find ALB '$ALB_NAME'"
    return
  fi

  local tg_arn
  tg_arn=$(aws elbv2 describe-target-groups --load-balancer-arn "$alb_arn" --region "$REGION" \
    --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || echo "")

  if [ -z "$tg_arn" ] || [ "$tg_arn" = "None" ]; then
    fail "No target group found"
    return
  fi

  aws elbv2 describe-target-health --target-group-arn "$tg_arn" --region "$REGION" \
    --query 'TargetHealthDescriptions[*].{target:Target.Id,port:Target.Port,state:TargetHealth.State,reason:TargetHealth.Reason}' \
    --output table 2>/dev/null || fail "Could not fetch target health"

  local healthy
  healthy=$(aws elbv2 describe-target-health --target-group-arn "$tg_arn" --region "$REGION" \
    --query 'length(TargetHealthDescriptions[?TargetHealth.State==`healthy`])' --output text 2>/dev/null || echo "0")

  local total
  total=$(aws elbv2 describe-target-health --target-group-arn "$tg_arn" --region "$REGION" \
    --query 'length(TargetHealthDescriptions)' --output text 2>/dev/null || echo "0")

  if [ "$healthy" = "$total" ] && [ "$total" != "0" ]; then
    ok "$healthy/$total targets healthy"
  elif [ "$healthy" = "0" ]; then
    fail "${RED}0/$total targets healthy — 504 errors expected${NC}"
  else
    warn "$healthy/$total targets healthy"
  fi
}

# ════════════════════════════════════════════════════════════════
# 5. Recent Logs
# ════════════════════════════════════════════════════════════════
check_logs() {
  header "Recent Errors (last 10 min)"

  local errors
  errors=$(aws logs filter-log-events \
    --log-group-name "$LOG_GROUP" \
    --start-time $(($(date +%s) * 1000 - 600000)) \
    --filter-pattern "ERROR" \
    --max-items 5 \
    --region "$REGION" \
    --query 'events[*].message' --output text 2>/dev/null || echo "")

  if [ -z "$errors" ]; then
    ok "No errors in last 10 minutes"
  else
    warn "Recent errors found:"
    echo "$errors" | head -10 | while IFS= read -r line; do
      echo -e "    ${DIM}${line:0:120}${NC}"
    done
  fi
}

# ════════════════════════════════════════════════════════════════
# 6. RDS Status
# ════════════════════════════════════════════════════════════════
check_rds() {
  header "RDS Database"

  local result
  result=$(aws rds describe-db-instances --db-instance-identifier ${RDS_ID:-beaver-db} --region "$REGION" \
    --query 'DBInstances[0].{status:DBInstanceStatus,cpu:PerformanceInsightsEnabled,storage:AllocatedStorage,multiAz:MultiAZ}' \
    --output json 2>/dev/null || echo '{}')

  local status
  status=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','unknown'))" 2>/dev/null || echo "unknown")

  if [ "$status" = "available" ]; then
    ok "RDS status: available"
  else
    fail "RDS status: $status"
  fi
}

# ════════════════════════════════════════════════════════════════
# 7. CloudWatch Alarms
# ════════════════════════════════════════════════════════════════
check_alarms() {
  header "CloudWatch Alarms"

  local alarming
  alarming=$(aws cloudwatch describe-alarms --state-value ALARM --region "$REGION" \
    --query 'MetricAlarms[*].AlarmName' --output text 2>/dev/null || echo "")

  if [ -z "$alarming" ] || [ "$alarming" = "None" ]; then
    ok "No alarms firing"
  else
    for alarm in $alarming; do
      fail "ALARM: $alarm"
    done
  fi
}

# ════════════════════════════════════════════════════════════════
# Menu
# ════════════════════════════════════════════════════════════════
show_menu() {
  echo ""
  echo -e "${BOLD}━━━ Actions ━━━${NC}"
  echo ""
  echo -e "  ${CYAN}[L]${NC}  Tail live logs (follow mode)"
  echo -e "  ${CYAN}[E]${NC}  Show only ERROR logs (last 30 min)"
  echo -e "  ${CYAN}[M]${NC}  Show migration/startup logs"
  echo -e "  ${CYAN}[T]${NC}  Show Textract throttle logs"
  echo ""
  echo -e "  ${YELLOW}[F]${NC}  FIX: Set health check grace period to 120s"
  echo -e "  ${YELLOW}[D]${NC}  FIX: Force new deployment"
  echo -e "  ${YELLOW}[R]${NC}  FIX: Grace period + force deploy (combo)"
  echo ""
  echo -e "  ${CYAN}[A]${NC}  Dump ALL diagnostics (copy-paste for debugging)"
  echo ""
  echo -e "  ${DIM}[S]${NC}  Re-run all checks"
  echo -e "  ${DIM}[Q]${NC}  Quit"
  echo ""
}

run_all_checks() {
  echo ""
  echo -e "${BOLD}BlueprintParser — ECS Health Check${NC}"
  echo -e "${DIM}Cluster: $CLUSTER | Service: $SERVICE | Region: $REGION${NC}"

  check_service
  check_deployments
  check_stopped_tasks
  check_alb_targets
  check_logs
  check_rds
  check_alarms
}

# ════════════════════════════════════════════════════════════════
# Main Loop
# ════════════════════════════════════════════════════════════════
run_all_checks
show_menu

while true; do
  echo -ne "${BOLD}> ${NC}"
  read -r choice

  choice=$(echo "$choice" | tr '[:upper:]' '[:lower:]')
  case "$choice" in
    l)
      echo -e "${DIM}Tailing logs (Ctrl+C to stop)...${NC}"
      aws logs tail "$LOG_GROUP" --since 5m --region "$REGION" --follow || true
      show_menu
      ;;
    e)
      header "ERROR logs (last 30 min)"
      aws logs tail "$LOG_GROUP" --since 30m --region "$REGION" --filter-pattern "ERROR" || true
      show_menu
      ;;
    m)
      header "Migration / Startup logs (last 15 min)"
      aws logs tail "$LOG_GROUP" --since 15m --region "$REGION" --filter-pattern "migration" || true
      echo ""
      aws logs tail "$LOG_GROUP" --since 15m --region "$REGION" --filter-pattern "Starting" || true
      show_menu
      ;;
    t)
      header "Textract Throttle logs (last 1 hr)"
      aws logs tail "$LOG_GROUP" --since 60m --region "$REGION" --filter-pattern "Throttled" || true
      show_menu
      ;;
    f)
      header "Setting health check grace period to 120s"
      aws ecs update-service \
        --cluster "$CLUSTER" --service "$SERVICE" \
        --health-check-grace-period-seconds 120 \
        --region "$REGION" > /dev/null 2>&1 && ok "Grace period set to 120s" || fail "Failed to update"
      show_menu
      ;;
    d)
      header "Forcing new deployment"
      aws ecs update-service \
        --cluster "$CLUSTER" --service "$SERVICE" \
        --force-new-deployment \
        --region "$REGION" > /dev/null 2>&1 && ok "New deployment triggered" || fail "Failed to deploy"
      echo -e "  ${DIM}Monitor: watch the deployment with [S] or [L]${NC}"
      show_menu
      ;;
    r)
      header "Combo Fix: Grace period + Force deploy"
      aws ecs update-service \
        --cluster "$CLUSTER" --service "$SERVICE" \
        --health-check-grace-period-seconds 120 \
        --region "$REGION" > /dev/null 2>&1 && ok "Grace period set to 120s" || fail "Grace period failed"
      aws ecs update-service \
        --cluster "$CLUSTER" --service "$SERVICE" \
        --force-new-deployment \
        --region "$REGION" > /dev/null 2>&1 && ok "New deployment triggered" || fail "Deploy failed"
      echo ""
      echo -e "  ${DIM}Typical timeline: ~2 min to pull image, ~30s to start, ~30s for health check${NC}"
      echo -e "  ${DIM}Run [S] in 3 minutes to verify${NC}"
      show_menu
      ;;
    a)
      echo ""
      echo "═══════════════════════════════════════════════════════"
      echo " FULL DIAGNOSTICS DUMP — $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
      echo " Cluster: $CLUSTER | Service: $SERVICE | Region: $REGION"
      echo "═══════════════════════════════════════════════════════"

      echo ""
      echo "--- SERVICE STATUS ---"
      aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
        --query 'services[0].{status:status,running:runningCount,desired:desiredCount,pending:pendingCount,healthGrace:healthCheckGracePeriodSeconds,deployments:deployments[*].{status:status,running:runningCount,desired:desiredCount,rollout:rolloutState,created:createdAt,image:taskDefinition}}' \
        --output json 2>/dev/null || echo "{}"

      echo ""
      echo "--- ALB TARGET HEALTH ---"
      local alb_arn_dump tg_arn_dump
      alb_arn_dump=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" --region "$REGION" \
        --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || echo "")
      if [ -n "$alb_arn_dump" ] && [ "$alb_arn_dump" != "None" ]; then
        tg_arn_dump=$(aws elbv2 describe-target-groups --load-balancer-arn "$alb_arn_dump" --region "$REGION" \
          --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || echo "")
        if [ -n "$tg_arn_dump" ] && [ "$tg_arn_dump" != "None" ]; then
          aws elbv2 describe-target-health --target-group-arn "$tg_arn_dump" --region "$REGION" --output json 2>/dev/null || echo "[]"
        fi
      fi

      echo ""
      echo "--- STOPPED TASKS (last 5) ---"
      local stopped_dump
      stopped_dump=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" \
        --desired-status STOPPED --region "$REGION" --query 'taskArns[0:5]' --output json 2>/dev/null || echo "[]")
      echo "$stopped_dump"
      for arn in $(echo "$stopped_dump" | python3 -c "import sys,json; [print(a) for a in json.load(sys.stdin)]" 2>/dev/null); do
        echo ""
        aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$arn" --region "$REGION" \
          --query 'tasks[0].{reason:stoppedReason,exit:containers[0].exitCode,health:containers[0].healthStatus,started:startedAt,stopped:stoppedAt}' \
          --output json 2>/dev/null || echo "{}"
      done

      echo ""
      echo "--- RDS STATUS ---"
      aws rds describe-db-instances --db-instance-identifier ${RDS_ID:-beaver-db} --region "$REGION" \
        --query 'DBInstances[0].{status:DBInstanceStatus,class:DBInstanceClass,storage:AllocatedStorage,multiAz:MultiAZ,engine:EngineVersion}' \
        --output json 2>/dev/null || echo "{}"

      echo ""
      echo "--- CLOUDWATCH ALARMS ---"
      aws cloudwatch describe-alarms --state-value ALARM --region "$REGION" \
        --query 'MetricAlarms[*].{name:AlarmName,state:StateValue,reason:StateReason}' \
        --output json 2>/dev/null || echo "[]"

      echo ""
      echo "--- ERROR LOGS (last 30 min, max 20) ---"
      aws logs filter-log-events \
        --log-group-name "$LOG_GROUP" \
        --start-time $(($(date +%s) * 1000 - 1800000)) \
        --filter-pattern "ERROR" \
        --max-items 20 \
        --region "$REGION" \
        --query 'events[*].{time:timestamp,msg:message}' --output json 2>/dev/null || echo "[]"

      echo ""
      echo "--- PROCESSING ERRORS (last 1 hr, max 10) ---"
      aws logs filter-log-events \
        --log-group-name "$LOG_GROUP" \
        --start-time $(($(date +%s) * 1000 - 3600000)) \
        --filter-pattern "\"Error processing page\"" \
        --max-items 10 \
        --region "$REGION" \
        --query 'events[*].{time:timestamp,msg:message}' --output json 2>/dev/null || echo "[]"

      echo ""
      echo "--- TEXTRACT THROTTLE (last 1 hr) ---"
      aws logs filter-log-events \
        --log-group-name "$LOG_GROUP" \
        --start-time $(($(date +%s) * 1000 - 3600000)) \
        --filter-pattern "Throttled" \
        --max-items 10 \
        --region "$REGION" \
        --query 'events[*].{time:timestamp,msg:message}' --output json 2>/dev/null || echo "[]"

      echo ""
      echo "═══════════════════════════════════════════════════════"
      echo " END DUMP — copy everything above for analysis"
      echo "═══════════════════════════════════════════════════════"
      show_menu
      ;;
    s)
      run_all_checks
      show_menu
      ;;
    q)
      echo -e "${DIM}Done.${NC}"
      exit 0
      ;;
    *)
      echo -e "${DIM}Unknown option. Press L/E/M/T/F/D/R/S/Q${NC}"
      ;;
  esac
done
