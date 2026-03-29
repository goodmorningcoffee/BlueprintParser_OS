# Plan: CSI Chain Wiring — Parsed Data → Tags → Spatial → LLM Context

## The Chain

```
Parsed table/keynote content
  ↓ (1) Server-side CSI detection
CSI codes on parsed region (e.g., "Door Schedule" → Div 08, 09)
  ↓ (2) Propagate to tag instances
Every tag instance inherits its row's CSI codes
  (Keynote 01 = CSI 06 16 00 → all instances of keynote 01 on the page also tagged 06 16 00)
  ↓ (3) Re-compute spatial map
CSI spatial map updated with parsed-data CSI codes
  (Now the spatial map knows "top-left has Div 06 from keynote 01")
  ↓ (4) Feed into LLM context
New context section: "CSI from Parsed Tables/Keynotes"
  (LLM can answer: "What trades are in the door schedule?")
```

## Step 1: Server-Side CSI Detection API

**Already partially done**: `/api/table-parse` response now includes `csiTags` from `detectCsiFromGrid()`.

**Still needed:**
- Keynote auto-parse also calls `/api/table-parse` so it gets csiTags too
- Manual parse doesn't call any API — needs a new `/api/csi/detect` POST endpoint
  - Accepts: `{ text: string }` or `{ headers: string[], rows: Record<string,string>[] }`
  - Returns: `{ csiTags: { code: string, description: string }[] }`
  - Client components call this instead of importing csi-detect.ts directly
- Wire manual parse (both table and keynote) to call this endpoint after parsing

**Files:**
- Create: `src/app/api/csi/detect/route.ts`
- Modify: `src/components/viewer/TableParsePanel.tsx` — call API after manual parse
- Modify: `src/components/viewer/KeynotePanel.tsx` — call API after manual parse

## Step 2: Propagate CSI Tags to Tag Instances

When a YoloTag is created from a parsed table/keynote:
- The tag's row has CSI codes (from the parsed region's csiTags or from per-row detection)
- Store these CSI codes on the YoloTag itself: `YoloTag.csiCodes?: string[]`
- When the tag is highlighted on canvas, the CSI codes travel with it

**Files:**
- Modify: `src/types/index.ts` — add `csiCodes?: string[]` to YoloTag interface
- Modify: `src/components/viewer/TableParsePanel.tsx` — set csiCodes when creating YoloTags in Map Tags
- Modify: `src/components/viewer/KeynotePanel.tsx` — set csiCodes when creating YoloTags after parse
- Modify: `src/lib/yolo-tag-engine.ts` — propagate csiCodes in mapYoloToOcrText results

## Step 3: Re-Compute CSI Spatial Map After Parsing

The CSI spatial map runs during processing and reads from text annotations + page-level CSI codes. After user-initiated parsing, the spatial map is stale.

**Approach:** Add a "refresh spatial" function that:
1. Takes existing spatial map
2. Adds CSI codes from parsedRegions (table/keynote CSI tags)
3. Adds CSI codes from YoloTag instances on this page
4. Re-bins into 3x3 grid zones
5. Updates pageIntelligence.csiSpatialMap

**Trigger:** After any parse completes (auto or manual) or after Map Tags runs.

**Files:**
- Modify: `src/lib/csi-spatial.ts` — add `refreshSpatialMapWithParsedData()` function
- Modify: `src/components/viewer/TableParsePanel.tsx` — call refresh after parse/map-tags
- Modify: `src/components/viewer/KeynotePanel.tsx` — call refresh after parse

## Step 4: LLM Context Section

Add new context section to `src/lib/context-builder.ts` at priority 6.2:

```
CSI FROM PARSED DATA — Page A-101:
  Door Schedule: Div 08 Openings (12 codes), Div 09 Finishes (3 codes)
    → Structured schedule data with 15 rows
  Keynotes: Div 06 Wood/Plastics, Div 09 Finishes
    → 5 page-specific keynote definitions
  Tag Instances: Keynote 01 (Div 06) appears 3 times in top-left quadrant
```

**Data source:** Read from `pageIntelligence.parsedRegions` which stores category + csiTags.

**Files:**
- Modify: `src/lib/context-builder.ts` — add `buildParsedDataCsiSection()` at priority 6.2

## Build Order

1. `/api/csi/detect` endpoint (unblocks client-side CSI tagging)
2. Wire manual parse → CSI detect API
3. Add csiCodes to YoloTag type + propagate in tag creation
4. Refresh spatial map after parsing
5. LLM context section for parsed data CSI

## Bug Fixes to Also Address

- CSI network graph button (pre-existing, investigate)
- Page misclassification edge cases (T-000.00)
- BB drawing mouse-leave issue (onMouseLeave={handleMouseUp})
- Admin reprocess progress persistence
- Compare/Edit shows full page instead of cropped region
