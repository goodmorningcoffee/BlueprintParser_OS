# Session 2026-04-18 — Post-ship bug triage + Docker build optimizations

Continuation of the 2026-04-17 Shape Parse session. Started with a code-reviewed plan of the six bugs/risks flagged in `notes.md:1179-1303`, then pivoted into Docker build-time optimization after a deploy revealed ~17min end-to-end deploy cycles.

## What Was Shipped This Session

### PR 1 — Lambda warnings plumbing + fanOut retry error check (DEPLOYED, VERIFIED IN PROD)

Closes the silent-fail gap where Shape Parse scanAll could return 0 keynotes with no user-visible diagnostic. Also hardens the fanOut retry path that previously swallowed `status === "error"` responses.

| File | Status | Description |
|------|--------|-------------|
| `scripts/lambda_handler.py` | MODIFIED | `worker_fn` contract now returns `(results, warnings)` tuple. `parse_worker` replaced by direct passthrough of `extract_keynotes_main`. `match_worker` returns empty warnings. `process_pages` accumulates `all_warnings` and surfaces via S3 JSON + handler return dict. Removed the outdated "warnings aren't plumbed through Lambda today" NOTE. |
| `src/lib/lambda-cv.ts` | MODIFIED | Extracted `assertLambdaOk(resp)` helper from inline L106-108 check. Applied to BOTH primary and retry invocations (fixes Bug B — retry no-error-check). `FanOutResult<T>` extended to include `warnings: string[]`. Both success and retry paths read `parsed.warnings` from S3 JSON and accumulate across batches. Removed the outdated NOTE at L132-136. |
| `src/app/api/shape-parse/route.ts` | MODIFIED | Lambda all-pages branch now destructures `warnings` from `fanOutShapeParse` and forwards in `NextResponse.json`, matching the shape the ECS fallback path already returned. |

**Verified in prod:** User deployed and ran Shape Parse on a multi-page blueprint. The previously-invisible diag warning surfaced in the DetectionPanel debug area: *"Shape Parse found 0 keynotes across 40 tiles (1200px, 150px overlap); image 8000x5333 @ scale 0.74, filters min_kn=14 max_kn=200. Pipeline (all tiles): 26413 text candidates, 64 shape candidates, 0 passed text-inside filter"* — exactly the message from `extract_keynotes.py:556-571` that used to be silently swallowed.

### PR 2 — pytest infrastructure + extract_keynotes test suite (SHIPPED)

First Python test suite in the repo. 5 tests, 0.22s run time.

| File | Status | Description |
|------|--------|-------------|
| `scripts/requirements-dev.txt` | CREATED | Dev-only Python deps — `pytest>=8.0`. Not shipped to Lambda (Dockerfile.lambda installs its own subset). |
| `scripts/conftest.py` | CREATED | Pytest fixtures. `small_blank_png` (800×800) for small-image path tests; `large_blank_png` (2500×2500) for tiled-path tests. Synthetic images generated via cv2 + numpy — no checked-in binary blobs. |
| `scripts/test_extract_keynotes.py` | CREATED | 5 regression tests: `test_returns_tuple` (lambda_handler contract gate), `test_small_image_takes_small_image_path` (distinguishes small vs tiled branch), `test_tiled_zero_keynotes_emits_warning` (the PR-1 diag signal), `test_max_kn_is_200_at_scale_1`, `test_max_kn_does_not_scale_down` (explicit regression gate for the 2026-04-16 scale-down bug, verified by re-introducing the regression and watching the test fail with the exact value 60). |
| `scripts/extract_keynotes.py` | MODIFIED | Updated stale NOTE at L547-551 that said "this warning currently only reaches the UI on the ECS single-page path" — no longer true after PR 1. |

**Run locally:** `cd blueprintparser_2 && pip install -r scripts/requirements-dev.txt && pytest scripts/`

### PR 3 — DetectionPanel extraction + co-located perf fixes (SHIPPED)

Shrinks DetectionPanel.tsx and isolates Shape Parse state from the tableParseRegion bleed. Fixes the three perf issues flagged in the same-file scan.

| File | Status | Description |
|------|--------|-------------|
| `src/hooks/useShapeParseInteraction.ts` | CREATED | 123 LOC. Owns `loading`, `error`, `warnings`, `region`, `drawing` state + the effect that consumes `tableParseRegion` when the Shape tab is active. Exposes `setError`, `setRegion`, `setDrawing` for the Save handlers + region-clear buttons. Three action callbacks: `startRegionDraw`, `runOnPage`, `runOnAll`. Mechanical extraction — zero behavior change. |
| `src/components/viewer/DetectionPanel.tsx` | MODIFIED | **1073 → 988 LOC.** Hoisted `DETECTION_SOURCES` Set to module level (was `new Set([...])` in render body). Added `pageCountByTag` useMemo keyed on `yoloTags` — O(tags × instances) Set allocations per render replaced with an O(1) lookup. Missing `setShapeParseRegion` dep from the old L83 effect resolved automatically via hook ownership. Dropped 3 `useViewerStore` individual subscriptions (`tableParseRegion`, `setTableParseRegion`, `setTableParseStep`) — now owned by the hook. |

### Diagnostic experiment — MAX_DIM_BEFORE_DOWNSCALE 8000 → 12000 (SHIPPED, user testing ongoing)

Per the user's hypothesis that full-page Shape Parse never works because downscaling makes the text-inside filter too strict. 1-line change; gates the "BB sliding-window architecture" decision.

| File | Status | Description |
|------|--------|-------------|
| `scripts/extract_keynotes.py` | MODIFIED | L43: `MAX_DIM_BEFORE_DOWNSCALE = 8000` → `12000`. For a 10800px page this means `scale_factor = 1.00` (no downscale), matching the BB-path preprocessing characteristics that do work. |

**Decision gate:** if post-deploy the diag warning shows `@ scale 1.00` AND keynotes > 0, scale was the villain and a UI slider / config knob becomes the next move. If scale 1.00 still produces 0 keynotes, the user's sliding-window-BB architecture is the correct build next.

### Fix 2 — Docker: move `npm install drizzle-orm pg` to cacheable layer (SHIPPED)

Closes a silent 195s penalty on every deploy. The runtime `RUN npm install drizzle-orm pg 2>/dev/null || true` lived at the END of the runner stage, so every source change invalidated it.

| File | Status | Description |
|------|--------|-------------|
| `Dockerfile` | MODIFIED | Added `# syntax=docker/dockerfile:1.7` header. Inserted cacheable install layer AFTER the pip block and BEFORE the first `COPY --from=builder`, with `COPY package.json package-lock.json*` to pin versions and `--mount=type=cache,target=/root/.npm,sharing=locked` on the `npm install`. Deleted the old runtime install line. Dropped the `2>/dev/null \|\| true` — silent failures are exactly how this escaped scrutiny. |

### Fix 3 — BuildKit cache mounts across all three Dockerfiles + explicit BuildKit (SHIPPED)

| File | Status | Description |
|------|--------|-------------|
| `Dockerfile` | MODIFIED | `npm install` in deps stage: `--mount=type=cache,target=/root/.npm`. `npm run build` in builder: `--mount=type=cache,target=/app/.next/cache` (see Caveat below). Runner's chained apt+pip block: `--mount=type=cache,target=/root/.cache/pip` and **removed all `--no-cache-dir`** flags from `pip3 install` — the BuildKit mount lives outside the final layer so no image bloat. |
| `Dockerfile.lambda` | MODIFIED | Added syntax header + pip cache mount + removed `--no-cache-dir`. |
| `Dockerfile.yolo` | MODIFIED | Added syntax header + pip cache mount + removed `--no-cache-dir`. Biggest single-layer cold-build cost (~2GB torch+CUDA download) now reused across builds. |
| `deploy.sh` | MODIFIED | `export DOCKER_BUILDKIT=1` at top. |
| `deploy-lambda.sh` | MODIFIED | `export DOCKER_BUILDKIT=1` at top. |
| `deploy-yolo.sh` | MODIFIED | `export DOCKER_BUILDKIT=1` at top. |

**Caveat on the `.next/cache` mount:** after post-deploy inspection, discovered that Next.js 16 uses Turbopack by default for `next build`, and Turbopack doesn't persist its main build cache to `.next/cache/` the way webpack did. `.next/cache/` is only 636K and contains `.tsbuildinfo` + tiny metadata. The mount isn't wrong but saves much less than originally estimated. Leaving it in because tsbuildinfo caching is non-zero value.

### Fix 4 — Host-build refactor (ATTEMPTED, REVERTED)

**What was tried:** Move `npm run build` + `esbuild process-worker` out of the Dockerfile into a host-side `deploy.sh` step. Collapse the Dockerfile to a single-stage runner that COPYs prebuilt `.next/standalone` + `.next/static` from the host context. Goal was to eliminate a claimed ~490s Docker Desktop VFS tax by building on native Linux instead.

**Why it failed:** User's deploy on Mac (Intel, darwin-x64) errored at `npm run build` with `Cannot find module '../lightningcss.darwin-x64.node'`. Deeper problem even if that fixed: Mac host build produces Darwin native binaries (`lightningcss`, `@next/swc`, `bcrypt`, `sharp`) in `.next/standalone/node_modules/` that can't run in the Debian Linux runtime. The "7.4× VFS tax" claim was apples-to-oranges — compared Linux dev container (77s) to Docker-on-Mac (570s), never measured Mac host build.

**Reverted cleanly:** all 4 files restored. Fix 2 and Fix 3 remain in place — those are unambiguously correct independent of Fix 4.

| File | Status | Description |
|------|--------|-------------|
| `Dockerfile` | REVERTED | Back to 3-stage layout with Fix 2 + Fix 3 cache mounts intact. |
| `deploy.sh` | REVERTED | Host-build block removed. Simple `docker build --build-arg ...` restored. |
| `next.config.ts` | REVERTED | `outputFileTracingExcludes` removed. |
| `.dockerignore` | REVERTED | `.next/standalone` and `.next/static` re-include lines removed. |

### Memory lessons saved (for future sessions)

| File | Description |
|------|-------------|
| `~/.claude/.../memory/feedback_verify_before_infra_plans.md` | Read actual Dockerfile/deploy scripts/configs before proposing build or deploy optimizations. Inference from a partial Explore report missed the two real elephants (570s npm run build, 196s runtime drizzle install) on the first pass. |
| `~/.claude/.../memory/feedback_native_binaries_in_docker.md` | For Mac→Linux deploys, host `npm run build` is a trap. Native Node modules (lightningcss, bcrypt, sharp, swc) ship platform-specific `.node` binaries and a Mac-built standalone can't execute in Debian. Legitimate options: base-image split, Linux CI, or accept the Docker build tax. |

## Verified-But-Not-Shipped

Part of the bug-review sweep; confirmed but deliberately not changed this session.

| Item | File:Line | Why not fixed |
|------|-----------|---------------|
| Symbol-search "Batch N/M" out-of-order in NDJSON | `src/app/api/symbol-search/route.ts:188` | **Non-bug.** Consumer `SymbolSearchPanel.tsx:244` already uses monotonic `pageIndex`, not the batch string. Users see correct progress. Purely cosmetic for anyone reading raw NDJSON. |
| `AnnotationOverlay.tsx` ~300-line useEffect with 11+ deps | `AnnotationOverlay.tsx` (draw loop) | Flagged as stale-closure / over-rerun risk during DetectionPanel scan. Legitimate concern, but out of scope — refactoring it is a session of its own, not a bug fix. |
| `shape-parse/route.ts` unbounded arrays in sequential fallback | `src/app/api/shape-parse/route.ts:96-98, 183` | Low priority. Lambda path is the common case; fallback only runs when Lambda disabled. |
| Follow-up DetectionPanel hook extractions | `useTagScanning`, `useCsiTagEditor` | Deferred. `useShapeParseInteraction` proves the pattern; the other two have deeper store coupling and aren't urgent. |

## Key Technical Decisions

1. **Lambda warnings plumbing adopts structured `(results, warnings)` worker contract** rather than a sidecar warning channel. `template_match`'s `match_worker` returns empty warnings list; shape_parse's worker is now literally `extract_keynotes_main` (direct passthrough, since `main()` already returns the right tuple). One contract, two workers, no branching.

2. **`assertLambdaOk` as a helper** — extracted from the inline status check. Mirroring it on the retry path fixes the "silent business-level error in retry" hole without duplication.

3. **Pytest tests use synthetic numpy images via fixtures**, not checked-in blobs. Keeps the repo lean and makes tests reproducible across environments. Tests work WITHOUT tesseract installed because `extract_keynotes.py` gracefully degrades (`_HAVE_OCR = False`).

4. **`useShapeParseInteraction` is the first hook of a planned three** (Tag scanning and CSI tag editing are follow-ups). Picked Shape Parse first because it was the largest recent addition and had the tableParseRegion bleed that was clearly an architectural smell.

5. **Docker Fix 3 removes `--no-cache-dir` from pip installs** — counterintuitive but correct. BuildKit cache mounts live outside the image layer, so keeping pip's cache files during build doesn't bloat the image. Net: build reuse + no size regression.

6. **`DOCKER_BUILDKIT=1` made explicit in deploy scripts** — default since Docker 23 but removes ambiguity in mixed dev-container / CI environments.

## Remaining Deploy-Time Bottleneck (Unsolved)

After Fix 2 + Fix 3, warm deploy is ~13 min (down from ~17). Remaining dominant cost: `npm run build` = 569s inside Docker on the user's Mac vs 77s on a Linux dev container. Attribution unclear — likely Docker Desktop VFS tax on FS-heavy Next.js build phases (page-data collection, SSG, standalone tracing), though Turbopack's caching model makes the exact breakdown hard to pin.

**Real options for further speedup (not pursued this session):**
1. User checks Docker Desktop VirtioFS setting + CPU/RAM allocation. Zero code.
2. Move builds to GitHub Actions `ubuntu-latest`. Linux native, no VFS tax, cache-to-gha. Setup: hours. Biggest safe win.
3. Base-image split (user's "two Dockerfiles" recollection): on analysis, doesn't actually help — the bottleneck is `npm run build` which runs AFTER any base-image layer, and the apt/pip/npm-install layers are already cached in warm builds today. Don't pursue.

## Still Deferred

- **Shape Parse architecture pivot** — pending the MAX_DIM=12000 experiment result. If scale-factor alone doesn't fix the 0-keynotes problem on full-page scans, the sliding-window BB approach becomes the right build.
- **Pixel-dimension counter on Markup meta** (user idea) — a cheap diagnostic for sizing BB-tiled scans.
- **outputFileTracingIncludes in next.config.ts** for drizzle-orm/pg — alternative to Fix 2's layer move. Deferred since Fix 2 shipped and works.
- **AnnotationOverlay useEffect refactor.**
- **UI consolidation of Shape Parse + Template Match into a single tabbed panel** (from the 2026-04-17 notes).
- **First "find all instances" feature** on the tag-mapping substrate.

## Lessons That Cost This Session Time

1. **Don't plan infra changes from inference or partial Explore reports.** My first Docker plan targeted ~60s of cache-mount wins and missed the 570s `npm run build` + 196s runtime drizzle install entirely. User had to reject twice before I read the actual files.
2. **Measure before committing to a build-speed hypothesis.** I claimed "tsc is ~520s of the 570s" and it turned out tsc is 10s. The entire Fix-1 (move tsc out) premise was wrong. Added a Phase 0 measurement gate to the plan AFTER the fact — should be Phase 0 always.
3. **Host-build for cross-platform deploys doesn't work if native binaries differ between build and runtime.** My Fix 4 didn't account for this and the deploy broke immediately on a darwin-x64 lightningcss error. Saved as a memory feedback.
