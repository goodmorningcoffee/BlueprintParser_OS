# Deep Dive: What Makes BlueprintParser Interesting

This isn't a plan — it's observations from reading the codebase deeply.

---

## The Core Insight: Compression as Architecture

The entire system is built around one idea: **250K tokens of messy OCR text is useless to an LLM, but 6K tokens of structured signals is powerful.** Every system in the codebase exists to compress raw pixels → structured meaning. That's not just a feature — it's the architecture itself.

The compression ratio is ~40:1. That's what makes Haiku viable at $0.0015/message instead of needing Opus at $0.075. The business model is literally encoded in the code architecture.

---

## Most Interesting: The 6-System Cascade

What's remarkable isn't any single system — it's how they chain:

```
Raw pixels → OCR words → spatial clusters → semantic regions →
classified tables → YOLO-text bindings → tag patterns →
page intelligence → project graph → LLM context
```

Each layer adds signal while reducing noise. The key design choice: **every layer outputs confidence scores, never binary decisions.** A text region classified as "table-like" at 0.6 confidence still flows downstream. The table classifier might boost it to 0.85 if keywords match. The heuristic engine might push it to 0.95 if YOLO confirms a table shape. Or it might decay to 0.3 and get filtered out.

This is Bayesian thinking without the math — each system acts as an independent evidence source, and confidence compounds through agreement.

---

## Most Clever: The Context Builder's Overflow Pool

`assembleContextWithConfig()` implements a token economy. Each section gets a percentage budget. But here's the elegant part: **unused allocation flows to an overflow pool that redistributes to sections that need more space.**

A door schedule with 100 words doesn't waste its 25% allocation — the remaining budget flows to spatial context or parsed tables that might have more data. This is adaptive without being complex. One `overflow` variable, tracked across the loop. Simple bookkeeping, powerful behavior.

The preset system (`balanced` / `structured` / `verbose`) encodes domain knowledge about what matters for different project types. A project with parsed schedules benefits from `structured` (tables get 25%). A project with only OCR text needs `verbose` (raw OCR gets 40%). The admin picks the preset, the system adapts.

---

## Most Surprising: CSI Detection is a Search Engine

`csi-detect.ts` isn't pattern matching — it's a miniature information retrieval system. Three tiers:

1. **Exact subphrase** (0.95) — consecutive words from description found in text
2. **Bag-of-words** (up to 0.75) — scattered significant words, scored by `(matched/total)²`
3. **Keyword anchors** (up to 0.50) — rare words weighted by inverse document frequency

The squared penalty in tier 2 is subtle: matching 3/4 words scores 0.56, but 2/4 scores only 0.25. This rewards near-complete matches exponentially. And tier 3's IDF-like weighting means "photovoltaic" matching has higher significance than "concrete" matching — because rarer words are more distinctive.

The multi-tier boost (+0.05 when both tier 2 and 3 agree) treats independent matching mechanisms as confirmatory evidence. Two weak signals that agree are stronger than one strong signal alone.

---

## Most Elegant: The Drawing State Decoupling

The performance architecture in AnnotationOverlay is a masterclass in React optimization for canvas-heavy UIs:

- `_drawing`, `_drawStart`, `_drawEnd`, `_mousePos` live in Zustand store
- AnnotationOverlay **writes** these via `getState()` but **does NOT subscribe**
- Only `DrawingPreviewLayer` subscribes → only the lightweight preview canvas re-renders during mouse movement
- The main canvas (1500 lines of annotation rendering) doesn't re-render at all during drawing

This is the observer pattern inverted: the writer doesn't observe its own writes. The naming convention (underscore prefix) signals "don't subscribe to these." It's not enforced by TypeScript, just by convention — but it works because the architecture makes the intent clear.

---

## Most Pragmatic: The Heuristic Engine as Data

The heuristic engine's rules are JSON, not code:

```
keynote-table:
  yoloRequired: ["horizontal_area"]
  yoloBoosters: ["table", "grid"]
  textKeywords: ["KEYNOTE", "LEGEND"]
  spatialConditions: [contains(horizontal_area, oval, min=3, axis=vertical)]
  textRegionType: "key-value"
```

This means an admin can:
- Disable a rule that produces false positives
- Add a custom rule for their specific blueprint conventions
- Change YOLO class requirements when they train a new model
- Adjust confidence thresholds per rule

All without code changes, all via the admin dashboard. The engine just scores rules against evidence. The intelligence is in the rule definitions, not the engine logic. This is the right separation for a tool used by different companies with different blueprint conventions.

---

## Most Underappreciated: The Chunking Strategy

`useChunkLoader.ts` solves a real problem: a 460-page blueprint set has ~80KB of OCR data per page = ~37MB total. Loading that into the browser kills performance.

The solution: **catalog data** (tiny, global — trade lists, schedule names, CSI code directory) loads once. **Detail data** (heavy — textract words, page intelligence, annotations) loads in a 15-page sliding window around the current page.

The snapshot-before-async pattern is defensive genius:
```typescript
const stateSnapshot = {
  keynotes: useViewerStore.getState().keynotes,
  csiCodes: useViewerStore.getState().csiCodes,
  // ...
};
// ... async fetch ...
// evict from snapshot, not current state (which may have changed)
```

If the user navigates rapidly (arrow keys), each navigation triggers a debounced fetch. But the eviction operates on the snapshot taken before the fetch, not the live state — preventing a race where rapid navigation corrupts the eviction boundaries.

---

## The Pattern I Keep Seeing

Every system in the codebase follows the same philosophy:

1. **Collect signals independently** (OCR, YOLO, CSI, heuristics, spatial)
2. **Score confidence per signal** (never binary)
3. **Combine through weighted agreement** (composable scoring)
4. **Degrade gracefully** (missing signal = skip, not fail)
5. **Let the admin tune** (thresholds, rules, budgets in dashboard)
6. **Compress for the LLM** (structured output, not raw dumps)

This is a product architecture, not just a codebase. The code encodes a theory of how to make construction blueprints machine-readable, layer by layer, without requiring perfect OCR or perfect object detection. It's designed for the real world where both are noisy.
