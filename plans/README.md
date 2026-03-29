# BlueprintParser Plans Directory

## Active Plans (TODO — in priority order)
1. **b2_csi_graph_visualization.md** — Full-page d3-force CSI network graph UI. Needs `npm install d3-force d3-selection`. (~2-3 hrs)
2. **page_naming_robust.md** — 3-strategy page naming: label-anchored search, improved regex, YOLO title_block validation. Reprocess button in admin. (~2-3 hrs)
3. **keynote_table_schedule_parsing_pipeline.md** — One pipeline with 4 handlers (schedule, keynote, legend, notes) + YOLO-tag-mapping + viewer UI. Early design phase. (~major feature)
4. **table_parsing_ocr_architecture.md** — Two-layer OCR architecture (base OCR for positions + table OCR via visual LLMs for structure). Discussion doc.
5. **symbol_search_template_matching_auto_qto.md** — OpenCV template matching "Symbol Search" tool + auto-QTO workflows. No ML training required. (~major feature)

## Small Tasks Remaining
- Auto-CSI-tag annotation notes on save (task #27) — run CSI matching on note text when saved
- CSI dropdown Standard/MasterFormat toggle — `src/data/csi.tsv` (2,778 standard codes) exists but unused. Add toggle to filter.

## Completed / Archived
- **current-state-march-23.md** — Pre-existing codebase review
- **current-state-march-24.md** — Pre-existing state doc
- **local-docker-mode.md** — Local Docker deployment plan (status unknown)
- **opensource_plan.md** — Open source release plan (status unknown)
- **quantity-takeoff.md** — QTO feature plan (count + area done, linear measurement not done)
- **security-hardening.md** — Security improvements (auth + rate limiting done, some items pending)

## What Was Built (March 28-29 sessions)
- Modular detector pipeline (10 detectors in src/lib/detectors/)
- Heuristic engine with 9 rules + admin UI with model/class picker + CSI divisions
- 3 classification systems (text region, heuristic, table meta-classifier)
- CSI MasterFormat upgrade (8,951 codes, 3-tier matching)
- Admin tabs: Text Annotations, CSI Codes, Heuristics, Page Intelligence (with reprocess)
- YOLO class CSI tagging (admin + viewer + pipeline wiring + reprocess endpoint)
- CSI spatial heatmap + CSI network graph (algorithms + pipeline wiring + LLM context)
- Page Intelligence Panel in viewer (with copy button)
- CsiPanel expand/collapse all + network graph summary (project scope) + "Open Full Graph" link
- DetectionPanel default collapsed + CSI tag sub-menu for project overrides
- System prompt editor in admin LLM config
- Context builder enhanced with CSI spatial (priority 7) + graph (priority 1) sections
- Universal CSI filter: click CSI code → highlights text annotations, filters YOLO + user markups by division
- User markup CSI tagging with input field + normalizer
- CSI normalizer utility (csi-utils.ts) wired into all CSI input points
- Searchable CSI dropdown in toolbar (replaced <select>)
- Drawing number regex fix for short formats (S3, DM1)
- Toolbar buttons reordered + red/green gradient styling
- All annotations default OFF, chat panel default ON
- Admin button → "Admin Dashboard" with outline styling
