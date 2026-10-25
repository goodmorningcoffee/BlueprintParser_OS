// Hermetic drive of deploy-aws.sh: fake aws / terraform / docker / dig / curl on PATH, fake
// deploy.sh + deploy-yolo.sh (the real ones are covered by their own specs), a scratch HOME for the
// ledger, and a scratch tfvars + .deploy.env the test edits the way the owner would. Nothing here
// reaches a network. What is asserted is ORDER: which mutation happened before which, and which
// never happened on a refused path.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const ACCOUNT = "123456789012";
const DOMAIN = "example.test";
const APP_DIGEST = `sha256:${"a".repeat(64)}`;
const NEXT_DIGEST = `sha256:${"b".repeat(64)}`;
const YOLO_DIGEST = `sha256:${"c".repeat(64)}`;
const CERT_ARN = `arn:aws:acm:us-east-1:${ACCOUNT}:certificate/11111111-2222-3333-4444-555555555555`;
const ALB = "beaver-alb-1.us-east-1.elb.amazonaws.com";
const CF = "d1example.cloudfront.net";
const ECR = `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com`;

let fixture;
let home;
let awsLog;
let tfvarsPath;
let deployEnvPath;
let csiKbPath;

const fakeAws = `#!/usr/bin/env bash
# Fake AWS CLI: records every call, answers from a tiny state dir.
set -u
STATE="\${MOCK_STATE}"
printf '%s\\n' "aws $*" >>"\${MOCK_AWS_LOG}"
service="\${1:-}"; action="\${2:-}"; shift 2 || true
has() { case " $* " in *" $1 "*) return 0;; esac; return 1; }
argval() { local k="$1"; shift; while [ $# -gt 0 ]; do if [ "$1" = "$k" ]; then printf '%s' "\${2:-}"; return; fi; shift; done; }
query="$(argval --query "$@")"
case "$service $action" in
  "sts get-caller-identity") echo "${ACCOUNT}" ;;
  "s3api head-bucket") [ -e "$STATE/bucket" ] ;;
  "s3api create-bucket") touch "$STATE/bucket" ;;
  "s3api put-bucket-versioning"|"s3api put-bucket-encryption"|"s3api put-public-access-block") : ;;
  "dynamodb describe-table") [ -e "$STATE/table" ] ;;
  "dynamodb create-table") touch "$STATE/table" ;;
  "dynamodb wait") : ;;
  "service-quotas get-service-quota") echo "16.0" ;;
  "service-quotas list-service-quotas")
    # doctor asks one value through --query; sagemaker-quotas reads the whole JSON listing.
    if [ -n "$query" ]; then echo "1.0"; elif [ -n "\${MOCK_QUOTAS_APPLIED:-}" ]; then cat "\${MOCK_QUOTAS_APPLIED}"; else exit 254; fi ;;
  "service-quotas list-aws-default-service-quotas")
    if [ -n "\${MOCK_QUOTAS_DEFAULTS:-}" ]; then cat "\${MOCK_QUOTAS_DEFAULTS}"; else exit 254; fi ;;
  "pricing get-products")
    if [ -n "\${MOCK_PRICES:-}" ]; then cat "\${MOCK_PRICES}"; else exit 254; fi ;;
  "lambda get-account-settings") echo "1000" ;;
  "lambda update-function-code") echo "codesha256" ;;
  "lambda wait") : ;;
  "lambda get-function") echo "\${MOCK_LAMBDA_STATUS:-Successful}" ;;
  "acm list-certificates") printf '{"CertificateSummaryList":[{"CertificateArn":"${CERT_ARN}","DomainName":"*.${DOMAIN}","Status":"%s"}]}\\n' "\${MOCK_CERT_STATUS:-ISSUED}" ;;
  "acm describe-certificate")
    if [ -n "$query" ]; then echo "\${MOCK_CERT_STATUS:-ISSUED}"; else
      printf '{"Certificate":{"Status":"%s","DomainValidationOptions":[{"ResourceRecord":{"Name":"_abc.${DOMAIN}.","Value":"_def.acm-validations.aws."}}]}}\\n' "\${MOCK_CERT_STATUS:-ISSUED}"; fi ;;
  "acm request-certificate") echo "${CERT_ARN}" ;;
  "ecr get-login-password") echo "pw" ;;
  "ecr describe-images")
    case "$query" in
      *imageManifestMediaType*) echo "\${MOCK_LAMBDA_MEDIA_TYPE:-application/vnd.docker.distribution.manifest.v2+json}" ;;
      *imageTags*) echo "deploy-\${MOCK_DEPLOYED_HEAD12:-000000000000}-20260101000000" ;;
      *) echo '{"imageDetails":[]}' ;;
    esac ;;
  "elbv2 describe-load-balancers") echo "${ALB}" ;;
  "scheduler get-schedule")
    case "$query" in *LastModificationDate*) echo "2020-01-01T00:00:00+00:00" ;; *) cat "$STATE/schedule-state" 2>/dev/null || echo DISABLED ;; esac ;;
  "ecs describe-services")
    running=$(cat "$STATE/running" 2>/dev/null || echo 0); desired=$(cat "$STATE/desired" 2>/dev/null || echo 0)
    td=$(cat "$STATE/service-td" 2>/dev/null || echo "arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/beaver-app:1")
    case "$query" in
      *rolloutState*) echo "\${MOCK_ROLLOUT:-COMPLETED}" ;;
      *runningCount*) echo "$running" ;;
      *networkConfiguration*) echo '{"awsvpcConfiguration":{"subnets":["subnet-1"],"securityGroups":["sg-1"],"assignPublicIp":"DISABLED"}}' ;;
      *) printf '{"services":[{"taskDefinition":"%s","desiredCount":%s,"runningCount":%s,"pendingCount":0,"deployments":[{"rolloutState":"%s"}],"networkConfiguration":{"awsvpcConfiguration":{"subnets":["subnet-1"],"securityGroups":["sg-1"],"assignPublicIp":"DISABLED"}}}]}\\n' "$td" "$desired" "$running" "\${MOCK_ROLLOUT:-COMPLETED}" ;;
    esac ;;
  "ecs describe-task-definition")
    ref="$(argval --task-definition "$@")"; ref="\${ref##*/}"; fam="\${ref%%:*}"
    latest=$(cat "$STATE/rev" 2>/dev/null || echo 1)
    case "$ref" in *:*) rev="\${ref##*:}" ;; *) rev="$latest" ;; esac
    case "$query" in
      *taskDefinitionArn*) echo "arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/$fam:$rev" ;;
      *image*) echo "${ECR}/beaver-app@$(cat "$STATE/digest-$rev" 2>/dev/null || echo "${APP_DIGEST}")" ;;
      *) echo "{}" ;;
    esac ;;
  "ecs run-task")
    printf '%s\\n' "RUNTASK $(argval --started-by "$@") $(argval --overrides "$@")" >>"\${MOCK_AWS_LOG}"
    if [ -n "\${MOCK_RUNTASK_FAIL:-}" ]; then echo '{"tasks":[],"failures":[{"arn":"x","reason":"RESOURCE:CPU","detail":"no capacity"}]}'; else
    echo '{"tasks":[{"taskArn":"arn:aws:ecs:us-east-1:${ACCOUNT}:task/beaver-cluster/0123456789abcdef0123456789abcdef"}],"failures":[]}'; fi ;;
  "ecs wait")
    case "$1" in services-stable) echo "$(cat "$STATE/desired" 2>/dev/null || echo 0)" >"$STATE/running" ;; esac ;;
  "ecs describe-tasks") printf '{"tasks":[{"stoppedReason":"Essential container in task exited","containers":[{"exitCode":%s}]}]}\\n' "\${MOCK_TASK_EXIT:-0}" ;;
  "ecs list-tasks") echo "\${MOCK_MAINTENANCE_TASK:-None}" ;;
  "iam get-role") : ;;
  "logs get-log-events") echo "[schema-migrate] complete at 0039_runtime_state" ;;
  "ecs update-service")
    printf '%s' "$(argval --task-definition "$@")" >"$STATE/service-td"
    printf '%s' "$(argval --desired-count "$@")" >"$STATE/desired"
    echo "beaver-app" ;;
  "logs tail") : ;;
  *) echo "fake aws: unsupported: $service $action $*" >&2; exit 97 ;;
esac
`;

const fakeTerraform = `#!/usr/bin/env bash
set -u
printf '%s\\n' "terraform $*" >>"\${MOCK_AWS_LOG}"
case " $* " in
  *" output -raw cloudfront_distribution_id "*) echo "E123CFID" ;;
  *" output -raw cloudfront_domain_name "*) echo "${CF}" ;;
  *" plan "*)
    # Real terraform colours its prose unless -no-color is passed; the tool must not grep prose.
    case " $* " in *" -no-color "*) printf 'Plan: 3 to add, 1 to change, 4 to destroy.\\n' ;; *) printf '\\033[1mPlan:\\033[0m 3 to add, 1 to change, 4 to destroy.\\n' ;; esac
    for a in "$@"; do case "$a" in -out=*) : >"\${a#-out=}" ;; esac; done ;;
  *" show -json "*)
    # Every release replaces the four task definitions; a tuple flip replaces the epoch. Those are
    # expected. MOCK_PLAN_DESTROY=1 adds a real deletion.
    extra=""; [ "\${MOCK_PLAN_DESTROY:-0}" != 0 ] && extra=',{"address":"aws_db_instance.beaver","change":{"actions":["delete"]}}'
    printf '{"resource_changes":[{"address":"aws_ecs_task_definition.beaver_app","change":{"actions":["delete","create"]}},{"address":"aws_ecs_task_definition.beaver_cpu_pipeline","change":{"actions":["delete","create"]}},{"address":"aws_ecs_task_definition.beaver_schema_migrator","change":{"actions":["delete","create"]}},{"address":"aws_ecs_task_definition.beaver_project_asset_deletions","change":{"actions":["delete","create"]}},{"address":"terraform_data.beaver_writer_mode_epoch","change":{"actions":["delete","create"]}},{"address":"aws_ecs_service.beaver_app","change":{"actions":["update"]}},{"address":"aws_s3_bucket.x","change":{"actions":["no-op"]}}%s]}\\n' "$extra" ;;
  *" apply "*)
    # Registering task definitions bumps the revision the fakes report.
    r=$(cat "\${MOCK_STATE}/rev" 2>/dev/null || echo 1); echo $((r+1)) >"\${MOCK_STATE}/rev"
    # The new revisions carry whatever digest tfvars names (the test sets MOCK_REGISTERED_DIGEST to it).
    printf '%s' "\${MOCK_REGISTERED_DIGEST:-${APP_DIGEST}}" >"\${MOCK_STATE}/digest-$((r+1))"
    # The LIVE tuple apply sets the service's desired count the way the real one does.
    # ECS converges running onto desired after an apply, like the real service does.
    if grep -q 'ecs_desired_count *= *1' "\${MOCK_TFVARS}"; then echo 1 >"\${MOCK_STATE}/desired"; echo 1 >"\${MOCK_STATE}/running"; echo ENABLED >"\${MOCK_STATE}/schedule-state"; else echo 0 >"\${MOCK_STATE}/desired"; echo 0 >"\${MOCK_STATE}/running"; fi ;;
  *) : ;;
esac
`;

const fakeDocker = `#!/usr/bin/env bash
printf '%s\\n' "docker $*" >>"\${MOCK_AWS_LOG}"
case "$1" in
  login) cat >/dev/null ;;  # consume --password-stdin like the real client, or the writer sees EPIPE
  manifest) echo '{"Descriptor":{"digest":"sha256:${"d".repeat(64)}","platform":{"architecture":"amd64"}}}' ;;
  run) echo "python ok 1.27.2.2 4.13.0" ;;
  *) : ;;
esac
`;
const fakeDig = `#!/usr/bin/env bash
printf '%s\\n' "dig $*" >>"\${MOCK_AWS_LOG}"
case " $* " in *" app.${DOMAIN} "*|*" labelstudio.${DOMAIN} "*) echo "${ALB}." ;; *" assets.${DOMAIN} "*) echo "${CF}." ;; *) echo "" ;; esac
`;
const fakeCurl = `#!/usr/bin/env bash
printf '%s\\n' "curl $*" >>"\${MOCK_AWS_LOG}"
# The first-user phase drives the app's own API: registration, the CSRF token, the credentials
# login (the tool reads only the redirect URL) and the session check.
case " $* " in
  *"/api/register"*)                 cat >/dev/null; printf '{"success":true}\\n%s\\n' "\${MOCK_REGISTER_HTTP:-200}" ;;
  *"/api/auth/csrf"*)                echo '{"csrfToken":"csrf-fixture"}' ;;
  *"/api/auth/callback/credentials"*) printf '%s' "\${MOCK_LOGIN_REDIRECT:-https://app.${DOMAIN}/}" ;;
  *"/api/auth/session"*)             echo '{"user":{"email":"owner@${DOMAIN}"}}' ;;
  *) echo '{"status":"ok"}' ;;
esac
`;
const fakeDeploySh = `#!/usr/bin/env bash
printf '%s\\n' "deploy.sh $* (BP_SKIP_PREFLIGHT=\${BP_SKIP_PREFLIGHT:-})" >>"\${MOCK_AWS_LOG}"
case "$1" in
  publish) printf 'Published immutable application image:\\n  ${ECR}/beaver-app@%s\\n' "\${MOCK_PUBLISH_DIGEST:-${APP_DIGEST}}" ;;
  activate) echo "Deployment completed" ;;
esac
`;
const fakeDeployYolo = `#!/usr/bin/env bash
printf '%s\\n' "deploy-yolo.sh $*" >>"\${MOCK_AWS_LOG}"
printf 'Published immutable YOLO processing image:\\n  ${ECR}/beaver-yolo-pipeline@${YOLO_DIGEST}\\n'
`;

const tfvars = (tuple, appDigest = APP_DIGEST) => `
account_id = "${ACCOUNT}"
domain_name = "${DOMAIN}"
acm_certificate_arn = "${CERT_ARN}"
root_admin_email = "owner@${DOMAIN}"
beaver_app_image_digest  = "${appDigest}"
beaver_yolo_image_digest = "${YOLO_DIGEST}"
label_studio_image = "heartexlabs/label-studio@sha256:${"e".repeat(64)}"
acknowledge_beaver_data_notification_takeover = true
anthropic_api_key = "sk-ant-..."
label_studio_api_key = "CHANGE_ME"
ecs_desired_count = ${tuple === "live" ? 1 : 0}
ecs_min_count     = ${tuple === "live" ? 1 : 0}
ecs_max_count     = 1
ecs_autoscaling_enabled = ${tuple === "live"}
maintenance_worker_schedule_enabled = ${tuple === "live"}
`;
const deployEnv = `AWS_ACCOUNT=${ACCOUNT}
AWS_REGION=us-east-1
ECS_CLUSTER=beaver-cluster
ECS_SERVICE=beaver-app
ECR_REPO=beaver-app
DOMAIN=${DOMAIN}
CLOUDFRONT_DISTRIBUTION_ID=E123CFID
ROOT_ADMIN_EMAIL=owner@${DOMAIN}
`;

before(async () => {
  fixture = await mkdtemp(path.join(tmpdir(), "deploy-aws-"));
  home = path.join(fixture, "home");
  await mkdir(path.join(fixture, "bin"), { recursive: true });
  await mkdir(path.join(fixture, "state"), { recursive: true });
  await mkdir(home, { recursive: true });
  for (const [name, body] of [
    ["aws", fakeAws], ["terraform", fakeTerraform], ["docker", fakeDocker], ["dig", fakeDig], ["curl", fakeCurl],
    ["deploy.sh", fakeDeploySh], ["deploy-yolo.sh", fakeDeployYolo],
  ]) {
    const p = path.join(fixture, "bin", name);
    await writeFile(p, body);
    await chmod(p, 0o755);
  }
  awsLog = path.join(fixture, "aws.log");
  tfvarsPath = path.join(fixture, "terraform.tfvars");
  deployEnvPath = path.join(fixture, "deploy.env");
  await writeFile(deployEnvPath, deployEnv);
  // src/data/csi-kb.json is gitignored by design (D1), so a fresh clone (CI) has none. release and
  // bootstrap run scripts/verify-csi-kb.mjs on it, so the harness hands them the smallest KB that
  // verifier accepts: current hashes of this tree's four inputs. The refusals have their own test.
  csiKbPath = path.join(fixture, "csi-kb.json");
  await writeFile(csiKbPath, await minimalCsiKb());
});
after(async () => {
  await rm(fixture, { recursive: true, force: true });
});

async function minimalCsiKb(mutate = (kb) => kb) {
  const sources = [{ path: "csi_masterformat.pdf", sha256: "0".repeat(64) }];
  for (const rel of ["src/data/csi-masterformat.tsv", "src/data/csi.tsv", "src/data/csi_terms.tsv", "src/lib/csi-tokenize.ts"]) {
    sources.push({ path: rel, sha256: createHash("sha256").update(await readFile(path.join(ROOT, rel))).digest("hex") });
  }
  return JSON.stringify(mutate({ header: { schemaVersion: "csi-kb/2", sources }, codes: [{ code: "00 00 00" }], patterns: [{ id: 0 }] }));
}

async function resetState() {
  await rm(path.join(fixture, "state"), { recursive: true, force: true });
  await mkdir(path.join(fixture, "state"), { recursive: true });
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  await writeFile(awsLog, "");
}

function runTool(args, extraEnv = {}) {
  const result = spawnSync("bash", [path.join(ROOT, "deploy-aws.sh"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.join(fixture, "bin")}:${process.env.PATH}`,
      HOME: home,
      MOCK_STATE: path.join(fixture, "state"),
      MOCK_AWS_LOG: awsLog,
      MOCK_TFVARS: tfvarsPath,
      BP_DEPLOY_ENV_FILE: deployEnvPath,
      BP_TFVARS_FILE: tfvarsPath,
      BP_DEPLOY_SH: path.join(fixture, "bin", "deploy.sh"),
      BP_DEPLOY_YOLO_SH: path.join(fixture, "bin", "deploy-yolo.sh"),
      BP_GREEN_HEADS: path.join(fixture, "GREEN_HEADS"),
      BP_CSI_KB_FILE: csiKbPath,
      BP_TRACE: process.env.DEPLOY_AWS_TEST_TRACE || "",
      // The harness runs against the live repo, which may carry uncommitted work; the clean-tree
      // gate has its own test below.
      BP_ALLOW_DIRTY: "1",
      // first-user registers the root admin through the API; non-interactive runs take these from env
      BP_ROOT_ADMIN_PASSWORD: "Fixture-Passw0rd",
      BP_ROOT_ADMIN_USERNAME: "owner",
      ...extraEnv,
    },
  });
  return result;
}
const logLines = async () => (await readFile(awsLog, "utf8")).split("\n").filter(Boolean);
const indexOfLine = (lines, needle) => lines.findIndex((l) => l.includes(needle));
const assertBefore = (lines, a, b) => {
  const ia = indexOfLine(lines, a);
  const ib = indexOfLine(lines, b);
  assert.ok(ia !== -1, `expected a line containing: ${a}`);
  assert.ok(ib !== -1, `expected a line containing: ${b}`);
  assert.ok(ia < ib, `${a} must happen before ${b} (got ${ia} vs ${ib})`);
};

test("bootstrap on an empty account runs the phases in the only order that works, and resumes across the tuple flip", async () => {
  await resetState();
  await writeFile(tfvarsPath, tfvars("outage"));
  await writeFile(path.join(fixture, "state", "rev"), "1");

  // First run: outage tuple. It must get through migrate and stop at infra-live, which needs the live tuple.
  const first = runTool(["bootstrap", "--yes"], { BP_ASSUME_OWNER_DONE: "1" });
  assert.notEqual(first.status, 0, first.stdout);
  assert.match(first.stderr, /owner step still not done|LIVE tuple/u, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
  let lines = await logLines();

  // Images are built BEFORE any AWS resource exists.
  assertBefore(lines, "docker build --platform linux/amd64 -t beaver-app:bootstrap-check", "aws s3api create-bucket");
  // State backend before terraform init; init before the targeted ECR apply.
  assertBefore(lines, "aws s3api create-bucket", "init -reconfigure");
  assertBefore(lines, "init -reconfigure", "plan -input=false -no-color -out=");
  assert.ok(lines.some((l) => l.includes("plan -input=false") && l.includes("-target=aws_ecr_repository.beaver_app")), "the ECR step is a targeted plan");
  // ECR repos before any push; the Lambda image before the full apply (Lambda needs it at create time).
  assertBefore(lines, "-target=aws_ecr_repository.beaver_cv_lambda", "docker push");
  assertBefore(lines, `docker push ${ECR}/beaver-cv-lambda:latest`, "deploy.sh publish");
  assert.ok(lines.some((l) => l.includes("deploy.sh publish (BP_SKIP_PREFLIGHT=1)")), "publish runs with the Mac-side preflight skipped");
  // Full apply (outage) after publish, then the EMPTY-database migrator before anything goes live.
  const fullPlans = lines.filter((l) => /terraform -chdir=.*plan -input=false -no-color -out=\S+$/.test(l));
  const fullApplies = lines.filter((l) => /terraform -chdir=.* apply -input=false \S+plan\.tfplan$/.test(l));
  assert.equal(fullPlans.length, 1, "exactly one full (untargeted) plan in the first run (outage)");
  assert.ok(fullApplies.length >= 2, "every plan is applied from its saved plan file (ECR + full)");
  const fullPlanIdx = lines.indexOf(fullPlans[0]);
  assert.ok(indexOfLine(lines, "deploy.sh publish") < fullPlanIdx, "publish happens before the full plan/apply");
  assert.ok(indexOfLine(lines, "-target=aws_ecr_repository.beaver_app") < indexOfLine(lines, "deploy.sh publish"), "the targeted ECR apply happens before publish");
  const migrate = lines.find((l) => l.startsWith("RUNTASK bp-bootstrap-migrate"));
  assert.ok(migrate, "the migrator one-off task ran");
  assert.match(migrate, /empty-database-singleton-quiescent/u);
  assert.ok(!lines.some((l) => l.includes("ecs update-service")), "bootstrap never calls update-service itself");
  // Ledger: phases through migrate are done; infra-live is not.
  const ledger = JSON.parse(await readFile(path.join(home, ".blueprintparser-deploy", "bootstrap.json"), "utf8"));
  assert.equal(ledger["phase:migrate"], "done");
  assert.equal(ledger["phase:infra-live"], undefined);
  assert.equal(ledger.app_digest, APP_DIGEST);
  assert.equal(ledger.yolo_digest, YOLO_DIGEST);

  // Owner flips the tuple; the second run resumes at infra-live and finishes.
  await writeFile(tfvarsPath, tfvars("live"));
  await writeFile(awsLog, "");
  const second = runTool(["bootstrap", "--yes"], { BP_ASSUME_OWNER_DONE: "1", MOCK_DEPLOYED_HEAD12: "000000000000" });
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  lines = await logLines();
  assert.ok(!lines.some((l) => l.includes("deploy.sh publish")), "no second publish on resume");
  assert.ok(!lines.some((l) => l.startsWith("RUNTASK bp-bootstrap-migrate")), "no second migration on resume");
  assert.equal(lines.filter((l) => /plan -input=false -no-color -out=\S+$/.test(l)).length, 1, "exactly one full plan on resume (live)");
  assertBefore(lines, "apply -input=false", "curl -sk --max-time 10 -H Host: app.");
  assertBefore(lines, "curl -sk --max-time 10 -H Host: app.", "RUNTASK bp-bootstrap-company");
  assertBefore(lines, "RUNTASK bp-bootstrap-company", "RUNTASK bp-bootstrap-admin");
  assertBefore(lines, "RUNTASK bp-bootstrap-admin", `deploy.sh activate ${APP_DIGEST}`);
  const releases = (await readFile(path.join(home, ".blueprintparser-deploy", "releases.jsonl"), "utf8")).trim().split("\n");
  assert.equal(JSON.parse(releases[0]).event, "bootstrap");
  assert.match(second.stdout, /Bootstrap complete/u);
});

test("release (rolling): publish → apply → read-only schema check → update-service, and the ledger remembers the previous digest", async () => {
  await resetState();
  const head = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  await mkdir(path.join(home, ".blueprintparser-deploy"), { recursive: true });
  await writeFile(path.join(home, ".blueprintparser-deploy", "releases.jsonl"),
    JSON.stringify({ at: "x", event: "bootstrap", digest: APP_DIGEST, previous: "-", head }) + "\n");
  await writeFile(tfvarsPath, tfvars("live", NEXT_DIGEST)); // the owner has already put the new digest in
  await writeFile(path.join(fixture, "state", "rev"), "7");
  await writeFile(path.join(fixture, "state", "desired"), "1");
  await writeFile(path.join(fixture, "state", "running"), "1");

  const result = runTool(["release", "--yes", "--allow-unverified"], { MOCK_PUBLISH_DIGEST: NEXT_DIGEST, MOCK_REGISTERED_DIGEST: NEXT_DIGEST });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const lines = await logLines();
  assertBefore(lines, "deploy.sh publish", "plan -input=false");
  assertBefore(lines, "apply -input=false", "RUNTASK bp-release-schema-check");
  const check = lines.find((l) => l.startsWith("RUNTASK bp-release-schema-check"));
  assert.match(check, /schema-check/u);
  assert.doesNotMatch(check, /BP_SCHEMA_MIGRATION_MODE/u, "a rolling release never runs a migration");
  assertBefore(lines, "RUNTASK bp-release-schema-check", "ecs update-service");
  const update = lines.find((l) => l.includes("ecs update-service"));
  assert.match(update, /task-definition\/beaver-app:8/u, "rolls onto the revision the apply registered");
  assert.match(update, /--desired-count 1/u);
  assert.ok(!lines.some((l) => l.includes("-target=")), "a release is a full apply, never a targeted one");
  const releases = (await readFile(path.join(home, ".blueprintparser-deploy", "releases.jsonl"), "utf8")).trim().split("\n");
  const last = JSON.parse(releases[releases.length - 1]);
  assert.equal(last.event, "release");
  assert.equal(last.digest, NEXT_DIGEST);
  assert.equal(last.previous, APP_DIGEST);
});

test("release refuses before publishing when drizzle/ changed since the deployed HEAD, and points at --outage", async () => {
  await resetState();
  // The commit that introduced migration 0039; its parent has a different drizzle/ tree.
  const introduced = spawnSync("git", ["-C", ROOT, "log", "--format=%H", "-1", "--", "drizzle/0039_runtime_state.sql"], { encoding: "utf8" }).stdout.trim();
  const parent = spawnSync("git", ["-C", ROOT, "rev-parse", `${introduced}^`], { encoding: "utf8" }).stdout.trim();
  await mkdir(path.join(home, ".blueprintparser-deploy"), { recursive: true });
  await writeFile(path.join(home, ".blueprintparser-deploy", "releases.jsonl"),
    JSON.stringify({ at: "x", event: "release", digest: APP_DIGEST, previous: "-", head: parent }) + "\n");
  await writeFile(tfvarsPath, tfvars("live"));
  const result = runTool(["release", "--yes", "--allow-unverified"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /schema change.*release --outage/su);
  const lines = await logLines();
  assert.ok(!lines.some((l) => l.includes("deploy.sh publish")), "nothing is built or pushed");
  assert.ok(!lines.some((l) => l.includes("terraform")), "nothing is applied");
});

test("release resolves a pre-rewrite deployed HEAD through filter-repo's commit-map instead of calling it a schema change", async () => {
  await resetState();
  const head = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const ghost = "f".repeat(40); // a SHA that existed before the 2026-10-03 history rewrite and no longer does
  await mkdir(path.join(home, ".blueprintparser-deploy"), { recursive: true });
  await writeFile(path.join(home, ".blueprintparser-deploy", "releases.jsonl"),
    JSON.stringify({ at: "x", event: "release", digest: APP_DIGEST, previous: "-", head: ghost }) + "\n");
  const map = path.join(home, "commit-map");
  await writeFile(map, `old new\n${ghost} ${head}\n`);
  await writeFile(tfvarsPath, tfvars("live", NEXT_DIGEST));
  await writeFile(path.join(fixture, "state", "rev"), "7");
  await writeFile(path.join(fixture, "state", "desired"), "1");
  await writeFile(path.join(fixture, "state", "running"), "1");
  const result = runTool(["release", "--yes", "--allow-unverified"], { BP_COMMIT_MAP: map, MOCK_PUBLISH_DIGEST: NEXT_DIGEST, MOCK_REGISTERED_DIGEST: NEXT_DIGEST });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /predates the history rewrite/u);
  assert.doesNotMatch(result.stderr, /schema change/u);

  // Without a map entry the tool must not guess: it stops before building anything and names the ledger line to fix.
  await resetState();
  await mkdir(path.join(home, ".blueprintparser-deploy"), { recursive: true });
  await writeFile(path.join(home, ".blueprintparser-deploy", "releases.jsonl"),
    JSON.stringify({ at: "x", event: "release", digest: APP_DIGEST, previous: "-", head: ghost }) + "\n");
  await writeFile(tfvarsPath, tfvars("live"));
  const refused = runTool(["release", "--yes", "--allow-unverified"], { BP_COMMIT_MAP: path.join(home, "no-such-map") });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /has no commit-map entry.*releases\.jsonl/su);
  const lines = await logLines();
  assert.ok(!lines.some((l) => l.includes("deploy.sh publish")), "nothing is built or pushed");
});

test("release stops before update-service when the schema check fails; the old revision keeps serving", async () => {
  await resetState();
  const head = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  await mkdir(path.join(home, ".blueprintparser-deploy"), { recursive: true });
  await writeFile(path.join(home, ".blueprintparser-deploy", "releases.jsonl"),
    JSON.stringify({ at: "x", event: "bootstrap", digest: APP_DIGEST, previous: "-", head }) + "\n");
  await writeFile(tfvarsPath, tfvars("live", NEXT_DIGEST));
  await writeFile(path.join(fixture, "state", "desired"), "1");
  const result = runTool(["release", "--yes", "--allow-unverified"], { MOCK_PUBLISH_DIGEST: NEXT_DIGEST, MOCK_REGISTERED_DIGEST: NEXT_DIGEST, MOCK_TASK_EXIT: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /schema check FAILED/u);
  const lines = await logLines();
  assert.ok(!lines.some((l) => l.includes("ecs update-service")));
});

test("lambda: amd64 single-manifest build → push → update-function-code on :latest → wait, and the head is recorded", async () => {
  await resetState();
  await writeFile(tfvarsPath, tfvars("live"));
  const head = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const result = runTool(["lambda", "--yes", "--allow-unverified"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const lines = await logLines();
  const build = lines.find((l) => l.startsWith("docker build") && l.includes("Dockerfile.lambda"));
  assert.ok(build, "built the Lambda image");
  assert.match(build, /--platform linux\/amd64/u);
  assertBefore(lines, "docker push", "lambda update-function-code");
  const update = lines.find((l) => l.includes("lambda update-function-code"));
  assert.match(update, /--function-name beaver-cv-pipeline/u);
  assert.match(update, /beaver-cv-lambda:latest/u, "the tag lambda.tf declares, so terraform sees no drift");
  assertBefore(lines, "lambda update-function-code", "lambda wait function-updated-v2");
  assert.ok(!lines.some((l) => l.includes("deploy.sh publish")), "the app image is not touched");
  assert.equal((await readFile(path.join(home, ".blueprintparser-deploy", "lambda-head"), "utf8")).trim(), head);
});

test("lambda refuses an image index before touching the function", async () => {
  await resetState();
  await writeFile(tfvarsPath, tfvars("live"));
  const result = runTool(["lambda", "--yes", "--allow-unverified"], { MOCK_LAMBDA_MEDIA_TYPE: "application/vnd.oci.image.index.v1+json" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /image INDEX/u);
  assert.ok(!(await logLines()).some((l) => l.includes("lambda update-function-code")));
});

test("lambda honours the GREEN_HEADS gate", async () => {
  await resetState();
  await writeFile(tfvarsPath, tfvars("live"));
  await writeFile(path.join(fixture, "GREEN_HEADS"), "0000000000000000000000000000000000000000 nothing\n");
  const refused = runTool(["lambda", "--yes"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /GREEN_HEADS/u);
  assert.ok(!(await logLines()).some((l) => l.startsWith("docker build")));
});

for (const [label, lambdaHead, expectUpdate] of [
  ["unchanged since the recorded Lambda head → no Lambda build", "HEAD", false],
  ["changed (recorded head unknown here) → Lambda rebuilt after the app rolls", "f".repeat(40), true],
]) {
  test(`release ships the CV Lambda only when its inputs changed: ${label}`, async () => {
    await resetState();
    const head = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    await mkdir(path.join(home, ".blueprintparser-deploy"), { recursive: true });
    await writeFile(path.join(home, ".blueprintparser-deploy", "releases.jsonl"),
      JSON.stringify({ at: "x", event: "bootstrap", digest: APP_DIGEST, previous: "-", head }) + "\n");
    await writeFile(path.join(home, ".blueprintparser-deploy", "lambda-head"), `${lambdaHead === "HEAD" ? head : lambdaHead}\n`);
    await writeFile(tfvarsPath, tfvars("live", NEXT_DIGEST));
    await writeFile(path.join(fixture, "state", "rev"), "7");
    await writeFile(path.join(fixture, "state", "desired"), "1");
    await writeFile(path.join(fixture, "state", "running"), "1");
    const result = runTool(["release", "--yes", "--allow-unverified"], { MOCK_PUBLISH_DIGEST: NEXT_DIGEST, MOCK_REGISTERED_DIGEST: NEXT_DIGEST });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const lines = await logLines();
    if (expectUpdate) {
      assertBefore(lines, "ecs update-service", "lambda update-function-code");
      assert.equal((await readFile(path.join(home, ".blueprintparser-deploy", "lambda-head"), "utf8")).trim(), head);
    } else {
      assert.ok(!lines.some((l) => l.includes("lambda update-function-code")), "no Lambda update");
      assert.ok(!lines.some((l) => l.startsWith("docker build") && l.includes("Dockerfile.lambda")), "no Lambda build");
    }
  });
}

test("release honours the GREEN_HEADS gate unless --allow-unverified", async () => {
  await resetState();
  await writeFile(tfvarsPath, tfvars("live"));
  await writeFile(path.join(fixture, "GREEN_HEADS"), "0000000000000000000000000000000000000000 nothing\n");
  const refused = runTool(["release", "--yes"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /GREEN_HEADS/u);
  assert.ok(!(await logLines()).some((l) => l.includes("deploy.sh publish")));
});

test("release --outage: drain to 0, forward migration, re-bind at 0, live apply", async () => {
  await resetState();
  const head = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  await mkdir(path.join(home, ".blueprintparser-deploy"), { recursive: true });
  await writeFile(path.join(home, ".blueprintparser-deploy", "releases.jsonl"),
    JSON.stringify({ at: "x", event: "bootstrap", digest: APP_DIGEST, previous: "-", head }) + "\n");
  // The owner has set the OUTAGE tuple with the new digest; the fake terraform flips desired on apply,
  // and the test flips the tfvars to LIVE when the tool asks (BP_ASSUME_OWNER_DONE cannot edit files,
  // so pre-stage the live file and swap it in via a wrapper around terraform).
  await writeFile(tfvarsPath, tfvars("outage", NEXT_DIGEST));
  await writeFile(path.join(fixture, "state", "desired"), "1");
  await writeFile(path.join(fixture, "state", "running"), "1");
  // Wrap the fake terraform: after the outage apply, the "owner" writes the live tuple.
  const liveTfvars = tfvars("live", NEXT_DIGEST);
  await writeFile(path.join(fixture, "live.tfvars"), liveTfvars);
  const wrapper = `#!/usr/bin/env bash
"${path.join(fixture, "bin", "terraform")}" "$@"; rc=$?
case " $* " in *" apply "*) if grep -q 'ecs_desired_count *= *0' "${tfvarsPath}"; then cp "${path.join(fixture, "live.tfvars")}" "${tfvarsPath}"; fi ;; esac
exit $rc
`;
  await writeFile(path.join(fixture, "terraform-wrap"), wrapper);
  await chmod(path.join(fixture, "terraform-wrap"), 0o755);
  const result = runTool(["release", "--yes", "--allow-unverified", "--outage"], {
    MOCK_PUBLISH_DIGEST: NEXT_DIGEST, MOCK_REGISTERED_DIGEST: NEXT_DIGEST, TERRAFORM_BIN: path.join(fixture, "terraform-wrap"),
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const lines = await logLines();
  const applies = lines.map((l, i) => [l, i]).filter(([l]) => / apply -input=false /.test(l));
  assert.equal(applies.length, 2, "outage apply then live apply");
  const migrate = lines.find((l) => l.startsWith("RUNTASK bp-release-migrate"));
  assert.match(migrate, /p2-0037-singleton-quiescent/u);
  assertBefore(lines, "apply -input=false", "RUNTASK bp-release-migrate");
  assertBefore(lines, "RUNTASK bp-release-migrate", "ecs update-service");
  assert.match(lines.find((l) => l.includes("ecs update-service")), /--desired-count 0/u, "re-bind happens while drained");
  const [, firstApply] = applies[0];
  const [, secondApply] = applies[1];
  const updateIdx = indexOfLine(lines, "ecs update-service");
  assert.ok(firstApply < updateIdx && updateIdx < secondApply, "update-service sits between the two applies");
});

test("no arguments opens the menu and q quits without touching AWS", async () => {
  await resetState();
  await writeFile(tfvarsPath, tfvars("live"));
  const result = spawnSync("bash", ["-c", `echo q | script -q /dev/null bash ${path.join(ROOT, "deploy-aws.sh")} 2>/dev/null || true`], { encoding: "utf8", env: { ...process.env, PATH: `${path.join(fixture, "bin")}:${process.env.PATH}`, HOME: home, MOCK_STATE: path.join(fixture, "state"), MOCK_AWS_LOG: awsLog, BP_DEPLOY_ENV_FILE: deployEnvPath, BP_TFVARS_FILE: tfvarsPath } });
  // `script` provides the tty the menu reads from; where it is unavailable the menu simply exits.
  assert.ok(!(await logLines()).some((l) => l.includes("aws ") && !l.includes("sts")), "the menu itself makes no mutating call");
});

test("release: a circuit-breaker rollback is reported as a failure, not recorded as a release", async () => {
  await resetState();
  const head = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  await mkdir(path.join(home, ".blueprintparser-deploy"), { recursive: true });
  await writeFile(path.join(home, ".blueprintparser-deploy", "releases.jsonl"),
    JSON.stringify({ at: "x", event: "bootstrap", digest: APP_DIGEST, previous: "-", head }) + "\n");
  await writeFile(tfvarsPath, tfvars("live", NEXT_DIGEST));
  await writeFile(path.join(fixture, "state", "rev"), "7");
  await writeFile(path.join(fixture, "state", "desired"), "1");
  await writeFile(path.join(fixture, "state", "running"), "1");
  // After the breaker rolls back, the service reports COMPLETED but is bound to the OLD revision.
  const wrapper = `#!/usr/bin/env bash
if [ "$1 $2" = "ecs update-service" ]; then "${path.join(fixture, "bin", "aws")}" "$@"; printf '%s' "arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/beaver-app:7" >"${path.join(fixture, "state", "service-td")}"; exit 0; fi
exec "${path.join(fixture, "bin", "aws")}" "$@"
`;
  await writeFile(path.join(fixture, "aws-rollback"), wrapper);
  await chmod(path.join(fixture, "aws-rollback"), 0o755);
  const result = runTool(["release", "--yes", "--allow-unverified"], {
    MOCK_PUBLISH_DIGEST: NEXT_DIGEST, MOCK_REGISTERED_DIGEST: NEXT_DIGEST, AWS_BIN: path.join(fixture, "aws-rollback"),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rolled the deployment back/u);
  const releases = (await readFile(path.join(home, ".blueprintparser-deploy", "releases.jsonl"), "utf8")).trim().split("\n");
  assert.equal(releases.length, 1, "no release line was written for a rollout that did not land");
});

test("release --outage waits for a running maintenance worker before migrating", async () => {
  await resetState();
  const head = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  await mkdir(path.join(home, ".blueprintparser-deploy"), { recursive: true });
  await writeFile(path.join(home, ".blueprintparser-deploy", "releases.jsonl"),
    JSON.stringify({ at: "x", event: "bootstrap", digest: APP_DIGEST, previous: "-", head }) + "\n");
  await writeFile(tfvarsPath, tfvars("outage", NEXT_DIGEST));
  await writeFile(path.join(fixture, "state", "desired"), "1");
  await writeFile(path.join(fixture, "state", "running"), "1");
  // A maintenance worker is RUNNING for the first two polls, then gone.
  const counter = path.join(fixture, "state", "list-tasks-calls");
  const wrapper = `#!/usr/bin/env bash
if [ "$1 $2" = "ecs list-tasks" ]; then n=$(cat "${counter}" 2>/dev/null || echo 0); echo $((n+1)) >"${counter}"; if [ "$n" -lt 2 ]; then echo "arn:aws:ecs:us-east-1:${ACCOUNT}:task/beaver-cluster/maint"; else echo None; fi; printf '%s\\n' "aws $*" >>"${awsLog}"; exit 0; fi
exec "${path.join(fixture, "bin", "aws")}" "$@"
`;
  await writeFile(path.join(fixture, "aws-maint"), wrapper);
  await chmod(path.join(fixture, "aws-maint"), 0o755);
  const liveTfvars = tfvars("live", NEXT_DIGEST);
  await writeFile(path.join(fixture, "live.tfvars"), liveTfvars);
  const tfwrap = `#!/usr/bin/env bash
"${path.join(fixture, "bin", "terraform")}" "$@"; rc=$?
case " $* " in *" apply "*) if grep -q 'ecs_desired_count *= *0' "${tfvarsPath}"; then cp "${path.join(fixture, "live.tfvars")}" "${tfvarsPath}"; fi ;; esac
exit $rc
`;
  await writeFile(path.join(fixture, "terraform-wrap2"), tfwrap);
  await chmod(path.join(fixture, "terraform-wrap2"), 0o755);
  const result = runTool(["release", "--yes", "--allow-unverified", "--outage"], {
    MOCK_PUBLISH_DIGEST: NEXT_DIGEST, MOCK_REGISTERED_DIGEST: NEXT_DIGEST,
    AWS_BIN: path.join(fixture, "aws-maint"), TERRAFORM_BIN: path.join(fixture, "terraform-wrap2"),
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const lines = await logLines();
  const polls = lines.filter((l) => l.includes("ecs list-tasks"));
  assert.ok(polls.length >= 3, "polled the maintenance family until it was empty");
  assertBefore(lines, "ecs list-tasks", "RUNTASK bp-release-migrate");
});

test("first-user re-run with an existing company and no saved key skips registration, logs in and promotes", async () => {
  await resetState();
  await writeFile(tfvarsPath, tfvars("live"));
  await mkdir(path.join(home, ".blueprintparser-deploy"), { recursive: true });
  await writeFile(path.join(home, ".blueprintparser-deploy", "bootstrap.json"), JSON.stringify({ app_digest: APP_DIGEST }));
  await writeFile(path.join(fixture, "state", "desired"), "1");
  await writeFile(path.join(fixture, "state", "running"), "1");
  // The company task exits 4 ("already bootstrapped"); the promote task exits 0.
  const wrapper = `#!/usr/bin/env bash
if [ "$1 $2" = "ecs describe-tasks" ]; then n=$(cat "${path.join(fixture, "state", "dt-calls")}" 2>/dev/null || echo 0); echo $((n+1)) >"${path.join(fixture, "state", "dt-calls")}"; if [ "$n" = 0 ]; then echo '{"tasks":[{"stoppedReason":"","containers":[{"exitCode":4}]}]}'; else echo '{"tasks":[{"stoppedReason":"","containers":[{"exitCode":0}]}]}'; fi; exit 0; fi
exec "${path.join(fixture, "bin", "aws")}" "$@"
`;
  await writeFile(path.join(fixture, "aws-exists"), wrapper);
  await chmod(path.join(fixture, "aws-exists"), 0o755);
  const result = runTool(["bootstrap", "--yes", "--from", "first-user"], {
    BP_ASSUME_OWNER_DONE: "1", AWS_BIN: path.join(fixture, "aws-exists"),
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /a company already exists and this tool has no saved key/u);
  const lines = await logLines();
  assert.ok(!lines.some((l) => l.startsWith("curl") && l.includes("/api/register")), "no registration without a key");
  assert.ok(lines.some((l) => l.startsWith("curl") && l.includes("/api/auth/callback/credentials")), "the login still runs");
  assert.match(result.stdout, /root admin with the admin role/u);
  // The key this run generated belongs to no row, so it must not be left behind as if it did.
  assert.equal(existsSync(path.join(home, ".blueprintparser-deploy", "first-company-key")), false);
});

test("first-user re-run after a run that died mid-phase registers with the key that run saved", async () => {
  await resetState();
  await writeFile(tfvarsPath, tfvars("live"));
  const stateDir = path.join(home, ".blueprintparser-deploy");
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "bootstrap.json"), JSON.stringify({ app_digest: APP_DIGEST }));
  await writeFile(path.join(fixture, "state", "desired"), "1");
  await writeFile(path.join(fixture, "state", "running"), "1");
  // An earlier run saved its key, launched the task (the INSERT committed), then died before
  // printing. This run finds the row (exit 4) and must hand the owner that same key.
  const savedKey = "0123456789abcdef0123456789abcdef";
  await writeFile(path.join(stateDir, "first-company-key"), `${savedKey}\n`);
  const wrapper = `#!/usr/bin/env bash
if [ "$1 $2" = "ecs describe-tasks" ]; then n=$(cat "${path.join(fixture, "state", "dt-calls")}" 2>/dev/null || echo 0); echo $((n+1)) >"${path.join(fixture, "state", "dt-calls")}"; if [ "$n" = 0 ]; then echo '{"tasks":[{"stoppedReason":"","containers":[{"exitCode":4}]}]}'; else echo '{"tasks":[{"stoppedReason":"","containers":[{"exitCode":0}]}]}'; fi; exit 0; fi
exec "${path.join(fixture, "bin", "aws")}" "$@"
`;
  await writeFile(path.join(fixture, "aws-exists"), wrapper);
  await chmod(path.join(fixture, "aws-exists"), 0o755);
  const result = runTool(["bootstrap", "--yes", "--from", "first-user"], {
    BP_ASSUME_OWNER_DONE: "1", AWS_BIN: path.join(fixture, "aws-exists"),
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /using the key that run saved/u);
  const lines = await logLines();
  assert.ok(lines.some((l) => l.startsWith("curl") && l.includes("/api/register")), "registered through the API with the saved key");
  assertBefore(lines, "/api/register", "/api/auth/callback/credentials");
  assertBefore(lines, "/api/auth/callback/credentials", "RUNTASK bp-bootstrap-admin");
  assert.match(result.stdout, /root admin with the admin role/u);
  assert.equal(existsSync(path.join(stateDir, "first-company-key")), false, "removed once the owner is promoted");
});

test("first-user: a refused login stops the phase before any promotion task", async () => {
  await resetState();
  await writeFile(tfvarsPath, tfvars("live"));
  const stateDir = path.join(home, ".blueprintparser-deploy");
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "bootstrap.json"), JSON.stringify({ app_digest: APP_DIGEST }));
  await writeFile(path.join(fixture, "state", "desired"), "1");
  await writeFile(path.join(fixture, "state", "running"), "1");
  const result = runTool(["bootstrap", "--yes", "--from", "first-user"], {
    BP_ASSUME_OWNER_DONE: "1",
    MOCK_LOGIN_REDIRECT: `https://app.${DOMAIN}/login?error=CredentialsSignin&code=credentials`,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /login as owner@example\.test was refused/u);
  const lines = await logLines();
  assert.ok(!lines.some((l) => l.startsWith("RUNTASK bp-bootstrap-admin")), "no promotion after a refused login");
  // The password never reaches a command line the log could capture.
  assert.ok(!lines.some((l) => l.includes("Fixture-Passw0rd")), "password absent from every logged command");
  // The access key file survives for the re-run.
  assert.equal(existsSync(path.join(stateDir, "first-company-key")), true);
});

test("release refuses an unclean working tree unless BP_ALLOW_DIRTY=1 (deploy.sh's own gate is skipped)", async () => {
  await resetState();
  await writeFile(tfvarsPath, tfvars("live"));
  const dirty = spawnSync("git", ["-C", ROOT, "status", "--porcelain"], { encoding: "utf8" }).stdout
    .split("\n").filter((l) => l && !/^ M \.gitignore$|^\?\? perf\/private-gateway-baseline\.json$/.test(l));
  if (dirty.length === 0) return; // nothing to prove against a clean tree
  const result = runTool(["release", "--yes", "--allow-unverified"], { BP_ALLOW_DIRTY: "0" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /uncommitted changes/u);
  assert.ok(!(await logLines()).some((l) => l.includes("deploy.sh publish")));
});

test("release and bootstrap refuse before building when the gitignored CSI lookup table is missing, a stub or stale", async () => {
  await resetState();
  await writeFile(tfvarsPath, tfvars("live"));
  const kb = (name, body) => {
    const p = path.join(fixture, name);
    return writeFile(p, body).then(() => p);
  };
  const bad = [
    [path.join(fixture, "no-such-csi-kb.json"), /is missing or unreadable/u],
    [await kb("csi-kb-empty.json", ""), /is empty/u],
    [await kb("csi-kb-stub.json", '{"header":{"schemaVersion":"csi-kb/2"}}\n'), /"codes" is missing or empty.*header\.sources is not an array/su],
    [await kb("csi-kb-stale.json", await minimalCsiKb((k) => {
      k.header.sources.find((s) => s.path === "src/lib/csi-tokenize.ts").sha256 = "f".repeat(64);
      return k;
    })), /STALE: "src\/lib\/csi-tokenize\.ts"/u],
  ];
  for (const [file, reason] of bad) {
    const release = runTool(["release", "--yes", "--allow-unverified"], { BP_CSI_KB_FILE: file });
    assert.notEqual(release.status, 0, file);
    assert.match(release.stderr, reason, file);
    assert.match(release.stderr, /gitignored by design.*eval\/csi\/build-kb-v2\.ts.*cannot ship/su, file);
    assert.ok(!(await logLines()).some((l) => l.includes("deploy.sh publish")), "release published no image");
  }
  await resetState();
  const boot = runTool(["bootstrap", "--yes"], { BP_ASSUME_OWNER_DONE: "1", BP_CSI_KB_FILE: bad[3][0] });
  assert.notEqual(boot.status, 0);
  assert.match(boot.stderr, /STALE: "src\/lib\/csi-tokenize\.ts"/u);
  assert.ok(!(await logLines()).some((l) => l.includes("docker build") || l.includes("deploy.sh publish")), "bootstrap built nothing");
});

test("the plan gate: expected task-definition/epoch replacements pass; a real deletion is refused non-interactively", async () => {
  await resetState();
  const head = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  await mkdir(path.join(home, ".blueprintparser-deploy"), { recursive: true });
  await writeFile(path.join(home, ".blueprintparser-deploy", "releases.jsonl"),
    JSON.stringify({ at: "x", event: "bootstrap", digest: APP_DIGEST, previous: "-", head }) + "\n");
  await writeFile(tfvarsPath, tfvars("live", NEXT_DIGEST));
  await writeFile(path.join(fixture, "state", "rev"), "7");
  await writeFile(path.join(fixture, "state", "desired"), "1");
  await writeFile(path.join(fixture, "state", "running"), "1");
  // The fake plan says "4 to destroy" (the four task definitions): must NOT trip the gate.
  const fine = runTool(["release", "--yes", "--allow-unverified"], { MOCK_PUBLISH_DIGEST: NEXT_DIGEST, MOCK_REGISTERED_DIGEST: NEXT_DIGEST });
  assert.equal(fine.status, 0, `${fine.stdout}\n${fine.stderr}`);
  assert.ok((await logLines()).some((l) => / apply -input=false \S+plan\.tfplan$/.test(l)), "applied the saved plan");
  // A deletion beyond those is refused unless the owner opts in.
  await resetState();
  await mkdir(path.join(home, ".blueprintparser-deploy"), { recursive: true });
  await writeFile(path.join(home, ".blueprintparser-deploy", "releases.jsonl"),
    JSON.stringify({ at: "x", event: "bootstrap", digest: APP_DIGEST, previous: "-", head }) + "\n");
  await writeFile(tfvarsPath, tfvars("live", NEXT_DIGEST));
  await writeFile(path.join(fixture, "state", "rev"), "7");
  await writeFile(path.join(fixture, "state", "desired"), "1");
  const refused = runTool(["release", "--yes", "--allow-unverified"], { MOCK_PUBLISH_DIGEST: NEXT_DIGEST, MOCK_REGISTERED_DIGEST: NEXT_DIGEST, MOCK_PLAN_DESTROY: "1" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /destructive plan/u);
  assert.match(refused.stdout, /DESTROY: aws_db_instance\.beaver/u);
  assert.ok(!(await logLines()).some((l) => / apply -input=false /.test(l)), "nothing applied");
});

test("bootstrap --from re-runs every later phase, and infra-live rolls the service onto a re-published digest", async () => {
  await resetState();
  await writeFile(tfvarsPath, tfvars("live", NEXT_DIGEST));
  await writeFile(path.join(fixture, "state", "rev"), "7");
  await writeFile(path.join(fixture, "state", "desired"), "1");
  await writeFile(path.join(fixture, "state", "running"), "1");
  await writeFile(path.join(fixture, "state", "service-td"), `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/beaver-app:1`);
  await mkdir(path.join(home, ".blueprintparser-deploy"), { recursive: true });
  const ledger = {};
  for (const p of ["preflight", "image-build", "state-backend", "certificate", "ecr", "images", "infra-outage", "migrate", "infra-live", "dns", "first-user", "verify"]) ledger[`phase:${p}`] = "done";
  ledger.app_digest = NEXT_DIGEST; ledger.app_head = "deadbeef";
  await writeFile(path.join(home, ".blueprintparser-deploy", "bootstrap.json"), JSON.stringify(ledger));
  const result = runTool(["bootstrap", "--yes", "--from", "infra-live"], { BP_ASSUME_OWNER_DONE: "1", MOCK_REGISTERED_DIGEST: NEXT_DIGEST, MOCK_DEPLOYED_HEAD12: "000000000000" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const lines = await logLines();
  assert.ok(lines.some((l) => l.includes("ecs update-service") && /beaver-app:8/.test(l)), "rolled the service onto the registered revision");
  assert.ok(lines.some((l) => l.startsWith("RUNTASK bp-bootstrap-company")), "first-user ran again (later phases were re-opened)");
  const after = JSON.parse(await readFile(path.join(home, ".blueprintparser-deploy", "bootstrap.json"), "utf8"));
  assert.equal(after["phase:verify"], "done");
});

// ── sagemaker-quotas (read-only) ─────────────────────────────────────────────
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/gu, "");
async function runQuotas(applied, defaults, prices = null) {
  await resetState();
  await writeFile(tfvarsPath, tfvars("live"));
  const env = {};
  if (applied) {
    env.MOCK_QUOTAS_APPLIED = path.join(fixture, "quotas-applied.json");
    await writeFile(env.MOCK_QUOTAS_APPLIED, JSON.stringify(applied));
  }
  if (defaults) {
    env.MOCK_QUOTAS_DEFAULTS = path.join(fixture, "quotas-defaults.json");
    await writeFile(env.MOCK_QUOTAS_DEFAULTS, JSON.stringify(defaults));
  }
  if (prices) {
    env.MOCK_PRICES = path.join(fixture, "prices.json");
    await writeFile(env.MOCK_PRICES, JSON.stringify(prices));
  }
  const result = runTool(["sagemaker-quotas"], env);
  const rows = new Map();
  for (const line of stripAnsi(result.stdout).split("\n")) {
    const cols = line.trim().split(/\s+/u);
    if (/^ml\./u.test(cols[0] ?? "")) rows.set(cols[0], cols.slice(1));
  }
  return { result, rows, out: stripAnsi(result.stdout), lines: await logLines() };
}

test("sagemaker-quotas lists only processing-job instance quotas, applied over default, marks YOLO fit + picker, and is read-only", async () => {
  const { result, rows, out, lines } = await runQuotas(
    {
      Quotas: [
        { QuotaName: "ml.g4dn.xlarge for processing job usage", QuotaCode: "L-G4DN", Value: 2 },
        { QuotaName: "ml.inf2.xlarge for processing job usage", QuotaCode: "L-INF2", Value: 4 },
        { QuotaName: "ml.g4dn.xlarge for training job usage", QuotaCode: "L-TRAIN", Value: 9 },
        { QuotaName: "Maximum number of processing jobs", QuotaCode: "L-MAX", Value: 100 },
      ],
    },
    {
      Quotas: [
        { QuotaName: "ml.g4dn.xlarge for processing job usage", QuotaCode: "L-G4DN", Value: 0 },
        { QuotaName: "ml.g5.xlarge for processing job usage", QuotaCode: "L-G5", Value: 0 },
        { QuotaName: "ml.m5.xlarge for processing job usage", QuotaCode: "L-M5", Value: 1 },
        { QuotaName: "ml.p4d.24xlarge for processing job usage", QuotaCode: "L-P4D", Value: 0 },
      ],
    },
    {
      PriceList: [
        // Price List entries are JSON strings; Processing only, the cheapest on-demand hourly rate wins.
        JSON.stringify({
          product: { attributes: { instanceName: "ml.g4dn.xlarge", component: "Processing", usagetype: "USE1-Processing:ml.g4dn.xlarge" } },
          terms: { OnDemand: { a: { priceDimensions: { b: { unit: "Hrs", pricePerUnit: { USD: "0.7364000000" } } } } } },
        }),
        JSON.stringify({
          product: { attributes: { instanceName: "ml.g5.xlarge", component: "Training", usagetype: "USE1-Train:ml.g5.xlarge" } },
          terms: { OnDemand: { a: { priceDimensions: { b: { unit: "Hrs", pricePerUnit: { USD: "9.99" } } } } } },
        }),
      ],
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  // INSTANCE → [QUOTA, SOURCE, YOLO, PICKER, $/H, QUOTA-CODE]
  assert.deepEqual(rows.get("ml.g4dn.xlarge"), ["2", "applied", "gpu", "yes", "0.736", "L-G4DN"]);
  assert.deepEqual(rows.get("ml.g5.xlarge"), ["0", "default", "gpu", "yes", "-", "L-G5"], "a Training price is not a Processing price");
  assert.deepEqual(rows.get("ml.m5.xlarge"), ["1", "default", "cpu-slow", "yes", "-", "L-M5"]);
  assert.deepEqual(rows.get("ml.inf2.xlarge"), ["4", "applied", "no", "-", "-", "L-INF2"]);
  assert.deepEqual(rows.get("ml.p4d.24xlarge"), ["0", "default", "gpu", "-", "-", "L-P4D"], "a GPU type the picker does not offer");
  assert.equal(rows.size, 5, "training-job and non-instance quotas are filtered out");
  assert.match(out, /2 YOLO-capable instance type\(s\) with a quota of at least 1/u, "inf2 has quota but cannot run the image");
  const awsCalls = lines.filter((l) => l.startsWith("aws "));
  assert.ok(awsCalls.length >= 3, "both listings and the price list were read");
  for (const call of awsCalls) {
    assert.match(
      call,
      /^aws (service-quotas list-(aws-default-)?service-quotas --service-code sagemaker |pricing get-products --region us-east-1 --service-code AmazonSageMaker )/u,
      `read-only: ${call}`,
    );
  }
});

test("sagemaker-quotas warns when no YOLO-capable type has quota, and fails when neither listing can be read", async () => {
  const none = await runQuotas(
    { Quotas: [{ QuotaName: "ml.trn1.2xlarge for processing job usage", QuotaCode: "L-T", Value: 3 }] },
    { Quotas: [{ QuotaName: "ml.g4dn.xlarge for processing job usage", QuotaCode: "L-G4DN", Value: 0 }] },
  );
  assert.equal(none.result.status, 0, none.result.stderr);
  assert.match(none.out, /no YOLO-capable instance type has a processing-job quota of at least 1/u);

  const onlyDefaults = await runQuotas(null, {
    Quotas: [{ QuotaName: "ml.g5.xlarge for processing job usage", QuotaCode: "L-G5", Value: 1 }],
  });
  assert.equal(onlyDefaults.result.status, 0, onlyDefaults.result.stderr);
  assert.deepEqual(onlyDefaults.rows.get("ml.g5.xlarge"), ["1", "default", "gpu", "yes", "-", "L-G5"]);
  assert.match(onlyDefaults.out + onlyDefaults.result.stderr, /on-demand prices unavailable/u);

  const broken = await runQuotas(null, null);
  assert.notEqual(broken.result.status, 0);
  assert.match(broken.result.stderr, /could not list SageMaker service quotas/u);
});
