#!/usr/bin/env bash
# deploy-aws.sh — the one deploy tool. Menu when run with no arguments, subcommands otherwise.
#
#   ./deploy-aws.sh                      interactive menu (TUI)
#   ./deploy-aws.sh doctor               read-only: Mac toolchain, AWS identity, quotas, config, cert, DNS
#   ./deploy-aws.sh status               what is live
#   ./deploy-aws.sh bootstrap [--from P] first deploy on an empty account, resumable phase by phase
#   ./deploy-aws.sh release              build → push → apply → schema check → rolling update (no downtime)
#   ./deploy-aws.sh release --outage     a release that carries a schema change (~10 min down)
#   ./deploy-aws.sh rollback             re-bind the previous digest (no schema change across it)
#   ./deploy-aws.sh restart              same-image restart after a config/secret change (deploy.sh activate)
#   ./deploy-aws.sh logs                 tail the app log
#   ./deploy-aws.sh unlock-login <email> clear a login lockout (the owner's own, typically)
#
# It ORCHESTRATES the tools that exist; it does not reimplement them. `./deploy.sh publish` remains
# the build-and-push step and `./deploy.sh activate` the same-image restart. Terraform owns every
# task definition. This script adds the order, the waits, the checks between steps, and a memory
# of where a bootstrap got to.
#
# Runs on a stock Mac: bash 3.2, aws CLI v2, terraform, docker, node, git, dig, curl. No brew.
# Private state lives in ~/.blueprintparser-deploy (backend.hcl, bootstrap ledger, logs), never in
# the repo, so deploy.sh's clean-tree check keeps passing. It never writes terraform.tfvars or
# .deploy.env: it tells you the exact line to add and waits.
#
# Every AWS/terraform/docker mutation is announced and, unless --yes, confirmed before it runs.
# Nothing here deletes anything.
set -euo pipefail
# BP_TRACE=<file>: full bash trace of a run, for diagnosing a failure after the fact.
if [ -n "${BP_TRACE:-}" ]; then exec 9>>"${BP_TRACE}"; export BASH_XTRACEFD=9; set -x; fi

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "${PROJECT_DIR}"   # deploy-yolo.sh and deploy.sh build from relative paths
TF_DIR="${PROJECT_DIR}/infrastructure/terraform"
STATE_DIR="${BP_DEPLOY_STATE_DIR:-${HOME}/.blueprintparser-deploy}"
LEDGER="${STATE_DIR}/bootstrap.json"
RELEASES="${STATE_DIR}/releases.jsonl"
LOG_DIR="${STATE_DIR}/log"
DEPLOY_ENV_FILE="${BP_DEPLOY_ENV_FILE:-${PROJECT_DIR}/.deploy.env}"
TFVARS_FILE="${BP_TFVARS_FILE:-${TF_DIR}/terraform.tfvars}"
DEPLOY_SH="${BP_DEPLOY_SH:-${PROJECT_DIR}/deploy.sh}"
DEPLOY_YOLO_SH="${BP_DEPLOY_YOLO_SH:-${PROJECT_DIR}/deploy-yolo.sh}"
AWS_BIN="${AWS_BIN:-aws}"
TERRAFORM_BIN="${TERRAFORM_BIN:-terraform}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
ASSUME_YES=0
FROM_PHASE=""
OUTAGE=0
ALLOW_UNVERIFIED=0
PAUSES=0
LAST_TASK_EXIT=none
GREEN_HEADS="${BP_GREEN_HEADS:-${PROJECT_DIR}/../../gitignore/projects/aws_deploy/GREEN_HEADS}"

# Build attestations (provenance/SBOM) turn a push into an OCI image index. ECS accepts that;
# Lambda rejects it and SageMaker has. Off for every build this script starts.
export BUILDX_NO_DEFAULT_ATTESTATIONS=1
export DOCKER_BUILDKIT=1

readonly ECS_CLUSTER_CANON="beaver-cluster"
readonly ECS_SERVICE_CANON="beaver-app"
readonly APP_FAMILY="beaver-app"
readonly MIGRATOR_FAMILY="beaver-schema-migrator"
readonly MAINTENANCE_SCHEDULE_GROUP="beaver-maintenance"
readonly MAINTENANCE_SCHEDULE_NAME="beaver-project-asset-deletions"
readonly SCHEDULE_DRAIN_SECONDS=900
readonly EMPTY_BOOTSTRAP_MODE="empty-database-singleton-quiescent"
readonly FORWARD_MODE="p2-0037-singleton-quiescent"
readonly PHASES="preflight image-build state-backend certificate ecr images infra-outage migrate infra-live dns first-user verify"

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

# ── output ───────────────────────────────────────────────────────────────────
section() { printf '\n%b━━━ %s ━━━%b\n' "${CYAN}" "$1" "${NC}"; }
ok()      { printf '  %b✔%b %s\n' "${GREEN}" "${NC}" "$1"; }
warn()    { printf '  %b⚠%b %s\n' "${YELLOW}" "${NC}" "$1"; }
fail()    { printf '  %b✘%b %s\n' "${RED}" "${NC}" "$1"; }
info()    { printf '  %b%s%b\n' "${DIM}" "$1" "${NC}"; }
die()     { printf '%bERROR:%b %s\n' "${RED}" "${NC}" "$*" >&2; exit 1; }

log_file() { printf '%s/%s.log' "${LOG_DIR}" "$(date -u +%Y%m%d)"; }
log_line() { mkdir -p "${LOG_DIR}"; printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >>"$(log_file)"; }

# Run a command, echoing it and appending its full output to the day's log. Output also streams.
run() {
  log_line "\$ $*"
  printf '  %b$ %s%b\n' "${DIM}" "$*" "${NC}"
  "$@" 2>&1 | tee -a "$(log_file)"
  return "${PIPESTATUS[0]}"
}
# Same, but capture stdout. stderr goes to the log; on failure its tail is shown, so an expired
# token or a throttle never kills the run silently.
capture() {
  log_line "\$ $*"
  "$@" 2>>"$(log_file)" || { local rc=$?; printf '  %bcommand failed (%s): %s%b\n' "${RED}" "${rc}" "$*" "${NC}" >&2; tail -5 "$(log_file)" | sed 's/^/    │ /' >&2; return "${rc}"; }
}
# capture, logging only a label: for argv that carries a secret (task overrides, login tokens).
capture_redacted() {
  local label="$1"; shift
  log_line "\$ ${label} [arguments redacted]"
  "$@" 2>>"$(log_file)" || { local rc=$?; printf '  %bcommand failed (%s): %s%b\n' "${RED}" "${rc}" "${label}" "${NC}" >&2; tail -5 "$(log_file)" | sed 's/^/    │ /' >&2; return "${rc}"; }
}
# Run a long command, streaming to the terminal AND saving its output to a file the caller reads.
# (A plain $(run …) would leave a 30-minute docker build with no output at all.)
run_to_file() {
  local out="$1"; shift
  log_line "\$ $*"
  printf '  %b$ %s%b\n' "${DIM}" "$*" "${NC}"
  "$@" 2>&1 | tee -a "$(log_file)" | tee "${out}"
  return "${PIPESTATUS[0]}"
}
aws_ro()  { capture "${AWS_BIN}" "$@"; }        # read-only calls: no confirmation
aws_mut() { announce "aws $*"; run "${AWS_BIN}" "$@"; }

announce() {
  printf '\n  %bABOUT TO RUN (account %s, %s):%b\n    %s\n' "${YELLOW}" "${AWS_ACCOUNT:-?}" "${AWS_REGION:-?}" "${NC}" "$1"
  confirm "Proceed?"
}
confirm() {
  if [ "${ASSUME_YES}" = 1 ]; then return 0; fi
  local reply
  printf '  %s [y/N] ' "$1"
  read -r reply </dev/tty || reply=""
  case "${reply}" in y|Y|yes|YES) return 0 ;; *) die "cancelled" ;; esac
}
pause_for_owner() {
  # A step only the owner can do (GoDaddy, tfvars, .deploy.env). Waits for Enter.
  printf '\n  %b▶ YOUR TURN:%b %s\n' "${BOLD}" "${NC}" "$1"
  # Callers loop until the step is really done, so a non-interactive run must stop, not spin.
  PAUSES=$((PAUSES+1))
  if [ "${BP_ASSUME_OWNER_DONE:-0}" = 1 ]; then
    [ "${PAUSES}" -lt 4 ] || die "owner step still not done after ${PAUSES} checks (see YOUR TURN above)"
    return 0
  fi
  if [ "${ASSUME_YES}" = 1 ]; then die "non-interactive run needs an owner step first (see YOUR TURN above)"; fi
  printf '  Press Enter when done (Ctrl-C to stop here; bootstrap resumes at this phase). '
  read -r _ </dev/tty || true
}

json() { # json <expr> <<< '<json>'   — evaluate a JS expression against parsed stdin
  node -e '
let s=""; process.stdin.setEncoding("utf8"); process.stdin.on("data",c=>s+=c);
process.stdin.on("end",()=>{ let j; try { j = JSON.parse(s || "null"); } catch { j = null; }
  const v = new Function("j", "return (" + process.argv[1] + ")")(j);
  process.stdout.write(v == null ? "" : (typeof v === "string" ? v : JSON.stringify(v))); });' "$1"
}

# ── config ───────────────────────────────────────────────────────────────────
load_config() {
  [ -f "${DEPLOY_ENV_FILE}" ] && { set +u; . "${DEPLOY_ENV_FILE}"; set -u; }
  AWS_ACCOUNT="${AWS_ACCOUNT:-}"; AWS_REGION="${AWS_REGION:-us-east-1}"
  ECS_CLUSTER="${ECS_CLUSTER:-${ECS_CLUSTER_CANON}}"; ECS_SERVICE="${ECS_SERVICE:-${ECS_SERVICE_CANON}}"
  ECR_REPO="${ECR_REPO:-beaver-app}"; DOMAIN="${DOMAIN:-}"
  export AWS_ACCOUNT AWS_REGION ECS_CLUSTER ECS_SERVICE ECR_REPO DOMAIN
  mkdir -p "${STATE_DIR}"; chmod 700 "${STATE_DIR}"
}
require_config() {
  local k; for k in "$@"; do
    eval "v=\${$k:-}"; [ -n "${v}" ] || die "$k is not set — add it to ${DEPLOY_ENV_FILE}"
  done
}
# terraform.tfvars is HCL; the values this tool needs are simple `key = "..."`/`key = 1`/`key = true`.
tfvar() { # tfvar <name> → value or empty
  [ -f "${TFVARS_FILE}" ] || return 0
  sed -n -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"?([^\"#]*)\"?[[:space:]]*(#.*)?$/\1/p" "${TFVARS_FILE}" | tail -1 | sed -E 's/[[:space:]]+$//'
}
tfvar_present() { grep -q -E "^[[:space:]]*$1[[:space:]]*=" "${TFVARS_FILE}" 2>/dev/null; }
tuple_is() { # tuple_is outage|live
  local d m x a s
  d=$(tfvar ecs_desired_count); m=$(tfvar ecs_min_count); x=$(tfvar ecs_max_count)
  a=$(tfvar ecs_autoscaling_enabled); s=$(tfvar maintenance_worker_schedule_enabled)
  a="${a:-true}"; s="${s:-true}"
  case "$1" in
    outage) [ "${d}" = 0 ] && [ "${m}" = 0 ] && [ "${x}" = 1 ] && [ "${a}" = false ] && [ "${s}" = false ] ;;
    live)   [ "${d}" = 1 ] && [ "${m}" = 1 ] && [ "${x}" = 1 ] && [ "${a}" = true ] && [ "${s}" = true ] ;;
  esac
}
print_tuple_lines() {
  local mode="$1"
  if [ "${mode}" = outage ]; then
    printf '    ecs_desired_count                   = 0\n    ecs_min_count                       = 0\n    ecs_max_count                       = 1\n    ecs_autoscaling_enabled             = false\n    maintenance_worker_schedule_enabled = false\n'
  else
    printf '    ecs_desired_count                   = 1\n    ecs_min_count                       = 1\n    ecs_max_count                       = 1\n    ecs_autoscaling_enabled             = true\n    maintenance_worker_schedule_enabled = true\n'
  fi
}
require_tuple() {
  until tuple_is "$1"; do
    pause_for_owner "set the $(echo "$1" | tr a-z A-Z) tuple in ${TFVARS_FILE}:
$(print_tuple_lines "$1")"
  done
  ok "tfvars is the $1 tuple"
}
valid_digest() { [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]; }
required_tf_variables() { # names of variables with no default, from variables.tf
  node -e '
const src=require("fs").readFileSync(process.argv[1],"utf8"); const out=[];
for (const m of src.matchAll(/variable\s+"([^"]+)"\s*\{([\s\S]*?)\n\}/g)) if (!/^\s*default\s*=/m.test(m[2])) out.push(m[1]);
process.stdout.write(out.join(" "));' "${TF_DIR}/variables.tf"
}

# ── ledger ───────────────────────────────────────────────────────────────────
ledger_get() {
  [ -f "${LEDGER}" ] || return 0
  node -e 'const fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{};const v=j[process.argv[2]];process.stdout.write(v==null?"":String(v))' "${LEDGER}" "$1"
}
ledger_set() { # ledger_set key value
  mkdir -p "${STATE_DIR}"
  node -e '
const fs=require("fs"); const [p,k,v]=process.argv.slice(1);
let j={}; try { j=JSON.parse(fs.readFileSync(p,"utf8")); } catch {}
j[k]=v; j.updatedAt=new Date().toISOString();
fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n", {mode:0o600});' "${LEDGER}" "$1" "$2"
}
phase_done() { [ "$(ledger_get "phase:$1")" = done ]; }
mark_done()  { ledger_set "phase:$1" done; ok "phase $1 done"; }
release_record() { # release_record <event> <digest> <previous> <head>
  mkdir -p "${STATE_DIR}"
  printf '{"at":"%s","event":"%s","digest":"%s","previous":"%s","head":"%s"}\n' \
    "$(date -u +%FT%TZ)" "$1" "$2" "$3" "$4" >>"${RELEASES}"
}
last_release_field() { # last_release_field <field>
  [ -f "${RELEASES}" ] || return 0
  tail -1 "${RELEASES}" | json "j && j[\"$1\"]"
}

# ── terraform ────────────────────────────────────────────────────────────────
# Never a blind -auto-approve: plan to a file, show the add/change/destroy line and every address
# that would be destroyed or replaced, refuse destruction unless the owner types `destroy`, then
# apply exactly that plan. tf_apply [extra plan args...]
tf_apply() {
  local plan="${STATE_DIR}/plan.tfplan" out="${STATE_DIR}/plan.txt" verdict destroys
  run "${TERRAFORM_BIN}" -chdir="${TF_DIR}" plan -input=false -no-color -out="${plan}" "$@" >"${out}" 2>&1 || { tail -30 "${out}"; die "terraform plan failed"; }
  grep -E '^(Plan: |No changes)' "${out}" | tail -1 | sed 's/^/  /' || true
  # Read the plan itself, not its prose. A release REPLACES the four task definitions (a digest
  # change is a new revision) and every live<->outage flip replaces terraform_data.…_epoch by
  # design: those are not destruction. Anything else deleted or replaced is.
  verdict=$("${TERRAFORM_BIN}" -chdir="${TF_DIR}" show -json "${plan}" 2>>"$(log_file)" | json '
    (() => {
      const rc = (j && j.resource_changes) || [];
      const expected = a => /^aws_ecs_task_definition\./.test(a) || a === "terraform_data.beaver_writer_mode_epoch";
      const acts = r => r.change && r.change.actions ? r.change.actions : [];
      const destroys = rc.filter(r => acts(r).includes("delete") && !expected(r.address)).map(r => r.address + " (" + acts(r).join(",") + ")");
      const changes = rc.filter(r => !(acts(r).length === 1 && acts(r)[0] === "no-op"));
      return JSON.stringify({ total: changes.length, destroys });
    })()')
  destroys=$(printf '%s' "${verdict}" | json 'j.destroys.length')
  printf '%s' "${verdict}" | json 'j.destroys.join("\n")' | sed 's/^/    DESTROY: /'
  if [ "$(printf '%s' "${verdict}" | json 'j.total')" = 0 ]; then ok "nothing to apply"; return 0; fi
  if [ "${destroys:-0}" != 0 ]; then
    printf '  %bThis plan DESTROYS %s resource(s) beyond the expected task-definition/epoch replacements.%b\n' "${RED}" "${destroys}" "${NC}"
    if [ "${ASSUME_YES}" = 1 ]; then
      [ "${BP_ALLOW_DESTROY:-0}" = 1 ] || die "refusing a destructive plan non-interactively (set BP_ALLOW_DESTROY=1 only on purpose)"
    else
      local typed; printf '  Type destroy to continue: '; read -r typed </dev/tty || typed=""
      [ "${typed}" = destroy ] || die "cancelled"
    fi
  else
    confirm "Apply this plan?"
  fi
  run "${TERRAFORM_BIN}" -chdir="${TF_DIR}" apply -input=false "${plan}"
}

# ── AWS lookups (read-only) ──────────────────────────────────────────────────
caller_account() { aws_ro sts get-caller-identity --query Account --output text 2>/dev/null || true; }
ecr_base() { printf '%s.dkr.ecr.%s.amazonaws.com' "${AWS_ACCOUNT}" "${AWS_REGION}"; }
service_json() { aws_ro ecs describe-services --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" --region "${AWS_REGION}" --output json 2>/dev/null || true; }
service_field() { service_json | json "j && j.services && j.services[0] && ($1)"; }
latest_td() { aws_ro ecs describe-task-definition --task-definition "$1" --region "${AWS_REGION}" --query taskDefinition.taskDefinitionArn --output text; }
td_image()  { aws_ro ecs describe-task-definition --task-definition "$1" --region "${AWS_REGION}" --query 'taskDefinition.containerDefinitions[0].image' --output text; }
live_digest() { local img; img=$(td_image "$(service_field 'j.services[0].taskDefinition')" 2>/dev/null || true); printf '%s' "${img##*@}"; }
alb_dns() { aws_ro elbv2 describe-load-balancers --names beaver-alb --region "${AWS_REGION}" --query 'LoadBalancers[0].DNSName' --output text 2>/dev/null || true; }
cf_domain() { "${TERRAFORM_BIN}" -chdir="${TF_DIR}" output -raw cloudfront_domain_name 2>/dev/null || true; }
tf_output() { "${TERRAFORM_BIN}" -chdir="${TF_DIR}" output -raw "$1" 2>/dev/null || true; }

health_ok() { # health_ok <url> [host-header]
  local body
  if [ -n "${2:-}" ]; then body=$(curl -sk --max-time 10 -H "Host: $2" "$1" 2>/dev/null || true)
  else body=$(curl -s --max-time 10 "$1" 2>/dev/null || true); fi
  [ "$(printf '%s' "${body}" | json 'j && j.status')" = ok ]
}
wait_for() { # wait_for <seconds> <interval> <label> <cmd...>
  local deadline=$(( $(date +%s) + $1 )) interval="$2" label="$3"; shift 3
  until "$@"; do
    [ "$(date +%s)" -lt "${deadline}" ] || die "timed out waiting for ${label}"
    printf '  %b… waiting for %s%b\n' "${DIM}" "${label}" "${NC}"; sleep "${interval}"
  done
}

# Run a one-off task on the migrator task definition with the app service's network config.
# Prints the task ARN; waits until it stops; returns the container exit code.
one_off_task() { # one_off_task <td arn> <overrides json> <started-by>
  local network task_arn exit_code
  network=$(service_field 'JSON.stringify(j.services[0].networkConfiguration)')
  [ -n "${network}" ] || die "could not read the app service network configuration"
  announce "aws ecs run-task ${1##*/} (started-by $3)"
  local response
  response=$(capture_redacted "aws ecs run-task ${1##*/} started-by $3" "${AWS_BIN}" ecs run-task --cluster "${ECS_CLUSTER}" --task-definition "$1" \
    --launch-type FARGATE --platform-version 1.4.0 --network-configuration "${network}" \
    --overrides "$2" --started-by "$3" --region "${AWS_REGION}" --output json)
  task_arn=$(printf '%s' "${response}" | json 'j && j.tasks && j.tasks[0] && j.tasks[0].taskArn')
  [ -n "${task_arn}" ] || die "run-task started nothing: $(printf '%s' "${response}" | json 'j && j.failures && j.failures.map(f=>f.reason+" "+(f.detail||"")).join("; ")')"
  info "task ${task_arn##*/}"
  # The CLI waiter gives up after 10 min; a cold pull of this image can take longer. Loop it.
  local tries=0
  until aws_ro ecs wait tasks-stopped --cluster "${ECS_CLUSTER}" --tasks "${task_arn}" --region "${AWS_REGION}" >/dev/null 2>&1; do
    tries=$((tries+1)); [ "${tries}" -lt 6 ] || die "task ${task_arn##*/} did not stop within an hour"
    info "still running…"
  done
  local described; described=$(aws_ro ecs describe-tasks --cluster "${ECS_CLUSTER}" --tasks "${task_arn}" --region "${AWS_REGION}" --output json)
  exit_code=$(printf '%s' "${described}" | json 'j && j.tasks && j.tasks[0] && j.tasks[0].containers && j.tasks[0].containers[0] && j.tasks[0].containers[0].exitCode')
  LAST_TASK_EXIT="${exit_code:-none}"
  info "exit code ${LAST_TASK_EXIT}; stopped: $(printf '%s' "${described}" | json 'j && j.tasks && j.tasks[0] && (j.tasks[0].stoppedReason||"")')"
  aws_ro logs get-log-events --log-group-name /ecs/blueprintparser-schema-migrator \
    --log-stream-name "schema-migrator/beaver-schema-migrator/${task_arn##*/}" --region "${AWS_REGION}" \
    --output json 2>/dev/null | json 'j && j.events && j.events.slice(-20).map(e=>e.message).join("\n")' | sed 's/^/    │ /' || true
  printf '\n'
  [ "${LAST_TASK_EXIT}" = 0 ]
}

roll_service() { # roll_service <app td arn> <desired>
  local td="$1" desired="$2" state tries=0
  aws_mut ecs update-service --cluster "${ECS_CLUSTER}" --service "${ECS_SERVICE}" \
    --task-definition "${td}" --desired-count "${desired}" --force-new-deployment \
    --region "${AWS_REGION}" --query 'service.serviceName' --output text
  until aws_ro ecs wait services-stable --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" --region "${AWS_REGION}" >/dev/null 2>&1; do
    tries=$((tries+1)); [ "${tries}" -lt 3 ] || die "service did not stabilise within 30 minutes"
    info "still rolling…"
  done
  # services-stable can return before the deployment reports COMPLETED; poll it.
  wait_for 600 15 "rollout COMPLETED" sh -c '
    s=$('"${AWS_BIN}"' ecs describe-services --cluster '"${ECS_CLUSTER}"' --services '"${ECS_SERVICE}"' --region '"${AWS_REGION}"' --query "services[0].deployments[0].rolloutState" --output text 2>/dev/null)
    case "$s" in COMPLETED) exit 0;; FAILED) echo "  rollout FAILED: the circuit breaker rolled back" >&2; exit 0;; *) exit 1;; esac'
  state=$(service_field 'j.services[0].deployments[0].rolloutState')
  [ "${state}" = COMPLETED ] || die "rollout state is ${state}; the previous task definition is still serving"
  # After a circuit-breaker rollback the ROLLBACK deployment is the one that reads COMPLETED, with
  # the old revision bound. Only the bound task definition says whether the roll happened.
  local bound; bound=$(service_field 'j.services[0].taskDefinition')
  [ "${bound}" = "${td}" ] || die "the service is bound to ${bound##*/}, not ${td##*/}: ECS rolled the deployment back (the new tasks did not become healthy — see the app log)"
  ok "service on ${td##*/} at desired ${desired}"
}

# ── doctor ───────────────────────────────────────────────────────────────────
cmd_doctor() {
  load_config
  section "Toolchain"
  local t; for t in "${AWS_BIN}" "${TERRAFORM_BIN}" "${DOCKER_BIN}" node git dig curl; do
    if command -v "${t}" >/dev/null 2>&1; then ok "${t}"; else fail "${t} not found"; fi
  done
  "${DOCKER_BIN}" info >/dev/null 2>&1 && ok "docker daemon up" || fail "docker daemon not running"
  info "bash ${BASH_VERSION} (3.2 is fine for this tool)"

  section "Identity"
  require_config AWS_ACCOUNT AWS_REGION DOMAIN
  local acct; acct=$(caller_account)
  if [ "${acct}" = "${AWS_ACCOUNT}" ]; then ok "aws caller account ${acct} matches .deploy.env"; else fail "aws caller is '${acct}', .deploy.env says ${AWS_ACCOUNT}"; fi
  [ "$(tfvar account_id)" = "${AWS_ACCOUNT}" ] && ok "tfvars account_id matches" || fail "tfvars account_id differs from .deploy.env"
  [ "$(tfvar domain_name)" = "${DOMAIN}" ] && ok "tfvars domain_name == DOMAIN (${DOMAIN})" || fail "tfvars domain_name '$(tfvar domain_name)' != DOMAIN '${DOMAIN}'"

  section "terraform.tfvars"
  # Every variable without a default, read from variables.tf itself, so this never drifts.
  local k; for k in $(required_tf_variables) root_admin_email; do
    if tfvar_present "$k"; then ok "$k present"; else fail "$k missing"; fi
  done
  [ "$(tfvar acknowledge_beaver_data_notification_takeover)" = true ] && ok "acknowledge_beaver_data_notification_takeover = true" || fail "acknowledge_beaver_data_notification_takeover must be true (a precondition fails every full plan otherwise)"
  if tuple_is outage; then ok "writer tuple: OUTAGE (first apply / migration)"; elif tuple_is live; then ok "writer tuple: LIVE"; else fail "writer tuple is neither exactly outage nor exactly live — the plan will fail"; fi
  case "$(tfvar anthropic_api_key)" in "sk-ant-..."|"") warn "anthropic_api_key is a placeholder (Groq is the day-one provider; fine)";; *) ok "anthropic_api_key set";; esac
  case "$(tfvar label_studio_api_key)" in *CHANGE*|"") warn "label_studio_api_key is a placeholder (Label Studio is off; fine)";; *) ok "label_studio_api_key set";; esac
  [ -n "$(tfvar root_admin_email)" ] && ok "root_admin_email = $(tfvar root_admin_email)" || warn "root_admin_email empty: nobody will be promoted to root at first login"

  section ".deploy.env"
  for k in CLOUDFRONT_DISTRIBUTION_ID ROOT_ADMIN_EMAIL; do
    eval "v=\${$k+set}"; [ "${v:-}" = set ] && ok "$k present" || warn "$k missing (needed after the first full apply)"
  done
  [ "${ROOT_ADMIN_EMAIL-unset}" = "$(tfvar root_admin_email)" ] && ok "ROOT_ADMIN_EMAIL == tfvars root_admin_email" || warn "ROOT_ADMIN_EMAIL must equal tfvars root_admin_email exactly"

  section "Quotas"
  local q
  q=$(aws_ro service-quotas get-service-quota --service-code fargate --quota-code L-3032A538 --region "${AWS_REGION}" --query Quota.Value --output text 2>/dev/null \
    || aws_ro service-quotas get-aws-default-service-quota --service-code fargate --quota-code L-3032A538 --region "${AWS_REGION}" --query Quota.Value --output text 2>/dev/null || echo "?")
  [ "${q%%.*}" -ge 12 ] 2>/dev/null && ok "Fargate vCPU quota ${q} (need ≥ 12: app 2 + processing 8 + cleanup)" || fail "Fargate vCPU quota ${q}: request ≥ 16 — aws service-quotas request-service-quota-increase --service-code fargate --quota-code L-3032A538 --desired-value 16"
  q=$(aws_ro lambda get-account-settings --region "${AWS_REGION}" --query AccountLimit.ConcurrentExecutions --output text 2>/dev/null || echo "?")
  [ "${q}" -ge 300 ] 2>/dev/null && ok "Lambda concurrency ${q} (need ≥ 300 for the 200 reservation)" || fail "Lambda concurrency ${q}: request ≥ 1000 (Service Quotas → Lambda → Concurrent executions)"
  q=$(aws_ro service-quotas list-service-quotas --service-code sagemaker --region "${AWS_REGION}" --query "Quotas[?QuotaName=='ml.g4dn.xlarge for processing job usage'].Value | [0]" --output text 2>/dev/null || echo "?")
  [ "${q%%.*}" -ge 1 ] 2>/dev/null && ok "SageMaker ml.g4dn.xlarge processing quota ${q}" || warn "SageMaker ml.g4dn.xlarge processing quota ${q}: YOLO runs need ≥ 1 (not needed for launch)"

  section "Service-linked roles (aws-nuke can delete them; the first apply then fails at the ECS service)"
  local r; for r in ecs.amazonaws.com:AWSServiceRoleForECS ecs.application-autoscaling.amazonaws.com:AWSServiceRoleForApplicationAutoScaling_ECSService elasticloadbalancing.amazonaws.com:AWSServiceRoleForElasticLoadBalancing rds.amazonaws.com:AWSServiceRoleForRDS elasticfilesystem.amazonaws.com:AWSServiceRoleForAmazonElasticFileSystem; do
    if aws_ro iam get-role --role-name "${r#*:}" >/dev/null 2>&1; then ok "${r#*:}"; else fail "${r#*:} missing — aws iam create-service-linked-role --aws-service-name ${r%%:*}"; fi
  done

  section "Certificate (ACM us-east-1)"
  local certs
  certs=$(aws_ro acm list-certificates --region us-east-1 --output json 2>/dev/null | json "j && j.CertificateSummaryList.filter(c=>c.DomainName==='*.${DOMAIN}'||c.DomainName==='${DOMAIN}').map(c=>c.Status+' '+c.CertificateArn).join('\n')")
  if [ -z "${certs}" ]; then fail "no certificate for ${DOMAIN} — bootstrap phase 'certificate' requests one"; else
    printf '%s\n' "${certs}" | while read -r st arn; do [ "${st}" = ISSUED ] && ok "${st} ${arn}" || warn "${st} ${arn}"; done
    local issued; issued=$(printf '%s\n' "${certs}" | awk '$1=="ISSUED"{print $2; exit}')
    [ -n "${issued}" ] && { [ "$(tfvar acm_certificate_arn)" = "${issued}" ] && ok "tfvars acm_certificate_arn points at the issued cert" || fail "tfvars acm_certificate_arn should be ${issued}"; }
  fi

  section "Terraform backend"
  if aws_ro s3api head-bucket --bucket "beaver-terraform-state-${AWS_ACCOUNT}" --region "${AWS_REGION}" >/dev/null 2>&1; then ok "state bucket exists"; else fail "state bucket beaver-terraform-state-${AWS_ACCOUNT} missing (bootstrap creates it)"; fi
  aws_ro dynamodb describe-table --table-name beaver-terraform-locks --region "${AWS_REGION}" >/dev/null 2>&1 && ok "lock table exists" || fail "lock table beaver-terraform-locks missing"
  [ -f "${STATE_DIR}/backend.hcl" ] && ok "backend.hcl in ${STATE_DIR}" || warn "no backend.hcl yet"

  section "DNS (GoDaddy) vs live"
  local alb cf h
  alb=$(alb_dns); cf=$(cf_domain)
  for h in app labelstudio assets; do
    local want; want=$([ "$h" = assets ] && printf '%s' "${cf}" || printf '%s' "${alb}")
    local got; got=$(dig +short "${h}.${DOMAIN}" CNAME 2>/dev/null | sed 's/\.$//' | head -1)
    if [ -z "${want}" ] || [ "${want}" = None ]; then info "${h}.${DOMAIN} → ${got:-<none>} (target not created yet)"
    elif [ "${got}" = "${want}" ]; then ok "${h}.${DOMAIN} → ${got}"; else fail "${h}.${DOMAIN} → ${got:-<none>}, should be ${want}"; fi
  done

  section "Live stack"
  cmd_status_body || true
}

cmd_status_body() {
  local sj; sj=$(service_json)
  if [ -z "${sj}" ] || [ "$(printf '%s' "${sj}" | json 'j && j.services && j.services.length')" != 1 ]; then info "no ECS service yet"; return 0; fi
  local td; td=$(printf '%s' "${sj}" | json 'j.services[0].taskDefinition')
  ok "service ${ECS_SERVICE}: desired $(printf '%s' "${sj}" | json 'j.services[0].desiredCount') running $(printf '%s' "${sj}" | json 'j.services[0].runningCount') rollout $(printf '%s' "${sj}" | json 'j.services[0].deployments[0].rolloutState')"
  info "bound task definition ${td##*/}, image $(td_image "${td}")"
  local latest; latest=$(latest_td "${APP_FAMILY}" 2>/dev/null || true)
  [ "${latest}" = "${td}" ] && ok "latest registered app revision is the bound one" || warn "latest registered revision ${latest##*/} is NOT bound (a terraform apply happened without a roll)"
  local sched; sched=$(aws_ro scheduler get-schedule --name "${MAINTENANCE_SCHEDULE_NAME}" --group-name "${MAINTENANCE_SCHEDULE_GROUP}" --region "${AWS_REGION}" --query State --output text 2>/dev/null || echo "?")
  info "maintenance schedule ${sched}"
  [ -n "${DOMAIN}" ] && { health_ok "https://app.${DOMAIN}/api/health" && ok "https://app.${DOMAIN}/api/health ok" || warn "https://app.${DOMAIN}/api/health not ok"; }
  if [ -f "${RELEASES}" ]; then info "last releases:"; tail -3 "${RELEASES}" | sed 's/^/    /'; fi
}
cmd_status() { load_config; section "Status"; cmd_status_body; }

# ── bootstrap phases ─────────────────────────────────────────────────────────
phase_preflight() {
  cmd_doctor
  printf '\n'
  confirm "Doctor output reviewed. Items later phases create (backend, cert, DNS, .deploy.env keys) may still be red. Continue?"
}

phase_image_build() {
  section "Build the images locally first (the likeliest failure, and free)"
  announce "docker build ×3 (app, Lambda, YOLO) — nothing is pushed"
  run "${DOCKER_BIN}" build --platform linux/amd64 -t beaver-app:bootstrap-check "${PROJECT_DIR}"
  run "${DOCKER_BIN}" build --platform linux/amd64 -f "${PROJECT_DIR}/Dockerfile.lambda" -t beaver-cv-lambda:bootstrap-check "${PROJECT_DIR}"
  run "${DOCKER_BIN}" build --platform linux/amd64 -f "${PROJECT_DIR}/Dockerfile.yolo" -t beaver-yolo-pipeline:bootstrap-check "${PROJECT_DIR}"
  info "smoke: the python the web task shells out to must import cleanly"
  run "${DOCKER_BIN}" run --rm --entrypoint python3 beaver-app:bootstrap-check -c "import fitz, cv2, img2table, PIL, pytesseract; print('python ok', fitz.version[0], cv2.__version__)"
  info "smoke: native node modules must load on the Debian runner (they were traced on an Alpine builder)"
  run "${DOCKER_BIN}" run --rm --entrypoint node beaver-app:bootstrap-check -e "require('sharp'); require('bcrypt'); require('pg'); require('drizzle-orm'); console.log('node native ok')"
}

phase_state_backend() {
  section "Terraform state backend"
  local bucket="beaver-terraform-state-${AWS_ACCOUNT}" table="beaver-terraform-locks"
  if aws_ro s3api head-bucket --bucket "${bucket}" --region "${AWS_REGION}" >/dev/null 2>&1; then ok "bucket ${bucket} exists"; else
    if [ "${AWS_REGION}" = us-east-1 ]; then aws_mut s3api create-bucket --bucket "${bucket}" --region us-east-1
    else aws_mut s3api create-bucket --bucket "${bucket}" --region "${AWS_REGION}" --create-bucket-configuration "LocationConstraint=${AWS_REGION}"; fi
  fi
  aws_mut s3api put-bucket-versioning --bucket "${bucket}" --versioning-configuration Status=Enabled
  aws_mut s3api put-bucket-encryption --bucket "${bucket}" --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  aws_mut s3api put-public-access-block --bucket "${bucket}" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  if aws_ro dynamodb describe-table --table-name "${table}" --region "${AWS_REGION}" >/dev/null 2>&1; then ok "table ${table} exists"; else
    aws_mut dynamodb create-table --table-name "${table}" --attribute-definitions AttributeName=LockID,AttributeType=S \
      --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST --region "${AWS_REGION}"
    aws_ro dynamodb wait table-exists --table-name "${table}" --region "${AWS_REGION}"
  fi
  umask 077
  cat >"${STATE_DIR}/backend.hcl" <<EOF
bucket         = "${bucket}"
key            = "infrastructure/terraform.tfstate"
region         = "${AWS_REGION}"
encrypt        = true
dynamodb_table = "${table}"
EOF
  ok "wrote ${STATE_DIR}/backend.hcl"
  announce "terraform init -reconfigure against the new backend"
  run "${TERRAFORM_BIN}" -chdir="${TF_DIR}" init -reconfigure -input=false -backend-config="${STATE_DIR}/backend.hcl"
}

phase_certificate() {
  section "Certificate (ACM, us-east-1 — one cert for the ALB and CloudFront)"
  local arn status
  arn=$(aws_ro acm list-certificates --region us-east-1 --output json | json "j && (j.CertificateSummaryList.find(c=>c.DomainName==='*.${DOMAIN}'&&c.Status==='ISSUED')||j.CertificateSummaryList.find(c=>c.DomainName==='*.${DOMAIN}')||{}).CertificateArn")
  if [ -z "${arn}" ]; then
    arn=$(capture "${AWS_BIN}" acm request-certificate --domain-name "*.${DOMAIN}" --subject-alternative-names "${DOMAIN}" \
      --validation-method DNS --region us-east-1 --query CertificateArn --output text)
    ok "requested ${arn}"; sleep 5
  else ok "found ${arn}"; fi
  status=$(aws_ro acm describe-certificate --certificate-arn "${arn}" --region us-east-1 --query Certificate.Status --output text)
  if [ "${status}" != ISSUED ]; then
    local rec=""
    wait_for 300 10 "the ACM validation record to be issued" sh -c "${AWS_BIN} acm describe-certificate --certificate-arn ${arn} --region us-east-1 --output json 2>/dev/null | grep -q ResourceRecord"
    rec=$(aws_ro acm describe-certificate --certificate-arn "${arn}" --region us-east-1 --output json | json 'j && j.Certificate.DomainValidationOptions.map(o=>(o.ResourceRecord||{}).Name+"  CNAME  "+(o.ResourceRecord||{}).Value).filter((v,i,a)=>a.indexOf(v)===i).join("\n")')
    pause_for_owner "add this CNAME at GoDaddy (name without the domain suffix, value with the trailing dot allowed). If one with the same name already exists from the old certificate, leave it:
    ${rec}"
    wait_for 3600 30 "certificate ISSUED" sh -c "${AWS_BIN} acm describe-certificate --certificate-arn ${arn} --region us-east-1 --query Certificate.Status --output text 2>/dev/null | grep -q ISSUED"
  fi
  ok "ISSUED ${arn}"
  until [ "$(tfvar acm_certificate_arn)" = "${arn}" ]; do
    pause_for_owner "set in ${TFVARS_FILE}:
    acm_certificate_arn = \"${arn}\""
  done
  ok "tfvars acm_certificate_arn matches"
}

phase_ecr() {
  section "ECR repositories (targeted apply — the images must exist before the full apply)"
  for k in beaver_app_image_digest beaver_yolo_image_digest label_studio_image; do
    until tfvar_present "$k"; do
      case "$k" in
        label_studio_image) pause_for_owner "set in ${TFVARS_FILE} (Label Studio stays OFF, but terraform needs a pinned image; current upstream digest:)
    label_studio_image = \"heartexlabs/label-studio@$(docker_manifest_digest heartexlabs/label-studio:latest || echo 'sha256:<see docker manifest inspect heartexlabs/label-studio:latest>')\"" ;;
        *) pause_for_owner "set a PLACEHOLDER for now in ${TFVARS_FILE} (real digests come from the next phase):
    $k = \"sha256:0000000000000000000000000000000000000000000000000000000000000000\"" ;;
      esac
    done
  done
  info "terraform: only the three ECR repositories"
  tf_apply -target=aws_ecr_repository.beaver_app -target=aws_ecr_repository.beaver_cv_lambda -target=aws_ecr_repository.beaver_yolo_pipeline
}
docker_manifest_digest() { "${DOCKER_BIN}" manifest inspect --verbose "$1" 2>/dev/null | json 'j && (Array.isArray(j) ? j.find(m=>m.Descriptor.platform.architecture==="amd64") : j).Descriptor.digest' || true; }

phase_images() {
  section "Push the three images"
  local base; base=$(ecr_base)
  capture_redacted "aws ecr get-login-password" "${AWS_BIN}" ecr get-login-password --region "${AWS_REGION}" | "${DOCKER_BIN}" login --username AWS --password-stdin "${base}" >/dev/null
  announce "build + push beaver-cv-lambda:latest (Lambda needs it at create time; single manifest, amd64)"
  run "${DOCKER_BIN}" build --platform linux/amd64 -f "${PROJECT_DIR}/Dockerfile.lambda" -t "${base}/beaver-cv-lambda:latest" "${PROJECT_DIR}"
  run "${DOCKER_BIN}" push "${base}/beaver-cv-lambda:latest"
  local mt; mt=$(aws_ro ecr describe-images --repository-name beaver-cv-lambda --image-ids imageTag=latest --region "${AWS_REGION}" --query 'imageDetails[0].imageManifestMediaType' --output text)
  case "${mt}" in *index*|*list*) die "the Lambda image was pushed as an image INDEX (${mt}); Lambda rejects that. Docker Desktop attestations are still on." ;; esac
  ok "Lambda image is a single manifest (${mt})"

  announce "./deploy-yolo.sh (immutable tag, prints the YOLO digest)"
  run_to_file "${STATE_DIR}/last-yolo-publish.txt" "${DEPLOY_YOLO_SH}"
  YOLO_DIGEST=$(sed -n -E 's/.*beaver-yolo-pipeline@(sha256:[0-9a-f]{64}).*/\1/p' "${STATE_DIR}/last-yolo-publish.txt" | tail -1)
  valid_digest "${YOLO_DIGEST:-}" || die "could not read the YOLO digest from deploy-yolo.sh output"
  ledger_set yolo_digest "${YOLO_DIGEST}"

  announce "BP_SKIP_PREFLIGHT=1 ./deploy.sh publish (the gates ran in the container; the Mac cannot run test:scripts)"
  BP_SKIP_PREFLIGHT=1 run_to_file "${STATE_DIR}/last-publish.txt" "${DEPLOY_SH}" publish
  APP_DIGEST=$(sed -n -E 's/.*beaver-app@(sha256:[0-9a-f]{64}).*/\1/p' "${STATE_DIR}/last-publish.txt" | tail -1)
  valid_digest "${APP_DIGEST:-}" || die "could not read the app digest from deploy.sh publish output"
  ledger_set app_digest "${APP_DIGEST}"
  ledger_set app_head "$(git -C "${PROJECT_DIR}" rev-parse HEAD)"

  until [ "$(tfvar beaver_app_image_digest)" = "${APP_DIGEST}" ] && [ "$(tfvar beaver_yolo_image_digest)" = "${YOLO_DIGEST}" ]; do
    pause_for_owner "set the real digests in ${TFVARS_FILE}:
    beaver_app_image_digest  = \"${APP_DIGEST}\"
    beaver_yolo_image_digest = \"${YOLO_DIGEST}\""
  done
  ok "tfvars carries both digests"
}

require_caller() { [ "$(caller_account)" = "${AWS_ACCOUNT}" ] || die "aws caller account is not ${AWS_ACCOUNT} (credentials expired?)"; }

phase_infra_outage() {
  section "Full apply, OUTAGE tuple (the app must not start before the schema exists)"
  require_caller
  [ "$(tfvar acknowledge_beaver_data_notification_takeover)" = true ] || pause_for_owner "set in ${TFVARS_FILE}:
    acknowledge_beaver_data_notification_takeover = true"
  require_tuple outage
  info "terraform: the full stack (~10 min; RDS and NAT start billing now)"
  tf_apply
  ledger_set infra_outage_applied_at "$(date -u +%FT%TZ)"
  local cfid; cfid=$(tf_output cloudfront_distribution_id)
  until [ "${CLOUDFRONT_DISTRIBUTION_ID-unset}" = "${cfid}" ] && [ "${ROOT_ADMIN_EMAIL-unset}" = "$(tfvar root_admin_email)" ]; do
    pause_for_owner "add to ${DEPLOY_ENV_FILE} (both are exact identities the deploy checks compare):
    CLOUDFRONT_DISTRIBUTION_ID=${cfid}
    ROOT_ADMIN_EMAIL=$(tfvar root_admin_email)"
    load_config
  done
  ok ".deploy.env carries CLOUDFRONT_DISTRIBUTION_ID and ROOT_ADMIN_EMAIL"
}

# Before any migration: the maintenance schedule is DISABLED in the outage tuple, but its retry
# window is 600 s, so the cutover contract waits 900 s after its last change before trusting that
# nothing can fire; and no writer (app task or maintenance worker) may still be running.
# The migrator refuses, in BOTH modes, an image whose latest migration is not the pinned
# P2_CURRENT_TAG (scripts/schema-migration-contract.mjs). Check that here, before anything is
# drained, because discovering it from a failed task after a 15-minute wait is a site outage.
require_journal_pin() {
  local latest pin
  latest=$(node -e 'const j=require(process.argv[1]);process.stdout.write(j.entries[j.entries.length-1].tag)' "${PROJECT_DIR}/drizzle/meta/_journal.json")
  pin=$(sed -n -E 's/^export const P2_CURRENT_TAG = "([^"]+)";/\1/p' "${PROJECT_DIR}/scripts/schema-migration-contract.mjs")
  [ -n "${pin}" ] || die "could not read P2_CURRENT_TAG from scripts/schema-migration-contract.mjs"
  [ "${latest}" = "${pin}" ] || die "drizzle journal ends at ${latest} but the migrator is pinned to ${pin}: bump P2_CURRENT_TAG (and the policy/test literals) in the same commit as the migration, then release again"
  ok "journal ${latest} matches the migrator pin"
}

await_writer_quiescence() {
  local modified now since; modified=$(aws_ro scheduler get-schedule --name "${MAINTENANCE_SCHEDULE_NAME}" --group-name "${MAINTENANCE_SCHEDULE_GROUP}" --region "${AWS_REGION}" --query LastModificationDate --output text)
  now=$(date +%s); since=$(( now - $(node -e 'process.stdout.write(String(Math.floor(Date.parse(process.argv[1])/1000)))' "${modified}") ))
  if [ "${since}" -lt "${SCHEDULE_DRAIN_SECONDS}" ]; then info "waiting $(( SCHEDULE_DRAIN_SECONDS - since )) s for the scheduler drain window"; sleep $(( SCHEDULE_DRAIN_SECONDS - since )); fi
  [ "$(service_field 'j.services[0].runningCount')" = 0 ] || die "the app service has running tasks; it must be at 0 for a migration"
  wait_for 600 15 "maintenance workers to finish" sh -c "out=\$(${AWS_BIN} ecs list-tasks --cluster ${ECS_CLUSTER} --family beaver-project-asset-deletions --desired-status RUNNING --region ${AWS_REGION} --query 'taskArns[0]' --output text) || exit 1; [ -z \"\$(printf '%s' \"\$out\" | grep -v '^None$')\" ]"
  ok "no writers running; scheduler drain window elapsed"
}

phase_migrate() {
  section "Create the schema (empty database → 40 migrations)"
  require_journal_pin
  await_writer_quiescence
  local td; td=$(latest_td "${MIGRATOR_FAMILY}")
  [ "$(td_image "${td}")" = "$(ecr_base)/beaver-app@$(ledger_get app_digest)" ] || die "migrator task definition image does not match the published digest"
  one_off_task "${td}" "{\"containerOverrides\":[{\"name\":\"beaver-schema-migrator\",\"environment\":[{\"name\":\"BP_SCHEMA_MIGRATION_MODE\",\"value\":\"${EMPTY_BOOTSTRAP_MODE}\"}]}]}" bp-bootstrap-migrate \
    || die "the migration task failed — read its log above; re-running this phase is safe (the migrator refuses anything but an empty database or the exact current history)"
  ok "schema created"
}

phase_infra_live() {
  section "Go live: LIVE tuple"
  require_caller
  require_tuple live
  info "terraform: desired 1, autoscaling and maintenance schedule on"
  tf_apply
  # Terraform ignores the service's task definition, so a resumed bootstrap whose image was
  # re-published leaves the service on the old revision. Roll it onto the published digest.
  local td; td=$(service_field 'j.services[0].taskDefinition')
  if [ "$(td_image "${td}")" != "$(ecr_base)/${ECR_REPO}@$(ledger_get app_digest)" ]; then
    warn "service is bound to ${td##*/}, not the published digest; rolling it"
    roll_service "$(bound_app_td_for "$(ledger_get app_digest)")" 1
  else
    local tries=0
    until aws_ro ecs wait services-stable --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" --region "${AWS_REGION}" >/dev/null 2>&1; do
      tries=$((tries+1)); [ "${tries}" -lt 3 ] || die "service did not stabilise"; info "still starting…"
    done
  fi
  local alb; alb=$(alb_dns)
  wait_for 600 15 "app healthy through the ALB" health_ok "https://${alb}/api/health" "app.${DOMAIN}"
  ok "app answers through the ALB (${alb})"
  release_record bootstrap "$(ledger_get app_digest)" "-" "$(ledger_get app_head)"
}

phase_dns() {
  section "DNS at GoDaddy"
  local alb cf; alb=$(alb_dns); cf=$(cf_domain)
  if dig +short "app.${DOMAIN}" CNAME 2>/dev/null | sed 's/\.$//' | grep -qx "${alb}"; then ok "app.${DOMAIN} already points at ${alb}"; else
  pause_for_owner "set these CNAMEs at GoDaddy (the old values point at resources that no longer exist):
    app          CNAME  ${alb}
    labelstudio  CNAME  ${alb}
    assets       CNAME  ${cf}
  and DELETE the stale 'hded' A record (it points at an AWS address that may be reassigned)."
  fi
  wait_for 3600 30 "app.${DOMAIN} to resolve to the ALB" sh -c "dig +short app.${DOMAIN} CNAME | sed 's/\.\$//' | grep -qx '${alb}'"
  wait_for 600 15 "https://app.${DOMAIN}/api/health" health_ok "https://app.${DOMAIN}/api/health"
  ok "https://app.${DOMAIN} is live"
}

phase_first_user() {
  section "First account"
  local email; email=$(tfvar root_admin_email); [ -n "${email}" ] || die "root_admin_email is empty in tfvars; set it and re-run this phase"
  local name slug key
  printf '  Company name for your own account [BlueprintParser]: '; read -r name </dev/tty || true; name="${name:-BlueprintParser}"
  slug=$(printf '%s' "${name}" | tr 'A-Z' 'a-z' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')-$(openssl rand -hex 4)
  key=$(openssl rand -hex 16)
  local td; td=$(latest_td "${MIGRATOR_FAMILY}")
  # The migrator task definition has DATABASE_URL and nothing else; `worker` mode asserts the
  # schema is current before running the command. Values travel as env overrides (visible in
  # describe-tasks for the task's lifetime — the access key is shown to you once and can be
  # regenerated in the admin UI). The SQL lives in scripts/bootstrap-first-company.mjs, in the image.
  one_off_task "${td}" "$(node -e 'const [name,slug,key]=process.argv.slice(1);process.stdout.write(JSON.stringify({containerOverrides:[{name:"beaver-schema-migrator",command:["./entrypoint.sh","worker","node","scripts/bootstrap-first-company.mjs"],environment:[{name:"BP_COMPANY_NAME",value:name},{name:"BP_DATA_KEY",value:slug},{name:"BP_ACCESS_KEY",value:key}]}]}))' "${name}" "${slug}" "${key}")" bp-bootstrap-company \
    || { [ "${LAST_TASK_EXIT}" = 4 ] || die "could not insert the company row"; }
  if [ "${LAST_TASK_EXIT}" = 4 ]; then
    warn "a company already exists (an earlier run inserted it); its key was shown then — if lost, regenerate it in /admin after logging in. No new row, no new key."
  else
    printf '\n  %bCompany access key (shown once; regenerate it in /admin afterwards — it also sits in the ECS task record for a while):%b %s\n' "${BOLD}" "${NC}" "${key}"
  fi
  pause_for_owner "register at https://app.${DOMAIN}/register with email ${email}, the key above, and a password (10+ chars, one uppercase, one digit); then LOG IN once (that login promotes ${email} to root admin)."
  one_off_task "${td}" "$(node -e 'const [email]=process.argv.slice(1);process.stdout.write(JSON.stringify({containerOverrides:[{name:"beaver-schema-migrator",command:["./entrypoint.sh","worker","node","scripts/promote-first-admin.mjs"],environment:[{name:"BP_EMAIL",value:email}]}]}))' "${email}")" bp-bootstrap-admin \
    || die "no root-admin row for ${email} yet — did the login happen? re-run this phase after logging in"
  ok "${email} is root admin with the admin role; /admin is open"
}

phase_verify() {
  section "Verify with the digest-pinned machinery (same-image restart)"
  announce "./deploy.sh activate $(ledger_get app_digest)"
  run "${DEPLOY_SH}" activate "$(ledger_get app_digest)"
}

cmd_bootstrap() {
  load_config; require_config AWS_ACCOUNT AWS_REGION DOMAIN
  section "Bootstrap — ledger ${LEDGER}"
  local p started=0
  # --from P re-runs P and everything after it: a later phase's "done" was earned against the
  # state P is about to change (a re-publish changes the digest every later phase depends on).
  if [ -n "${FROM_PHASE}" ]; then
    for p in ${PHASES}; do
      if [ "$p" = "${FROM_PHASE}" ]; then started=1; fi
      [ "${started}" = 1 ] && ledger_set "phase:$p" pending
    done
    started=0
  fi
  for p in ${PHASES}; do
    if [ -n "${FROM_PHASE}" ] && [ "${started}" = 0 ]; then [ "$p" = "${FROM_PHASE}" ] && started=1 || continue; fi
    if phase_done "$p"; then ok "phase $p already done"; continue; fi
    printf '\n%b▶ phase %s%b\n' "${BOLD}" "$p" "${NC}"
    "phase_$(printf '%s' "$p" | tr '-' '_')"
    mark_done "$p"
  done
  section "Bootstrap complete — https://app.${DOMAIN}"
}

# ── release ──────────────────────────────────────────────────────────────────
deployed_head() {
  local h; h=$(last_release_field head)
  if [ -z "${h}" ]; then # fall back to the tag on the bound image: deploy-<sha12>-<ts>
    local tag; tag=$(aws_ro ecr describe-images --repository-name "${ECR_REPO}" --image-ids "imageDigest=$(live_digest)" --region "${AWS_REGION}" --query 'imageDetails[0].imageTags[0]' --output text 2>/dev/null || true)
    h=$(printf '%s' "${tag}" | sed -n -E 's/^deploy-([0-9a-f]{12})-.*/\1/p')
  fi
  printf '%s' "${h}"
}
require_green_head() {
  local head="$1" f="${GREEN_HEADS}"
  [ "${ALLOW_UNVERIFIED}" = 1 ] && { warn "--allow-unverified: skipping the test-gate check"; return 0; }
  if [ -f "${f}" ] && grep -q "^${head}" "${f}"; then ok "HEAD ${head:0:12} passed the full suite (GREEN_HEADS)"; return 0; fi
  die "HEAD ${head:0:12} is not in GREEN_HEADS (run the suite in the container and record it), or pass --allow-unverified"
}

# deploy.sh's own clean-tree gate is skipped (BP_SKIP_PREFLIGHT=1), so it lives here: the image is
# built from the working tree, and the ledger records HEAD as what shipped. Same allowlist.
require_clean_tree() {
  local dirt
  dirt=$(git -C "${PROJECT_DIR}" status --porcelain | grep -v -E '^ M \.gitignore$|^\?\? perf/private-gateway-baseline\.json$' || true)
  [ -z "${dirt}" ] && { ok "working tree clean (known owner dirt allowed)"; return 0; }
  [ "${BP_ALLOW_DIRTY:-0}" = 1 ] && { warn "uncommitted changes will ship (BP_ALLOW_DIRTY=1):"; printf '%s\n' "${dirt}" | sed 's/^/    /'; return 0; }
  printf '%s\n' "${dirt}" | sed 's/^/    /'
  die "uncommitted changes: commit them, or BP_ALLOW_DIRTY=1 to ship the working tree anyway"
}

cmd_release() {
  load_config; require_config AWS_ACCOUNT AWS_REGION DOMAIN CLOUDFRONT_DISTRIBUTION_ID
  section "Release$( [ "${OUTAGE}" = 1 ] && printf ' (OUTAGE: schema change)')"
  local head; head=$(git -C "${PROJECT_DIR}" rev-parse HEAD)
  require_clean_tree
  [ "$(caller_account)" = "${AWS_ACCOUNT}" ] || die "aws caller account is not ${AWS_ACCOUNT}"
  require_green_head "${head}"
  local previous; previous=$(live_digest); info "live digest ${previous:-<none>}"
  local dh; dh=$(deployed_head)
  if [ -n "${dh}" ] && ! git -C "${PROJECT_DIR}" diff --quiet "${dh}" "${head}" -- drizzle/ 2>/dev/null; then
    if [ "${OUTAGE}" = 0 ]; then die "drizzle/ changed since the deployed HEAD ${dh:0:12}: this release carries a schema change. Run: ./deploy-aws.sh release --outage"; fi
    warn "schema change detected — outage path"
  elif [ "${OUTAGE}" = 1 ]; then
    warn "no drizzle/ change since ${dh:0:12}; --outage is not needed but proceeds"
  fi

  [ "${OUTAGE}" = 1 ] && require_journal_pin
  announce "BP_SKIP_PREFLIGHT=1 ./deploy.sh publish"
  local digest
  BP_SKIP_PREFLIGHT=1 run_to_file "${STATE_DIR}/last-publish.txt" "${DEPLOY_SH}" publish
  digest=$(sed -n -E 's/.*beaver-app@(sha256:[0-9a-f]{64}).*/\1/p' "${STATE_DIR}/last-publish.txt" | tail -1)
  valid_digest "${digest:-}" || die "could not read the digest from deploy.sh publish"
  ok "published ${digest}"

  if [ "${OUTAGE}" = 1 ]; then release_outage "${digest}" "${previous}" "${head}"; else release_rolling "${digest}" "${previous}" "${head}"; fi
}

apply_digest() { # apply_digest <digest> <tuple>
  until [ "$(tfvar beaver_app_image_digest)" = "$1" ]; do
    pause_for_owner "set in ${TFVARS_FILE}:
    beaver_app_image_digest = \"$1\""
  done
  require_tuple "$2"
  info "terraform: registers the four task definitions for ${1:0:19}…; the service keeps its current revision until we roll it"
  tf_apply
}
bound_app_td_for() { # bound_app_td_for <digest> → latest app td arn, asserting its image
  local td; td=$(latest_td "${APP_FAMILY}")
  [ "$(td_image "${td}")" = "$(ecr_base)/${ECR_REPO}@$1" ] || die "latest app task definition does not carry $1 — did the apply run?"
  printf '%s' "${td}"
}
schema_check() { # read-only: the new image's journal must equal the database's history
  local td; td=$(latest_td "${MIGRATOR_FAMILY}")
  one_off_task "${td}" '{"containerOverrides":[{"name":"beaver-schema-migrator","command":["./entrypoint.sh","schema-check"]}]}' bp-release-schema-check
}

release_rolling() {
  local digest="$1" previous="$2" head="$3"
  apply_digest "${digest}" live
  schema_check || die "schema check FAILED: the database does not match the new image's migrations. The service still runs ${previous}. Use: ./deploy-aws.sh release --outage"
  ok "schema check passed"
  roll_service "$(bound_app_td_for "${digest}")" 1
  wait_for 300 10 "https://app.${DOMAIN}/api/health" health_ok "https://app.${DOMAIN}/api/health"
  release_record release "${digest}" "${previous}" "${head}"
  section "Released ${digest:0:19}… (previous ${previous:0:19}…) — ./deploy-aws.sh rollback undoes it"
}

release_outage() {
  local digest="$1" previous="$2" head="$3"
  apply_digest "${digest}" outage
  wait_for 900 15 "service drained to 0 running" sh -c "[ \"\$(${AWS_BIN} ecs describe-services --cluster ${ECS_CLUSTER} --services ${ECS_SERVICE} --region ${AWS_REGION} --query 'services[0].runningCount' --output text)\" = 0 ]"
  await_writer_quiescence
  local td; td=$(latest_td "${MIGRATOR_FAMILY}")
  one_off_task "${td}" "{\"containerOverrides\":[{\"name\":\"beaver-schema-migrator\",\"environment\":[{\"name\":\"BP_SCHEMA_MIGRATION_MODE\",\"value\":\"${FORWARD_MODE}\"}]}]}" bp-release-migrate \
    || die "migration FAILED. The service is at 0 and still bound to ${previous}. Fix forward, or restore the LIVE tuple with the previous digest to come back up."
  ok "migrated"
  roll_service "$(bound_app_td_for "${digest}")" 0
  apply_digest "${digest}" live
  wait_for 600 15 "https://app.${DOMAIN}/api/health" health_ok "https://app.${DOMAIN}/api/health"
  release_record release-outage "${digest}" "${previous}" "${head}"
  section "Released ${digest:0:19}… with schema change"
}

cmd_rollback() {
  load_config; require_config AWS_ACCOUNT AWS_REGION DOMAIN
  section "Rollback"
  local previous; previous=$(last_release_field previous)
  valid_digest "${previous:-}" || die "no previous digest in ${RELEASES}"
  local current; current=$(live_digest)
  info "live ${current} → back to ${previous}"
  # The restored image was built from an earlier HEAD; record that one, so the next release's
  # drizzle/ comparison starts from the code that is actually running.
  local ph; ph=$(node -e 'const fs=require("fs");const [p,d]=process.argv.slice(1);const rows=fs.readFileSync(p,"utf8").trim().split("\n").map(l=>JSON.parse(l));const r=[...rows].reverse().find(r=>r.digest===d);process.stdout.write(r?r.head:"")' "${RELEASES}" "${previous}")
  confirm "Re-bind ${previous:0:19}…? (the schema check below refuses if its migrations differ from the database)"
  apply_digest "${previous}" live
  schema_check || die "the previous image's migrations do not match the database; a rollback across a schema change is not possible"
  roll_service "$(bound_app_td_for "${previous}")" 1
  release_record rollback "${previous}" "${current}" "${ph}"
  ok "rolled back"
}

cmd_restart() {
  load_config
  local d; d=$(live_digest); valid_digest "${d:-}" || die "no live digest"
  announce "./deploy.sh activate ${d} (same image; picks up secret/config changes)"
  run "${DEPLOY_SH}" activate "${d}"
}
cmd_logs() { load_config; run "${AWS_BIN}" logs tail /ecs/blueprintparser-app --since 10m --follow --region "${AWS_REGION}"; }
cmd_unlock_login() {
  load_config; require_config AWS_ACCOUNT AWS_REGION
  [ -n "${1:-}" ] || die "usage: ./deploy-aws.sh unlock-login <email>"
  local td; td=$(latest_td "${MIGRATOR_FAMILY}")
  one_off_task "${td}" "$(node -e 'const [email]=process.argv.slice(1);process.stdout.write(JSON.stringify({containerOverrides:[{name:"beaver-schema-migrator",command:["./entrypoint.sh","worker","node","scripts/unlock-login.mjs"],environment:[{name:"BP_EMAIL",value:email}]}]}))' "$1")" bp-unlock-login \
    || die "unlock failed"
  ok "lockouts cleared for $1"
}

# ── TUI ──────────────────────────────────────────────────────────────────────
tui() {
  load_config
  while :; do
    printf '\n%b━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%b\n' "${CYAN}" "${NC}"
    printf '%b  BlueprintParser → AWS%b   account %s · %s · %s\n' "${BOLD}" "${NC}" "${AWS_ACCOUNT:-?}" "${AWS_REGION}" "${DOMAIN:-?}"
    printf '%b━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%b\n' "${CYAN}" "${NC}"
    local p n=0 d=0; for p in ${PHASES}; do n=$((n+1)); phase_done "$p" && d=$((d+1)); done
    printf '  bootstrap: %s/%s phases done · branch %s @ %s\n' "$d" "$n" "$(git -C "${PROJECT_DIR}" rev-parse --abbrev-ref HEAD 2>/dev/null)" "$(git -C "${PROJECT_DIR}" rev-parse --short=12 HEAD 2>/dev/null)"
    printf '\n  1) doctor     — check Mac, AWS identity, quotas, config, cert, DNS (read-only)\n'
    printf '  2) status     — what is live (read-only)\n'
    printf '  3) bootstrap  — first deploy on an empty account, resumable (%s/%s)\n' "$d" "$n"
    printf '  4) release    — build → push → apply → schema check → rolling update (no downtime)\n'
    printf '  5) release with schema change (--outage, ~10 min down)\n'
    printf '  6) restart    — same image, picks up secret/config changes\n'
    printf '  7) rollback   — re-bind the previous digest\n'
    printf '  8) logs       — tail the app log\n'
    printf '  9) unlock     — clear a login lockout for an email\n'
    printf '  q) quit\n\n  > '
    local c; read -r c </dev/tty || exit 0
    case "${c}" in
      1) cmd_doctor ;; 2) cmd_status ;; 3) cmd_bootstrap ;;
      4) OUTAGE=0; cmd_release ;; 5) OUTAGE=1; cmd_release ;;
      6) cmd_restart ;; 7) cmd_rollback ;; 8) cmd_logs ;;
      9) local e; printf '  email: '; read -r e </dev/tty || e=""; cmd_unlock_login "${e}" ;;
      q|Q) exit 0 ;; *) warn "unknown choice" ;;
    esac
  done
}

usage() { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 64; }

# ── main ─────────────────────────────────────────────────────────────────────
cmd="${1:-}"; [ $# -gt 0 ] && shift
POSITIONAL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1 ;;
    --from) FROM_PHASE="$2"; shift; case " ${PHASES} " in *" ${FROM_PHASE} "*) ;; *) die "unknown phase ${FROM_PHASE}; phases: ${PHASES}" ;; esac ;;
    --outage) OUTAGE=1 ;;
    --allow-unverified) ALLOW_UNVERIFIED=1 ;;
    -h|--help) usage ;;
    -*) die "unknown option $1" ;;
    *) POSITIONAL="$1" ;;
  esac
  shift
done
case "${cmd}" in
  "") tui ;;
  doctor) cmd_doctor ;;
  status) cmd_status ;;
  bootstrap) cmd_bootstrap ;;
  release) cmd_release ;;
  rollback) cmd_rollback ;;
  restart) cmd_restart ;;
  logs) cmd_logs ;;
  unlock-login) cmd_unlock_login "${POSITIONAL}" ;;
  help|-h|--help) usage ;;
  *) usage ;;
esac
