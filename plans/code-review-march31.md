# Comprehensive Code Review — BlueprintParser 2
**Date: March 31, 2026**

## Executive Summary

Architecturally sound codebase with good patterns (Drizzle ORM parameterized queries, slice selectors, graceful degradation in processing). Main risks: **1 critical auth gap**, **near-zero test coverage**, **no timeouts on external services**, and **type safety erosion** (153 `as any` casts).

---

## CRITICAL — Fix Before Next Deploy

### 1. Missing company auth on `/api/pages/intelligence` (PATCH)
**File:** `src/app/api/pages/intelligence/route.ts` line 39
Uses `requireAuth()` but queries `pages.projectId = projectId` without checking the project belongs to `session.user.companyId`. Any authenticated user can modify any company's page intelligence by guessing internal projectId (sequential integer).
**Fix:** Join to projects table with `eq(projects.companyId, session.user.companyId)` before update.
**Effort:** 15 min

### 2. Admin invites returns ALL companies' invites
**File:** `src/app/api/admin/invites/route.ts` line 13
`db.select().from(inviteRequests)` with no `companyId` filter. Admin of Company A sees invite requests from Company B.
**Fix:** Add `where(eq(inviteRequests.companyId, session.user.companyId))` — but inviteRequests table may not have companyId column. If not, filter by email domain or add the column.
**Effort:** 15-30 min

---

## HIGH — Fix This Week

### 3. No timeout on LLM stream
**File:** `src/lib/llm/stream.ts` line 33
`for await (const content of iterable)` waits forever if LLM API hangs. No abort mechanism. The HTTP request eventually times out at infrastructure level, but the server-side async generator leaks.
**Fix:** AbortController with 30-60s timeout, clean up on abort.
**Effort:** 30 min

### 4. No timeout on per-page processing
**File:** `src/lib/processing.ts`
If Textract or Ghostscript hangs on one page, that worker never completes. With concurrency=8, one hung page blocks 1/8 of capacity indefinitely.
**Fix:** `Promise.race([pagePromise, timeout(60000)])` per page.
**Effort:** 30 min

### 5. `decryptApiKey()` not wrapped in try-catch
**File:** `src/lib/llm/resolve.ts` line 39
If AES decryption fails (corrupted key, wrong ENCRYPTION_SECRET after rotation), entire LLM config resolution fails silently. User sees "not configured" instead of helpful error.
**Fix:** Wrap in try-catch, log error, fall through to next config source.
**Effort:** 10 min

### 6. CSI database load failure is silent
**File:** `src/lib/csi-detect.ts` lines 92-95
If the CSI TSV file is missing in production Docker image, `detectCsiCodes()` returns `[]` with only a `console.error`. All CSI detection silently broken with no user-visible indication.
**Fix:** Log a loud warning at startup. Consider a health check endpoint that verifies CSI database loaded.
**Effort:** 10 min

### 7. No quotas on expensive endpoints
These routes have auth but no per-user rate limiting:
- `/api/symbol-search` — rasterizes pages, runs Python CV (expensive)
- `/api/table-parse` — rasterizes pages, runs OpenCV line detection
- `/api/search` and `/api/search/global` — PostgreSQL full-text queries
- `/api/csi/detect` — no auth at all (by design, but DoS-able)
**Fix:** Add quota checks similar to existing `checkChatQuota()` / `checkYoloQuota()`.
**Effort:** 1-2 hrs

### 8. Error responses leak internal details
**Files:** `/api/yolo/run`, `/api/table-parse`, `/api/symbol-search`, `/api/pages/intelligence`
Return `err.message` to client, potentially leaking file paths, AWS SDK errors, Python tracebacks, DB column names.
**Fix:** Log full error server-side, return generic message to client.
**Effort:** 1 hr (5 routes)

---

## MEDIUM — Fix This Month

### 9. Test coverage: 34 tests (~0.5% of codebase)
**Existing tests:** `bbox-utils.test.ts` (15), `table-parse-utils.test.ts` (6), `viewerStore.test.ts` (13)
**Zero test coverage on:**
- Processing pipeline (`processing.ts` — 420 LOC)
- CSI 3-tier matching (`csi-detect.ts` — 284 LOC)
- Text annotation detectors (30+ regex patterns in `detectors/*`)
- Heuristic engine scoring + spatial operators (`heuristic-engine.ts` — 523 LOC)
- Table classifier scoring (`table-classifier.ts` — 248 LOC)
- LLM config resolution chain (`llm/resolve.ts`)
- OCR grid detection (`ocr-grid-detect.ts` — the algorithm we just made tunable)
- Reprocess route (3 scopes, streaming NDJSON)
**Impact:** Any regression ships silently. The retry/backoff logic added this session has no tests.
**Effort:** Half day for ~40 core tests

### 10. AnnotationOverlay.tsx — 1,508 lines, 67 store subscriptions
**File:** `src/components/viewer/AnnotationOverlay.tsx`
Subscribes to 67 individual store fields (lines 101-172). Every field change triggers re-render + full canvas redraw (228-line useEffect). Primary performance bottleneck.
**Should:** Migrate to ~6 slice selector calls (`useTableParse()`, `useDetection()`, `useYoloTags()`, etc.). Split canvas rendering into separate useEffects per concern.
**Impact:** Estimated 60-75% fewer re-renders.
**Effort:** 1-2 hrs

### 11. 153 `as any` casts across codebase
**Worst offenders:** `ai/chat/route.ts` (16), `AnnotationOverlay.tsx` (12), `processing.ts` (9), `AiModelsTab.tsx` (9), `reprocess/route.ts` (8), `llm/preview/route.ts` (8), `KeynotePanel.tsx` (7)
**Root cause:** `ClientAnnotation.data` typed as `Record<string, unknown>` with `[key: string]: unknown` escape hatch in `AnnotationData` interface (`src/types/index.ts` line 384).
**Fix:** Discriminated union on `data` based on `source` field (yolo vs user vs takeoff).
**Effort:** Half day

### 12. Missing composite DB index
**File:** `src/lib/db/schema.ts`
`pages` table has index on `projectId` alone. Common query "get page N of project M" (`eq(pages.projectId, X), eq(pages.pageNumber, Y)`) would benefit from composite index `(projectId, pageNumber)`.
**Effort:** 10 min (migration)

### 13. DB error catches too broad
**File:** `src/app/api/admin/reprocess/route.ts` line 365
`try {} catch { /* textAnnotations column may not exist */ }` swallows ALL DB errors including connection failures, permission denied, timeouts. Should check PostgreSQL error code `42703` specifically.
**Effort:** 10 min

### 14. Store: 250 fields, 1,103 lines
15 slice selectors defined but many components bypass them with direct `useViewerStore((s) => s.field)`. The slices use `useShallow()` for memoization, which only helps if components actually use them.
**Fix:** Enforce slice usage, remove unused fields (`projectIntelligenceData`, `labelingSessions`, `labelingCredentials`).
**Effort:** 2-3 hrs (audit + migrate)

---

## LOW — Backlog

### 15. Inconsistent projectId format
Some routes use internal integer ID (`/api/pages/textract?projectId=5`), others use publicId string (`/api/projects/abc123`). Not a security issue (company auth exists on both paths) but causes confusion.

### 16. Missing React.memo on list-rendered components
`AnnotationListItem`, `KeynoteItem`, `ClassGroupHeader` render in loops without memoization.

### 17. Zero-bbox fallback in page-analysis.ts
Returns `[0, 0, 0, 0]` as fallback bbox instead of `null`. Downstream consumers may treat zero-bbox as valid.

### 18. Components over 500 lines that could be decomposed
| Component | Lines | Status |
|-----------|-------|--------|
| AnnotationOverlay.tsx | 1,508 | Decompose: polygon handler, calibration, markup interaction |
| KeynotePanel.tsx | 905 | Now contains tuning sliders, could extract shared guided parse |
| AutoQtoTab.tsx | 855 | Multi-step workflow, hard to split further |
| PageSidebar.tsx | 758 | Already refactored from larger size |
| ViewerToolbar.tsx | 639 | Many toggles, naturally flat |

---

## What's Working Well

- **Auth pattern**: `requireAuth()` / `requireAdmin()` used consistently on 34/39 routes
- **Graceful degradation**: Every processing step has independent try-catch
- **No SQL injection**: Drizzle ORM parameterized queries everywhere
- **Textract resilience**: Full → half-res → Tesseract → empty, with retry+backoff (added this session)
- **Context builder**: Clean priority system with admin-configurable sections, budgets, presets (wired to chat this session)
- **Component decomposition**: Good patterns — TableParsePanel→7 files, TakeoffPanel→5 files
- **Admin dashboard**: 9 tabs with real power (pipeline, heuristics, LLM, models, CSI, etc.)
- **CSI embedding**: Universal tagging layer connecting OCR/YOLO/parsing/LLM
- **Drawing perf**: Zustand drawing state decoupled via `getState()` — only DrawingPreviewLayer subscribes
- **Processing pipeline**: Configurable concurrency, per-step error isolation, good logging

---

## Recommended Fix Priority

| # | Item | Effort | Impact |
|---|------|--------|--------|
| 1 | `/api/pages/intelligence` company auth | 15 min | Closes data isolation hole |
| 2 | `/api/admin/invites` company filter | 15 min | Closes cross-tenant leak |
| 3 | LLM stream timeout | 30 min | Prevents hung connections |
| 4 | Page processing timeout | 30 min | Prevents hung workers |
| 5 | `decryptApiKey` try-catch | 10 min | Better error messages |
| 6 | CSI database startup check | 10 min | Detects silent failures |
| 7 | Error response sanitization | 1 hr | Prevents info leaks |
| 8 | Quotas on expensive endpoints | 1-2 hrs | Prevents DoS/abuse |
| 9 | Core detector tests | Half day | Prevents regressions |
| 10 | AnnotationOverlay slice migration | 1-2 hrs | Perf improvement |
