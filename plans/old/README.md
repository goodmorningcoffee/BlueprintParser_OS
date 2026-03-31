# BlueprintParser Plans Directory

## Active Plans (TODO — in priority order)
1. **roadmap-next-phases.md** — 6 remaining items: Pipeline Phases 1-3, LLM Tool-Use, Auto-YOLO, YOLO Progress Terminal
2. **auto-qto-spec.md** — Auto-QTO Phases C-E: tag engine upgrade, review + CSV editor, polish

## Reviews & Audits (March 31, 2026)
- **code-review-march31.md** — Comprehensive code review: 20 findings (2 critical auth gaps, 34 tests total, 153 `as any` casts)
- **security-audit-march31.md** — Security deep dive: committed API key, missing auth on 2 routes, SSL validation disabled, IAM over-permissioned
- **session-march30-4features.md** — Session plan for features A-D

## Small Tasks Remaining
- Auto-CSI-tag annotation notes on save
- CSI dropdown Standard/MasterFormat toggle
- Security fixes from audit (auth gaps, error sanitization, timeouts)

## Completed / Implemented ✓
- **llm-context-admin.md** — LLM/Context admin tab: 4 panels BUILT + WIRED to chat (March 30-31) ✓
- **b2_csi_graph_visualization.md** — CSI graph viz (March 29) ✓
- **page_naming_robust.md** — 3-strategy page naming (March 29) ✓
- **symbol_search_template_matching_auto_qto.md** — Symbol search + template matching (March 29) ✓
- **keynote_parser_tool.md** — Keynote parsing tool (March 29) ✓
- **table_parse_comparison_overlay.md** — Table compare modal (March 29) ✓
- **csi_chain_wiring.md** — CSI tagging pipeline (March 29) ✓
- **security-hardening.md** — Rate limiting, brute force, audit log (March 23-24) ✓
- **quantity-takeoff.md** — Count + Area takeoff (March 23-24) ✓

## Roadmap Items Status (from roadmap-next-phases.md)
| # | Item | Status |
|---|------|--------|
| 1 | Pipeline Phase 1 — wire disabledSteps | TODO |
| 2 | Pipeline Phase 2 — YOLO table proposals | TODO |
| 3 | Guided Parse universal module | **DONE** (March 31) |
| 4 | Pipeline Phase 3 — QTO pre-compute | TODO |
| 5 | LLM Tool-Use | TODO |
| 6 | YOLO Class Picker | **DONE** (March 31) |
| 7 | CSI Spatial Grid 3x3→configurable | **DONE** (March 31) |
| 8 | Auto-YOLO on upload | TODO |
| 9 | YOLO Progress Terminal | TODO |
| 10 | LLM/Context Admin Tab | **DONE** (March 30-31) |

## Historical / Reference Only
- **current-state-march-23.md** / **current-state-march-24.md** — snapshots
- **keynote_table_schedule_parsing_pipeline.md** — early design (superseded)
- **table_parsing_ocr_architecture.md** — discussion doc
- **local-docker-mode.md** — local Docker deployment plan
- **opensource_plan.md** — open source strategy + blockers

## What Was Built (March 28-31 sessions)
- Modular detector pipeline, heuristic engine, 3 classification systems
- CSI MasterFormat upgrade, CSI spatial heatmap + network graph
- Admin dashboard (9 tabs: pipeline, heuristics, AI models, LLM context, CSI, text annotations, page intelligence, users, overview)
- Table/keynote parsing (3 methods + guided parse with tunable sliders + compare modal)
- Symbol search (template matching, cv2 + SIFT)
- YOLO-tag mapping engine, Auto-QTO Phases A-B
- Chunking strategy, 3 dark themes, component decomposition
- Textract retry+backoff, configurable page concurrency
- AWS hardening script (ECR scan, CloudWatch, WAF, GuardDuty, CloudTrail)
