#!/usr/bin/env bash
set -euo pipefail

# BlueprintParser owner break-glass root-admin helper.
#
# This helper exposes four fixed, schema-preserving database operations through
# ECS Exec: list root-admin status, promote one exact email, demote one exact
# email, and delete one exact email's root two-factor (TOTP) enrollment row
# (`2fa-reset`, the break-glass for a lost authenticator device). It deliberately
# has no arbitrary SQL, DDL, password-reset, task-ARN, container, cluster,
# service, region, or account override channel.
#
# Usage:  ./root_admin.sh                 interactive menu
#         ./root_admin.sh 2fa-reset <email>
#         ./root_admin.sh help
#
# [2026-10-25] Root two-factor is MANDATORY in the app: a promoted root holds no access until it
# has enrolled an authenticator app (password + code) in /admin; 2fa-reset returns an account to
# that enrollment gate (it does NOT grant password-only root). Every mutation here also inserts an
# app audit_log row (action root_admin_sh_<operation>) inside the same transaction. The only
# password-only root path is the emergency task-definition switch ROOT_2FA_ENFORCE=0.

readonly SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
readonly DEPLOY_ENV_FILE="${BP_ROOT_ADMIN_ENV_FILE:-${SCRIPT_DIR}/.deploy.env}"
[ -f "${DEPLOY_ENV_FILE}" ] && source "${DEPLOY_ENV_FILE}"
# Reuse the same immutable task-definition and live database-secret authority
# checks as the deployment/cutover entrypoints.
# shellcheck source=scripts/lib/ecs-schema-tools.sh
source "${SCRIPT_DIR}/scripts/lib/ecs-schema-tools.sh"

readonly CANONICAL_AWS_REGION="us-east-1"
readonly CANONICAL_ECS_CLUSTER="beaver-cluster"
readonly CANONICAL_ECS_SERVICE="beaver-app"
readonly CANONICAL_CONTAINER_NAME="beaver-app"
readonly CANONICAL_ECR_REPO="beaver-app"
readonly AWS_CLI="${AWS_BIN:-aws}"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

die() {
  echo -e "${RED}ERROR: $*${NC}" >&2
  return 1
}

aws_cli() {
  "${AWS_CLI}" "$@"
}

assert_canonical_configuration() {
  : "${AWS_ACCOUNT:?ERROR: Set AWS_ACCOUNT in .deploy.env or environment}"
  : "${AWS_REGION:?ERROR: Set AWS_REGION in .deploy.env or environment}"
  : "${ECS_CLUSTER:?ERROR: Set ECS_CLUSTER in .deploy.env or environment}"
  : "${ECS_SERVICE:?ERROR: Set ECS_SERVICE in .deploy.env or environment}"
  : "${ECR_REPO:?ERROR: Set ECR_REPO in .deploy.env or environment}"
  : "${DOMAIN:?ERROR: Set DOMAIN in .deploy.env or environment}"
  : "${CLOUDFRONT_DISTRIBUTION_ID:?ERROR: Set CLOUDFRONT_DISTRIBUTION_ID in .deploy.env or environment}"
  [ "${ROOT_ADMIN_EMAIL+x}" = x ] ||
    die "ROOT_ADMIN_EMAIL must be explicitly set; use an empty value to disable bootstrap promotion"

  [[ "${AWS_ACCOUNT}" =~ ^[0-9]{12}$ ]] ||
    die "AWS_ACCOUNT must be the canonical 12-digit account ID"
  [ "${AWS_REGION}" = "${CANONICAL_AWS_REGION}" ] ||
    die "AWS_REGION must be ${CANONICAL_AWS_REGION}"
  [ "${ECS_CLUSTER}" = "${CANONICAL_ECS_CLUSTER}" ] ||
    die "ECS_CLUSTER must be ${CANONICAL_ECS_CLUSTER}"
  [ "${ECS_SERVICE}" = "${CANONICAL_ECS_SERVICE}" ] ||
    die "ECS_SERVICE must be ${CANONICAL_ECS_SERVICE}"
  [ "${ECR_REPO}" = "${CANONICAL_ECR_REPO}" ] ||
    die "ECR_REPO must be ${CANONICAL_ECR_REPO}"

  # An operator-supplied task can be unrelated to the canonical service even
  # when it lives in the same cluster. Always discover and verify the task.
  if [ "${TASK_ARN+x}" = x ]; then
    die "TASK_ARN overrides are forbidden; the helper verifies the canonical service task"
  fi
}

assert_caller_account() {
  local caller_account
  caller_account=$(aws_cli sts get-caller-identity \
    --region "${AWS_REGION}" \
    --query Account \
    --output text) || {
    die "Unable to read the AWS caller identity"
    return 1
  }
  [ "${caller_account}" = "${AWS_ACCOUNT}" ] ||
    die "AWS caller account identity does not match the configured canonical account"
}

canonical_service_task_definition() {
  local service_json task_definition
  service_json=$(aws_cli ecs describe-services \
    --cluster "${ECS_CLUSTER}" \
    --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" \
    --output json) || {
    die "Unable to describe the canonical ECS service"
    return 1
  }

  if ! task_definition=$(printf '%s' "${service_json}" | node -e '
let input = "";
const [account, region, cluster, service] = process.argv.slice(1);
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const response = JSON.parse(input);
    if (!Array.isArray(response.failures) || response.failures.length !== 0 ||
        !Array.isArray(response.services) || response.services.length !== 1) {
      throw new Error("expected exactly one service and no lookup failures");
    }
    const candidate = response.services[0];
    const serviceArn = `arn:aws:ecs:${region}:${account}:service/${cluster}/${service}`;
    const clusterArn = `arn:aws:ecs:${region}:${account}:cluster/${cluster}`;
    const familyPrefix = `arn:aws:ecs:${region}:${account}:task-definition/${service}:`;
    if (candidate.serviceArn !== serviceArn || candidate.clusterArn !== clusterArn ||
        candidate.serviceName !== service || candidate.status !== "ACTIVE" ||
        candidate.enableExecuteCommand !== true ||
        typeof candidate.taskDefinition !== "string" ||
        !candidate.taskDefinition.startsWith(familyPrefix) ||
        !/:[1-9][0-9]*$/u.test(candidate.taskDefinition)) {
      throw new Error("service identity, status, ECS Exec, or task-definition authority mismatch");
    }
    process.stdout.write(candidate.taskDefinition);
  } catch (error) {
    console.error(`Service verification failed: ${error.message}`);
    process.exit(2);
  }
});
' "${AWS_ACCOUNT}" "${AWS_REGION}" "${ECS_CLUSTER}" "${ECS_SERVICE}"); then
    die "Canonical ECS service verification failed"
    return 1
  fi
  printf '%s\n' "${task_definition}"
}

assert_service_task_definition_contract() {
  local task_definition="$1"
  local database_selector image image_prefix digest

  database_selector=$(bp_assert_task_definition_contract "${task_definition}" app) || {
    die "Selected service revision violates the canonical app task contract"
    return 1
  }

  image=$(bp_task_definition_image "${task_definition}") || {
    die "Unable to verify the selected service revision image"
    return 1
  }
  image_prefix="${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com/${CANONICAL_ECR_REPO}@"
  case "${image}" in
    "${image_prefix}"*) ;;
    *)
      die "Selected service revision does not use the canonical digest-pinned app image"
      return 1
      ;;
  esac
  digest="${image#"${image_prefix}"}"
  bp_validate_digest "${digest}" || {
    die "Selected service revision does not use an exact immutable app digest"
    return 1
  }
  [ "${image}" = "${image_prefix}${digest}" ] || {
    die "Selected service revision image has noncanonical suffix data"
    return 1
  }

  bp_assert_database_secret_identity "${database_selector}" || {
    die "Selected service revision does not use the live canonical immutable DATABASE_URL secret"
    return 1
  }
  echo -e "${DIM}Verified app task contract, immutable image, and live database secret.${NC}" >&2
}

single_running_service_task() {
  local tasks_json task_arn
  tasks_json=$(aws_cli ecs list-tasks \
    --cluster "${ECS_CLUSTER}" \
    --service-name "${ECS_SERVICE}" \
    --desired-status RUNNING \
    --region "${AWS_REGION}" \
    --output json) || {
    die "Unable to list canonical service tasks"
    return 1
  }

  if ! task_arn=$(printf '%s' "${tasks_json}" | node -e '
let input = "";
const [account, region, cluster] = process.argv.slice(1);
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const response = JSON.parse(input);
    if (!Array.isArray(response.taskArns) || response.taskArns.length !== 1 || response.nextToken != null) {
      throw new Error("expected exactly one running task and an unpaginated result");
    }
    const taskArn = response.taskArns[0];
    const prefix = `arn:aws:ecs:${region}:${account}:task/${cluster}/`;
    if (typeof taskArn !== "string" || !taskArn.startsWith(prefix) ||
        !/\/[0-9a-f]{32}$/u.test(taskArn)) {
      throw new Error("task ARN is outside the canonical account, region, or cluster");
    }
    process.stdout.write(taskArn);
  } catch (error) {
    console.error(`Task selection failed: ${error.message}`);
    process.exit(2);
  }
});
' "${AWS_ACCOUNT}" "${AWS_REGION}" "${ECS_CLUSTER}"); then
    die "Refusing an absent or ambiguous running-task selection"
    return 1
  fi
  printf '%s\n' "${task_arn}"
}

assert_task_belongs_to_service() {
  local task_arn="$1"
  local service_task_definition="$2"
  local task_json
  task_json=$(aws_cli ecs describe-tasks \
    --cluster "${ECS_CLUSTER}" \
    --tasks "${task_arn}" \
    --region "${AWS_REGION}" \
    --output json) || {
    die "Unable to describe the selected service task"
    return 1
  }

  if ! printf '%s' "${task_json}" | node -e '
let input = "";
const [account, region, cluster, service, containerName, expectedTaskArn, expectedTaskDefinition] = process.argv.slice(1);
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const response = JSON.parse(input);
    if (!Array.isArray(response.failures) || response.failures.length !== 0 ||
        !Array.isArray(response.tasks) || response.tasks.length !== 1) {
      throw new Error("expected exactly one described task and no lookup failures");
    }
    const task = response.tasks[0];
    const clusterArn = `arn:aws:ecs:${region}:${account}:cluster/${cluster}`;
    const containers = task.containers;
    if (task.taskArn !== expectedTaskArn || task.clusterArn !== clusterArn ||
        task.group !== `service:${service}` || task.lastStatus !== "RUNNING" ||
        task.desiredStatus !== "RUNNING" || task.enableExecuteCommand !== true ||
        task.taskDefinitionArn !== expectedTaskDefinition ||
        !Array.isArray(containers) || containers.length !== 1 ||
        containers[0].name !== containerName || containers[0].lastStatus !== "RUNNING" ||
        containers[0].taskArn !== expectedTaskArn) {
      throw new Error("task is not the canonical running service/task-definition/container instance");
    }
  } catch (error) {
    console.error(`Task membership verification failed: ${error.message}`);
    process.exit(2);
  }
});
' "${AWS_ACCOUNT}" "${AWS_REGION}" "${ECS_CLUSTER}" "${ECS_SERVICE}" \
    "${CANONICAL_CONTAINER_NAME}" "${task_arn}" "${service_task_definition}"; then
    die "Selected task does not belong to the canonical service deployment"
    return 1
  fi
}

verified_task_arn() {
  local service_task_definition task_arn
  assert_caller_account || return 1
  service_task_definition=$(canonical_service_task_definition) || return 1
  assert_service_task_definition_contract "${service_task_definition}" || return 1
  task_arn=$(single_running_service_task) || return 1
  assert_task_belongs_to_service "${task_arn}" "${service_task_definition}" || return 1
  echo -e "${DIM}Verified task: ${task_arn##*/}${NC}" >&2
  printf '%s\n' "${task_arn}"
}

validate_email() {
  local email="$1"
  if [ "${#email}" -gt 255 ] || [[ ! "${email}" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]]; then
    die "Enter one syntactically valid email address (maximum 255 characters)"
  fi
}

run_fixed_operation() {
  local operation="$1"
  local email="${2:-}"
  local email_b64 task_arn
  case "${operation}" in
    list) [ -z "${email}" ] || die "The list operation accepts no value" ;;
    promote|demote|reset2fa) validate_email "${email}" || return 1 ;;
    *) die "Unsupported fixed root-admin operation"; return 1 ;;
  esac

  email_b64=$(printf '%s' "${email}" | base64 | tr -d '\n')
  task_arn=$(verified_task_arn) || return 1
  aws_cli ecs execute-command \
    --cluster "${ECS_CLUSTER}" \
    --task "${task_arn}" \
    --container "${CANONICAL_CONTAINER_NAME}" \
    --interactive \
    --command "node -e \"
(async()=>{
  const{Pool}=require('pg');
  const{databaseTlsOptions}=await import('./scripts/database-tls.mjs');
  const operation=process.argv[1];
  const email=Buffer.from(process.argv[2]||'','base64').toString('utf8');
  const twoFactorKeyPrefix='root-2fa:';
  const operations=Object.freeze({
    list:Object.freeze({text:'SELECT email, is_root_admin FROM public.users ORDER BY lower(email), email',values:[],mutation:false}),
    promote:Object.freeze({text:'UPDATE public.users SET is_root_admin = true WHERE email = \\\$1 AND is_root_admin = false RETURNING email, is_root_admin',values:[email],mutation:true}),
    demote:Object.freeze({text:'UPDATE public.users AS target SET is_root_admin = false WHERE target.email = \\\$1 AND target.is_root_admin = true AND EXISTS (SELECT 1 FROM public.users AS other WHERE other.is_root_admin = true AND other.id <> target.id) RETURNING target.email, target.is_root_admin',values:[email],mutation:true}),
    reset2fa:Object.freeze({text:'DELETE FROM public.app_settings AS setting USING public.users AS owner WHERE owner.email = \\\$1 AND setting.key = \\\$2 || owner.id::text RETURNING owner.email, owner.is_root_admin',values:[email,twoFactorKeyPrefix],mutation:true})
  });
  const spec=operations[operation];
  if(!spec)throw new Error('unsupported fixed operation');
  const bootstrapEmail=(process.env.ROOT_ADMIN_EMAIL||'').trim();
  if(operation==='demote'&&bootstrapEmail!==''&&bootstrapEmail.toLowerCase()===email.trim().toLowerCase()){
    throw new Error('refusing to demote the configured ROOT_ADMIN_EMAIL bootstrap identity; clear root_admin_email in Terraform, apply it, and complete a same-digest deploy.sh activate before retrying');
  }
  const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:databaseTlsOptions(process.env)});
  let client;
  try{
    client=await pool.connect();
    if(spec.mutation){
      await client.query('BEGIN');
      await client.query('SELECT pg_catalog.pg_advisory_xact_lock(737375864)');
    }
    const result=await client.query(spec.text,spec.values);
    if(spec.mutation&&result.rowCount!==1){
      throw new Error('safety check refused the update: expected exactly one changed user row (demotion also requires another root admin; 2fa-reset requires an existing enrollment)');
    }
    if(spec.mutation){
      // [2026-10-25] Every break-glass mutation leaves an app audit_log row in the same transaction.
      await client.query('INSERT INTO public.audit_log (action, user_id, company_id, details) SELECT \\\$1, id, company_id, \\\$2::jsonb FROM public.users WHERE email = \\\$3',['root_admin_sh_'+operation,JSON.stringify({operation,via:'ecs-exec',email}),email]);
      await client.query('COMMIT');
    }
    for(const row of result.rows||[]){
      console.log(JSON.stringify({email:row.email,isRootAdmin:row.is_root_admin===true}));
    }
    console.log(spec.mutation?(operation==='reset2fa'?'Root two-factor enrollment deleted for exactly one user.':'Root-admin update verified for exactly one user.'):('Listed '+result.rowCount+' user(s); only email and root-admin status were emitted.'));
  }catch(error){
    if(client&&spec.mutation){try{await client.query('ROLLBACK');}catch{}}
    throw error;
  }finally{
    if(client)client.release();
    await pool.end();
  }
})().catch(error=>{console.error('Operation failed:',error.message);process.exit(1);});
\" '${operation}' '${email_b64}'" \
    --region "${AWS_REGION}"
}

show_menu() {
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}  BlueprintParser — Owner Root-Admin Break Glass${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${DIM}  Every database action re-verifies the canonical AWS service task.${NC}"
  echo ""
  echo -e "  ${GREEN}1${NC}  List user emails and root-admin status"
  echo -e "  ${GREEN}2${NC}  Promote one exact email"
  echo -e "  ${GREEN}3${NC}  Demote one exact email (never the last root admin)"
  echo -e "  ${GREEN}4${NC}  Show ROOT_ADMIN_EMAIL Terraform setup"
  echo -e "  ${GREEN}5${NC}  Reset one exact email's root two-factor (TOTP) enrollment"
  echo -e "  ${GREEN}q${NC}  Quit"
  echo ""
}

show_help() {
  echo ""
  echo -e "${BOLD}BlueprintParser — Owner Root-Admin Break Glass${NC}"
  echo ""
  echo -e "Usage:"
  echo -e "  ${CYAN}./root_admin.sh${NC}                      interactive menu (choices 1-5 below)"
  echo -e "  ${CYAN}./root_admin.sh 2fa-reset <email>${NC}    delete that root user's two-factor (TOTP)"
  echo -e "                                        enrollment row (app_settings key root-2fa:<id>)"
  echo -e "                                        after typing RESET-2FA. Root 2FA is MANDATORY:"
  echo -e "                                        the next sign-in lands on the /admin enrollment"
  echo -e "                                        gate (account password + authenticator app) and"
  echo -e "                                        holds NO access until enrolled and verified."
  echo -e "                                        Rotate the account password at the same time if"
  echo -e "                                        it may be known to anyone else."
  echo -e "  ${CYAN}./root_admin.sh help${NC}                 this text"
  echo ""
  echo -e "  1  List user emails and root-admin status"
  echo -e "  2  Promote one exact email"
  echo -e "  3  Demote one exact email (never the last root admin)"
  echo -e "  4  Show ROOT_ADMIN_EMAIL Terraform setup"
  echo -e "  5  Reset one exact email's root two-factor (TOTP) enrollment"
  echo ""
  echo -e "${DIM}Every database action re-verifies the canonical AWS service task over ECS Exec.${NC}"
  echo ""
}

list_users() {
  echo -e "\n${BOLD}User root-admin status:${NC}\n"
  run_fixed_operation list
}

promote_user() {
  local email confirmation
  read -rp "Enter the exact email to promote: " email
  validate_email "${email}" || return 1
  read -rp "Type PROMOTE to confirm: " confirmation
  [ "${confirmation}" = "PROMOTE" ] || {
    echo -e "${YELLOW}Promotion cancelled.${NC}"
    return 0
  }
  run_fixed_operation promote "${email}"
}

demote_user() {
  local email confirmation
  read -rp "Enter the exact email to demote: " email
  validate_email "${email}" || return 1
  read -rp "Type DEMOTE to confirm: " confirmation
  [ "${confirmation}" = "DEMOTE" ] || {
    echo -e "${YELLOW}Demotion cancelled.${NC}"
    return 0
  }
  run_fixed_operation demote "${email}"
}

reset_two_factor() {
  local email="${1:-}" confirmation
  if [ -z "${email}" ]; then
    read -rp "Enter the exact email whose root two-factor enrollment to delete: " email
  fi
  validate_email "${email}" || return 1
  read -rp "Type RESET-2FA to confirm: " confirmation
  [ "${confirmation}" = "RESET-2FA" ] || {
    echo -e "${YELLOW}Two-factor reset cancelled.${NC}"
    return 0
  }
  run_fixed_operation reset2fa "${email}"
}

show_root_email_setup() {
  echo -e "\n${BOLD}Root-admin bootstrap configuration:${NC}\n"
  echo -e "${YELLOW}Never place the bootstrap identity in tracked ecs.tf source.${NC}"
  echo -e "Set the validated Terraform input with either:"
  echo -e "  ${CYAN}root_admin_email = \"admin@example.com\"${NC} in the untracked"
  echo -e "  ${CYAN}infrastructure/terraform/terraform.tfvars${NC} file; or"
  echo -e "  ${CYAN}export TF_VAR_root_admin_email=admin@example.com${NC} for the owner-run plan/apply."
  echo ""
  echo -e "Terraform apply and application deploy remain explicit owner-run operations."
}

main() {
  case "${1:-}" in
    2fa-reset)
      [ "$#" -eq 2 ] || { show_help; die "usage: ./root_admin.sh 2fa-reset <email>"; }
      assert_canonical_configuration
      reset_two_factor "$2"
      exit $?
      ;;
    help|-h|--help) show_help; exit 0 ;;
    "") ;;
    *) show_help; die "Unknown command: $1" ;;
  esac
  assert_canonical_configuration
  while true; do
    show_menu
    read -rp "Choose [1-5, q]: " choice
    case "${choice}" in
      1) list_users ;;
      2) promote_user ;;
      3) demote_user ;;
      4) show_root_email_setup ;;
      5) reset_two_factor ;;
      q|Q) echo -e "\n${GREEN}Bye.${NC}\n"; exit 0 ;;
      *) echo -e "${RED}Invalid choice.${NC}" ;;
    esac
  done
}

main "$@"
