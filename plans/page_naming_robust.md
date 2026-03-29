# Plan: Robust Page Naming Module

## Date: March 29, 2026

---

## Problem

Current page naming (`title-block.ts`) is regex-only with a hardcoded title block region (bottom-right 25% × right 50%). It:
- Fails on non-standard names like "S3" (fixed with regex update)
- Proposes gibberish names like "HMO1" that aren't even in the title block
- Has no validation that the proposed name actually makes sense
- Can't use YOLO title_block detection even when available
- Has no way to look for label keywords like "SHEET", "DWG NUM", etc.

## Architecture: Strategy Chain with Validation

```
Page Naming Module
├── Strategy 1: Label-Anchored Search (most precise, no YOLO needed)
│   └── Find keywords like "SHEET", "DWG", "DRAWING" in title block region
│   └── Grab the adjacent word/value as the page name
│
├── Strategy 2: Regex Pattern Match (current approach, improved)
│   └── Scan title block region for drawing number patterns
│   └── Score by position + confidence + pattern quality
│
├── Strategy 3: YOLO-Augmented Validation (optional, when title_block class exists)
│   └── Use YOLO title_block bbox to constrain search area
│   └── Validate proposed name exists INSIDE the title block detection
│   └── Prefer candidates in the LOWER HALF of the title block
│
└── Validation Layer (runs on all strategies)
    └── Check proposed name against known discipline prefixes
    └── Reject candidates that look like random OCR noise
    └── Cross-validate: does this name appear elsewhere on the page? (if yes, less likely to be the page name)
```

### How They Work Together

1. Run Strategy 1 (label-anchored) first — if found, high confidence
2. Run Strategy 2 (regex) — produces candidates with scores
3. If YOLO title_block class is available, run Strategy 3 to validate/re-rank candidates
4. Validation layer filters out gibberish
5. Best surviving candidate wins

---

## Strategy 1: Label-Anchored Search

**Keywords to search for** (case-insensitive, in title block region):
- "SHEET", "SHEET NO", "SHEET NUMBER", "SHEET NUM"
- "DWG", "DWG NO", "DRAWING", "DRAWING NO", "DRAWING NUMBER", "DRW", "DRW NUM"
- "PLAN NO", "PLAN NUMBER"
- "PAGE", "PAGE NO"

**Algorithm:**
1. Find any OCR word matching a label keyword in the title block region
2. Look at the word(s) immediately to the RIGHT or BELOW the label (within ~0.05 normalized distance)
3. If the adjacent text matches the drawing number regex → high confidence match
4. If no adjacent match, look for the nearest regex-matching word within 0.1 distance

**Why this is better:** Instead of scoring every regex match in the title block, we anchor on the LABEL that architects put next to the drawing number. "SHEET NO: A-101" — the label tells us exactly where to look.

**Handles variations:**
- "SHEET NO" followed by "A-101" on the right
- "DWG" on one line, "S3" on the line below
- "DRAWING NUMBER" in a label cell, value in the adjacent cell

---

## Strategy 2: Improved Regex Match (Current, Enhanced)

**File:** `src/lib/title-block.ts` — `extractDrawingNumber()`

**Current issues to fix:**
- Regex `[A-Z]{1,4}[-.]?\d{1,4}` is too permissive — matches things like "HMO1", "THE2", "FOR3"
- No validation that the match is a plausible drawing number

**Improvements:**
1. **Known prefix boost:** If the matched prefix (first 1-2 chars) is in DISCIPLINE_MAP, add +0.3 to score. Unknown prefixes get no boost.
2. **Length penalty:** Very short matches (2 chars like "S3") get a slight penalty vs longer matches ("S-301") — longer is more likely correct
3. **Context check:** If the word immediately LEFT of the candidate is a label keyword ("SHEET", "DWG"), big score boost (+0.4)
4. **Duplicate penalty:** If the same text appears multiple times on the page (outside title block), it's probably not the page name — it's a common label. Penalize.

---

## Strategy 3: YOLO-Augmented Validation

**Prerequisite:** A YOLO model with a `title_block` class exists and has been run on the project.

**How it works:**
1. Check if YOLO annotations for this page include a `title_block` detection
2. If yes, use the YOLO bbox as the search region instead of the hardcoded TITLE_BLOCK constants
3. Within the YOLO title_block bbox, prefer candidates in the **lower half** (drawing numbers are almost always in the bottom section of the title block)
4. If a candidate from Strategy 1 or 2 falls OUTSIDE the YOLO title_block bbox → reject or heavily penalize

**Default off.** Only activates when:
- A YOLO model with `title_block` in its classTypes (marked as "spatial") is found
- That model has been run on the project (annotations with `name: "title_block"` exist)

**How to detect if available:**
- Query annotations table for `source='yolo' AND name='title_block' AND pageNumber=N`
- If found, use the detection's bbox as the title block region
- Multiple title_block detections on one page → use the one in the bottom-right (highest centerX + centerY)

---

## Validation Layer

**Applied to ALL candidate names regardless of strategy:**

1. **Known prefix check:** First 1-2 chars should be in DISCIPLINE_MAP or be a common prefix. Unknown prefixes get confidence penalty.

2. **Gibberish filter:** Reject candidates where:
   - All characters are the same letter ("AAA1")
   - The "prefix" isn't alphabetic followed by numeric ("1A2B" → reject)
   - The word is a common English word that happens to match regex ("FOR1", "THE2", "TO3")

3. **Common words blacklist:** Maintain a small set of words that match the regex but aren't drawing numbers:
   ```
   "REV", "REF", "SIM", "TYP", "NTS", "EQ", "MIN", "MAX", "NO"
   ```
   These appear in title blocks but aren't page names.

4. **Cross-page consistency check** (project-level, runs after all pages named):
   - If most pages follow a pattern (A-101, A-102, A-103...) but one page is "HMO1", flag it as suspicious
   - Pages in a project usually share a consistent naming scheme

---

## Function Signature (Updated)

```typescript
export function extractDrawingNumber(
  textractData: TextractPageData,
  yoloTitleBlock?: { minX: number; minY: number; maxX: number; maxY: number } | null,
): string | null
```

- `yoloTitleBlock` is optional — when provided, constrains search area and enables Strategy 3
- Caller (processing.ts or reprocess endpoint) passes YOLO data if available

---

## Admin Integration

### "Reprocess Page Names" button
- Add to Text Annotations tab in Admin Dashboard (alongside existing reprocess)
- Calls reprocess endpoint with `scope=page-names`
- Re-runs `extractDrawingNumber()` on all pages with existing textractData
- If YOLO title_block detections exist, passes them to the function
- Streams progress as NDJSON

### Pipeline config
- `pipelineConfig.pageNaming.useYoloTitleBlock?: boolean` — default true (auto-detect)
- `pipelineConfig.pageNaming.customPrefixes?: string[]` — additional discipline prefixes beyond the built-in map
- `pipelineConfig.pageNaming.labelKeywords?: string[]` — additional keywords to search for beyond defaults

---

## Build Order

1. **Strategy 1 (label-anchored search)** — biggest improvement, no YOLO needed
2. **Validation layer** — filter gibberish, known prefix boost, blacklist
3. **Strategy 2 improvements** — context check, duplicate penalty
4. **Strategy 3 (YOLO augmented)** — optional enhancement when title_block class available
5. **Reprocess button** — admin UI for re-running page naming
6. **Pipeline config** — admin-configurable prefixes and keywords

---

## Files to Modify

- `src/lib/title-block.ts` — main extraction logic, all 3 strategies
- `src/lib/processing.ts` — pass YOLO title_block data when available (during reprocess)
- `src/app/api/admin/reprocess/route.ts` — add `scope=page-names` mode
- `src/app/admin/tabs/TextAnnotationsTab.tsx` — add "Reprocess Page Names" button

---

## Open Questions

1. Should we store the naming strategy that was used (label-anchored vs regex vs YOLO-validated) in pageIntelligence for debugging?
2. For the cross-page consistency check — should this auto-correct suspicious names or just flag them?
3. Should the manual override (user renames a page in the viewer) be preserved across reprocessing? (Currently yes — check if this still works)
