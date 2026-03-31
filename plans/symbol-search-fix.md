# Symbol Search Fix Plan

## Date: March 31, 2026
## Status: Ready for Implementation

---

## Problems Found

### 1. CRITICAL: S3 Path Mismatch — Pre-rendered PNGs Never Found

`symbol-search/route.ts:143`:
```typescript
const s3Key = `${project.dataUrl}/images/page_${...}.png`;  // WRONG path
```

`processing.ts:148`:
```typescript
await uploadToS3(`${project.dataUrl}/pages/page_${...}.png`, ...);  // Actual path
```

**Impact:** Every search falls back to re-rasterizing ALL target pages from the PDF via Ghostscript at 200 DPI. For a 40-page project, that's 40 Ghostscript subprocess calls before matching even starts. This is why it "runs and stops" — it's either timing out or taking minutes.

**Fix:** Change `images/` to `pages/` on line 143. One character.

### 2. Auto-fires immediately — no configuration before running

`AnnotationOverlay.tsx:1142-1214`: The moment you release the BB draw, it immediately calls `fetch("/api/symbol-search")` with hardcoded defaults. No config panel shown first.

**Current defaults sent to API:**
- `confidenceThreshold`: from store (0.75)
- `multiScale`: not sent (API defaults to true)
- `useSiftFallback`: not sent (API defaults to true)
- `searchPages`: not sent (searches ALL pages)
- scales, siftFallbackThreshold, nmsIouThreshold, maxMatchesPerPage: all defaulted in Python

**Available configurable params (Python engine supports all of these):**
| Parameter | Default | What it does |
|-----------|---------|--------------|
| `confidenceThreshold` | 0.75 | Min match confidence (0-1) |
| `multiScale` | true | Try template at different sizes |
| `scales` | [0.9, 0.95, 1.0, 1.05, 1.1] | Scale factors to try |
| `useSiftFallback` | true | Use SIFT+RANSAC when matchTemplate finds < N hits |
| `siftFallbackThreshold` | 3 | Trigger SIFT when matchTemplate finds fewer than this |
| `nmsIouThreshold` | 0.3 | Non-max suppression overlap threshold |
| `maxMatchesPerPage` | 100 | Cap matches per page |
| `searchPages` | all | Which pages to search (subset) |

### 3. No error visibility

When the search fails (timeout, rasterization error, Python crash), the error goes to `symbolSearchError` in the store and shows as "Search failed" in the panel. But if Python silently produces 0 results, the user sees "0 matches" with no way to know why.

---

## Implementation Plan

### Step 1: Fix S3 path (1 line)

**File: `src/app/api/symbol-search/route.ts`**

Line 143: Change `images/` to `pages/`

```typescript
// BEFORE:
const s3Key = `${project.dataUrl}/images/page_${String(pageNum).padStart(4, "0")}.png`;

// AFTER:
const s3Key = `${project.dataUrl}/pages/page_${String(pageNum).padStart(4, "0")}.png`;
```

This alone will make symbol search orders of magnitude faster — reading existing 300 DPI PNGs from S3 instead of re-rasterizing every page.

### Step 2: Don't auto-fire — show config panel first

**File: `src/components/viewer/AnnotationOverlay.tsx`**

Change the mouseUp handler (lines 1142-1216): Instead of immediately calling the API, just save the template bbox and open the config panel.

```typescript
if (symbolSearchActive) {
  const store = useViewerStore.getState();
  store.setSymbolSearchActive(false);  // stop draw mode
  store.setSymbolSearchTemplateBbox([minX, minY, maxX, maxY]);
  store.setSymbolSearchSourcePage(pageNumber);
  // DON'T auto-fire search — let the panel show config first
  return;
}
```

### Step 3: Add config UI to SymbolSearchPanel

**File: `src/components/viewer/SymbolSearchPanel.tsx`**

Add a new "configure" state between "idle" and "processing". When template is set but search hasn't started:

```
States: idle → [draw BB] → configure → [click Run] → processing → results/error
```

Config panel shows:
- Template preview image (already works)
- **Confidence threshold** slider (already exists, move here)
- **Multi-scale** toggle (on/off)
- **Scale range** presets: "Exact size only" [1.0], "Small range" [0.95-1.05], "Wide range" [0.8-1.2]
- **SIFT fallback** toggle (on/off) — "Use rotation-invariant matching"
- **Page scope**: "All pages" | "Same discipline" | "Custom selection"
- **Run Search** button

### Step 4: Move search trigger to SymbolSearchPanel

**File: `src/components/viewer/SymbolSearchPanel.tsx`**

Add a `runSearch()` function that fires the API call with all configured params. Move the fetch + NDJSON stream logic from AnnotationOverlay into this component (or a shared hook).

```typescript
async function runSearch() {
  const store = useViewerStore.getState();
  store.setSymbolSearchLoading(true);
  store.setSymbolSearchError(null);

  const resp = await fetch("/api/symbol-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: store.projectId,
      sourcePageNumber: store.symbolSearchSourcePage,
      templateBbox: {
        x: bbox[0], y: bbox[1],
        w: bbox[2] - bbox[0], h: bbox[3] - bbox[1],
      },
      confidenceThreshold: config.confidenceThreshold,
      multiScale: config.multiScale,
      useSiftFallback: config.useSiftFallback,
      searchPages: config.searchPages,  // null = all
    }),
  });
  // ... NDJSON stream reading (same as current AnnotationOverlay code)
}
```

### Step 5: Add store fields for config

**File: `src/stores/viewerStore.ts`**

Add:
```typescript
symbolSearchConfig: {
  confidenceThreshold: number;  // default 0.75
  multiScale: boolean;          // default true
  useSiftFallback: boolean;     // default true
  searchPages: number[] | null; // null = all
}
```

---

## Files Changed

```
src/app/api/symbol-search/route.ts        — fix S3 path (1 line)
src/components/viewer/AnnotationOverlay.tsx — remove auto-fire, just save bbox
src/components/viewer/SymbolSearchPanel.tsx — add config UI + run trigger
src/stores/viewerStore.ts                  — add symbolSearchConfig state
```

## Verification

1. Draw BB around a symbol → config panel shows (NOT auto-search)
2. Adjust confidence, toggle multi-scale, select pages
3. Click "Run Search" → progress bar shows → results appear
4. Check server logs: should see "Loading from S3" not "Rasterizing page"
5. Test with different symbols: door, window, keynote circle
6. Test error case: draw tiny BB → should show clear error
