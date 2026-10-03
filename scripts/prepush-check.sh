#!/usr/bin/env bash
# prepush-check.sh — refuse to push anything that would put model weights on GitHub.
#
# The trained models under models/ (yolo_*.pt ≈137 MB each, tatr/model.safetensors) are a real
# investment and must never reach the public repository. Today they are untracked and ignored by
# the anchored `/models/` line in .gitignore; this script makes that a checked invariant at push
# time instead of a remembered one. Four checks, any hit is fatal:
#
#   1. INDEX    no tracked file under the top-level models/ or with a weights extension
#   2. IGNORE   .gitignore still carries the anchored `/models/` line (an un-anchored `models/`
#               once swallowed src/app/api/admin/models/ — the anchor is load-bearing both ways)
#   3. HISTORY  no commit reachable from any ref being pushed ever added such a file
#   4. SIZE     no blob reachable from any ref being pushed exceeds 50 MB — catches a weight file
#               renamed to dodge check 3 (largest legitimate blob in history is 36 MB; GitHub
#               rejects 100 MB outright)
#
# Usage
#   scripts/prepush-check.sh            check every local branch (what a manual pre-push run wants)
#   scripts/prepush-check.sh --install  install as this clone's git pre-push hook (idempotent)
#   (as a hook) git feeds "<local ref> <local sha> <remote ref> <remote sha>" lines on stdin and
#   only the refs being pushed are checked.
#
# Runs on stock macOS bash 3.2: no ${var,,}, no mapfile, no associative arrays.
set -eu

# Anchored to the TOP-LEVEL models/ on purpose: src/app/api/admin/models/ is a source directory
# (the same ambiguity that once gitignored it). Weights elsewhere are caught by extension or size.
WEIGHT_RE='^models/|\.(pt|pth|safetensors|onnx|ckpt|weights|h5|pb|tflite|pkl|pickle)$'
MAX_BLOB_BYTES=$((50 * 1024 * 1024))
ZERO_SHA='0000000000000000000000000000000000000000'

root=$(git rev-parse --show-toplevel) || { echo "prepush-check: not inside a git repository" >&2; exit 2; }
cd "${root}"

if [ "${1:-}" = "--install" ]; then
  hooks=$(git rev-parse --git-path hooks)
  mkdir -p "${hooks}"
  hook="${hooks}/pre-push"
  if [ -e "${hook}" ] && ! grep -q 'scripts/prepush-check.sh' "${hook}"; then
    echo "prepush-check: ${hook} exists and is not ours — refusing to overwrite it" >&2
    exit 2
  fi
  printf '#!/usr/bin/env bash\n# installed by scripts/prepush-check.sh --install\nexec "$(git rev-parse --show-toplevel)/scripts/prepush-check.sh" "$@"\n' >"${hook}"
  chmod +x "${hook}"
  echo "prepush-check: installed ${hook}"
  exit 0
fi

failures=0
fail() { echo "prepush-check: FAIL — $1" >&2; failures=$((failures + 1)); }

# 1. INDEX
tracked=$(git ls-files | grep -iE "${WEIGHT_RE}" || true)
if [ -n "${tracked}" ]; then
  fail "tracked files that look like model weights:"
  printf '%s\n' "${tracked}" | sed 's/^/    /' >&2
fi

# 2. IGNORE
grep -qx '/models/' .gitignore 2>/dev/null || fail ".gitignore no longer carries the anchored line '/models/'"

# Which commits are being pushed? Hook mode reads ref lines from stdin; otherwise every local branch.
tips=""
if [ ! -t 0 ]; then
  while read -r _local_ref local_sha _remote_ref _remote_sha; do
    [ -n "${local_sha:-}" ] || continue
    [ "${local_sha}" = "${ZERO_SHA}" ] && continue   # a branch deletion pushes nothing
    tips="${tips} ${local_sha}"
  done
fi
if [ -z "${tips}" ]; then
  tips=$(git for-each-ref --format='%(objectname)' refs/heads/ | tr '\n' ' ')
fi
[ -n "${tips}" ] || { echo "prepush-check: nothing to check"; exit 0; }

# 3. HISTORY — every file ever added or renamed-in by any commit reachable from the pushed tips.
# Commit lines are marked with a unit separator (0x1f) so a path can never be mistaken for one;
# the path alone is matched (tolower: BSD awk has no case-insensitive flag).
# shellcheck disable=SC2086
history_hits=$(git log --diff-filter=AR --name-only --format='%x1f%h' ${tips} \
  | awk -v re="${WEIGHT_RE}" '
      /^\037/ { commit = substr($0, 2); next }
      NF && tolower($0) ~ re { print commit "  " $0 }')
if [ -n "${history_hits}" ]; then
  fail "commits in the push add files that look like model weights:"
  printf '%s\n' "${history_hits}" | sed 's/^/    /' >&2
fi

# 4. SIZE — any blob reachable from the pushed tips above the ceiling, whatever its name.
# shellcheck disable=SC2086
big_blobs=$(git rev-list --objects ${tips} \
  | git cat-file --batch-check='%(objecttype) %(objectsize) %(rest)' \
  | awk -v max="${MAX_BLOB_BYTES}" '$1=="blob" && $2>max {printf "%.1f MB  %s\n", $2/1048576, substr($0, index($0,$3))}')
if [ -n "${big_blobs}" ]; then
  fail "blobs over $((MAX_BLOB_BYTES / 1048576)) MB reachable from the push (a renamed weight file looks like this):"
  printf '%s\n' "${big_blobs}" | sed 's/^/    /' >&2
fi

if [ "${failures}" -ne 0 ]; then
  echo "prepush-check: ${failures} check(s) failed — push refused. The trained models never go to GitHub." >&2
  exit 1
fi
echo "prepush-check: clean — no model weights tracked, added in history, or hiding as a large blob; /models/ still ignored"
