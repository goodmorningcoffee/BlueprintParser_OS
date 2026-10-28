# Deploying BlueprintParser to AWS

This is the operator guide. The [README](../README.md) covers local development; nothing here is
needed to run the app on your own machine.

**Who this is for.** The infrastructure is the maintainer's own production stack, published as a
reference: Terraform for one AWS account and Region, a container image built from this tree, and a
set of owner-run shell tools with deliberately strict admission checks. It assumes you can read
Terraform and the AWS CLI.

**What it costs.** Roughly $150–300 a month for the always-on part (ECS Fargate app, RDS
PostgreSQL, NAT gateway, ALB), plus about $0.75 per hour of SageMaker GPU time while a YOLO job runs.
AWS Budgets alarms are part of the Terraform (`budgets.tf`).

## The short version

```bash
cp .deploy.env.example .deploy.env                         # domain, cluster/service names, root admin e-mail
cp infrastructure/terraform/terraform.tfvars.example \
   infrastructure/terraform/terraform.tfvars               # untracked; the real values never enter git
./deploy-aws.sh doctor                                     # read-only: toolchain, AWS identity, quotas, config, certificate, DNS
./deploy-aws.sh bootstrap                                  # first deploy on an empty account, resumable phase by phase
./deploy-aws.sh release                                    # every later release: build → push → apply → schema check → rolling update
```

`deploy-aws.sh` was written for the maintainer's Mac (stock bash 3.2, aws CLI v2, terraform, docker,
node, git, dig, curl) and keeps its private state in `~/.blueprintparser-deploy`, never in the repo.
Three assumptions to know before you use it elsewhere:

- **Test gate.** `release` refuses a HEAD that is not listed in a `GREEN_HEADS` file (a record of
  commits that passed the full test suite). Point `BP_GREEN_HEADS` at your own file, or pass
  `--allow-unverified` to skip the check.
- **DNS.** The prompts say "GoDaddy" because that is the maintainer's registrar; any DNS provider
  works — the tool only prints the CNAME records to create and waits for you.
- **CSI lookup table.** `release` and `bootstrap` refuse to start until `src/data/csi-kb.json` exists
  and verifies (`node scripts/verify-csi-kb.mjs`), because the image build needs it. See the README,
  "Build prerequisites".

The image build also needs the Table Transformer checkpoint in `models/tatr/` (README, "Build
prerequisites"). YOLO inference has its own image (`Dockerfile.yolo`, built and pushed by
`deploy-yolo.sh`); the CV Lambda has `Dockerfile.lambda` (`deploy-aws.sh lambda`).

## Scripts

| Script                            | Purpose                                                                                                        | When to Use                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `deploy-aws.sh`                   | The one deploy tool: a menu with no arguments, subcommands otherwise. `bootstrap` walks a first deploy on an empty account phase by phase (state backend, certificate, ECR, images, outage apply, schema, live apply, DNS, first account), resumable; `release` = publish → `terraform apply` → read-only schema check → rolling update; `release --outage` for a schema change; `rollback`, `restart`, `status`, `doctor`, `lambda`, `logs`, `unlock-login <email>`, `sagemaker-quotas`. Calls `deploy.sh`, never replaces it. Stock macOS bash | Every deploy: the first one, and each release after |
| `deploy.sh`                       | Publish an immutable app image, then activate digest-pinned task definitions after migration-history admission | Called by `deploy-aws.sh`; also usable alone   |
| `entrypoint.sh`                   | Container entrypoint. The **first positional argument** selects the mode: `app`, `worker`, `migrate`, `schema-check`, `schema-readiness`, `janitor`. `app` and `worker` assert the schema is current and **never migrate** | Inside the image; not run by hand              |
| `scripts/p2-schema-cutover.sh`    | Verify zero writers/readiness, bind and retire old revisions, migrate, and verify restoration                  | Schema compatibility boundaries and empty-database bootstrap |
| `scripts/rollback.sh`             | Read-only/advisory. Resolves digests and prints the exact owner command sequence to rebind a prior image; mutates nothing | Planning a rollback (execution is owner-gated) |
| `deploy-yolo.sh`                  | Build and push YOLO inference container to ECR                                                                 | When updating YOLO models or inference code    |
| `aws_tools.sh`                    | AWS operations TUI. Diagnosis is read-only and is the default; `pause`/`resume`/`grace`/`redeploy` are guarded mutations behind a typed confirmation. `pause` suspends autoscaling and sets desired count to 0 — **resume before any Terraform apply** | Explaining an ALB 503; deliberate web-service pause |
| `root_admin.sh`                   | Owner break-glass over ECS Exec: list root-admin status, promote one exact email, demote one exact email, `2fa-reset <email>` (delete a root user's authenticator-app enrollment after a lost device). It cannot create an account and has no password-reset channel | Emergency root-admin access recovery           |
| `install_setup.sh`                | Interactive config wizard; schema setup is allowed only for a loopback development database                    | Local setup, or updating service configuration |
| `scripts/cost-control.sh`         | Read-only ECS, Step Functions, and SageMaker status report                                                     | Production cost and writer-state inspection    |
| `hardening.sh`                    | Retired fail-closed tombstone; performs no AWS action                                                           | Never; manage reviewed controls through Terraform |
| `scripts/sagemaker-killswitch.sh` | Retired fail-closed tombstone; runs no AWS command and exits 64                                                | Never; a working kill switch must deny `sagemaker:*` at the SageMaker execution role |

The other shell scripts (`deploy-label-studio.sh`, `deploy-lambda.sh`, `ecs-health.sh`, `ecs-tune.sh`,
`setup-lambda-iam.sh`, `scripts/setup-label-studio.sh`, `scripts/record-battery-green.sh`,
`infrastructure/terraform/ecs-surgical-nuke.sh`, …) each state their contract in their own header
comment.

## Configuration files

| File                        | Purpose                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `.deploy.env.example`       | Deployment identities read by the shell tools: account/Region, ECS cluster and service, ECR repositories, ALB, RDS, log group, domain, CloudFront distribution, root-admin e-mail, Secrets Manager prefix, CV Lambda. Copy to `.deploy.env` (gitignored). |
| `infrastructure/terraform/` | Full AWS infrastructure as code. Copy `backend.hcl.example` outside the repo, set untracked `terraform.tfvars` (start from `terraform.tfvars.example`), and initialize with `-backend-config=/owner/private/beaver-backend.hcl`. |
| `.env.example`              | The app's own environment variables (local development and the container); the server validates its contract at boot in `src/lib/env.ts`. |

## Infrastructure (Terraform)

| Resource        | Config                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------ |
| VPC             | 10.0.0.0/16, 2 public + 2 private subnets, NAT gateway                                     |
| ECS Fargate     | 2 vCPU / 4 GB app, 8 vCPU / 16 GB processing tasks; app capacity capped by `ecs_max_count` (default 1); maintenance-worker and singleton migrator task definitions |
| ALB             | HTTPS with ACM cert, policy `ELBSecurityPolicy-TLS13-1-2-2021-06` (TLS 1.3 and 1.2), 300 s idle, circuit-breaker rollback |
| RDS             | PostgreSQL 16, db.t4g.medium, 50 GB gp3, encrypted, 7-day backups; Multi-AZ when `environment = "production"` (the default) |
| S3 + CloudFront | Versioned private bucket; app-gated reads; CloudFront viewer 404 with no OAC S3 read grant |
| ECR             | 4 repositories (app, cpu-pipeline, yolo-pipeline, cv-lambda), scan-on-push                 |
| Step Functions  | Blueprint processing orchestrator with retry/catch                                         |
| SageMaker       | Processing jobs for YOLO (ml.g4dn.xlarge GPU, on-demand)                                   |
| Lambda          | CV fan-out (symbol search, shape parse) from the `cv-lambda` image                         |
| SQS + EventBridge | Durable project-asset deletion queue fed by S3 events                                    |
| Label Studio    | Optional ECS service with EFS storage, behind the same ALB                                 |
| Secrets Manager | 9 secrets with a 7-day recovery window                                                     |
| Budgets / CloudWatch | Cost budget alarms; CloudWatch alarms; one-day private ALB access logs                |

WAF, GuardDuty and CloudTrail are owner-managed and are **not** created by this Terraform.

## Schema-change and first-deploy runbook (low level)

`deploy-aws.sh` drives the sequences below for you. They are documented here because they are the
safety contract the tools enforce, and because a schema change (`release --outage`) is a short
deliberate outage, not a rolling update. "P2" names the schema compatibility boundary introduced by
migration `0037`; `0032` is the oldest migration history the cutover accepts.


Before the first full apply against an existing data bucket, an owner must inventory its complete S3
notification subresource. Terraform's `aws_s3_bucket_notification` resource replaces that whole
subresource, not just the EventBridge field. Save the current configuration outside the repository
with owner-only permissions:

```bash
umask 077
aws s3api get-bucket-notification-configuration \
  --bucket "beaver-data-${AWS_ACCOUNT}" \
  --region "${AWS_REGION}" \
  > /owner/private/beaver-data-notification-before-terraform.json
```

Review and reconcile every `LambdaFunctionConfigurations`, `QueueConfigurations`,
`TopicConfigurations`, and `EventBridgeConfiguration` entry. The declared end state is
EventBridge-only; decide explicitly how every pre-existing target is retired or represented before
setting `acknowledge_beaver_data_notification_takeover = true` in reviewed, untracked Terraform
values. Its false default deliberately blocks takeover. Terraform enables EventBridge only after the
durable queue target and both delivery policies exist.

For an ordinary candidate deployment whose database is already exactly current, keep the old digest
while entering the exact outage tuple, create its local witness, and only then admit the candidate:

```bash
bash install_setup.sh
./deploy.sh publish                       # retain its candidate sha256 digest

# In untracked tfvars keep the CURRENT digest and set exactly 0/0/1, autoscaling
# false, and the maintenance schedule false; apply, drain, and observe 900 seconds.
terraform -chdir=infrastructure/terraform apply
./deploy.sh preflight-outage sha256:CURRENT_DIGEST sha256:CANDIDATE_DIGEST

# Change only to the CANDIDATE digest while the exact outage tuple remains; apply.
terraform -chdir=infrastructure/terraform apply
./deploy.sh bind-quiescent sha256:CANDIDATE_DIGEST

# Restore exactly 1/1/1 with autoscaling and the maintenance schedule true; apply.
terraform -chdir=infrastructure/terraform apply
./deploy.sh verify-restored sha256:CANDIDATE_DIGEST
```

If the candidate apply changes the schedule's `LastModificationDate`, wait another 900 seconds before
`bind-quiescent`. The witness's replay authority is the Terraform-managed writer-mode epoch exposed
on the canonical ECS service: it rotates on every live/outage transition but stays stable during the
candidate-only outage apply. The schedule timestamp is retained as supplemental audit evidence.
Immediately before `UpdateService`, `bind-quiescent` replaces the baseline proof with a short-lived
`candidate-admitted` receipt containing all four exact candidate task definitions, the pinned database
secret version, outage epoch, timestamps, and nonce. If the update response is ambiguous or the local
process stops, rerun `bind-quiescent` while the receipt is valid; it admits only the recorded baseline
or recorded candidate binding and converts to a nonexpiring receipt only after the candidate is proved
stable and quiescent.
`verify-restored` accepts only desired/running/minimum/maximum `1/1/1/1`; there is no count override.
`deploy.sh activate` is reserved for a same-digest configuration or secret restart and refuses to
change the service's image digest.

Do not use that activation sequence for a new empty RDS database or the first upgrade from the
durable `0032` checkpoint. A brand-new AWS account needs a two-stage repository bootstrap because
`deploy.sh publish` cannot push until Terraform has created ECR, while the full stack requires a real
published digest:

1. Configure the required Terraform values, including a reviewed
   `heartexlabs/label-studio@sha256:...` manifest digest. Set app desired/minimum to zero, disable
   autoscaling and the maintenance schedule, and give `beaver_app_image_digest` a syntactically valid
   temporary value (`sha256:` plus 64 zeroes).
2. Apply **only** `-target=aws_ecr_repository.beaver_app`. Never apply the full stack with the
   placeholder digest.
3. Run `./deploy.sh publish`, replace the placeholder with its printed digest, and run the full apply
   with exactly desired/minimum/maximum `0/0/1`, autoscaling disabled, and the maintenance schedule
   disabled.
4. Leave the new schedule disabled for the documented 900-second observation/drain interval, then
   run `BP_APP_IMAGE_DIGEST=sha256:... scripts/p2-schema-cutover.sh bootstrap-empty`. A first attempt's
   read-only readiness task accepts only zero migration history plus no objects in the `public`
   schema. It then writes a short-lived, owner-only `empty-bootstrap-armed` witness bound to the exact
   candidate task definitions, database-secret version, writer-mode epoch, timestamps, and nonce
   before it can launch the armed migrator. Only a retry with that still-valid witness may admit exact
   current history after an ambiguous success; it reuses the nonce-derived ECS client token to
   reconcile the same migration request. Every intermediate or otherwise divergent history is refused.
5. Restore exactly desired/minimum/maximum `1/1/1`, enable autoscaling and the maintenance schedule,
   apply, and run `BP_APP_IMAGE_DIGEST=sha256:... scripts/p2-schema-cutover.sh verify-restored`.
   The empty-database proof is the sole safe exception to the old-digest witness requirement.

Use the P2 cutover sequence below for an existing exact `0032`–`0038` history. Restore normal writer
counts only after `verify-restored` succeeds.

Terraform deliberately ignores the app service's `task_definition`: an apply registers the reviewed
digest for every process role but cannot roll the app. Only `deploy.sh activate` after its remote
migration-history check can restart the already-bound digest. A new digest is bound only by the
witness-backed zero-count cohort or the deliberate empty-database bootstrap.

The setup wizard prompts for: database URL, auth secrets, LLM API keys (Groq/Anthropic/OpenAI), AWS credentials, S3 bucket, CloudFront, Step Functions, SageMaker, and Label Studio. Re-run anytime to update configuration. Its schema command is an operator safety fence for loopback development databases only; it neither proves that a loopback/SSH-tunneled target is non-production nor mutates a cloud database.

Label Studio integration requires `LABEL_STUDIO_URL`, the server-only
`LABEL_STUDIO_API_KEY`, and a stable `LABEL_STUDIO_INSTANCE_ID`. Terraform
also requires an immutable `heartexlabs/label-studio@sha256:...` image reference; resolve and review
the upstream manifest digest rather than supplying a tag. Terraform
combines the EFS filesystem ID with `label_studio_instance_generation`; increment
that generation before restarting BlueprintParser whenever the Label Studio
database is reinitialized, replaced, or restored as a new logical instance,
even if EFS survives. Bootstrap email and password are consumed only by the
Label Studio container. The separate `root_admin_email` variable controls
BlueprintParser root-admin promotion and must never be sourced from the Label
Studio administrator.

Deployment admission also treats task values as exact identities, not merely present environment
variables. `DOMAIN`, `CLOUDFRONT_DISTRIBUTION_ID`, and the explicitly present `ROOT_ADMIN_EMAIL` come
from the owner-reviewed `.deploy.env`; an intentionally disabled root-admin email is represented by an
explicit empty value. App and maintenance definitions must share the validated
`LABEL_STUDIO_INSTANCE_ID`; all four roles must use the same version-pinned canonical
`DATABASE_URL` Secrets Manager value. The app accepts a varying YOLO digest only beneath the canonical
account/Region `beaver-yolo-pipeline` repository. Canonical HTTPS app/Label Studio/CloudFront
identities, the Step Functions ARN, SageMaker role, data bucket, Region, port, Lambda controls, and
role-specific allowlists are checked before any task is run or service is changed. The singleton
migrator has a dedicated ECS task role with no inline or attached permission policies.

## P2 schema and Label Studio cutover

Migration `0037` is a **writer-outage compatibility boundary**, not a rolling migration. It requires
zero legacy Label Studio sessions/intents and adds columns that every new writer must understand.
Application and worker startup now performs only an exact ordered Drizzle migration-history check
(timestamps and SQL hashes); it never migrates. This does not claim that arbitrary out-of-band DDL is
absent—routine helpers expose no DDL, and direct database authority remains break-glass.
`deploy.sh activate` runs that read-only history check remotely and refuses a pre-0038 database before it
updates the service. The app, CPU worker, maintenance worker, and singleton migrator task definitions
all use one ECR digest, so a delayed scheduled task cannot pull a newer mutable `latest` image.

Use this owner-run order for the first 0037/0038 deployment and for a simultaneous provider reset:

1. While the old provider is available, close labeling admission, retire every Label Studio session
   and pending provisioning intent, verify provider cleanup, and rotate historical bootstrap secrets.
2. Run `./deploy.sh publish` and retain both the currently bound and printed candidate
   `sha256:...` digests. Do not run `activate`.
3. With the **currently bound digest unchanged**, set untracked Terraform values to the exact outage
   tuple: `maintenance_worker_schedule_enabled = false`, `ecs_autoscaling_enabled = false`,
   `ecs_desired_count = 0`, `ecs_min_count = 0`, and `ecs_max_count = 1`. Apply and wait for the
   service to drain. Merely setting minimum/desired zero is insufficient because an unsuspended
   target-tracking policy can scale the service back out. If replacing the provider, also increment
   `label_studio_instance_generation` in this writer-disabled plan.
4. Leave the schedule disabled for at least 900 seconds (its declared 600-second retry/event-age
   window plus a 300-second ECS consistency window), then create the baseline witness while all four
   latest definitions and the zero-count service still use the old digest:

   ```bash
   BP_APP_IMAGE_DIGEST=sha256:CURRENT_DIGEST \
   BP_CANDIDATE_IMAGE_DIGEST=sha256:CANDIDATE_DIGEST \
     scripts/p2-schema-cutover.sh preflight-outage
   ```

5. Change only `beaver_app_image_digest` to the candidate while preserving the exact outage tuple and
   apply. If this changes the schedule's `LastModificationDate`, observe another 900 seconds. Then run:

   ```bash
   BP_APP_IMAGE_DIGEST=sha256:CANDIDATE_DIGEST scripts/p2-schema-cutover.sh run
   ```

   `run` refuses a missing, malformed, expired, replayed-epoch, wrong-candidate, or wrong-identity
   owner-local witness, and proves that
   the zero-count service remains bound to its witnessed old revision before admitting the candidate.
   The Step Functions ARN and all task/schedule family identities are canonical and are not caller
   selectable. The cohort fails unless the schedule is disabled and old enough to drain delayed
   delivery, app desired/minimum/running/pending counts are zero, dynamic-in/dynamic-out/scheduled
   autoscaling are all suspended, there are no live app/CPU/maintenance/migrator tasks (including
   stopping tasks), there are no running Step Functions executions, all four latest task definitions
   use the candidate digest and exact role contracts, and both Step Functions and Scheduler target
   their exact revisions in the canonical cluster. `run` accepts only exact full-history prefixes from
   `0032` through `0038`, rejects invalid legacy company storage namespaces/paths, waits a fixed
   additional 300-second observation interval, and repeats the complete launcher preflight. It then
   runs a separate read-only database-readiness task. For a pre-0037 history that task also requires
   zero legacy sessions/intents; an exact 0037 or 0038 retry may legitimately contain new-protocol
   rows. After readiness passes, the tool first persists the short-lived full-candidate
   `candidate-admitted` receipt, then binds the app revision at desired zero, proves it
   stable, and deregisters every other ACTIVE revision in all four writer families. It observes the
   fixed 600-second ECS deregistration enforcement window, re-verifies the retained ACTIVE sets,
   stable zero-count binding, absence of writer tasks, and the full launcher preflight, then passes the
   migration mode as a one-run ECS override. The request uses a deterministic client token derived
   from the admitted nonce. Within ECS's token lifetime—the lower of 24 hours and the task lifetime
   plus one hour—rerunning `run` with the still-valid receipt reconciles the same RunTask after an
   ambiguous response. A still-valid six-hour receipt can outlive that ECS token; a later retry may
   launch the same guarded request again, so the locked, no-permission migrator repeats the history,
   namespace/path, and conditional legacy-row checks before any SQL and treats exact-current history
   as a no-op. Do not restore writers if RunTask or its waiter has an ambiguous outcome; use the
   printed client token/started-by value to verify tasks and migration history while the outage remains
   in force.

6. With the candidate digest unchanged, restore the exact live tuple:
   `ecs_desired_count = 1`, `ecs_min_count = 1`, `ecs_max_count = 1`,
   `maintenance_worker_schedule_enabled = true`, and `ecs_autoscaling_enabled = true`. Apply, wait for
   ECS stability, then run
   `BP_APP_IMAGE_DIGEST=sha256:CANDIDATE_DIGEST scripts/p2-schema-cutover.sh verify-restored`.
   Reopen labeling only after it consumes the bound witness successfully and provider generation is
   verified. Never use `deploy.sh activate` for the initial boundary.

The cutover tool can observe the application-owned service, task families, schedule, and state
machine, but it cannot revoke unrelated IAM principals. During the bounded outage, operators must
also prevent external principals from starting the Step Functions state machine or standalone tasks.
After the boundary, never re-register or directly launch a deregistered pre-boundary task definition:
those images predate exact schema admission. `ecs-tune.sh` and `scripts/cost-control.sh` are read-only;
they cannot scale or restore the app. Change writer counts only through reviewed Terraform, use
the witness-backed `preflight-outage` / `bind-quiescent` / `verify-restored` path for every candidate
digest, and reserve `deploy.sh activate` for a same-digest configuration or secret restart. Complete
`verify-restored` after the P2 outage. A deny on the state-machine execution role does not block caller authorization to start an
execution, so the cost report never labels Step Functions as blocked. Direct ECS Exec/database DDL
remains break-glass owner authority and is intentionally absent from `root_admin.sh`.

Deferred deployment reproducibility item: the Terraform AWS provider is still constrained by
`~> 5.0` while `.terraform.lock.hcl` is not tracked. Treat CI/provider resolution as moving until a
scrubbed, reviewed dependency lock is committed in the planned infrastructure hardening pass.

Label Studio task images use opaque, revocable application URLs because the provider cannot add a
BlueprintParser authorization header to an imported image request. The bearer is consequently in the
URL query and the shared ALB records it in the request target before application redaction is possible.
Treat ALB access logs as secrets: Terraform writes them only to the dedicated
`beaver-alb-access-logs-*` bucket, blocks public access, enforces bucket ownership and TLS, uses the
ALB-compatible SSE-S3 encryption mode, restricts delivery to the named `beaver-alb` in this account
and Region, and expires the `alb-logs/` prefix after one day (the shortest S3 age-based lifecycle
period;
deletion is asynchronous). Do not grant routine operators `s3:GetObject`/`s3:ListBucket` on this
bucket or paste request targets into tickets. A copied bearer remains usable until its grant is
revoked by Label Studio session retirement; lifecycle deletion limits log persistence but is not
revocation.

## First private CloudFront cutover (owner-run once)

This is a deliberate one-time owner operation, not a routine deploy.

1. Review a targeted plan and apply only `aws_cloudfront_function.beaver_public_snapshot_gate` and `aws_cloudfront_distribution.beaver` plus their required dependencies. Confirm that `aws_s3_bucket_policy.beaver_data` is absent from that apply.
2. Wait until the distribution status is `Deployed`.
3. Probe known legacy cached asset URLs and require an HTTP 404 with no asset bytes.
4. Create a `/*` CloudFront invalidation and wait for it to complete.
5. Review and run the full Terraform plan/apply, re-read the live data-bucket policy, and repeat the 404 probes.

Never add a reopen/public flag to this gate. Any future public edge delivery requires a separately reviewed publication and revocation protocol; the retired `hardening.sh` is not a cutover path.
