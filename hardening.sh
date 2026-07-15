#!/usr/bin/env bash
set -euo pipefail

# RETIRED SECURITY BOUNDARY
#
# This file intentionally remains as an executable tombstone because older
# operator notes and shell history may still invoke ./hardening.sh. The former
# implementation made imperative, partially best-effort AWS mutations outside
# Terraform. In particular, it replaced the canonical project-data bucket
# policy while installing CloudTrail permissions and could print a successful
# summary after individual controls failed. Either behavior can silently remove
# private-asset defenses or create unreviewed infrastructure drift.
#
# Keep this script side-effect-free. Security infrastructure changes must be
# reviewed in infrastructure/terraform and applied only by the owner. Existing
# non-Terraform controls must be audited/imported explicitly; this tombstone
# must never try to repair them.

cat >&2 <<'MESSAGE'
hardening.sh is retired and made deliberately side-effect-free.

It performed non-atomic AWS mutations outside Terraform and could replace the
canonical project-data bucket policy. No AWS command has been run.

Review and manage security controls in infrastructure/terraform. Only the
owner may apply Terraform or make AWS changes.
MESSAGE

exit 64
