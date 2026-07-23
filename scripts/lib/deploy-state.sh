#!/usr/bin/env bash
# [refactor jul23 P5.1] deploy-state: owner-local, append-only deploy state shared by
# deploy.sh, scripts/record-battery-green.sh, and scripts/rollback.sh. This library performs
# NO AWS mutation. It reads (read-only) the currently bound app digest via the ecs-schema-tools
# helpers, maintains an append-only audit ledger of digest transitions (β), and the recorded
# battery-green marker keyed to HEAD (γ). Callers must have already sourced
# scripts/lib/ecs-schema-tools.sh (for bp_die/bp_aws/bp_validate_digest/bp_service_task_definition/
# bp_task_definition_image) and must export PROJECT_DIR + the AWS_*/ECS_* coordinates it reads.
#
# Path convention (owner-local, .deploy.env-configurable — mirrors the p2-schema-cutover.sh
# witness-file precedent): both files default under ${XDG_RUNTIME_DIR:-/tmp} keyed by
# account+region so they never land inside the repo (the .gitignore is owner-managed and must
# not be edited here). A repo-local location is possible only via explicit env override, in
# which case the owner is responsible for gitignoring it.

# ---- [refactor jul23 P5.1-β] digest resolution + append-only ledger ----

bp_current_head() {
  # Best-effort HEAD SHA of the deploy clone; "unknown" when git is unavailable.
  git -C "${PROJECT_DIR}" rev-parse HEAD 2>/dev/null || printf '%s' unknown
}

bp_digest_from_image_uri() {
  # Extract the sha256:... digest from a `<registry>/<repo>@sha256:<hex>` image URI.
  local uri="$1" digest
  digest="${uri##*@}"
  bp_validate_digest "${digest}" >/dev/null 2>&1 || return 1
  printf '%s\n' "${digest}"
}

bp_current_bound_digest() {
  # Read-only: the digest the app service is currently bound to. Returns nonzero (no AWS call)
  # when the service coordinates are not available in this environment (e.g. a bare publish).
  [ -n "${ECS_CLUSTER:-}" ] && [ -n "${ECS_SERVICE:-}" ] && [ -n "${AWS_REGION:-}" ] || return 1
  local task_definition image
  task_definition=$(bp_service_task_definition) || return 1
  image=$(bp_task_definition_image "${task_definition}") || return 1
  bp_digest_from_image_uri "${image}"
}

bp_deploy_ledger_path() {
  printf '%s\n' "${BP_DEPLOY_LEDGER_FILE:-${XDG_RUNTIME_DIR:-/tmp}/blueprintparser-deploy-ledger-${AWS_ACCOUNT:-unknown}-${AWS_REGION:-unknown}.jsonl}"
}

bp_deploy_ledger_append() {
  # Append one JSONL audit record of a digest event. Append-only and best-effort: a failure to
  # write the audit ledger is loud but never fails the deploy (it is an aid, not a gate). The
  # digest fields are validated so only well-formed records land.
  local event="$1" digest="$2" previous_digest="${3:--}" head="${4:-unknown}"
  local ledger_path
  ledger_path=$(bp_deploy_ledger_path)
  if ! node -e '
const fs = require("node:fs");
const pathModule = require("node:path");
const [ledgerPath, event, digest, previousDigest, head, account, region] = process.argv.slice(1);
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
if (!["publish", "activate", "verify-restored", "rollback-advisory"].includes(event)) process.exit(2);
if (!digestPattern.test(digest)) process.exit(2);
if (previousDigest !== "-" && !digestPattern.test(previousDigest)) process.exit(2);
const directory = pathModule.dirname(ledgerPath);
if (!fs.statSync(directory).isDirectory()) process.exit(2);
const record = {
  version: 1,
  event,
  digest,
  previousDigest: previousDigest === "-" ? null : previousDigest,
  head: /^[0-9a-f]{40}$/u.test(head) ? head : "unknown",
  account,
  region,
  recordedAtEpoch: Math.floor(Date.now() / 1000),
};
// Ensure 0600 on first creation without truncating an existing append-only ledger.
try { fs.closeSync(fs.openSync(ledgerPath, "a", 0o600)); } catch {}
fs.appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
' "${ledger_path}" "${event}" "${digest}" "${previous_digest}" "${head}" \
    "${AWS_ACCOUNT:-unknown}" "${AWS_REGION:-unknown}"; then
    echo "WARNING: could not append to the deploy ledger ${ledger_path}; continuing (audit-only)." >&2
    return 0
  fi
  echo "Recorded ${event} of ${digest} in the deploy ledger ${ledger_path}." >&2
}

# ---- [refactor jul23 P5.1-γ] recorded battery-green marker (heavy-gate proxy) ----
#
# The heavy landing battery — `npm test` (vitest; needs the test DB + node 20) and `npm run
# build` — cannot run fast/hermetically at deploy time on the owner host. Root/owner runs it
# deliberately at the landing HEAD (L1 of P_LAND_PLAN: "Final HEAD battery green + recorded")
# and then records THIS marker via scripts/record-battery-green.sh. deploy.sh preflight asserts
# the marker is present and pinned to the exact current HEAD, turning L1's human checklist item
# into a machine-checked gate — without re-running the heavy battery.
#
# Marker file format (JSON, single object, 0600):
#   { "version": 1, "head": "<40-hex commit sha>", "recordedAtEpoch": <int>,
#     "battery": ["vitest", "build"] }
# Path: BP_BATTERY_GREEN_FILE, else ${XDG_RUNTIME_DIR:-/tmp}/blueprintparser-battery-green-<k>.json
# where <k> is a stable 16-hex digest of PROJECT_DIR so distinct clones never collide and both
# the writer and the asserter derive the identical path.

bp_battery_green_path() {
  if [ -n "${BP_BATTERY_GREEN_FILE:-}" ]; then
    printf '%s\n' "${BP_BATTERY_GREEN_FILE}"
    return 0
  fi
  local key
  key=$(printf '%s' "${PROJECT_DIR}" | node -e '
let s = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { s += c; });
process.stdin.on("end", () => {
  process.stdout.write(require("node:crypto").createHash("sha256").update(s).digest("hex").slice(0, 16));
});
') || return 1
  printf '%s\n' "${XDG_RUNTIME_DIR:-/tmp}/blueprintparser-battery-green-${key}.json"
}

bp_battery_green_write() {
  # Record the marker at current HEAD. Callers MUST have already run the heavy battery green at
  # this HEAD; this only records that fact. Fails if HEAD is unresolvable.
  local head marker_path
  head=$(bp_current_head)
  if [ "${head}" = unknown ] || [[ ! "${head}" =~ ^[0-9a-f]{40}$ ]]; then
    bp_die "record-battery-green: cannot resolve a concrete git HEAD for ${PROJECT_DIR}"
    return 1
  fi
  marker_path=$(bp_battery_green_path) || {
    bp_die "record-battery-green: could not resolve the marker path"
    return 1
  }
  if ! node -e '
const fs = require("node:fs");
const pathModule = require("node:path");
const [markerPath, head] = process.argv.slice(1);
if (!/^[0-9a-f]{40}$/u.test(head)) process.exit(2);
const directory = pathModule.dirname(markerPath);
if (!fs.statSync(directory).isDirectory()) process.exit(2);
const record = { version: 1, head, recordedAtEpoch: Math.floor(Date.now() / 1000), battery: ["vitest", "build"] };
fs.writeFileSync(markerPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
' "${marker_path}" "${head}"; then
    bp_die "record-battery-green: could not write the battery-green marker ${marker_path}"
    return 1
  fi
  echo "Recorded battery-green marker at HEAD ${head}: ${marker_path}"
}

bp_battery_green_assert_head() {
  # Assert a valid marker exists AND is pinned to expected_head. Fails closed on missing, stale,
  # or malformed markers with a specific, actionable message.
  local expected_head="$1" marker_path rc
  marker_path=$(bp_battery_green_path) || {
    bp_die "preflight: could not resolve the battery-green marker path"
    return 1
  }
  if node -e '
const fs = require("node:fs");
const [markerPath, expectedHead] = process.argv.slice(1);
let record;
try {
  record = JSON.parse(fs.readFileSync(markerPath, "utf8"));
} catch {
  process.exit(3); // missing/unreadable
}
const nowEpoch = Math.floor(Date.now() / 1000);
if (
  record == null || typeof record !== "object" || Array.isArray(record) ||
  record.version !== 1 ||
  !/^[0-9a-f]{40}$/u.test(record.head || "") ||
  !Number.isSafeInteger(record.recordedAtEpoch) ||
  record.recordedAtEpoch <= 0 || record.recordedAtEpoch > nowEpoch + 60
) process.exit(2); // malformed
if (record.head !== expectedHead) process.exit(4); // stale
process.exit(0);
' "${marker_path}" "${expected_head}"; then
    return 0
  else
    # Capture node's classification exit code (2/3/4) here: after `fi` bash would reset $? to 0.
    rc=$?
  fi
  case "${rc}" in
    3) bp_die "preflight: no recorded battery-green marker at ${marker_path}; run the heavy battery (npm test && npm run build) green at HEAD ${expected_head}, then scripts/record-battery-green.sh" ;;
    4) bp_die "preflight: battery-green marker at ${marker_path} is STALE (recorded at a different HEAD than ${expected_head}); re-run the heavy battery at this HEAD then scripts/record-battery-green.sh" ;;
    *) bp_die "preflight: battery-green marker at ${marker_path} is malformed" ;;
  esac
  return 1
}

# ---- [refactor jul23 P5.1-ε] read-only rollback resolution helpers ----
# All strictly read-only. No AWS mutation is ever performed here.

bp_ecr_digest_exists() {
  # True iff the exact digest is present in the canonical ECR repository.
  local digest="$1"
  bp_aws ecr describe-images \
    --repository-name "${ECR_REPO}" \
    --image-ids "imageDigest=${digest}" \
    --region "${AWS_REGION}" >/dev/null 2>&1
}

bp_family_latest_digest() {
  # Digest pinned by a family's latest ACTIVE task-definition revision (read-only).
  local family="$1" arn image
  arn=$(bp_latest_task_definition "${family}") || return 1
  image=$(bp_task_definition_image "${arn}") || return 1
  bp_digest_from_image_uri "${image}"
}

bp_ledger_previous_digest() {
  # Resolve the rollback target from the append-only ledger: prefer the previousDigest recorded
  # against the most recent event that matches the current digest (a publish transition records
  # exactly the digest it superseded), else the most recent distinct digest seen. Exit 3 = no
  # ledger, 4 = nothing usable.
  local current="$1" ledger_path
  ledger_path=$(bp_deploy_ledger_path)
  node -e '
const fs = require("node:fs");
const [ledgerPath, current] = process.argv.slice(1);
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
let lines;
try {
  lines = fs.readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.trim());
} catch {
  process.exit(3);
}
const records = [];
for (const line of lines) {
  try { records.push(JSON.parse(line)); } catch { /* skip malformed line */ }
}
// Preferred: newest record whose digest is the current one -> the digest it superseded.
for (let i = records.length - 1; i >= 0; i--) {
  const r = records[i];
  if (r && r.digest === current && digestPattern.test(r.previousDigest || "")) {
    process.stdout.write(r.previousDigest);
    process.exit(0);
  }
}
// Fallback: newest distinct digest recorded (digest or previousDigest fields).
const flat = [];
for (const r of records) {
  if (r && digestPattern.test(r.digest || "")) flat.push(r.digest);
  if (r && digestPattern.test(r.previousDigest || "")) flat.push(r.previousDigest);
}
for (let i = flat.length - 1; i >= 0; i--) {
  if (flat[i] !== current) {
    process.stdout.write(flat[i]);
    process.exit(0);
  }
}
process.exit(4);
' "${ledger_path}" "${current}"
}
