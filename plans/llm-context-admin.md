# LLM/Context Admin Tab — Full Context Control

## Problem

The LLM chat context system has 12+ priority-ordered sections, model-aware budgets, and a system prompt — all hardcoded. The admin can't see what the LLM receives, can't adjust priorities or token allocation, can't disable noisy sections, and can't debug why the LLM missed information. Every preprocessing output (CSI, heuristics, YOLO, parsed tables, spatial maps) can contribute to context, but the admin has no control over how much weight each gets.

## How Context Works Today

### Context Assembly Flow

```
1. resolveLLMConfig()     → determines provider, model, baseUrl
2. getContextBudget()     → hardcoded chars based on model (Opus: 200K, Sonnet: 80K, etc.)
3. Build sections         → 12+ sections each with header, content, priority number
4. assembleContext()      → sort by priority, greedily fill until budget exhausted
5. buildSystemPrompt()    → hardcoded anti-hallucination prompt + "DATA PROVIDED" list
6. Send to LLM            → system message = prompt + context, then history + user message
```

### Current Sections (all hardcoded priorities, no % allocation)

```
Priority  Section                              Feeds Into LLM?  Configurable?
────────  ───────────────────────────────────   ───────────────  ─────────────
0.5       Project Intelligence Report           Yes              No
1.0       YOLO Detections (counts only)         Yes              No
1.0       CSI Network Graph (project scope)     Yes              No
1.5       Page Classification                   Yes              No
2.0       User Annotations (markups + notes)    Yes              No
3.0       Takeoff Notes                         Yes              No
3.5       Cross-References                      Yes              No
4.0       CSI Codes                             Yes              No
5.0       Text Annotations (phone, dims, etc)   Yes              No
5.5       Note Blocks                           Yes              No
5.8       Parsed Tables/Keynotes                Yes              No
6.0       Detected Regions (classified tables)  Yes              No
6.2       CSI from Parsed Data                  Yes              No
7.0       CSI Spatial Distribution (3x3 grid)   Yes              No
8.0       Spatial Context (OCR→YOLO regions)    Yes              No
10.0      Raw OCR Text                          Yes              No

NOT IN CONTEXT TODAY:
—         YOLO bbox locations per annotation    NO               —
—         YOLO class descriptions/notes         NO               —
—         Heuristic inferences                  NO               —
—         Tag patterns (YOLO→OCR)               NO               —
—         QTO workflow results                  NO               —
—         Proposed table regions                NO               —
```

### Current Budgets (hardcoded)

| Provider | Model | Budget (chars) | Context Window |
|----------|-------|---------------|----------------|
| Anthropic | Opus | 200,000 | 1M tokens |
| Anthropic | Sonnet | 80,000 | 200K tokens |
| Anthropic | Haiku | 40,000 | 200K tokens |
| OpenAI | GPT-4o | 60,000 | 128K tokens |
| OpenAI | o1/o3 | 80,000 | 200K tokens |
| Groq | Llama | 24,000 | 8-128K tokens |
| Custom/Ollama | any | 30,000 | unknown |

---

## What to Build: LLM/Context Admin Tab

Single admin tab with 4 panels. System prompt moves here from its current hidden config location.

### Panel 1: Model & Budget

Shows the active LLM configuration and context budget. Auto-detects capabilities for known providers; admin sets context window for custom models.

```
┌─ Active Model ──────────────────────────────────────────────┐
│                                                              │
│ Provider: Anthropic          Model: claude-sonnet-4-20250514│
│ Context Window: 200,000 tokens (auto-detected)              │
│ Context Budget: [80000] chars (~20K tokens)                 │
│                                                              │
│ For custom/Ollama models:                                    │
│ Context Window: [32000] tokens  (set manually)              │
│                                                              │
│ [Reset to Default]  [Save]                                   │
└──────────────────────────────────────────────────────────────┘
```

**Auto-detection for known providers:**
- The chat route already calls `resolveLLMConfig()` which returns `{ provider, model }`. For known providers (Anthropic, OpenAI, Groq), context windows are known — no API call needed.
- For custom/Ollama: admin sets `contextWindow` field in LLM config. Ollama's `GET /api/show` could auto-detect `num_ctx` but a manual field is simpler and more reliable.

**Budget vs context window:**
- Context window = model's total capacity (tokens)
- Budget = how many chars we fill with blueprint data (~25% of window, rest for system prompt + history + response)
- Admin can override the budget to use more or less of the window

**Zero overhead:** `resolveLLMConfig()` already runs before context assembly. Adding budget lookup is one more field read from `pipelineConfig.llm`.

**Data model:**
```typescript
llm?: {
  budgetOverrides?: Record<string, number>;  // "anthropic:sonnet" → 100000
  customContextWindow?: number;               // for custom/Ollama models
}
```

### Panel 2: System Prompt

System prompt editor moves here from the hidden `pipelineConfig.llm.systemPrompt` field. This is the instruction the LLM sees before any blueprint data.

```
┌─ System Prompt ─────────────────────────────────────────────┐
│                                                              │
│ [textarea]                                                   │
│ You are an expert construction blueprint analyst...          │
│                                                              │
│                                                              │
│ Template variables:                                          │
│ {{project_name}} {{page_count}} {{company_name}}            │
│ {{discipline}} {{drawing_number}}                           │
│                                                              │
│ Anti-hallucination guardrails are always appended.           │
│ The LLM will also see a "DATA PROVIDED:" summary of         │
│ which context sections are included.                         │
│                                                              │
│ [Reset to Default]  [Save]                                   │
└──────────────────────────────────────────────────────────────┘
```

### Panel 3: Context Sections + Token Allocation

Every preprocessing output that exists is listed here. Admin toggles sections on/off, sets priority order, and allocates what % of the budget each section gets.

```
┌─ Context Sections ──────────────────────────────────────────────┐
│                                                                  │
│ Active Model: Sonnet — Budget: 80,000 chars                     │
│ Allocation: [Balanced] [Structured ✓] [Verbose] [Custom]       │
│                                                                  │
│       Section                       ON/OFF  Priority  % Budget  │
│ ─────────────────────────────────────────────────────────────── │
│ [ON]  Project Intelligence Report     0.5      2%  ██░░░░░░░░  │
│ [ON]  YOLO Detections (counts)        1.0     10%  ████░░░░░░  │
│ [ON]  YOLO Annotation Detail (NEW)    1.2      8%  ███░░░░░░░  │
│ [ON]  Page Classification             1.5      2%  ██░░░░░░░░  │
│ [ON]  User Annotations                2.0      3%  ██░░░░░░░░  │
│ [ON]  Takeoff Notes                   3.0      2%  ██░░░░░░░░  │
│ [ON]  Cross-References                3.5      3%  ██░░░░░░░░  │
│ [ON]  CSI Codes                       4.0      5%  ███░░░░░░░  │
│ [ON]  Text Annotations                5.0      5%  ███░░░░░░░  │
│ [ON]  Note Blocks                     5.5      5%  ███░░░░░░░  │
│ [ON]  Parsed Tables/Keynotes          5.8     20%  ████████░░  │
│ [ON]  Detected Regions                6.0      3%  ██░░░░░░░░  │
│ [ON]  CSI from Parsed Data            6.2      2%  ██░░░░░░░░  │
│ [ON]  Heuristic Inferences (NEW)      6.5      3%  ██░░░░░░░░  │
│ [ON]  CSI Spatial Distribution        7.0      5%  ███░░░░░░░  │
│ [ON]  Spatial Context (OCR→YOLO)      8.0     10%  ████░░░░░░  │
│ [OFF] Tag Patterns (NEW)             8.5      0%  ░░░░░░░░░░  │
│ [OFF] QTO Results (NEW)             9.0      0%  ░░░░░░░░░░  │
│ [OFF] Raw OCR Text                   10.0      0%  ░░░░░░░░░░  │
│       ─── Overflow Pool ───                  12%  █████░░░░░  │
│                                              ───               │
│                                              100%              │
│                                                                  │
│ [Reset to Defaults]  [Save]                                      │
└──────────────────────────────────────────────────────────────────┘
```

**How percentage allocation works:**

Each enabled section gets a max % of the total budget. The overflow pool collects unused space (when a section's actual content is smaller than its allocation). Overflow redistributes to sections that need more space, in priority order.

```
Budget: 80,000 chars
Parsed Tables allocated 20% = 16,000 chars max
  → actual content = 4,000 chars
  → 12,000 chars flow to overflow pool
  → overflow goes to next section that exceeded its allocation
```

**Presets:**
- **Balanced** — even distribution across all enabled sections
- **Structured** — parsed tables + CSI heavy, raw OCR off
- **Verbose** — raw OCR heavy (for projects without much structured data)
- **Custom** — manual % per section

**New sections not currently in context:**
- **YOLO Annotation Detail** — per-annotation bbox locations + class descriptions + CSI tags (see below)
- **Heuristic Inferences** — what the heuristic engine detected (schedule types, legends, notes)
- **Tag Patterns** — YOLO→OCR tag groups detected by `detectTagPatterns()`
- **QTO Results** — auto-QTO workflow results (tag counts, page locations)

**Data model:**
```typescript
sectionConfig?: {
  disabledSections?: string[];
  priorityOverrides?: Record<string, number>;
  percentAllocations?: Record<string, number>;
  preset?: "balanced" | "structured" | "verbose" | "custom";
}
```

**Assembly logic (`assembleContext()`):**

```
1. Filter out disabled sections
2. Apply priority overrides
3. Calculate per-section char budget from % allocations
4. Sort by priority (ascending)
5. Fill each section within its char budget
6. Track overflow (unused allocation from small sections)
7. Redistribute overflow to sections that exceeded their allocation (priority order)
8. Truncate any section still over budget after redistribution
```

### Panel 4: Context Preview Tool

Pick any project + page → see exactly what the LLM receives.

```
┌─ Context Preview ───────────────────────────────────────────┐
│                                                              │
│ Project: [Office Tower ▾]  Page: [12 ▾]  Scope: [Page ▾]   │
│ [Preview Context]                                            │
│                                                              │
│ ┌─ Result ─────────────────────────────────────────────────┐│
│ │ Model: Sonnet | Budget: 80,000 chars                     ││
│ │                                                          ││
│ │ SYSTEM PROMPT (423 chars)                                ││
│ │ You are an expert construction blueprint analyst...      ││
│ │                                                          ││
│ │ === OBJECT DETECTIONS === (2,847 / 8,000 chars) P:1     ││
│ │ 47 objects detected across 1 page...                     ││
│ │                                                          ││
│ │ === YOLO ANNOTATION DETAIL === (5,200 / 6,400) P:1.2   ││
│ │ door_single (14): "Single-leaf door" [CSI 08 11 16]     ││
│ │   #1: upper-left area, conf 0.91                        ││
│ │   ...                                                    ││
│ │                                                          ││
│ │ === PARSED TABLES === (3,940 / 16,000 chars) P:5.8      ││
│ │ "Door Schedule": 23 rows, 8 columns...                   ││
│ │                                                          ││
│ │ === RAW OCR TEXT === DISABLED                             ││
│ │                                                          ││
│ │ ─── Summary ───                                          ││
│ │ Total: 18,240 / 80,000 chars (23% of budget)            ││
│ │ Sections included: 12/16  Truncated: 0  Skipped: 4      ││
│ │ Overflow pool: 42,000 chars unused                       ││
│ └──────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

Shows each section with: actual chars / allocated chars, priority, truncation status. The admin can immediately see if important data is getting cut or if the budget is underutilized.

---

## YOLO Annotation Detail for LLM

### The problem

The LLM currently sees YOLO as aggregated counts: "14 door_single on page 12." It does NOT see individual annotation locations. Every annotation has a bbox — this spatial data is thrown away to save tokens.

### What to build

**1. Per-class descriptions (AI Models tab):**

Add `classDescriptions` to model config:
```typescript
classDescriptions?: Record<string, string>;
// e.g. { "door_single": "Single-leaf door. Usually has a door tag (circle with text) nearby." }
```

Admin writes natural-language descriptions per YOLO class. These feed directly into context.

**2. New context section: "YOLO ANNOTATION DETAIL":**

When enabled (toggleable in Panel 3), includes per-annotation data:

```
=== YOLO ANNOTATION DETAIL — Page 12 ===
door_single (14 instances): "Single-leaf door" [CSI 08 11 16]
  #1: upper-left area, confidence 0.91
  #2: center area, confidence 0.88
  #3: center-right area, confidence 0.85
  ...

circle (23 instances): "Shape containing tag text (D-01, T-04)"
  #1: upper-left area (near door_single #1), confidence 0.95
  ...
```

**3. Human-readable spatial hints (not raw bbox coords):**

Instead of `bbox(0.12, 0.34, 0.18, 0.41)`, translate to grid zone names using CSI spatial map zones:
- "upper-left area" / "center" / "bottom-right near title block"
- Proximity hints: "near door_single #1" (when bboxes overlap or are adjacent)

This makes locations useful to the LLM without requiring coordinate math.

### Files to modify
- `src/app/admin/tabs/AiModelsTab.tsx` — add `classDescriptions` textarea per class
- `src/lib/context-builder.ts` — new `buildAnnotationDetailSection()` function
- `src/app/api/ai/chat/route.ts` — load model configs, pass class descriptions to context builder
- `src/types/index.ts` — add `classDescriptions` to `ModelConfig`

---

## Data Model

### All config in `pipelineConfig.llm`

```typescript
llm?: {
  // Panel 1: Budget
  budgetOverrides?: Record<string, number>;    // "anthropic:sonnet" → 100000
  customContextWindow?: number;                 // for custom/Ollama models

  // Panel 2: System prompt
  systemPrompt?: string;                        // custom prompt text (already exists, moves to this tab)

  // Panel 3: Section control + allocation
  sectionConfig?: {
    disabledSections?: string[];                // section headers to skip
    priorityOverrides?: Record<string, number>; // header → custom priority
    percentAllocations?: Record<string, number>;// header → % of budget
    preset?: "balanced" | "structured" | "verbose" | "custom";
  };
}
```

All stored in existing `companies.pipelineConfig` JSONB. No new tables or migrations.

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/app/admin/tabs/LlmContextTab.tsx` | 4-panel admin UI (model/budget, prompt, sections, preview) |
| `src/app/api/admin/llm/preview/route.ts` | Context preview endpoint (builds context, returns section metadata) |
| `src/app/api/admin/llm/config/route.ts` | GET/PUT for LLM context config |

## Files to Modify

| File | Change |
|------|--------|
| `src/app/admin/AdminTabs.tsx` | Add "llm-context" tab |
| `src/app/admin/page.tsx` | Render LlmContextTab |
| `src/lib/context-builder.ts` | Accept sectionConfig + budgetOverrides, add `buildAnnotationDetailSection()`, percentage-based assembly |
| `src/app/api/ai/chat/route.ts` | Load company LLM config, pass to context builder |
| `src/app/admin/tabs/AiModelsTab.tsx` | Add classDescriptions per YOLO class |
| `src/types/index.ts` | Add classDescriptions to ModelConfig |

## Patterns to Reuse

| Pattern | Source | Use For |
|---------|--------|---------|
| pipelineConfig PATCH | `api/admin/pipeline/route.ts` | LLM config persistence |
| Admin tab structure | Any existing tab | LlmContextTab layout |
| Context builder functions | `context-builder.ts` | Preview tool reuses all builders |
| Chat route context assembly | `api/ai/chat/route.ts:150-418` | Preview endpoint mirrors this logic |
| YOLO class config UI | `AiModelsTab.tsx` classTypes/classCsiCodes pattern | classDescriptions textarea |

## Verification

1. Set custom system prompt → chat → verify prompt appears in LLM behavior
2. Disable "Raw OCR Text" section → preview → verify excluded, budget freed up
3. Set "Parsed Tables" to 30% allocation → preview → verify it gets more space
4. Switch preset from Structured to Verbose → preview → verify allocation shift
5. Add class description "Single-leaf door" → chat "what doors are on this page?" → verify LLM uses description
6. Preview tool: pick project + page → verify sections match actual chat context
7. Set custom budget for Groq to 40000 → chat → verify more context included
8. Enable "YOLO Annotation Detail" → preview → verify per-annotation locations shown
9. Custom/Ollama model: set contextWindow to 32000 → verify budget calculated correctly
