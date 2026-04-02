#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# BlueprintParser — Root Admin Management
#
# Runs SQL on the production RDS database via ECS exec (the running container
# has network access to the private-subnet DB; your local machine does not).
#
# Prerequisites:
#   - AWS CLI configured with credentials (same as deploy.sh)
#   - ECS Exec enabled on the service (enableExecuteCommand = true in terraform)
#   - Session Manager plugin installed
# ─────────────────────────────────────────────────────────────────────────────

AWS_REGION="us-east-1"
ECS_CLUSTER="beaver-cluster"
ECS_SERVICE="beaver-app"
CONTAINER_NAME="beaver-app"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ─── Get a running task ARN ──────────────────────────────────────────────────
get_task_arn() {
  if [ -z "${TASK_ARN:-}" ]; then
    echo -e "${DIM}Finding running ECS task...${NC}"
    TASK_ARN=$(aws ecs list-tasks \
      --cluster "$ECS_CLUSTER" \
      --service-name "$ECS_SERVICE" \
      --desired-status RUNNING \
      --query 'taskArns[0]' \
      --output text \
      --region "$AWS_REGION" 2>/dev/null) || {
      echo -e "${RED}Failed to find running tasks. Is the service running?${NC}"
      exit 1
    }
    if [ "$TASK_ARN" = "None" ] || [ -z "$TASK_ARN" ]; then
      echo -e "${RED}No running tasks found in ${ECS_SERVICE}.${NC}"
      exit 1
    fi
    echo -e "${GREEN}Task: ${TASK_ARN##*/}${NC}"
  fi
}

# ─── Run SQL via ECS exec (no parameters) ────────────────────────────────────
run_sql() {
  local sql="$1"
  get_task_arn
  aws ecs execute-command \
    --cluster "$ECS_CLUSTER" \
    --task "$TASK_ARN" \
    --container "$CONTAINER_NAME" \
    --interactive \
    --command "node -e \"
const{Pool}=require('pg');
const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
p.query(\\\`${sql}\\\`).then(r=>{
  if(r.rows&&r.rows.length>0){
    const c=Object.keys(r.rows[0]);
    console.log(c.map(k=>k.padEnd(25)).join(''));
    console.log(c.map(()=>'─'.repeat(25)).join(''));
    r.rows.forEach(row=>console.log(c.map(k=>String(row[k]??'').padEnd(25)).join('')));
    console.log('('+r.rows.length+' rows)');
  }else{console.log('OK — '+(r.rowCount||0)+' row(s) affected.');}
  p.end();
}).catch(e=>{console.error('SQL Error:',e.message);p.end();process.exit(1);});
\"" \
    --region "$AWS_REGION"
}

# ─── Run SQL with a parameterized value (safe for emails with quotes) ────────
run_sql_param() {
  local sql="$1"
  local param="$2"
  get_task_arn
  aws ecs execute-command \
    --cluster "$ECS_CLUSTER" \
    --task "$TASK_ARN" \
    --container "$CONTAINER_NAME" \
    --interactive \
    --command "node -e \"
const{Pool}=require('pg');
const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
p.query('${sql}',['${param}']).then(r=>{
  console.log('OK — '+(r.rowCount||0)+' row(s) affected.');
  p.end();
}).catch(e=>{console.error('SQL Error:',e.message);p.end();process.exit(1);});
\"" \
    --region "$AWS_REGION"
}

# ─── Menu ────────────────────────────────────────────────────────────────────
show_menu() {
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}  BlueprintParser — Root Admin Manager${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${DIM}  Runs SQL on prod DB via ECS container (private subnet).${NC}"
  echo ""
  echo -e "  ${GREEN}1${NC}  List all users"
  echo -e "  ${GREEN}2${NC}  Promote user to root admin (by email)"
  echo -e "  ${GREEN}3${NC}  Demote user from root admin (by email)"
  echo -e "  ${GREEN}4${NC}  List companies"
  echo -e "  ${GREEN}5${NC}  Check ECS task env vars"
  echo -e "  ${GREEN}6${NC}  Update ROOT_ADMIN_EMAIL in ecs.tf"
  echo -e "  ${GREEN}7${NC}  Run custom SQL"
  echo -e "  ${GREEN}8${NC}  Quick: promote first user to root admin"
  echo -e "  ${GREEN}9${NC}  Ensure is_root_admin column exists"
  echo -e "  ${GREEN}q${NC}  Quit"
  echo ""
}

# ─── Actions ─────────────────────────────────────────────────────────────────

list_users() {
  echo -e "\n${BOLD}All Users:${NC}\n"
  run_sql "SELECT id, email, username, role, is_root_admin, can_run_models, company_id FROM users ORDER BY id"
}

promote_user() {
  read -rp "Enter email to promote to root admin: " email
  if [ -z "$email" ]; then echo -e "${RED}No email provided.${NC}"; return; fi
  echo -e "${YELLOW}Promoting ${email} to root admin...${NC}"
  run_sql_param "UPDATE users SET is_root_admin = true WHERE email = \$1" "$email"
  echo -e "${GREEN}Done. Refresh the admin page — takes effect immediately.${NC}"
}

demote_user() {
  read -rp "Enter email to remove root admin: " email
  if [ -z "$email" ]; then echo -e "${RED}No email provided.${NC}"; return; fi
  echo -e "${YELLOW}Removing root admin from ${email}...${NC}"
  run_sql_param "UPDATE users SET is_root_admin = false WHERE email = \$1" "$email"
  echo -e "${GREEN}Done.${NC}"
}

list_companies() {
  echo -e "\n${BOLD}All Companies:${NC}\n"
  run_sql "SELECT c.id, c.name, c.data_key, COUNT(u.id) as user_count FROM companies c LEFT JOIN users u ON u.company_id = c.id GROUP BY c.id, c.name, c.data_key ORDER BY c.id"
}

check_ecs_env() {
  echo -e "\n${BOLD}Current ECS Task Definition Environment:${NC}\n"
  local task_def
  task_def=$(aws ecs describe-services \
    --cluster "$ECS_CLUSTER" \
    --services "$ECS_SERVICE" \
    --query 'services[0].taskDefinition' \
    --output text \
    --region "$AWS_REGION")
  echo -e "${DIM}Task: ${task_def}${NC}\n"
  aws ecs describe-task-definition \
    --task-definition "$task_def" \
    --query 'taskDefinition.containerDefinitions[0].environment[*].[name,value]' \
    --output table \
    --region "$AWS_REGION"
}

update_root_email() {
  read -rp "Enter new ROOT_ADMIN_EMAIL value: " new_email
  if [ -z "$new_email" ]; then echo -e "${RED}No email provided.${NC}"; return; fi
  echo -e "${YELLOW}This will update ROOT_ADMIN_EMAIL in ecs.tf and require terraform apply + deploy.${NC}"

  local ecs_file="infrastructure/terraform/ecs.tf"
  if [ ! -f "$ecs_file" ]; then
    ecs_file="$(dirname "$0")/infrastructure/terraform/ecs.tf"
  fi

  if [ -f "$ecs_file" ]; then
    sed -i.bak "s/ROOT_ADMIN_EMAIL.*/ROOT_ADMIN_EMAIL\", value = \"${new_email}\" },/" "$ecs_file"
    rm -f "${ecs_file}.bak"
    echo -e "${GREEN}Updated ecs.tf. Now run:${NC}"
    echo -e "  ${CYAN}cd infrastructure/terraform && terraform apply${NC}"
    echo -e "  ${CYAN}cd ../.. && ./deploy.sh${NC}"
  else
    echo -e "${RED}Could not find ecs.tf. Update manually.${NC}"
  fi
  echo ""
  echo -e "${YELLOW}Or promote immediately via option 2 or 8.${NC}"
}

run_custom_sql() {
  echo -e "${DIM}Enter SQL (single line, avoid single quotes — use LIKE instead):${NC}"
  read -rp "> " sql
  if [ -z "$sql" ]; then echo -e "${RED}No SQL provided.${NC}"; return; fi
  run_sql "$sql"
}

promote_first_user() {
  echo -e "${YELLOW}Promoting the first user in the database to root admin...${NC}"
  run_sql "UPDATE users SET is_root_admin = true WHERE id = (SELECT id FROM users ORDER BY id LIMIT 1)"
  echo -e "${GREEN}Done. Refresh the admin page.${NC}"
}

ensure_column() {
  echo -e "${YELLOW}Ensuring is_root_admin column exists...${NC}"
  run_sql "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_root_admin BOOLEAN DEFAULT FALSE NOT NULL"
  echo -e "${GREEN}Column ready.${NC}"
}

# ─── Main Loop ───────────────────────────────────────────────────────────────
main() {
  while true; do
    show_menu
    read -rp "Choose [1-9, q]: " choice
    case "$choice" in
      1) list_users ;;
      2) promote_user ;;
      3) demote_user ;;
      4) list_companies ;;
      5) check_ecs_env ;;
      6) update_root_email ;;
      7) run_custom_sql ;;
      8) promote_first_user ;;
      9) ensure_column ;;
      q|Q) echo -e "\n${GREEN}Bye.${NC}\n"; exit 0 ;;
      *) echo -e "${RED}Invalid choice.${NC}" ;;
    esac
  done
}

main "$@"
