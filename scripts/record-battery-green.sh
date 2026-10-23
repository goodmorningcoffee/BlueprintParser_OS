#!/usr/bin/env bash
# [refactor jul23 P5.1-γ] record-battery-green: tiny marker-writer for the heavy landing battery.
#
# The heavy battery — `npm test` (vitest; needs the test DB + the .nvmrc node) and `npm run build` —
# cannot run fast/hermetically at deploy time. Root/owner runs it deliberately at the landing
# HEAD (P_LAND_PLAN L1: "Final HEAD battery green + recorded"). AFTER it is GREEN, run this
# script to record a HEAD-pinned marker that `deploy.sh preflight` asserts (without re-running
# the battery). If HEAD later moves, the marker goes stale and preflight fails closed until the
# battery is re-run and re-recorded.
#
# This script does NOT run the battery — it only records that you did. Run it only when the
# battery is actually green at the current HEAD.
#
#   npm test && npm run build   # (owner/root, in a node-20 env with the test DB)
#   scripts/record-battery-green.sh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/ecs-schema-tools.sh
source "${PROJECT_DIR}/scripts/lib/ecs-schema-tools.sh"
# shellcheck source=scripts/lib/deploy-state.sh
source "${PROJECT_DIR}/scripts/lib/deploy-state.sh"
DEPLOY_ENV_FILE="${BP_DEPLOY_ENV_FILE:-${PROJECT_DIR}/.deploy.env}"
[ -f "${DEPLOY_ENV_FILE}" ] && source "${DEPLOY_ENV_FILE}"

[ "$#" -eq 0 ] || {
  echo "Usage: scripts/record-battery-green.sh" >&2
  echo "Run after 'npm test && npm run build' are GREEN at the current HEAD." >&2
  exit 64
}

bp_battery_green_write
