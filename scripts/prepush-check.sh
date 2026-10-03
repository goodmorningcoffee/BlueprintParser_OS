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
#   5. PRIVATE  none of the named files below is tracked or was ever added in the pushed history.
#               They quote a client's drawings and were scrubbed from history on 2026-10-03; copies
#               live outside the repo (gitignore/projects/csi_private_eval/) and are NOT ignored
#               here, so a careless `git add eval/csi` would bring them back.
#
# Usage
#   scripts/prepush-check.sh            check every local branch (what a manual pre-push run wants)
#   scripts/prepush-check.sh --install  install as this clone's git pre-push hook (idempotent)
#   (as a hook) git feeds "<local ref> <local sha> <remote ref> <remote sha>" lines on stdin and
#   only the refs being pushed are checked.
#
# Runs on stock macOS bash 3.2: no ${var,,}, no mapfile, no associative arrays.
# pipefail: every check is a pipeline; a failing `git log`/`rev-list` must refuse the push, not print "clean".
set -euo pipefail
# Paths are printed raw (core.quotePath=false): a C-quoted "models/\303\261.pt" would slip past every regex.
git() { command git -c core.quotePath=false "$@"; }

# Anchored to the TOP-LEVEL models/ on purpose: src/app/api/admin/models/ is a source directory
# (the same ambiguity that once gitignored it). Weights elsewhere are caught by extension or size.
WEIGHT_RE='^models/|\.(pt|pth|safetensors|onnx|ckpt|weights|h5|pb|tflite|pkl|pickle|bin|npz|npy|gguf|ggml|joblib|keras|mlmodel|engine|trt|caffemodel|params)(\.(gz|bz2|xz|zst|zip))?$'
MAX_BLOB_BYTES=$((50 * 1024 * 1024))
# One path per line; matched exactly against tracked paths and paths added in the pushed history.
FORBIDDEN_PATHS='eval/csi/PILOT_ADJUDICATION_PACKET.md
eval/csi/gold-pilot.json
eval/csi/lexicon-gap.json
eval/csi/GRANULARITY_RUBRIC.md'

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
history_hits=$(git log -m --diff-filter=AR --name-only --format='%x1f%h' ${tips} \
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

# 5. PRIVATE — exact-path matches, in the index and in every commit reachable from the pushed tips.
private_hits=$( { git ls-files; git log -m --diff-filter=AR --name-only --format= ${tips}; } \
  | awk 'NR == FNR { forbidden[$0] = 1; next } ($0 in forbidden) && !seen[$0]++' <(printf '%s\n' "${FORBIDDEN_PATHS}") -)
if [ -n "${private_hits}" ]; then
  fail "files that quote client drawings (scrubbed 2026-10-03) are back in the index or the pushed history:"
  printf '%s\n' "${private_hits}" | sed 's/^/    /' >&2
fi

if [ "${failures}" -ne 0 ]; then
  echo "prepush-check: ${failures} check(s) failed — push refused. Nothing private goes to GitHub." >&2
  exit 1
fi
echo "prepush-check: clean — no model weights or client-text files tracked or added in history, no blob over 50 MB; /models/ still ignored"
