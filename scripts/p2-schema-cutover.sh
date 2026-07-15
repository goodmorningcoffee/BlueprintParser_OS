#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/ecs-schema-tools.sh
source "${PROJECT_DIR}/scripts/lib/ecs-schema-tools.sh"

readonly CALLER_BP_APP_IMAGE_DIGEST="${BP_APP_IMAGE_DIGEST:-}"
readonly CALLER_BP_CANDIDATE_IMAGE_DIGEST="${BP_CANDIDATE_IMAGE_DIGEST:-}"
DEPLOY_ENV_FILE="${BP_DEPLOY_ENV_FILE:-${PROJECT_DIR}/.deploy.env}"
[ -f "${DEPLOY_ENV_FILE}" ] && source "${DEPLOY_ENV_FILE}"
# Image identities are cutover authority. A convenience env file may supply
# infrastructure coordinates, but it may never replace caller-supplied digests.
BP_APP_IMAGE_DIGEST="${CALLER_BP_APP_IMAGE_DIGEST}"
BP_CANDIDATE_IMAGE_DIGEST="${CALLER_BP_CANDIDATE_IMAGE_DIGEST}"
export BP_APP_IMAGE_DIGEST BP_CANDIDATE_IMAGE_DIGEST

for forbidden_override in \
  APP_FAMILY CPU_FAMILY MAINTENANCE_FAMILY MIGRATOR_FAMILY \
  MAINTENANCE_SCHEDULE_GROUP MAINTENANCE_SCHEDULE_NAME; do
  if [ "${!forbidden_override+x}" = x ]; then
    bp_die "${forbidden_override} is not configurable for the P2 production boundary"
    exit 64
  fi
done

readonly APP_FAMILY="beaver-app"
readonly CPU_FAMILY="beaver-cpu-pipeline"
readonly MAINTENANCE_FAMILY="beaver-project-asset-deletions"
readonly MIGRATOR_FAMILY="beaver-schema-migrator"
readonly MAINTENANCE_SCHEDULE_GROUP="beaver-maintenance"
readonly MAINTENANCE_SCHEDULE_NAME="beaver-project-asset-deletions"
readonly CANONICAL_ECS_CLUSTER="beaver-cluster"
readonly CANONICAL_ECS_SERVICE="beaver-app"
readonly CANONICAL_ECR_REPO="beaver-app"
readonly MAINTENANCE_MAX_EVENT_AGE_SECONDS=600
readonly ECS_CONSISTENCY_WINDOW_SECONDS=300
readonly QUIESCENCE_OBSERVATION_SECONDS=300
readonly TASK_DEFINITION_DEREGISTRATION_WINDOW_SECONDS=600
readonly WRITER_WITNESS_TTL_SECONDS=21600
readonly P2_MIGRATION_MODE="p2-0037-singleton-quiescent"
readonly EMPTY_BOOTSTRAP_MODE="empty-database-singleton-quiescent"
readonly EMPTY_BOOTSTRAP_STRICT_READINESS_MODE="empty-database-strict-readiness"
readonly EMPTY_BOOTSTRAP_RETRY_READINESS_MODE="empty-database-armed-retry-readiness"

usage() {
  cat >&2 <<'EOF'
Usage:
  BP_APP_IMAGE_DIGEST=sha256:BASELINE BP_CANDIDATE_IMAGE_DIGEST=sha256:CANDIDATE \
    scripts/p2-schema-cutover.sh preflight-outage
  BP_APP_IMAGE_DIGEST=sha256:... scripts/p2-schema-cutover.sh run
  BP_APP_IMAGE_DIGEST=sha256:... scripts/p2-schema-cutover.sh bootstrap-empty
  BP_APP_IMAGE_DIGEST=sha256:... scripts/p2-schema-cutover.sh verify-restored
  BP_APP_IMAGE_DIGEST=sha256:... scripts/p2-schema-cutover.sh bind-quiescent

For an existing database, `run` requires an owner-local witness created by
`preflight-outage` while the service and all latest writer definitions still use
the explicitly supplied baseline digest. The witness is bound to the explicitly
supplied intended candidate and Terraform-managed remote outage epoch. Apply the
candidate definitions only after that proof, preserving the exact outage tuple
and epoch. A changed Scheduler timestamp is re-aged and retained as supplemental
audit evidence. `run` then requires the maintenance schedule DISABLED,
app desired/minimum zero, autoscaling maximum one with every scaling mode
suspended, zero app/CPU/maintenance/migrator tasks, zero running Step Functions
executions, and all four latest task definitions pinned to the candidate digest.
It runs one singleton migrator and binds the app revision while desired count
remains zero. `bootstrap-empty` is the deliberate no-baseline exception. A first
attempt accepts only zero migration history plus no objects in the public schema,
then writes an owner-local armed witness before any mutation. Only a retry with
that exact, unexpired witness may admit exact-current history after an ambiguous
success. Existing-database paths likewise persist a short-lived, full-candidate
`candidate-admitted` receipt before UpdateService; a retry accepts only the exact
recorded baseline or candidate binding and reuses the nonce-derived P2 migration
token. Only the final fully proved quiescent binding becomes nonexpiring.
It deliberately does not restore writers; restore Terraform counts/schedule only
after `run`, then execute `verify-restored` before reopening labeling.

Ordinary candidate rollouts use the separate witness-backed cohort: prove the
old digest in `preflight-outage`, apply only the candidate task definitions while
the exact outage tuple remains in force, then `bind-quiescent`. Restore the exact
live tuple and invoke `verify-restored` through deploy.sh to consume the witness.
EOF
  exit 64
}

assert_eq() {
  local actual="$1" expected="$2" description="$3"
  if [ "${actual}" != "${expected}" ]; then
    bp_die "${description}: expected ${expected}, found ${actual}"
    return 1
  fi
}

assert_boolean() {
  local actual="${1,,}" expected="${2,,}" description="$3"
  assert_eq "${actual}" "${expected}" "${description}"
}

writer_outage_witness_path() {
  printf '%s\n' "${BP_WRITER_OUTAGE_WITNESS_FILE:-${XDG_RUNTIME_DIR:-/tmp}/blueprintparser-writer-outage-${AWS_ACCOUNT}-${AWS_REGION}.json}"
}

acquire_writer_operation_lock() {
  local witness_path lock_path
  witness_path=$(writer_outage_witness_path)
  lock_path="${witness_path}.lock"
  command -v flock >/dev/null 2>&1 || {
    bp_die "flock is required for serialized writer-witness operations"
    return 1
  }
  node -e '
const fs = require("node:fs");
const path = require("node:path");
const lockPath = process.argv[1];
if (!path.isAbsolute(lockPath)) process.exit(2);
const directory = path.dirname(lockPath);
if (!fs.statSync(directory).isDirectory()) process.exit(2);
try {
  const fd = fs.openSync(lockPath, "wx", 0o600);
  fs.closeSync(fd);
} catch (error) {
  if (error?.code !== "EEXIST") throw error;
}
const stat = fs.lstatSync(lockPath);
if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0 || stat.size !== 0) process.exit(2);
' "${lock_path}" || {
    bp_die "missing or unsafe owner-local writer operation lock ${lock_path}"
    return 1
  }
  exec {WRITER_OPERATION_LOCK_FD}<>"${lock_path}"
  if ! flock -n "${WRITER_OPERATION_LOCK_FD}"; then
    bp_die "another writer-witness operation is already in progress"
    return 1
  fi
  readonly WRITER_OPERATION_LOCK_FD
}

schedule_generation() {
  local raw
  raw=$(bp_aws scheduler get-schedule \
    --group-name "${MAINTENANCE_SCHEDULE_GROUP}" \
    --name "${MAINTENANCE_SCHEDULE_NAME}" \
    --region "${AWS_REGION}" \
    --query LastModificationDate \
    --output text)
  node -e '
const value = process.argv[1];
const parsed = Date.parse(value);
if (!Number.isFinite(parsed)) process.exit(2);
process.stdout.write(new Date(parsed).toISOString());
' "${raw}" || {
    bp_die "invalid maintenance schedule LastModificationDate: ${raw}"
    return 1
  }
}

writer_mode_snapshot() {
  local expected_mode="$1" service_arn expected_service_arn tags_json
  service_arn=$(bp_aws ecs describe-services \
    --cluster "${ECS_CLUSTER}" \
    --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" \
    --query 'services[0].serviceArn' \
    --output text)
  expected_service_arn="arn:aws:ecs:${AWS_REGION}:${AWS_ACCOUNT}:service/${ECS_CLUSTER##*/}/${ECS_SERVICE##*/}"
  assert_eq "${service_arn}" "${expected_service_arn}" \
    "writer-mode epoch service ARN" || return 1
  tags_json=$(bp_aws ecs list-tags-for-resource \
    --resource-arn "${service_arn}" \
    --region "${AWS_REGION}" \
    --query tags \
    --output json)
  node -e '
const [raw, expectedMode] = process.argv.slice(1);
const tags = JSON.parse(raw);
if (!Array.isArray(tags) || !["live", "outage"].includes(expectedMode)) process.exit(2);
const exact = (key) => tags.filter((tag) =>
  tag && typeof tag === "object" && !Array.isArray(tag) &&
  Object.keys(tag).length === 2 && typeof tag.key === "string" &&
  typeof tag.value === "string" && tag.key === key);
const modes = exact("BlueprintParserWriterMode");
const epochs = exact("BlueprintParserWriterModeEpoch");
if (modes.length !== 1 || modes[0].value !== expectedMode || epochs.length !== 1 ||
    !/^[0-9a-f]{64}$/u.test(epochs[0].value)) {
  process.exit(2);
}
process.stdout.write(epochs[0].value);
' "${tags_json}" "${expected_mode}" || {
    bp_die "missing or invalid canonical ${expected_mode} writer-mode epoch on ${ECS_SERVICE}"
    return 1
  }
}

write_writer_outage_witness() {
  local phase="$1" baseline_digest="$2" baseline_task_definition="$3"
  local baseline_cpu_task_definition="$4" baseline_maintenance_task_definition="$5"
  local baseline_migrator_task_definition="$6" candidate_digest="$7"
  local candidate_task_definition="$8" candidate_cpu_task_definition="$9"
  local candidate_maintenance_task_definition="${10}"
  local candidate_migrator_task_definition="${11}" database_secret="${12}"
  local outage_epoch="${13}" schedule_generation_value="${14}"
  local issued_at_epoch="${15}" expires_at_epoch="${16}" nonce="${17}"
  local witness_path
  witness_path=$(writer_outage_witness_path)
  node -e '
const fs = require("node:fs");
const pathModule = require("node:path");
const { randomBytes } = require("node:crypto");
const [
  witnessPath, phase, account, region, cluster, service, ecrRepo,
  baselineDigest, baselineTaskDefinition, baselineCpuTaskDefinition,
  baselineMaintenanceTaskDefinition, baselineMigratorTaskDefinition,
  candidateDigestArg, candidateTaskDefinitionArg, candidateCpuTaskDefinitionArg,
  candidateMaintenanceTaskDefinitionArg, candidateMigratorTaskDefinitionArg,
  databaseSecret, outageEpoch, scheduleGeneration,
  issuedAtArg, expiresAtArg, nonceArg, ttlArg,
] = process.argv.slice(1);
const candidateTaskDefinition = candidateTaskDefinitionArg === "-" ? null : candidateTaskDefinitionArg;
const candidateCpuTaskDefinition = candidateCpuTaskDefinitionArg === "-" ? null : candidateCpuTaskDefinitionArg;
const candidateMaintenanceTaskDefinition = candidateMaintenanceTaskDefinitionArg === "-" ? null : candidateMaintenanceTaskDefinitionArg;
const candidateMigratorTaskDefinition = candidateMigratorTaskDefinitionArg === "-" ? null : candidateMigratorTaskDefinitionArg;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const taskDefinitionPattern = (family) => new RegExp(`^arn:aws:ecs:${region}:${account}:task-definition/${family}:[1-9][0-9]*$`);
const validBaselineDefinitions =
  taskDefinitionPattern("beaver-app").test(baselineTaskDefinition) &&
  taskDefinitionPattern("beaver-cpu-pipeline").test(baselineCpuTaskDefinition) &&
  taskDefinitionPattern("beaver-project-asset-deletions").test(baselineMaintenanceTaskDefinition) &&
  taskDefinitionPattern("beaver-schema-migrator").test(baselineMigratorTaskDefinition);
const candidateDefinitions = [candidateTaskDefinition, candidateCpuTaskDefinition,
  candidateMaintenanceTaskDefinition, candidateMigratorTaskDefinition];
const validCandidateDefinitions =
  taskDefinitionPattern("beaver-app").test(candidateTaskDefinition ?? "") &&
  taskDefinitionPattern("beaver-cpu-pipeline").test(candidateCpuTaskDefinition ?? "") &&
  taskDefinitionPattern("beaver-project-asset-deletions").test(candidateMaintenanceTaskDefinition ?? "") &&
  taskDefinitionPattern("beaver-schema-migrator").test(candidateMigratorTaskDefinition ?? "");
const databaseSecretPattern = new RegExp(`^arn:aws:secretsmanager:${region}:${account}:secret:beaver/DATABASE_URL-[A-Za-z0-9]{6}:::[A-Za-z0-9-]{32,64}$`);
const ttl = Number(ttlArg);
const nowEpoch = Math.floor(Date.now() / 1000);
const creating = issuedAtArg === "-" && expiresAtArg === "-" && nonceArg === "-";
const issuedAtEpoch = creating ? nowEpoch : Number(issuedAtArg);
const durable = phase === "quiescent-bound";
const expiresAtEpoch = durable ? null : (creating ? nowEpoch + ttl : Number(expiresAtArg));
const nonce = creating ? randomBytes(32).toString("hex") : nonceArg;
const bootstrap = baselineDigest === candidateDigestArg;
if (
  !pathModule.isAbsolute(witnessPath) ||
  !["outage-preflight", "candidate-admitted", "empty-bootstrap-armed", "quiescent-bound"].includes(phase) ||
  !/^[0-9]{12}$/u.test(account) ||
  !/^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*$/u.test(region) ||
  cluster !== "beaver-cluster" || service !== "beaver-app" || ecrRepo !== "beaver-app" ||
  !digestPattern.test(baselineDigest) || !validBaselineDefinitions ||
  !digestPattern.test(candidateDigestArg) || !databaseSecretPattern.test(databaseSecret) ||
  !/^[0-9a-f]{64}$/u.test(outageEpoch) ||
  new Date(scheduleGeneration).toISOString() !== scheduleGeneration ||
  !Number.isSafeInteger(ttl) || ttl !== 21600 ||
  !Number.isSafeInteger(issuedAtEpoch) || issuedAtEpoch <= 0 || issuedAtEpoch > nowEpoch ||
  (durable ? expiresAtArg !== "null" :
    (!Number.isSafeInteger(expiresAtEpoch) || expiresAtEpoch !== issuedAtEpoch + ttl || expiresAtEpoch <= nowEpoch)) ||
  !/^[0-9a-f]{64}$/u.test(nonce) ||
  (phase === "outage-preflight" &&
    (bootstrap || candidateDefinitions.some((definition) => definition !== null))) ||
  (phase === "candidate-admitted" &&
    (bootstrap || !validCandidateDefinitions)) ||
  (phase === "empty-bootstrap-armed" &&
    (!bootstrap || !validCandidateDefinitions ||
      candidateTaskDefinition !== baselineTaskDefinition ||
      candidateCpuTaskDefinition !== baselineCpuTaskDefinition ||
      candidateMaintenanceTaskDefinition !== baselineMaintenanceTaskDefinition ||
      candidateMigratorTaskDefinition !== baselineMigratorTaskDefinition)) ||
  (phase === "quiescent-bound" && !validCandidateDefinitions)
) process.exit(2);
const directory = pathModule.dirname(witnessPath);
if (!fs.statSync(directory).isDirectory()) process.exit(2);
const record = {
  version: 2,
  phase,
  account,
  region,
  cluster,
  service,
  ecrRepo,
  baselineDigest,
  baselineTaskDefinition,
  baselineCpuTaskDefinition,
  baselineMaintenanceTaskDefinition,
  baselineMigratorTaskDefinition,
  candidateDigest: candidateDigestArg,
  candidateTaskDefinition,
  candidateCpuTaskDefinition,
  candidateMaintenanceTaskDefinition,
  candidateMigratorTaskDefinition,
  databaseSecret,
  outageEpoch,
  scheduleGeneration,
  issuedAtEpoch,
  expiresAtEpoch,
  nonce,
};
const temporaryPath = `${witnessPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
try {
  fs.writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.chmodSync(temporaryPath, 0o600);
  fs.renameSync(temporaryPath, witnessPath);
} catch (error) {
  try { fs.unlinkSync(temporaryPath); } catch {}
  throw error;
}
' "${witness_path}" "${phase}" "${AWS_ACCOUNT}" "${AWS_REGION}" \
    "${ECS_CLUSTER}" "${ECS_SERVICE}" "${ECR_REPO}" \
    "${baseline_digest}" "${baseline_task_definition}" \
    "${baseline_cpu_task_definition}" "${baseline_maintenance_task_definition}" \
    "${baseline_migrator_task_definition}" "${candidate_digest}" \
    "${candidate_task_definition:--}" "${candidate_cpu_task_definition:--}" \
    "${candidate_maintenance_task_definition:--}" \
    "${candidate_migrator_task_definition:--}" \
    "${database_secret}" "${outage_epoch}" "${schedule_generation_value}" \
    "${issued_at_epoch}" "${expires_at_epoch}" "${nonce}" \
    "${WRITER_WITNESS_TTL_SECONDS}" || {
      bp_die "could not write the owner-local writer outage witness ${witness_path}"
      return 1
    }
}

load_writer_outage_witness() {
  local witness_path output
  local -a fields
  witness_path=$(writer_outage_witness_path)
  output=$(node -e '
const fs = require("node:fs");
const [witnessPath] = process.argv.slice(1);
const stat = fs.lstatSync(witnessPath);
if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 4096) {
  process.exit(2);
}
const record = JSON.parse(fs.readFileSync(witnessPath, "utf8"));
const expectedKeys = [
  "account", "baselineCpuTaskDefinition", "baselineDigest",
  "baselineMaintenanceTaskDefinition", "baselineMigratorTaskDefinition",
  "baselineTaskDefinition", "candidateCpuTaskDefinition", "candidateDigest",
  "candidateMaintenanceTaskDefinition", "candidateMigratorTaskDefinition",
  "candidateTaskDefinition", "cluster", "databaseSecret", "ecrRepo",
  "expiresAtEpoch", "issuedAtEpoch", "nonce", "outageEpoch", "phase", "region",
  "scheduleGeneration", "service", "version",
];
const nowEpoch = Math.floor(Date.now() / 1000);
if (
  record == null || Array.isArray(record) ||
  JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys) ||
  record.version !== 2 ||
  !["outage-preflight", "candidate-admitted", "empty-bootstrap-armed", "quiescent-bound"].includes(record.phase) ||
  !/^[0-9]{12}$/u.test(record.account) ||
  !/^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*$/u.test(record.region) ||
  typeof record.cluster !== "string" || typeof record.service !== "string" ||
  typeof record.ecrRepo !== "string" ||
  !/^sha256:[0-9a-f]{64}$/u.test(record.baselineDigest) ||
  !/^sha256:[0-9a-f]{64}$/u.test(record.candidateDigest) ||
  typeof record.baselineTaskDefinition !== "string" ||
  typeof record.baselineCpuTaskDefinition !== "string" ||
  typeof record.baselineMaintenanceTaskDefinition !== "string" ||
  typeof record.baselineMigratorTaskDefinition !== "string" ||
  typeof record.databaseSecret !== "string" ||
  !/^[0-9a-f]{64}$/u.test(record.outageEpoch) ||
  typeof record.scheduleGeneration !== "string" ||
  !Number.isSafeInteger(record.issuedAtEpoch) || record.issuedAtEpoch <= 0 || record.issuedAtEpoch > nowEpoch ||
  (record.phase === "quiescent-bound"
    ? record.expiresAtEpoch !== null
    : (!Number.isSafeInteger(record.expiresAtEpoch) ||
      record.expiresAtEpoch !== record.issuedAtEpoch + 21600 || record.expiresAtEpoch <= nowEpoch)) ||
  !/^[0-9a-f]{64}$/u.test(record.nonce) ||
  new Date(record.scheduleGeneration).toISOString() !== record.scheduleGeneration ||
  (record.phase === "outage-preflight" &&
    (record.baselineDigest === record.candidateDigest ||
      [record.candidateTaskDefinition, record.candidateCpuTaskDefinition,
        record.candidateMaintenanceTaskDefinition, record.candidateMigratorTaskDefinition]
        .some((definition) => definition !== null))) ||
  (record.phase === "candidate-admitted" &&
    (record.baselineDigest === record.candidateDigest ||
      [record.candidateTaskDefinition, record.candidateCpuTaskDefinition,
        record.candidateMaintenanceTaskDefinition, record.candidateMigratorTaskDefinition]
        .some((definition) => typeof definition !== "string"))) ||
  (record.phase === "empty-bootstrap-armed" &&
    (record.baselineDigest !== record.candidateDigest ||
      record.candidateTaskDefinition !== record.baselineTaskDefinition ||
      record.candidateCpuTaskDefinition !== record.baselineCpuTaskDefinition ||
      record.candidateMaintenanceTaskDefinition !== record.baselineMaintenanceTaskDefinition ||
      record.candidateMigratorTaskDefinition !== record.baselineMigratorTaskDefinition)) ||
  (record.phase === "quiescent-bound" &&
    [record.candidateTaskDefinition, record.candidateCpuTaskDefinition,
      record.candidateMaintenanceTaskDefinition, record.candidateMigratorTaskDefinition]
      .some((definition) => typeof definition !== "string"))
) process.exit(2);
const taskDefinitionPattern = (family) => new RegExp(`^arn:aws:ecs:${record.region}:${record.account}:task-definition/${family}:[1-9][0-9]*$`);
const databaseSecretPattern = new RegExp(`^arn:aws:secretsmanager:${record.region}:${record.account}:secret:beaver/DATABASE_URL-[A-Za-z0-9]{6}:::[A-Za-z0-9-]{32,64}$`);
const definitionPairs = [
  ["beaver-app", record.baselineTaskDefinition, record.candidateTaskDefinition],
  ["beaver-cpu-pipeline", record.baselineCpuTaskDefinition, record.candidateCpuTaskDefinition],
  ["beaver-project-asset-deletions", record.baselineMaintenanceTaskDefinition, record.candidateMaintenanceTaskDefinition],
  ["beaver-schema-migrator", record.baselineMigratorTaskDefinition, record.candidateMigratorTaskDefinition],
];
if (definitionPairs.some(([family, baseline, candidate]) =>
      !taskDefinitionPattern(family).test(baseline) ||
      (candidate !== null && !taskDefinitionPattern(family).test(candidate))) ||
    !databaseSecretPattern.test(record.databaseSecret)) process.exit(2);
process.stdout.write([
  record.phase, record.account, record.region, record.cluster, record.service,
  record.ecrRepo, record.baselineDigest, record.baselineTaskDefinition,
  record.baselineCpuTaskDefinition, record.baselineMaintenanceTaskDefinition,
  record.baselineMigratorTaskDefinition, record.candidateDigest,
  record.candidateTaskDefinition ?? "-", record.candidateCpuTaskDefinition ?? "-",
  record.candidateMaintenanceTaskDefinition ?? "-", record.candidateMigratorTaskDefinition ?? "-",
  record.databaseSecret, record.outageEpoch, record.scheduleGeneration,
  String(record.issuedAtEpoch), record.expiresAtEpoch === null ? "-" : String(record.expiresAtEpoch), record.nonce,
].join("\n"));
' "${witness_path}") || {
    bp_die "missing or invalid owner-local writer outage witness ${witness_path} (including expiry); do not restore writers"
    return 1
  }
  mapfile -t fields <<< "${output}"
  if [ "${#fields[@]}" -ne 22 ]; then
    bp_die "invalid owner-local writer outage witness field count"
    return 1
  fi
  WRITER_WITNESS_PHASE="${fields[0]}"
  WRITER_WITNESS_BASELINE_DIGEST="${fields[6]}"
  WRITER_WITNESS_BASELINE_TASK_DEFINITION="${fields[7]}"
  WRITER_WITNESS_BASELINE_CPU_TASK_DEFINITION="${fields[8]}"
  WRITER_WITNESS_BASELINE_MAINTENANCE_TASK_DEFINITION="${fields[9]}"
  WRITER_WITNESS_BASELINE_MIGRATOR_TASK_DEFINITION="${fields[10]}"
  WRITER_WITNESS_CANDIDATE_DIGEST="${fields[11]}"
  WRITER_WITNESS_CANDIDATE_TASK_DEFINITION="${fields[12]}"
  WRITER_WITNESS_CANDIDATE_CPU_TASK_DEFINITION="${fields[13]}"
  WRITER_WITNESS_CANDIDATE_MAINTENANCE_TASK_DEFINITION="${fields[14]}"
  WRITER_WITNESS_CANDIDATE_MIGRATOR_TASK_DEFINITION="${fields[15]}"
  WRITER_WITNESS_DATABASE_SECRET="${fields[16]}"
  WRITER_WITNESS_OUTAGE_EPOCH="${fields[17]}"
  WRITER_WITNESS_SCHEDULE_GENERATION="${fields[18]}"
  WRITER_WITNESS_ISSUED_AT_EPOCH="${fields[19]}"
  WRITER_WITNESS_EXPIRES_AT_EPOCH="${fields[20]}"
  WRITER_WITNESS_NONCE="${fields[21]}"
  export WRITER_WITNESS_PHASE WRITER_WITNESS_BASELINE_DIGEST \
    WRITER_WITNESS_BASELINE_TASK_DEFINITION WRITER_WITNESS_CANDIDATE_DIGEST \
    WRITER_WITNESS_BASELINE_CPU_TASK_DEFINITION \
    WRITER_WITNESS_BASELINE_MAINTENANCE_TASK_DEFINITION \
    WRITER_WITNESS_BASELINE_MIGRATOR_TASK_DEFINITION \
    WRITER_WITNESS_CANDIDATE_TASK_DEFINITION WRITER_WITNESS_DATABASE_SECRET \
    WRITER_WITNESS_CANDIDATE_CPU_TASK_DEFINITION \
    WRITER_WITNESS_CANDIDATE_MAINTENANCE_TASK_DEFINITION \
    WRITER_WITNESS_CANDIDATE_MIGRATOR_TASK_DEFINITION \
    WRITER_WITNESS_OUTAGE_EPOCH \
    WRITER_WITNESS_SCHEDULE_GENERATION WRITER_WITNESS_ISSUED_AT_EPOCH \
    WRITER_WITNESS_EXPIRES_AT_EPOCH WRITER_WITNESS_NONCE
  assert_eq "${fields[1]}" "${AWS_ACCOUNT}" "writer witness account"
  assert_eq "${fields[2]}" "${AWS_REGION}" "writer witness region"
  assert_eq "${fields[3]}" "${ECS_CLUSTER}" "writer witness cluster"
  assert_eq "${fields[4]}" "${ECS_SERVICE}" "writer witness service"
  assert_eq "${fields[5]}" "${ECR_REPO}" "writer witness ECR repository"
}

assert_witness_outage_epoch() {
  local current_epoch
  current_epoch=$(writer_mode_snapshot outage)
  assert_eq "${current_epoch}" "${WRITER_WITNESS_OUTAGE_EPOCH}" \
    "writer witness outage epoch"
}

assert_canonical_identities() {
  local canonical_step_function_arn caller_account
  canonical_step_function_arn="arn:aws:states:${AWS_REGION}:${AWS_ACCOUNT}:stateMachine:beaver-process-blueprint"
  assert_eq "${ECS_CLUSTER}" "${CANONICAL_ECS_CLUSTER}" "ECS cluster identity"
  assert_eq "${ECS_SERVICE}" "${CANONICAL_ECS_SERVICE}" "ECS service identity"
  assert_eq "${ECR_REPO}" "${CANONICAL_ECR_REPO}" "ECR repository identity"
  caller_account=$(bp_aws sts get-caller-identity \
    --region "${AWS_REGION}" --query Account --output text)
  assert_eq "${caller_account}" "${AWS_ACCOUNT}" "AWS caller account identity"
  if [ -n "${STEP_FUNCTION_ARN:-}" ]; then
    assert_eq "${STEP_FUNCTION_ARN}" "${canonical_step_function_arn}" \
      "caller-supplied Step Functions identity"
  fi
}

family_live_task_count() {
  local family="$1" desired count task_text offset batch_live
  count=0
  # desiredStatus=RUNNING includes provisioning/pending tasks whose desired
  # state is RUNNING. STOPPED catches tasks whose stop was requested but whose
  # lastStatus has not converged. Collect full paginated ARN lists, then honor
  # ECS's 100-task describe limit and validate every response.
  for desired in RUNNING STOPPED; do
    task_text=$(bp_aws ecs list-tasks \
      --cluster "${ECS_CLUSTER}" \
      --family "${family}" \
      --desired-status "${desired}" \
      --page-size 100 \
      --region "${AWS_REGION}" \
      --query taskArns \
      --output text)
    if [ -n "${task_text}" ] && [ "${task_text}" != "None" ]; then
      # shellcheck disable=SC2206
      local candidates=( ${task_text} )
      for ((offset = 0; offset < ${#candidates[@]}; offset += 100)); do
        local batch=("${candidates[@]:offset:100}")
        batch_live=$(bp_describe_task_batch_live_count "${batch[@]}") || return 1
        count=$((count + batch_live))
      done
    fi
  done
  printf '%s\n' "${count}"
}

assert_no_writer_tasks() {
  local family count
  for family in \
    "${APP_FAMILY}" \
    "${CPU_FAMILY}" \
    "${MAINTENANCE_FAMILY}" \
    "${MIGRATOR_FAMILY}"; do
    count=$(family_live_task_count "${family}")
    assert_eq "${count}" "0" "live ECS tasks in ${family}"
  done
}

exact_active_revisions() {
  local family="$1" task_text arn arn_family revision
  local -a exact=()
  task_text=$(bp_aws ecs list-task-definitions \
    --family-prefix "${family}" \
    --status ACTIVE \
    --sort DESC \
    --page-size 100 \
    --region "${AWS_REGION}" \
    --query taskDefinitionArns \
    --output text)
  if [ -n "${task_text}" ] && [ "${task_text}" != "None" ]; then
    for arn in ${task_text}; do
      if [[ ! "${arn}" =~ ^arn:aws:ecs:[a-z0-9-]+:[0-9]{12}:task-definition/([^:]+):([0-9]+)$ ]]; then
        bp_die "malformed ACTIVE task-definition ARN returned for ${family}: ${arn}"
        return 1
      fi
      arn_family="${BASH_REMATCH[1]}"
      revision="${BASH_REMATCH[2]}"
      [ -n "${revision}" ] || return 1
      # list-task-definitions uses prefix matching; preserve legitimate sibling
      # families while selecting only the exact writer family.
      if [ "${arn_family}" = "${family}" ]; then
        exact+=("${arn}")
      fi
    done
  fi
  if [ "${#exact[@]}" -eq 0 ]; then
    bp_die "no ACTIVE task definitions found for ${family}"
    return 1
  fi
  printf '%s\n' "${exact[*]}"
}

retire_other_active_revisions() {
  local family="$1" retained="$2" task_text arn remaining attempt delay
  task_text=$(exact_active_revisions "${family}") || return 1
  for arn in ${task_text}; do
    if [ "${arn}" != "${retained}" ]; then
      bp_aws ecs deregister-task-definition \
        --task-definition "${arn}" \
        --region "${AWS_REGION}" \
        --query 'taskDefinition.taskDefinitionArn' \
        --output text >/dev/null
    fi
  done

  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    remaining=$(exact_active_revisions "${family}") || return 1
    if [ "${remaining}" = "${retained}" ]; then
      return 0
    fi
    if [ "${attempt}" -eq 10 ]; then
      bp_die "ACTIVE task-definition retirement did not converge for ${family}: ${remaining}"
      return 1
    fi
    delay=$((1 << (attempt - 1)))
    [ "${delay}" -le 8 ] || delay=8
    sleep "${delay}"
  done
}

retire_pre_boundary_task_definitions() {
  retire_other_active_revisions "${APP_FAMILY}" "${APP_TASK_DEFINITION}"
  retire_other_active_revisions "${CPU_FAMILY}" "${CPU_TASK_DEFINITION}"
  retire_other_active_revisions "${MAINTENANCE_FAMILY}" "${MAINTENANCE_TASK_DEFINITION}"
  retire_other_active_revisions "${MIGRATOR_FAMILY}" "${MIGRATOR_TASK_DEFINITION}"
}

assert_retained_task_definitions_only() {
  local revisions
  revisions=$(exact_active_revisions "${APP_FAMILY}") || return 1
  assert_eq "${revisions}" "${APP_TASK_DEFINITION}" \
    "sole retained ACTIVE app task definition"
  revisions=$(exact_active_revisions "${CPU_FAMILY}") || return 1
  assert_eq "${revisions}" "${CPU_TASK_DEFINITION}" \
    "sole retained ACTIVE CPU task definition"
  revisions=$(exact_active_revisions "${MAINTENANCE_FAMILY}") || return 1
  assert_eq "${revisions}" "${MAINTENANCE_TASK_DEFINITION}" \
    "sole retained ACTIVE maintenance task definition"
  revisions=$(exact_active_revisions "${MIGRATOR_FAMILY}") || return 1
  assert_eq "${revisions}" "${MIGRATOR_TASK_DEFINITION}" \
    "sole retained ACTIVE migrator task definition"
}

assert_task_definitions() {
  local expected_image="$1" expected_schedule_state="$2"
  local app_step_function_arn canonical_step_function_arn
  local canonical_cluster_arn app_database cpu_database maintenance_database migrator_database
  local app_provider_identity maintenance_provider_identity
  APP_TASK_DEFINITION=$(bp_assert_task_definition_image "${APP_FAMILY}" "${expected_image}")
  CPU_TASK_DEFINITION=$(bp_assert_task_definition_image "${CPU_FAMILY}" "${expected_image}")
  MAINTENANCE_TASK_DEFINITION=$(bp_assert_task_definition_image "${MAINTENANCE_FAMILY}" "${expected_image}")
  MIGRATOR_TASK_DEFINITION=$(bp_assert_task_definition_image "${MIGRATOR_FAMILY}" "${expected_image}")
  export APP_TASK_DEFINITION CPU_TASK_DEFINITION MAINTENANCE_TASK_DEFINITION MIGRATOR_TASK_DEFINITION

  app_database=$(bp_assert_task_definition_contract "${APP_TASK_DEFINITION}" app)
  cpu_database=$(bp_assert_task_definition_contract "${CPU_TASK_DEFINITION}" cpu)
  maintenance_database=$(bp_assert_task_definition_contract "${MAINTENANCE_TASK_DEFINITION}" maintenance)
  migrator_database=$(bp_assert_task_definition_contract "${MIGRATOR_TASK_DEFINITION}" migrator)
  assert_eq "${cpu_database}" "${app_database}" "CPU task database secret"
  assert_eq "${maintenance_database}" "${app_database}" "maintenance task database secret"
  assert_eq "${migrator_database}" "${app_database}" "migrator task database secret"
  bp_assert_task_role_has_no_permissions "beaver-schema-migrator-task-role"
  bp_assert_database_secret_identity "${app_database}"
  APP_DATABASE_SECRET="${app_database}"
  export APP_DATABASE_SECRET
  app_provider_identity=$(bp_task_definition_label_studio_identity "${APP_TASK_DEFINITION}")
  maintenance_provider_identity=$(bp_task_definition_label_studio_identity "${MAINTENANCE_TASK_DEFINITION}")
  assert_eq "${maintenance_provider_identity}" "${app_provider_identity}" \
    "app/maintenance Label Studio provider identity"

  canonical_step_function_arn="arn:aws:states:${AWS_REGION}:${AWS_ACCOUNT}:stateMachine:beaver-process-blueprint"
  canonical_cluster_arn="arn:aws:ecs:${AWS_REGION}:${AWS_ACCOUNT}:cluster/${CANONICAL_ECS_CLUSTER}"
  app_step_function_arn=$(bp_task_definition_environment_value \
    "${APP_TASK_DEFINITION}" STEP_FUNCTION_ARN)
  assert_eq "${app_step_function_arn}" "${canonical_step_function_arn}" \
    "app task definition Step Functions identity"
  STEP_FUNCTION_ARN="${app_step_function_arn}"
  export STEP_FUNCTION_ARN
  bp_assert_state_machine_task_definition "${CPU_TASK_DEFINITION}" "${canonical_cluster_arn}"

  bp_assert_maintenance_schedule_contract \
    "${MAINTENANCE_TASK_DEFINITION}" "${canonical_cluster_arn}" \
    "${MAINTENANCE_SCHEDULE_GROUP}" "${MAINTENANCE_SCHEDULE_NAME}" \
    "${expected_schedule_state}"
}

assert_scheduler_drain_barrier() {
  local last_modified modified_epoch now_epoch
  local disabled_age required_age
  last_modified=$(bp_aws scheduler get-schedule \
    --group-name "${MAINTENANCE_SCHEDULE_GROUP}" \
    --name "${MAINTENANCE_SCHEDULE_NAME}" \
    --region "${AWS_REGION}" \
    --query LastModificationDate \
    --output text)
  modified_epoch=$(node -e '
const parsed = Date.parse(process.argv[1]);
if (!Number.isFinite(parsed)) process.exit(2);
process.stdout.write(String(Math.floor(parsed / 1000)));
' "${last_modified}") || {
    bp_die "invalid maintenance schedule LastModificationDate: ${last_modified}"
    return 1
  }
  now_epoch=$(date -u +%s)
  disabled_age=$((now_epoch - modified_epoch))
  required_age=$((MAINTENANCE_MAX_EVENT_AGE_SECONDS + ECS_CONSISTENCY_WINDOW_SECONDS))
  if [ "${disabled_age}" -lt "${required_age}" ]; then
    bp_die "maintenance schedule has been disabled for ${disabled_age}s; require at least ${required_age}s to drain retries and ECS observations"
    return 1
  fi
}

assert_quiescent_preflight() {
  local expected_image="$1"
  local schedule_state desired running pending min_capacity max_capacity running_executions
  local scale_in_suspended scale_out_suspended scheduled_scaling_suspended

  assert_task_definitions "${expected_image}" DISABLED

  schedule_state=$(bp_aws scheduler get-schedule \
    --group-name "${MAINTENANCE_SCHEDULE_GROUP}" \
    --name "${MAINTENANCE_SCHEDULE_NAME}" \
    --region "${AWS_REGION}" \
    --query State \
    --output text)
  assert_eq "${schedule_state}" "DISABLED" "maintenance schedule state"
  assert_scheduler_drain_barrier

  desired=$(bp_aws ecs describe-services \
    --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" --query 'services[0].desiredCount' --output text)
  running=$(bp_aws ecs describe-services \
    --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" --query 'services[0].runningCount' --output text)
  pending=$(bp_aws ecs describe-services \
    --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" --query 'services[0].pendingCount' --output text)
  assert_eq "${desired}" "0" "app desired count"
  assert_eq "${running}" "0" "app running count"
  assert_eq "${pending}" "0" "app pending count"

  min_capacity=$(bp_aws application-autoscaling describe-scalable-targets \
    --service-namespace ecs \
    --resource-ids "service/${ECS_CLUSTER##*/}/${ECS_SERVICE##*/}" \
    --region "${AWS_REGION}" \
    --query 'ScalableTargets[0].MinCapacity' \
    --output text)
  assert_eq "${min_capacity}" "0" "app autoscaling minimum"
  max_capacity=$(bp_aws application-autoscaling describe-scalable-targets \
    --service-namespace ecs \
    --resource-ids "service/${ECS_CLUSTER##*/}/${ECS_SERVICE##*/}" \
    --region "${AWS_REGION}" \
    --query 'ScalableTargets[0].MaxCapacity' \
    --output text)
  assert_eq "${max_capacity}" "1" "app autoscaling maximum"
  scale_in_suspended=$(bp_aws application-autoscaling describe-scalable-targets \
    --service-namespace ecs \
    --resource-ids "service/${ECS_CLUSTER##*/}/${ECS_SERVICE##*/}" \
    --region "${AWS_REGION}" \
    --query 'ScalableTargets[0].SuspendedState.DynamicScalingInSuspended' \
    --output text)
  scale_out_suspended=$(bp_aws application-autoscaling describe-scalable-targets \
    --service-namespace ecs \
    --resource-ids "service/${ECS_CLUSTER##*/}/${ECS_SERVICE##*/}" \
    --region "${AWS_REGION}" \
    --query 'ScalableTargets[0].SuspendedState.DynamicScalingOutSuspended' \
    --output text)
  scheduled_scaling_suspended=$(bp_aws application-autoscaling describe-scalable-targets \
    --service-namespace ecs \
    --resource-ids "service/${ECS_CLUSTER##*/}/${ECS_SERVICE##*/}" \
    --region "${AWS_REGION}" \
    --query 'ScalableTargets[0].SuspendedState.ScheduledScalingSuspended' \
    --output text)
  assert_boolean "${scale_in_suspended}" true "dynamic scale-in suspension"
  assert_boolean "${scale_out_suspended}" true "dynamic scale-out suspension"
  assert_boolean "${scheduled_scaling_suspended}" true "scheduled scaling suspension"

  running_executions=$(bp_aws stepfunctions list-executions \
    --state-machine-arn "${STEP_FUNCTION_ARN}" \
    --status-filter RUNNING \
    --region "${AWS_REGION}" \
    --query 'length(executions)' \
    --output text)
  assert_eq "${running_executions}" "0" "running Step Functions executions"

  assert_no_writer_tasks
}

verify_restored() {
  local expected_image="$1"
  local schedule_state desired running pending min_capacity max_capacity current_task_definition
  local scale_in_suspended scale_out_suspended scheduled_scaling_suspended

  assert_task_definitions "${expected_image}" ENABLED
  bp_assert_service_revision_stable "${APP_TASK_DEFINITION}" 1
  schedule_state=$(bp_aws scheduler get-schedule \
    --group-name "${MAINTENANCE_SCHEDULE_GROUP}" \
    --name "${MAINTENANCE_SCHEDULE_NAME}" \
    --region "${AWS_REGION}" --query State --output text)
  assert_eq "${schedule_state}" "ENABLED" "maintenance schedule state"
  desired=$(bp_aws ecs describe-services --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" --query 'services[0].desiredCount' --output text)
  running=$(bp_aws ecs describe-services --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" --query 'services[0].runningCount' --output text)
  pending=$(bp_aws ecs describe-services --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" --query 'services[0].pendingCount' --output text)
  min_capacity=$(bp_aws application-autoscaling describe-scalable-targets \
    --service-namespace ecs --resource-ids "service/${ECS_CLUSTER##*/}/${ECS_SERVICE##*/}" \
    --region "${AWS_REGION}" --query 'ScalableTargets[0].MinCapacity' --output text)
  max_capacity=$(bp_aws application-autoscaling describe-scalable-targets \
    --service-namespace ecs --resource-ids "service/${ECS_CLUSTER##*/}/${ECS_SERVICE##*/}" \
    --region "${AWS_REGION}" --query 'ScalableTargets[0].MaxCapacity' --output text)
  scale_in_suspended=$(bp_aws application-autoscaling describe-scalable-targets \
    --service-namespace ecs --resource-ids "service/${ECS_CLUSTER##*/}/${ECS_SERVICE##*/}" \
    --region "${AWS_REGION}" --query 'ScalableTargets[0].SuspendedState.DynamicScalingInSuspended' --output text)
  scale_out_suspended=$(bp_aws application-autoscaling describe-scalable-targets \
    --service-namespace ecs --resource-ids "service/${ECS_CLUSTER##*/}/${ECS_SERVICE##*/}" \
    --region "${AWS_REGION}" --query 'ScalableTargets[0].SuspendedState.DynamicScalingOutSuspended' --output text)
  scheduled_scaling_suspended=$(bp_aws application-autoscaling describe-scalable-targets \
    --service-namespace ecs --resource-ids "service/${ECS_CLUSTER##*/}/${ECS_SERVICE##*/}" \
    --region "${AWS_REGION}" --query 'ScalableTargets[0].SuspendedState.ScheduledScalingSuspended' --output text)
  current_task_definition=$(bp_aws ecs describe-services \
    --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" --query 'services[0].taskDefinition' --output text)
  assert_eq "${desired}" "1" "restored app desired count"
  assert_eq "${running}" "1" "restored app running count"
  assert_eq "${pending}" "0" "restored app pending count"
  assert_eq "${min_capacity}" "1" "restored app autoscaling minimum"
  assert_eq "${max_capacity}" "1" "restored app autoscaling maximum"
  assert_boolean "${scale_in_suspended}" false "restored dynamic scale-in suspension"
  assert_boolean "${scale_out_suspended}" false "restored dynamic scale-out suspension"
  assert_boolean "${scheduled_scaling_suspended}" false "restored scheduled scaling suspension"
  assert_eq "${current_task_definition}" "${APP_TASK_DEFINITION}" "restored app task definition"
  echo "P2 schema cutover restore verified for ${expected_image}."
}

preflight_writer_outage_cohort() {
  local expected_image="$1" baseline_digest="$2" candidate_digest="$3"
  local service_task_definition service_image outage_epoch final_epoch generation

  # This proof is intentionally made against the old/bound digest. If Terraform
  # changed the task definitions and disabled writers in one apply, either the
  # latest-definition proof or the bound-service proof below must fail.
  outage_epoch=$(writer_mode_snapshot outage)
  assert_quiescent_preflight "${expected_image}"
  service_task_definition=$(bp_service_task_definition)
  service_image=$(bp_task_definition_image "${service_task_definition}")
  assert_eq "${service_task_definition}" "${APP_TASK_DEFINITION}" \
    "outage service/latest app task definition"
  assert_eq "${service_image}" "${expected_image}" "outage service image"
  bp_assert_service_revision_stable "${service_task_definition}" 0
  assert_no_writer_tasks
  final_epoch=$(writer_mode_snapshot outage)
  assert_eq "${final_epoch}" "${outage_epoch}" \
    "writer-mode epoch during outage preflight"
  generation=$(schedule_generation)
  write_writer_outage_witness \
    outage-preflight "${baseline_digest}" "${service_task_definition}" \
    "${CPU_TASK_DEFINITION}" "${MAINTENANCE_TASK_DEFINITION}" \
    "${MIGRATOR_TASK_DEFINITION}" "${candidate_digest}" - - - - \
    "${APP_DATABASE_SECRET}" "${outage_epoch}" \
    "${generation}" - - -
  echo "Writer outage preflight passed for the still-bound baseline ${expected_image} and intended candidate ${candidate_digest}."
}

assert_witnessed_baseline_binding() {
  local candidate_digest="$1"
  local baseline_image service_task_definition service_image
  load_writer_outage_witness
  assert_eq "${WRITER_WITNESS_PHASE}" outage-preflight "writer witness phase"
  assert_eq "${WRITER_WITNESS_CANDIDATE_DIGEST}" "${candidate_digest}" \
    "writer witness intended candidate digest"
  assert_witness_outage_epoch
  baseline_image=$(bp_expected_image_uri "${WRITER_WITNESS_BASELINE_DIGEST}")
  service_task_definition=$(bp_service_task_definition)
  service_image=$(bp_task_definition_image "${service_task_definition}")
  assert_eq "${service_task_definition}" "${WRITER_WITNESS_BASELINE_TASK_DEFINITION}" \
    "preflight baseline service task definition"
  assert_eq "${service_image}" "${baseline_image}" "preflight baseline service image"
  bp_assert_service_revision_stable "${service_task_definition}" 0
}

assert_admitted_candidate_contract() {
  local candidate_digest="$1"
  assert_eq "${WRITER_WITNESS_PHASE}" candidate-admitted "writer witness phase"
  assert_eq "${WRITER_WITNESS_CANDIDATE_DIGEST}" "${candidate_digest}" \
    "admitted candidate digest"
  assert_eq "${WRITER_WITNESS_CANDIDATE_TASK_DEFINITION}" \
    "${APP_TASK_DEFINITION}" "admitted candidate app task definition"
  assert_eq "${WRITER_WITNESS_CANDIDATE_CPU_TASK_DEFINITION}" \
    "${CPU_TASK_DEFINITION}" "admitted candidate CPU task definition"
  assert_eq "${WRITER_WITNESS_CANDIDATE_MAINTENANCE_TASK_DEFINITION}" \
    "${MAINTENANCE_TASK_DEFINITION}" \
    "admitted candidate maintenance task definition"
  assert_eq "${WRITER_WITNESS_CANDIDATE_MIGRATOR_TASK_DEFINITION}" \
    "${MIGRATOR_TASK_DEFINITION}" "admitted candidate migrator task definition"
  assert_eq "${WRITER_WITNESS_DATABASE_SECRET}" "${APP_DATABASE_SECRET}" \
    "admitted candidate database secret identity"
  assert_witness_outage_epoch
}

assert_admitted_service_binding() {
  local candidate_image="$1"
  local baseline_image service_task_definition service_image
  baseline_image=$(bp_expected_image_uri "${WRITER_WITNESS_BASELINE_DIGEST}")
  service_task_definition=$(bp_service_task_definition)
  service_image=$(bp_task_definition_image "${service_task_definition}")
  if [ "${service_task_definition}" = "${WRITER_WITNESS_BASELINE_TASK_DEFINITION}" ]; then
    assert_eq "${service_image}" "${baseline_image}" \
      "admitted baseline service image"
  elif [ "${service_task_definition}" = "${WRITER_WITNESS_CANDIDATE_TASK_DEFINITION}" ]; then
    assert_eq "${service_image}" "${candidate_image}" \
      "admitted candidate service image"
  else
    bp_die "app service uses ${service_task_definition}, expected the admitted baseline or candidate task definition"
    return 1
  fi
  bp_assert_service_revision_stable "${service_task_definition}" 0
}

write_candidate_admission() {
  local candidate_digest="$1" generation
  generation=$(schedule_generation)
  write_writer_outage_witness \
    candidate-admitted "${WRITER_WITNESS_BASELINE_DIGEST}" \
    "${WRITER_WITNESS_BASELINE_TASK_DEFINITION}" \
    "${WRITER_WITNESS_BASELINE_CPU_TASK_DEFINITION}" \
    "${WRITER_WITNESS_BASELINE_MAINTENANCE_TASK_DEFINITION}" \
    "${WRITER_WITNESS_BASELINE_MIGRATOR_TASK_DEFINITION}" \
    "${candidate_digest}" "${APP_TASK_DEFINITION}" "${CPU_TASK_DEFINITION}" \
    "${MAINTENANCE_TASK_DEFINITION}" "${MIGRATOR_TASK_DEFINITION}" \
    "${APP_DATABASE_SECRET}" "${WRITER_WITNESS_OUTAGE_EPOCH}" \
    "${generation}" "${WRITER_WITNESS_ISSUED_AT_EPOCH}" \
    "${WRITER_WITNESS_EXPIRES_AT_EPOCH}" "${WRITER_WITNESS_NONCE}"
  load_writer_outage_witness
  assert_admitted_candidate_contract "${candidate_digest}"
}

bind_quiescent_writer_cohort() {
  local candidate_image="$1" candidate_digest="$2"
  local overrides generation witness_phase

  load_writer_outage_witness
  witness_phase="${WRITER_WITNESS_PHASE}"
  case "${witness_phase}" in
    outage-preflight)
      assert_witnessed_baseline_binding "${candidate_digest}"
      ;;
    candidate-admitted)
      assert_eq "${WRITER_WITNESS_CANDIDATE_DIGEST}" "${candidate_digest}" \
        "admitted candidate digest"
      assert_witness_outage_epoch
      ;;
    *)
      bp_die "bind-quiescent requires an outage-preflight or candidate-admitted witness"
      return 1
      ;;
  esac

  # Candidate task definitions may now exist, but every launcher remains in the
  # exact outage tuple. A retry may find either the witnessed baseline or the
  # write-ahead admitted candidate already bound at desired count zero.
  assert_quiescent_preflight "${candidate_image}"
  if [ "${witness_phase}" = candidate-admitted ]; then
    assert_admitted_candidate_contract "${candidate_digest}"
    assert_admitted_service_binding "${candidate_image}"
  else
    assert_eq "${APP_DATABASE_SECRET}" "${WRITER_WITNESS_DATABASE_SECRET}" \
      "candidate database secret identity"
    assert_witness_outage_epoch
    bp_assert_service_revision_stable "${WRITER_WITNESS_BASELINE_TASK_DEFINITION}" 0
  fi
  assert_no_writer_tasks

  overrides='{"containerOverrides":[{"name":"beaver-schema-migrator","command":["./entrypoint.sh","schema-check"]}]}'
  echo "Verifying the exact database schema from ${MIGRATOR_TASK_DEFINITION} before quiescent binding..."
  bp_run_one_off_task "${MIGRATOR_TASK_DEFINITION}" "${overrides}" >/dev/null
  assert_no_writer_tasks

  if [ "${witness_phase}" = outage-preflight ]; then
    # Persist the complete candidate intent before UpdateService. This
    # write-ahead receipt makes an ambiguous response or local interruption
    # recoverable without weakening the old-digest preflight proof.
    assert_witnessed_baseline_binding "${candidate_digest}"
    write_candidate_admission "${candidate_digest}"
  else
    load_writer_outage_witness
    assert_admitted_candidate_contract "${candidate_digest}"
  fi
  assert_admitted_service_binding "${candidate_image}"

  bp_aws ecs update-service \
    --cluster "${ECS_CLUSTER}" \
    --service "${ECS_SERVICE}" \
    --task-definition "${APP_TASK_DEFINITION}" \
    --desired-count 0 \
    --region "${AWS_REGION}" \
    --query 'service.serviceName' \
    --output text >/dev/null
  bp_assert_service_revision_stable "${APP_TASK_DEFINITION}" 0
  assert_quiescent_preflight "${candidate_image}"
  assert_admitted_candidate_contract "${candidate_digest}"
  bp_assert_service_revision_stable \
    "${WRITER_WITNESS_CANDIDATE_TASK_DEFINITION}" 0
  assert_no_writer_tasks
  generation=$(schedule_generation)
  write_writer_outage_witness \
    quiescent-bound "${WRITER_WITNESS_BASELINE_DIGEST}" \
    "${WRITER_WITNESS_BASELINE_TASK_DEFINITION}" \
    "${WRITER_WITNESS_BASELINE_CPU_TASK_DEFINITION}" \
    "${WRITER_WITNESS_BASELINE_MAINTENANCE_TASK_DEFINITION}" \
    "${WRITER_WITNESS_BASELINE_MIGRATOR_TASK_DEFINITION}" \
    "${candidate_digest}" "${APP_TASK_DEFINITION}" "${CPU_TASK_DEFINITION}" \
    "${MAINTENANCE_TASK_DEFINITION}" "${MIGRATOR_TASK_DEFINITION}" \
    "${WRITER_WITNESS_DATABASE_SECRET}" \
    "${WRITER_WITNESS_OUTAGE_EPOCH}" \
    "${generation}" "${WRITER_WITNESS_ISSUED_AT_EPOCH}" null \
    "${WRITER_WITNESS_NONCE}"
  echo "Candidate ${candidate_image} is bound while every writer remains quiescent; restore only the exact live Terraform tuple."
}

verify_writer_cohort_restored() {
  local expected_image="$1" expected_digest="$2" witness_path live_epoch
  load_writer_outage_witness
  assert_eq "${WRITER_WITNESS_PHASE}" quiescent-bound "writer witness phase"
  assert_eq "${WRITER_WITNESS_CANDIDATE_DIGEST}" "${expected_digest}" \
    "restored writer witness digest"
  verify_restored "${expected_image}"
  assert_eq "${APP_TASK_DEFINITION}" "${WRITER_WITNESS_CANDIDATE_TASK_DEFINITION}" \
    "restored writer witness task definition"
  assert_eq "${CPU_TASK_DEFINITION}" "${WRITER_WITNESS_CANDIDATE_CPU_TASK_DEFINITION}" \
    "restored writer witness CPU task definition"
  assert_eq "${MAINTENANCE_TASK_DEFINITION}" \
    "${WRITER_WITNESS_CANDIDATE_MAINTENANCE_TASK_DEFINITION}" \
    "restored writer witness maintenance task definition"
  assert_eq "${MIGRATOR_TASK_DEFINITION}" \
    "${WRITER_WITNESS_CANDIDATE_MIGRATOR_TASK_DEFINITION}" \
    "restored writer witness migrator task definition"
  assert_eq "${APP_DATABASE_SECRET}" "${WRITER_WITNESS_DATABASE_SECRET}" \
    "restored writer witness database secret identity"
  live_epoch=$(writer_mode_snapshot live)
  if [ "${live_epoch}" = "${WRITER_WITNESS_OUTAGE_EPOCH}" ]; then
    bp_die "restored writer-mode epoch did not rotate away from the witnessed outage"
    return 1
  fi
  witness_path=$(writer_outage_witness_path)
  rm -- "${witness_path}"
  echo "Writer cohort restore verified and the local outage witness was consumed."
}

run_migration_and_bind() {
  local expected_image="$1" migration_mode="$2" description="$3" cohort_mode="$4"
  local readiness_overrides overrides desired running pending migration_client_token
  local bootstrap_retry=false candidate_admitted=false witness_path outage_epoch generation readiness_mode

  if [ "${cohort_mode}" = "witnessed-boundary" ]; then
    load_writer_outage_witness
    case "${WRITER_WITNESS_PHASE}" in
      outage-preflight)
        assert_witnessed_baseline_binding "${BP_APP_IMAGE_DIGEST}"
        ;;
      candidate-admitted)
        assert_eq "${WRITER_WITNESS_CANDIDATE_DIGEST}" "${BP_APP_IMAGE_DIGEST}" \
          "admitted candidate digest"
        assert_witness_outage_epoch
        candidate_admitted=true
        ;;
      *)
        bp_die "P2 boundary requires an outage-preflight or candidate-admitted witness"
        return 1
        ;;
    esac
  elif [ "${cohort_mode}" = "empty-bootstrap" ]; then
    witness_path=$(writer_outage_witness_path)
    if [ -e "${witness_path}" ] || [ -L "${witness_path}" ]; then
      load_writer_outage_witness
      assert_eq "${WRITER_WITNESS_PHASE}" empty-bootstrap-armed \
        "empty bootstrap witness phase"
      assert_eq "${WRITER_WITNESS_CANDIDATE_DIGEST}" "${BP_APP_IMAGE_DIGEST}" \
        "empty bootstrap candidate digest"
      assert_witness_outage_epoch
      bootstrap_retry=true
    fi
  else
    bp_die "unknown migration cohort mode ${cohort_mode}"
    return 1
  fi
  assert_quiescent_preflight "${expected_image}"
  if [ "${cohort_mode}" = "witnessed-boundary" ]; then
    if [ "${candidate_admitted}" = true ]; then
      assert_admitted_candidate_contract "${BP_APP_IMAGE_DIGEST}"
      assert_admitted_service_binding "${expected_image}"
    else
      assert_eq "${APP_DATABASE_SECRET}" "${WRITER_WITNESS_DATABASE_SECRET}" \
        "candidate database secret identity"
      assert_witness_outage_epoch
    fi
  elif [ "${bootstrap_retry}" = true ]; then
    assert_eq "${WRITER_WITNESS_BASELINE_TASK_DEFINITION}" "${APP_TASK_DEFINITION}" \
      "empty bootstrap armed task definition"
    assert_eq "${WRITER_WITNESS_CANDIDATE_TASK_DEFINITION}" "${APP_TASK_DEFINITION}" \
      "empty bootstrap armed candidate task definition"
    assert_eq "${WRITER_WITNESS_CANDIDATE_CPU_TASK_DEFINITION}" \
      "${CPU_TASK_DEFINITION}" "empty bootstrap armed CPU task definition"
    assert_eq "${WRITER_WITNESS_CANDIDATE_MAINTENANCE_TASK_DEFINITION}" \
      "${MAINTENANCE_TASK_DEFINITION}" \
      "empty bootstrap armed maintenance task definition"
    assert_eq "${WRITER_WITNESS_CANDIDATE_MIGRATOR_TASK_DEFINITION}" \
      "${MIGRATOR_TASK_DEFINITION}" \
      "empty bootstrap armed migrator task definition"
    assert_eq "${WRITER_WITNESS_DATABASE_SECRET}" "${APP_DATABASE_SECRET}" \
      "empty bootstrap armed database secret identity"
    assert_witness_outage_epoch
  fi
  echo "Observing quiescence for ${QUIESCENCE_OBSERVATION_SECONDS}s before the final preflight..."
  sleep "${QUIESCENCE_OBSERVATION_SECONDS}"
  # The second complete observation is separated by the fixed consistency
  # window; there is intentionally no environment override for this delay.
  assert_quiescent_preflight "${expected_image}"
  if [ "${cohort_mode}" = "witnessed-boundary" ] || [ "${bootstrap_retry}" = true ]; then
    assert_witness_outage_epoch
  fi
  if [ "${candidate_admitted}" = true ]; then
    assert_admitted_candidate_contract "${BP_APP_IMAGE_DIGEST}"
    assert_admitted_service_binding "${expected_image}"
  fi

  # Prove the database can cross the boundary before making old compatible
  # revisions unavailable. The armed migrator repeats these checks after the
  # retirement fence so this read-only observation is not the final authority.
  readiness_mode="${migration_mode}"
  if [ "${cohort_mode}" = "empty-bootstrap" ]; then
    if [ "${bootstrap_retry}" = true ]; then
      readiness_mode="${EMPTY_BOOTSTRAP_RETRY_READINESS_MODE}"
    else
      readiness_mode="${EMPTY_BOOTSTRAP_STRICT_READINESS_MODE}"
    fi
  fi
  readiness_overrides="{\"containerOverrides\":[{\"name\":\"beaver-schema-migrator\",\"command\":[\"./entrypoint.sh\",\"schema-readiness\",\"${readiness_mode}\"]}]}"
  echo "Running the ${description} read-only database readiness task..."
  bp_run_one_off_task "${MIGRATOR_TASK_DEFINITION}" "${readiness_overrides}" >/dev/null
  assert_no_writer_tasks

  if [ "${cohort_mode}" = "empty-bootstrap" ] && [ "${bootstrap_retry}" = false ]; then
    outage_epoch=$(writer_mode_snapshot outage)
    generation=$(schedule_generation)
    write_writer_outage_witness \
      empty-bootstrap-armed "${BP_APP_IMAGE_DIGEST}" "${APP_TASK_DEFINITION}" \
      "${CPU_TASK_DEFINITION}" "${MAINTENANCE_TASK_DEFINITION}" \
      "${MIGRATOR_TASK_DEFINITION}" "${BP_APP_IMAGE_DIGEST}" \
      "${APP_TASK_DEFINITION}" "${CPU_TASK_DEFINITION}" \
      "${MAINTENANCE_TASK_DEFINITION}" "${MIGRATOR_TASK_DEFINITION}" \
      "${APP_DATABASE_SECRET}" "${outage_epoch}" "${generation}" - - -
    load_writer_outage_witness
    bootstrap_retry=true
  elif [ "${cohort_mode}" = "witnessed-boundary" ] && [ "${candidate_admitted}" = false ]; then
    # Seal every candidate identity before the first service mutation. A retry
    # can therefore distinguish this exact admitted transition from a forged
    # combined outage/candidate apply and reconcile either exact service binding.
    assert_witnessed_baseline_binding "${BP_APP_IMAGE_DIGEST}"
    write_candidate_admission "${BP_APP_IMAGE_DIGEST}"
    candidate_admitted=true
  fi
  if [ "${candidate_admitted}" = true ]; then
    load_writer_outage_witness
    assert_admitted_candidate_contract "${BP_APP_IMAGE_DIGEST}"
    assert_admitted_service_binding "${expected_image}"
  elif [ "${cohort_mode}" = "empty-bootstrap" ]; then
    load_writer_outage_witness
    assert_eq "${WRITER_WITNESS_PHASE}" empty-bootstrap-armed \
      "empty bootstrap witness phase"
    assert_eq "${WRITER_WITNESS_CANDIDATE_DIGEST}" "${BP_APP_IMAGE_DIGEST}" \
      "empty bootstrap candidate digest"
  fi
  assert_witness_outage_epoch

  # Bind the zero-count service before retirement: ECS may still scale a
  # service that references an INACTIVE task definition.
  bp_aws ecs update-service \
    --cluster "${ECS_CLUSTER}" \
    --service "${ECS_SERVICE}" \
    --task-definition "${APP_TASK_DEFINITION}" \
    --desired-count 0 \
    --region "${AWS_REGION}" \
    --query 'service.serviceName' \
    --output text >/dev/null
  bp_assert_service_revision_stable "${APP_TASK_DEFINITION}" 0
  desired=$(bp_aws ecs describe-services --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" --query 'services[0].desiredCount' --output text)
  running=$(bp_aws ecs describe-services --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" --query 'services[0].runningCount' --output text)
  pending=$(bp_aws ecs describe-services --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" --query 'services[0].pendingCount' --output text)
  assert_eq "${desired}" "0" "zero-count app desired count after binding"
  assert_eq "${running}" "0" "zero-count app running count after binding"
  assert_eq "${pending}" "0" "zero-count app pending count after binding"
  assert_no_writer_tasks

  retire_pre_boundary_task_definitions
  echo "Observing the ECS deregistration enforcement window for ${TASK_DEFINITION_DEREGISTRATION_WINDOW_SECONDS}s..."
  sleep "${TASK_DEFINITION_DEREGISTRATION_WINDOW_SECONDS}"
  assert_retained_task_definitions_only
  bp_assert_service_revision_stable "${APP_TASK_DEFINITION}" 0
  assert_no_writer_tasks
  # Re-run every launcher/writer observation after deregistration enforcement,
  # immediately before the only armed migration task.
  assert_quiescent_preflight "${expected_image}"
  assert_witness_outage_epoch

  overrides="{\"containerOverrides\":[{\"name\":\"beaver-schema-migrator\",\"environment\":[{\"name\":\"BP_SCHEMA_MIGRATION_MODE\",\"value\":\"${migration_mode}\"}]}]}"
  echo "Running the ${description} singleton schema migrator..."
  if [ "${cohort_mode}" = "empty-bootstrap" ]; then
    migration_client_token="bp-empty-${WRITER_WITNESS_NONCE:0:48}"
  else
    migration_client_token="bp-p2-${WRITER_WITNESS_NONCE:0:48}"
  fi
  bp_run_one_off_task \
    "${MIGRATOR_TASK_DEFINITION}" "${overrides}" "${migration_client_token}" >/dev/null
  assert_retained_task_definitions_only
  bp_assert_service_revision_stable "${APP_TASK_DEFINITION}" 0
  assert_no_writer_tasks
  if [ "${cohort_mode}" = "witnessed-boundary" ]; then
    assert_admitted_candidate_contract "${BP_APP_IMAGE_DIGEST}"
    bp_assert_service_revision_stable \
      "${WRITER_WITNESS_CANDIDATE_TASK_DEFINITION}" 0
  else
    assert_witness_outage_epoch
  fi

  if [ "${cohort_mode}" = "witnessed-boundary" ]; then
    generation=$(schedule_generation)
    write_writer_outage_witness \
      quiescent-bound "${WRITER_WITNESS_BASELINE_DIGEST}" \
      "${WRITER_WITNESS_BASELINE_TASK_DEFINITION}" \
      "${WRITER_WITNESS_BASELINE_CPU_TASK_DEFINITION}" \
      "${WRITER_WITNESS_BASELINE_MAINTENANCE_TASK_DEFINITION}" \
      "${WRITER_WITNESS_BASELINE_MIGRATOR_TASK_DEFINITION}" \
      "${BP_APP_IMAGE_DIGEST}" "${APP_TASK_DEFINITION}" \
      "${CPU_TASK_DEFINITION}" "${MAINTENANCE_TASK_DEFINITION}" \
      "${MIGRATOR_TASK_DEFINITION}" "${WRITER_WITNESS_DATABASE_SECRET}" \
      "${WRITER_WITNESS_OUTAGE_EPOCH}" \
      "${generation}" "${WRITER_WITNESS_ISSUED_AT_EPOCH}" null \
      "${WRITER_WITNESS_NONCE}"
  else
    generation=$(schedule_generation)
    write_writer_outage_witness \
      quiescent-bound "${BP_APP_IMAGE_DIGEST}" "${APP_TASK_DEFINITION}" \
      "${CPU_TASK_DEFINITION}" "${MAINTENANCE_TASK_DEFINITION}" \
      "${MIGRATOR_TASK_DEFINITION}" "${BP_APP_IMAGE_DIGEST}" \
      "${APP_TASK_DEFINITION}" "${CPU_TASK_DEFINITION}" \
      "${MAINTENANCE_TASK_DEFINITION}" "${MIGRATOR_TASK_DEFINITION}" \
      "${WRITER_WITNESS_DATABASE_SECRET}" "${WRITER_WITNESS_OUTAGE_EPOCH}" \
      "${generation}" "${WRITER_WITNESS_ISSUED_AT_EPOCH}" null \
      "${WRITER_WITNESS_NONCE}"
  fi

  cat <<EOF
Schema migration completed and the app task definition is stable at desired count zero.
Keep labeling closed. Restore Terraform with:
  TF_VAR_beaver_app_image_digest=${BP_APP_IMAGE_DIGEST}
  maintenance_worker_schedule_enabled=true
  ecs_autoscaling_enabled=true
  ecs_desired_count=1
  ecs_min_count=1
  ecs_max_count=1
Then run this script's verify-restored mode before reopening labeling.
EOF
}

mode="${1:-}"
[ -n "${mode}" ] || usage
case "${mode}" in
  run|bootstrap-empty|verify-restored|preflight-outage|bind-quiescent) ;;
  *) usage ;;
esac
bp_require_env AWS_ACCOUNT AWS_REGION ECR_REPO ECS_CLUSTER ECS_SERVICE \
  BP_APP_IMAGE_DIGEST DOMAIN CLOUDFRONT_DISTRIBUTION_ID
bp_require_set ROOT_ADMIN_EMAIL
bp_validate_digest "${BP_APP_IMAGE_DIGEST}"
if [ "${mode}" = preflight-outage ]; then
  bp_require_env BP_CANDIDATE_IMAGE_DIGEST
  bp_validate_digest "${BP_CANDIDATE_IMAGE_DIGEST}"
  if [ "${BP_APP_IMAGE_DIGEST}" = "${BP_CANDIDATE_IMAGE_DIGEST}" ]; then
    bp_die "preflight-outage requires distinct baseline and intended candidate digests"
    exit 64
  fi
fi
acquire_writer_operation_lock
assert_canonical_identities
EXPECTED_IMAGE=$(bp_expected_image_uri "${BP_APP_IMAGE_DIGEST}")

case "${mode}" in
  run)
    run_migration_and_bind "${EXPECTED_IMAGE}" "${P2_MIGRATION_MODE}" "P2 boundary" "witnessed-boundary"
    ;;
  bootstrap-empty)
    run_migration_and_bind "${EXPECTED_IMAGE}" "${EMPTY_BOOTSTRAP_MODE}" "empty-database bootstrap" "empty-bootstrap"
    ;;
  verify-restored)
    verify_writer_cohort_restored "${EXPECTED_IMAGE}" "${BP_APP_IMAGE_DIGEST}"
    ;;
  preflight-outage)
    preflight_writer_outage_cohort \
      "${EXPECTED_IMAGE}" "${BP_APP_IMAGE_DIGEST}" "${BP_CANDIDATE_IMAGE_DIGEST}"
    ;;
  bind-quiescent)
    bind_quiescent_writer_cohort "${EXPECTED_IMAGE}" "${BP_APP_IMAGE_DIGEST}"
    ;;
  *) usage ;;
esac
