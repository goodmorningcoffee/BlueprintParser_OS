#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Beaver Cost Control TUI
# Manage SageMaker, ECS, and Step Functions from your terminal.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "${SCRIPT_DIR}/../.deploy.env" ] && source "${SCRIPT_DIR}/../.deploy.env"

ROLE_NAME="${ECS_TASK_ROLE:-blueprintparser-ecs-task-role}"
SFN_ROLE="${SFN_ROLE:-blueprintparser-step-functions-role}"
SM_KILL_POLICY="sagemaker-kill-switch"
SFN_KILL_POLICY="stepfunctions-kill-switch"
REGION="${AWS_REGION:-us-east-1}"
ECS_CLUSTER="${ECS_CLUSTER:-blueprintparser-cluster}"
ECS_SERVICE="${ECS_SERVICE:-blueprintparser-app}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ─── Status checks ───────────────────────────────────────────

check_sagemaker() {
  if aws iam get-role-policy --role-name "$ROLE_NAME" --policy-name "$SM_KILL_POLICY" 2>/dev/null | grep -q "Deny"; then
    echo "BLOCKED"
  else
    echo "ENABLED"
  fi
}

check_stepfunctions() {
  if aws iam get-role-policy --role-name "$SFN_ROLE" --policy-name "$SFN_KILL_POLICY" 2>/dev/null | grep -q "Deny"; then
    echo "BLOCKED"
  else
    echo "ENABLED"
  fi
}

check_ecs_service() {
  local desired
  desired=$(aws ecs describe-services --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" --region "$REGION" --query 'services[0].desiredCount' --output text 2>/dev/null)
  echo "${desired:-unknown}"
}

get_running_tasks() {
  aws ecs list-tasks --cluster "$ECS_CLUSTER" --region "$REGION" --query 'taskArns | length(@)' --output text 2>/dev/null || echo "?"
}

get_monthly_cost_estimate() {
  # ECS app cost (always on): 2 vCPU / 4 GB
  local ecs_hourly="0.137"  # ~$0.08 CPU + $0.018 mem
  local ecs_monthly
  ecs_monthly=$(echo "$ecs_hourly * 720" | bc 2>/dev/null || echo "~99")
  echo "\$${ecs_monthly}/mo"
}

# ─── Actions ─────────────────────────────────────────────────

toggle_sagemaker() {
  local status
  status=$(check_sagemaker)
  if [ "$status" = "BLOCKED" ]; then
    echo -e "${GREEN}Restoring SageMaker access...${NC}"
    aws iam delete-role-policy --role-name "$ROLE_NAME" --policy-name "$SM_KILL_POLICY" 2>/dev/null
    echo -e "${GREEN}SageMaker ENABLED${NC}"
  else
    echo -e "${RED}Blocking SageMaker access...${NC}"
    aws iam put-role-policy \
      --role-name "$ROLE_NAME" \
      --policy-name "$SM_KILL_POLICY" \
      --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"sagemaker:*","Resource":"*"}]}'
    echo -e "${RED}SageMaker BLOCKED${NC}"
  fi
}

toggle_stepfunctions() {
  local status
  status=$(check_stepfunctions)
  if [ "$status" = "BLOCKED" ]; then
    echo -e "${GREEN}Restoring Step Functions access...${NC}"
    aws iam delete-role-policy --role-name "$SFN_ROLE" --policy-name "$SFN_KILL_POLICY" 2>/dev/null
    echo -e "${GREEN}Step Functions ENABLED (uploads will process)${NC}"
  else
    echo -e "${RED}Blocking Step Functions access...${NC}"
    aws iam put-role-policy \
      --role-name "$SFN_ROLE" \
      --policy-name "$SFN_KILL_POLICY" \
      --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":["states:StartExecution","states:StopExecution"],"Resource":"*"}]}'
    echo -e "${RED}Step Functions BLOCKED (no new processing jobs)${NC}"
  fi
}

scale_ecs() {
  local current
  current=$(check_ecs_service)
  echo -e "Current desired count: ${BOLD}${current}${NC}"
  echo -n "New desired count (0 to stop, 1 to run): "
  read -r count
  if [[ "$count" =~ ^[0-9]+$ ]]; then
    aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" --desired-count "$count" --region "$REGION" --output text --query 'service.serviceName' > /dev/null
    echo -e "${GREEN}ECS service scaled to ${count}${NC}"
  else
    echo -e "${RED}Invalid number${NC}"
  fi
}

emergency_shutdown() {
  echo -e "${RED}${BOLD}EMERGENCY SHUTDOWN${NC}"
  echo -e "${RED}This will:${NC}"
  echo -e "  - Block SageMaker (no YOLO jobs)"
  echo -e "  - Block Step Functions (no processing)"
  echo -e "  - Scale ECS to 0 (app goes offline)"
  echo ""
  echo -n "Type 'SHUTDOWN' to confirm: "
  read -r confirm
  if [ "$confirm" = "SHUTDOWN" ]; then
    aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "$SM_KILL_POLICY" \
      --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"sagemaker:*","Resource":"*"}]}'
    aws iam put-role-policy --role-name "$SFN_ROLE" --policy-name "$SFN_KILL_POLICY" \
      --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":["states:StartExecution","states:StopExecution"],"Resource":"*"}]}'
    aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" --desired-count 0 --region "$REGION" --output text > /dev/null
    echo -e "${RED}${BOLD}ALL SERVICES SHUT DOWN${NC}"
    echo -e "Run this script again to restore services."
  else
    echo "Cancelled."
  fi
}

restore_all() {
  echo -e "${GREEN}Restoring all services...${NC}"
  aws iam delete-role-policy --role-name "$ROLE_NAME" --policy-name "$SM_KILL_POLICY" 2>/dev/null
  aws iam delete-role-policy --role-name "$SFN_ROLE" --policy-name "$SFN_KILL_POLICY" 2>/dev/null
  aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" --desired-count 1 --region "$REGION" --output text > /dev/null
  echo -e "${GREEN}${BOLD}ALL SERVICES RESTORED${NC}"
}

view_recent_costs() {
  echo -e "${CYAN}Fetching recent SageMaker jobs...${NC}"
  aws sagemaker list-processing-jobs \
    --region "$REGION" \
    --sort-by CreationTime \
    --sort-order Descending \
    --max-results 10 \
    --query 'ProcessingJobSummaries[].{Name:ProcessingJobName,Status:ProcessingJobStatus,Created:CreationTime}' \
    --output table 2>/dev/null || echo "No recent jobs or insufficient permissions."
  echo ""

  echo -e "${CYAN}Active ECS tasks:${NC}"
  aws ecs list-tasks --cluster "$ECS_CLUSTER" --region "$REGION" \
    --query 'taskArns' --output table 2>/dev/null || echo "Could not fetch tasks."
}

# ─── Main loop ───────────────────────────────────────────────

while true; do
  clear
  local_sm=$(check_sagemaker)
  local_sfn=$(check_stepfunctions)
  local_ecs=$(check_ecs_service)
  local_tasks=$(get_running_tasks)

  # Color status
  if [ "$local_sm" = "BLOCKED" ]; then sm_color="${RED}BLOCKED${NC}"; else sm_color="${GREEN}ENABLED${NC}"; fi
  if [ "$local_sfn" = "BLOCKED" ]; then sfn_color="${RED}BLOCKED${NC}"; else sfn_color="${GREEN}ENABLED${NC}"; fi
  if [ "$local_ecs" = "0" ]; then ecs_color="${RED}OFFLINE${NC}"; else ecs_color="${GREEN}${local_ecs} instance(s)${NC}"; fi

  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}  Beaver Cost Control${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "  SageMaker (YOLO):    $sm_color"
  echo -e "  Step Functions:      $sfn_color"
  echo -e "  ECS App:             $ecs_color"
  echo -e "  Running tasks:       ${local_tasks}"
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "  ${BOLD}1${NC}  Toggle SageMaker   (YOLO inference)"
  echo -e "  ${BOLD}2${NC}  Toggle Step Funcs   (PDF processing)"
  echo -e "  ${BOLD}3${NC}  Scale ECS           (web app instances)"
  echo -e "  ${BOLD}4${NC}  View recent jobs    (SageMaker + ECS)"
  echo -e "  ${BOLD}5${NC}  Restore all         (enable everything)"
  echo -e "  ${RED}${BOLD}9${NC}  ${RED}EMERGENCY SHUTDOWN${NC}  (kill everything)"
  echo -e "  ${BOLD}0${NC}  Exit"
  echo ""
  echo -n "  > "
  read -r choice

  case "$choice" in
    1) toggle_sagemaker; echo ""; read -rp "Press Enter to continue..." ;;
    2) toggle_stepfunctions; echo ""; read -rp "Press Enter to continue..." ;;
    3) scale_ecs; echo ""; read -rp "Press Enter to continue..." ;;
    4) view_recent_costs; echo ""; read -rp "Press Enter to continue..." ;;
    5) restore_all; echo ""; read -rp "Press Enter to continue..." ;;
    9) emergency_shutdown; echo ""; read -rp "Press Enter to continue..." ;;
    0|q) echo "Bye."; exit 0 ;;
    *) ;;
  esac
done
