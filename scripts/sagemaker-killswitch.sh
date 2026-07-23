#!/usr/bin/env bash
set -euo pipefail

# RETIRED KILL SWITCH — deliberately side-effect-free
#
# [refactor jul23 P5.3 U2] This script formerly made a LIVE, unreviewed IAM
# mutation from the repo: `aws iam put-role-policy` / `aws iam delete-role-policy`
# on an ECS *task* role, to add/remove a `Deny sagemaker:*` inline policy
# (see git history for the previous implementation).
#
# It was doubly wrong and doubly dangerous:
#   1. Wrong PRINCIPAL. SageMaker processing jobs are launched by the
#      Step-Functions state machine and run under a SageMaker *execution* role
#      — NOT the app's ECS task role. A `Deny sagemaker:*` on the ECS task role
#      never stops a YOLO job, yet the script printed "SageMaker BLOCKED".
#   2. Wrong / stale NAME. The hard-coded default role was the legacy
#      `blueprintparser-ecs-task-role`, which does not exist under the canonical
#      `beaver-*` naming — so `put-role-policy` targeted a nonexistent resource
#      and silently no-op'd while still reporting success. (A local .deploy.env
#      could substitute `beaver-ecs-task-role`, but that is still the wrong
#      *principal* per (1), so the mutation was harmful either way.)
#
# Either way this was a real IAM write from an unreviewed shell script that
# *looked* like it worked — exactly the deploy/IAM-authority hazard the P2/P5
# closure removed from cost-control.sh and hardening.sh. It is retired here to
# the same fail-closed tombstone pattern: no AWS command is ever run, any
# invocation exits non-zero with owner guidance. Regression-locked by
# scripts/__tests__/sagemaker-killswitch.node-test.mjs (asserts exit 64 and,
# via a fake `aws` on PATH, that no aws command runs).
#
# OWNER FOLLOW-UP (IAM / Terraform, owner-only): a *working* SageMaker kill
# switch denies `sagemaker:*` at the CORRECT principal — the SageMaker execution
# role and/or the Step-Functions caller principal, under the canonical `beaver-*`
# names — and must be authored and reviewed in infrastructure/terraform and
# applied only by the owner. This tombstone must never try to repair it.

cat >&2 <<'MESSAGE'
sagemaker-killswitch.sh is retired and made deliberately side-effect-free.
No AWS command has been run.

It performed a live IAM put-role-policy mutation on the wrong principal (the ECS
task role, not the SageMaker execution role) against a stale role name, so it
could silently no-op while printing "SageMaker BLOCKED".

A working kill switch denies sagemaker:* at the SageMaker execution role and/or
the Step-Functions caller principal under the canonical beaver-* names. Author
and review it in infrastructure/terraform; only the owner may apply Terraform or
make IAM changes.
MESSAGE

exit 64
