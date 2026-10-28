#!/usr/bin/env bash
# prepush-check.sh — refuse to push anything that must not reach the public GitHub repository:
# model weights, private files, MasterFormat-derived data, real drawing text, and personal identities.
#
# The trained models under models/ (yolo_*.pt ≈137 MB each, tatr/model.safetensors) must never reach
# the public repository. They are untracked and ignored by the anchored `/models/` line in .gitignore;
# this script makes that (and the rules below) a checked invariant at push time. Nine checks, any hit
# is fatal:
#
#   1. INDEX    no tracked file under the top-level models/ or with a weights extension
#   2. IGNORE   .gitignore still carries the anchored `/models/` line (an un-anchored `models/`
#               once swallowed src/app/api/admin/models/ — the anchor is load-bearing both ways)
#   3. HISTORY  no commit reachable from any ref being pushed ever added such a file
#   4. SIZE     no blob reachable from any ref being pushed exceeds 50 MB — catches a weight file
#               renamed to dodge check 3 (GitHub rejects 100 MB outright)
#   5. PRIVATE  none of the named files below is tracked or was ever added in the pushed history.
#               The eval/csi ones quoted a client's drawings and were removed from history; their
#               copies live outside the repo and are NOT ignored here, so a careless `git add eval/csi`
#               would bring them back.
#               src/data/csi-kb.json, the CSI v2 lookup table built from the MasterFormat PDF, is kept
#               off the public repo (owner ruling D1, 2026-10-20). It is "gitignored but shipped":
#               built locally by eval/csi/build-kb-v2.ts, baked into the image from the working tree.
#               src/lib/__tests__/fixtures/csi-v2/mf-pages-excerpt.json, the CSI v2 parser test fixture
#               (verbatim MasterFormat PDF page text), gets the same treatment: regenerated locally by
#               eval/csi/mf-fixture-extract.ts, NOT shipped in the image.
#   6. MF-IGNORE each private MasterFormat file's anchored ignore line is in .gitignore — both in the
#               working tree (this clone's `git add -A`) and in the COMMITTED .gitignore of every
#               pushed tip that carries that file's generator:
#                 /src/data/csi-kb.json                                    <- eval/csi/build-kb-v2.ts
#                 /src/lib/__tests__/fixtures/csi-v2/mf-pages-excerpt.json <- eval/csi/mf-fixture-extract.ts
#               The second half is what GitHub receives: without it a fresh clone that runs the
#               generator stages the file on `git add -A`, and hooks are not cloned, so check 5
#               would not run there. Tips without a generator (older branches) cannot produce that
#               file and are not held to its line.
#   7. FIXTURES parse-engine test data stays synthetic (no real drawing text in this repository).
#               In the index and in every path added in the pushed history:
#                 src/lib/parse-engine/**/__fixtures__/**  only *.synthetic.json
#                 eval/parse-engine/**                     only intended-diffs.md, baseline.json, profile.json,
#                                                          capabilities/<name>.json
#                 scripts/parse-engine-fixtures/**         only *.ts (the generator and its layouts; a real
#                                                          slice dropped next to synthesize.ts is refused)
#               Real page slices and their goldens live outside the repository.
#   8. AUTHORS  every commit NEW to the remote (the pushed range; in manual mode every local branch
#               minus what any remote-tracking ref already has) carries an allowlisted author AND
#               committer e-mail and name (ALLOWED_EMAILS / ALLOWED_NAMES below, plus any
#               `git config --add prepush.allowedEmail <addr>` / `prepush.allowedName <name>` set in
#               this clone). Only the short SHA and the failing field are printed, never the identity.
#   9. PRIVATE-TERMS optional list of private identifiers, one literal per line (blank and # lines
#               ignored), outside the repository: $BP_PREPUSH_TERMS_FILE, default
#               <toplevel>/../../gitignore/projects/github_publish/forbidden-terms.txt. Each line is
#               matched case-insensitively against the same range as check 8: every added line of every
#               commit's diff (so a term added and later deleted is still refused), every added or
#               renamed path, every commit message and identity. Binary diffs are not scanned (like
#               `grep -I`). Only "<sha>  <path>" is printed, never the term. A missing list is a WARN
#               (public clones have none); BP_PREPUSH_REQUIRE_TERMS=1 makes it fatal.
#
# Usage
#   scripts/prepush-check.sh              check every local branch (what a manual pre-push run wants)
#   scripts/prepush-check.sh --install    install this clone's git pre-push AND pre-commit hooks (idempotent;
#                                         refuses to overwrite a hook it did not write)
#   scripts/prepush-check.sh --pre-commit (the pre-commit hook) refuse a commit whose author or committer
#                                         identity (`git var GIT_AUTHOR_IDENT` / GIT_COMMITTER_IDENT, which
#                                         honour --author, -c user.email and the GIT_* variables) is not
#                                         allowlisted. --no-verify, rebase, cherry-pick and am skip it;
#                                         check 8 at push time is the real gate.
#   (as a hook) git feeds "<local ref> <local sha> <remote ref> <remote sha>" lines on stdin and
#   only the refs being pushed are checked, minus what the remote already has.
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
eval/csi/GRANULARITY_RUBRIC.md
src/data/csi-kb.json
src/lib/__tests__/fixtures/csi-v2/mf-pages-excerpt.json'
# Check 6: "<anchored .gitignore line> <generator path>", one pair per line (no spaces in either).
MF_IGNORE_PAIRS='/src/data/csi-kb.json eval/csi/build-kb-v2.ts
/src/lib/__tests__/fixtures/csi-v2/mf-pages-excerpt.json eval/csi/mf-fixture-extract.ts'

# Checks 8 and the pre-commit hook: the only identities allowed in pushed commits (author AND committer).
# GitHub noreply addresses only — a personal mailbox in commit metadata is public forever. A contributor
# adds their own noreply identity per clone: git config --add prepush.allowedEmail <addr> (and allowedName).
ALLOWED_EMAILS='goodmorningcoffee@users.noreply.github.com
48738308+goodmorningcoffee@users.noreply.github.com
251408002+deliciousnoodles@users.noreply.github.com'
ALLOWED_NAMES='goodmorningcoffee
deliciousnoodles'

ZERO_SHA='0000000000000000000000000000000000000000'
US=$(printf '\037')   # field separator for git --format output: never appears in a name, path or message line

root=$(git rev-parse --show-toplevel) || { echo "prepush-check: not inside a git repository" >&2; exit 2; }
cd "${root}"

# "|a|b|c|" from a built-in newline list plus this clone's `git config --get-all <key>` values.
# $3 = "lower" folds case (e-mail addresses compare case-insensitively).
allow_list() {
  { printf '%s\n' "$1"; git config --get-all "$2" 2>/dev/null || true; } \
    | awk -v fold="${3:-}" 'NF { printf "|%s", (fold == "lower" ? tolower($0) : $0) } END { print "|" }'
}
allowed_emails=$(allow_list "${ALLOWED_EMAILS}" prepush.allowedEmail lower)
allowed_names=$(allow_list "${ALLOWED_NAMES}" prepush.allowedName)

if [ "${1:-}" = "--pre-commit" ]; then
  for v in GIT_AUTHOR_IDENT GIT_COMMITTER_IDENT; do
    ident=$(git var "${v}" 2>/dev/null) || { echo "prepush-check: pre-commit — git cannot determine ${v}; set user.name and user.email" >&2; exit 1; }
    name=${ident%% <*}
    email=${ident#*<}; email=${email%%>*}
    email=$(printf '%s' "${email}" | tr '[:upper:]' '[:lower:]')
    case "${allowed_emails}" in
      *"|${email}|"*) ;;
      *) echo "prepush-check: pre-commit — ${v} e-mail is not allowlisted; set user.email to your GitHub noreply address (or add it: git config --add prepush.allowedEmail <addr>)" >&2; exit 1 ;;
    esac
    case "${allowed_names}" in
      *"|${name}|"*) ;;
      *) echo "prepush-check: pre-commit — ${v} name is not allowlisted; set user.name to your GitHub login (or add it: git config --add prepush.allowedName <name>)" >&2; exit 1 ;;
    esac
  done
  exit 0
fi

if [ "${1:-}" = "--install" ]; then
  hooks=$(git rev-parse --git-path hooks)
  mkdir -p "${hooks}"
  for h in pre-push pre-commit; do
    if [ -e "${hooks}/${h}" ] && ! grep -q 'scripts/prepush-check.sh' "${hooks}/${h}"; then
      echo "prepush-check: ${hooks}/${h} exists and is not ours — refusing to overwrite it" >&2
      exit 2
    fi
  done
  printf '#!/usr/bin/env bash\n# installed by scripts/prepush-check.sh --install\nexec "$(git rev-parse --show-toplevel)/scripts/prepush-check.sh" "$@"\n' >"${hooks}/pre-push"
  # Hooks are shared by every worktree of this clone; a branch whose script predates --pre-commit
  # must not fall through to a full manual pre-push run on every commit, hence the grep.
  printf '#!/usr/bin/env bash\n# installed by scripts/prepush-check.sh --install\ns="$(git rev-parse --show-toplevel)/scripts/prepush-check.sh"\ngrep -q -e "--pre-commit" "$s" 2>/dev/null || exit 0\nexec "$s" --pre-commit\n' >"${hooks}/pre-commit"
  chmod +x "${hooks}/pre-push" "${hooks}/pre-commit"
  echo "prepush-check: installed ${hooks}/pre-push and ${hooks}/pre-commit"
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

# 6a. MF-IGNORE, working tree (run here, next to its sibling; 6b needs the pushed tips, below)
while read -r ignore_line _generator; do
  [ -n "${ignore_line}" ] || continue
  grep -qxF "${ignore_line}" .gitignore 2>/dev/null || fail ".gitignore no longer carries the anchored line '${ignore_line}'"
done <<EOF_PAIRS
${MF_IGNORE_PAIRS}
EOF_PAIRS

# Which commits are being pushed? Hook mode reads ref lines from stdin; otherwise every local branch.
# remote_excl: "^<sha>" for every remote sha git names that exists here — what the remote already has
# is not new (checks 8 and 9 also exclude every remote-tracking ref via --not --remotes).
tips=""
remote_excl=""
if [ ! -t 0 ]; then
  while read -r _local_ref local_sha _remote_ref remote_sha; do
    [ -n "${local_sha:-}" ] || continue
    [ "${local_sha}" = "${ZERO_SHA}" ] && continue   # a branch deletion pushes nothing
    tips="${tips} ${local_sha}"
    if [ -n "${remote_sha:-}" ] && [ "${remote_sha}" != "${ZERO_SHA}" ] && git cat-file -e "${remote_sha}^{commit}" 2>/dev/null; then
      remote_excl="${remote_excl} ^${remote_sha}"
    fi
  done
fi
if [ -z "${tips}" ]; then
  tips=$(git for-each-ref --format='%(objectname)' refs/heads/ | tr '\n' ' ')
fi
[ -n "${tips}" ] || { echo "prepush-check: nothing to check"; exit 0; }

# 6b. MF-IGNORE, committed — the .gitignore GitHub will receive, at every pushed tip that has the
# file's generator. Matched with `case`, not `git show | grep -q`: grep -q exits at the first hit,
# git show takes SIGPIPE, and pipefail would turn a present line into a failure. The pairs are read
# on fd 3 so nothing inside the loop can consume them.
while read -r ignore_line generator <&3; do
  [ -n "${ignore_line}" ] || continue
  unignored=""
  for t in ${tips}; do
    git cat-file -e "${t}:${generator}" 2>/dev/null || continue
    committed=$(git show "${t}:.gitignore" 2>/dev/null || true)
    case "
${committed}
" in
      *"
${ignore_line}
"*) ;;
      *) unignored="${unignored}    $(git rev-parse --short=12 "${t}")
" ;;
    esac
  done
  if [ -n "${unignored}" ]; then
    fail "pushed tips carry ${generator} but their COMMITTED .gitignore lacks '${ignore_line}' (a working-tree line does not reach GitHub — commit .gitignore):"
    printf '%s' "${unignored}" >&2
  fi
done 3<<EOF_PAIRS
${MF_IGNORE_PAIRS}
EOF_PAIRS

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
  fail "private files (client-drawing text scrubbed 2026-10-03; MasterFormat KB, ruling D1 2026-10-20; MasterFormat parser fixture, ruling 2026-10-20) are back in the index or the pushed history:"
  printf '%s\n' "${private_hits}" | sed 's/^/    /' >&2
fi

# 7. FIXTURES — same sources as check 5: the index plus every path added in the pushed history.
# shellcheck disable=SC2086
fixture_hits=$( { git ls-files; git log -m --diff-filter=AR --name-only --format= ${tips}; } \
  | awk '
      /^src\/lib\/parse-engine\/(.*\/)?__fixtures__\// { if ($0 !~ /\.synthetic\.json$/ && !seen[$0]++) print; next }
      /^eval\/parse-engine\// { if ($0 !~ /^eval\/parse-engine\/(intended-diffs\.md|baseline\.json|profile\.json|capabilities\/[^\/]+\.json)$/ && !seen[$0]++) print; next }
      /^scripts\/parse-engine-fixtures\// { if ($0 !~ /\.ts$/ && !seen[$0]++) print }')
if [ -n "${fixture_hits}" ]; then
  fail "parse-engine fixtures must be *.synthetic.json, eval/parse-engine/ holds only intended-diffs.md, baseline.json, profile.json, capabilities/*.json, and scripts/parse-engine-fixtures/ only *.ts (real slices belong in the private docs repo):"
  printf '%s\n' "${fixture_hits}" | sed 's/^/    /' >&2
fi

# 8. AUTHORS — every commit new to the remote: allowlisted author and committer, e-mail and name.
# The identity itself is never printed, so the output stays safe to paste.
# shellcheck disable=SC2086
id_hits=$(git log --format="%h${US}%an${US}%ae${US}%cn${US}%ce" ${tips} ${remote_excl} --not --remotes \
  | awk -F "${US}" -v ok_e="${allowed_emails}" -v ok_n="${allowed_names}" '
      { bad = "" }
      index(ok_e, "|" tolower($3) "|") == 0 { bad = bad " author-email" }
      index(ok_e, "|" tolower($5) "|") == 0 { bad = bad " committer-email" }
      index(ok_n, "|" $2 "|") == 0 { bad = bad " author-name" }
      index(ok_n, "|" $4 "|") == 0 { bad = bad " committer-name" }
      bad != "" { print $1 bad }')
if [ -n "${id_hits}" ]; then
  fail "commits with a non-allowlisted identity (rewrite them with git filter-repo --mailmap before the first push; never force-push over public history):"
  printf '%s\n' "${id_hits}" | sed 's/^/    /' >&2
fi

# 9. PRIVATE-TERMS — the optional out-of-repo list, against every added line, path, message and identity
# in the same range as check 8. awk reads the list first (NR == FNR), then the log on stdin.
terms_file="${BP_PREPUSH_TERMS_FILE:-${root}/../../gitignore/projects/github_publish/forbidden-terms.txt}"
terms_note=""
if [ -r "${terms_file}" ] && [ -f "${terms_file}" ]; then
  term_count=$(awk '{ sub(/\r$/, ""); sub(/^[ \t]+/, ""); sub(/[ \t]+$/, "") } NF && !/^#/ { n++ } END { print n + 0 }' "${terms_file}")
  if [ "${term_count}" -eq 0 ]; then
    echo "prepush-check: WARN — the private-terms list has no terms; check 9 scanned nothing" >&2
    terms_note="; private-terms list empty (WARN)"
  else
    # shellcheck disable=SC2086
    term_hits=$(git log -p --cc --no-ext-diff --no-textconv --no-color \
        --format="${US}%h%n%an <%ae> %cn <%ce>%n%B" ${tips} ${remote_excl} --not --remotes \
      | awk -v US="${US}" '
          function hit(where,   i, l) {
            l = tolower($0)
            for (i = 1; i <= n; i++) if (index(l, t[i])) { if (!seen[commit "  " where]++) print commit "  " where; return }
          }
          NR == FNR { sub(/\r$/, ""); sub(/^[ \t]+/, ""); sub(/[ \t]+$/, ""); if (NF && !/^#/) t[++n] = tolower($0); next }
          substr($0, 1, 1) == US { commit = substr($0, 2); state = "msg"; next }
          /^diff --(git|cc) / { state = "hdr"; cc = ($0 ~ /^diff --cc /); path = $0; sub(/^diff --(git|cc) /, "", path); hit(path); next }
          state == "msg" { hit("(commit message or identity)"); next }
          state == "hdr" && /^@@/ { state = "hunk"; next }
          state == "hdr" && /^(\+\+\+ b\/|rename to |copy to )/ { p = $0; sub(/^(\+\+\+ b\/|rename to |copy to )/, "", p); path = p; hit(path); next }
          state == "hunk" && /^@@/ { next }
          state == "hunk" && !cc && substr($0, 1, 1) == "+" { hit(path); next }
          state == "hunk" && cc && substr($0, 1, 2) ~ /\+/ { hit(path); next }
        ' "${terms_file}" -)
    if [ -n "${term_hits}" ]; then
      fail "private terms (from the out-of-repo list) appear in the pushed range — rewrite history (git filter-repo --replace-text) before pushing:"
      printf '%s\n' "${term_hits}" | sed 's/^/    /' >&2
    fi
    terms_note="; no private term (${term_count} in the list) in any pushed diff, path, message or identity"
  fi
elif [ "${BP_PREPUSH_REQUIRE_TERMS:-}" = "1" ]; then
  fail "BP_PREPUSH_REQUIRE_TERMS=1 but the private-terms list is missing or unreadable: ${terms_file}"
else
  echo "prepush-check: WARN — no private-terms list at ${terms_file}; check 9 skipped (BP_PREPUSH_REQUIRE_TERMS=1 makes this fatal)" >&2
  terms_note="; private-terms check skipped (no list, WARN)"
fi

if [ "${failures}" -ne 0 ]; then
  echo "prepush-check: ${failures} check(s) failed — push refused. Nothing private goes to GitHub." >&2
  exit 1
fi
echo "prepush-check: clean — parse-engine fixtures synthetic-only; no model weights, client-text files, MasterFormat KB (src/data/csi-kb.json) or MasterFormat parser fixture (src/lib/__tests__/fixtures/csi-v2/mf-pages-excerpt.json) tracked or added in history, no blob over 50 MB; /models/, /src/data/csi-kb.json and /src/lib/__tests__/fixtures/csi-v2/mf-pages-excerpt.json still ignored (each committed so at every pushed tip with its generator); every new commit's author and committer allowlisted${terms_note}"
