                                                                                                         
● The plan is written and decisions are saved to memory. A few things I want to flag before we finalize:  
                                                                                                          
  1. pdf.js slowness — The key is lazy rendering (only render 1-3 visible pages) and debounced zoom       
  (render low-res during active zooming, high-res when zoom stops). This should solve the performance     
  issue you hit before.                                                                                   
  2. The plan doesn't touch blueprintparser_current — everything goes in blueprintparser_2/. The Terraform
   infra patterns get replicated, not shared.                                                             
  3. BYOK encryption — API keys stored AES-256 encrypted in the database, decrypted server-side only when 
  making API calls. Users never see each other's keys.                                                    
  4. Scope — This is a ~6-7 week build. Phase 1 (viewer + upload) and Phase 2 (OCR + search) are the      
  foundation everything else depends on.                                                                  
                                                                                                          
──────────────────────────────────────────────────────────────────────────────────────────────────────────
 Ready to code?                                                                                           
                                                                                                          
 Here is Claude's plan:                                                                                   
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 BlueprintParser_2 — Comprehensive Build Plan                                                             
                                                                                                          
 Context                                                                                                  
                                                                                                          
 BlueprintParser_current (the "Beaver" app) was built as a modern rewrite of the legacy Theta 2018        
 codebase, but it falls short of feature parity in critical areas: PDF rendering distorts on zoom (raster 
  PNG scaling vs theta_old's vector HTML), no auto page naming from title blocks, no working OCR          
 pipeline, no LLM chat feature, and several theta_old features are incomplete or missing.

 Goal: Build blueprintparser_2 as a new Next.js project in /workspaces/Theta_2018/blueprintparser_2/ that
  replicates all theta_old features with modern infrastructure, adds LLM "chat with your blueprints"
 functionality, and uses Amazon Textract for OCR.

 ---
 Architecture Decisions (Confirmed)

 ┌──────────────┬───────────────────────────────────┬────────────────────────────────────────────────┐
 │   Decision   │              Choice               │                   Rationale                    │
 ├──────────────┼───────────────────────────────────┼────────────────────────────────────────────────┤
 │ PDF          │                                   │ Canvas-based, re-renders at zoom resolution,   │
 │ Rendering    │ pdf.js (Mozilla)                  │ no distortion. Lazy-load + progressive         │
 │              │                                   │ resolution to avoid slowness.                  │
 ├──────────────┼───────────────────────────────────┼────────────────────────────────────────────────┤
 │ OCR          │ Amazon Textract                   │ $1.50/1K pages, word-level bounding boxes,     │
 │              │                                   │ handles blueprints well. Already on AWS.       │
 ├──────────────┼───────────────────────────────────┼────────────────────────────────────────────────┤
 │              │ Next.js 16 + React 19 +           │ Reuse infrastructure patterns from             │
 │ Tech Stack   │ TypeScript                        │ blueprintparser_current (Terraform, Drizzle,   │
 │              │                                   │ NextAuth, deploy.sh). New codebase.            │
 ├──────────────┼───────────────────────────────────┼────────────────────────────────────────────────┤
 │              │ Both page-scoped and project-wide │                                                │
 │ LLM Chat     │  with toggle. Free tier =         │                                                │
 │              │ page-only.                        │                                                │
 ├──────────────┼───────────────────────────────────┼────────────────────────────────────────────────┤
 │ Free LLM     │ Groq API (Llama 3)                │ Free tier available, blazing fast, no          │
 │              │                                   │ self-hosting.                                  │
 ├──────────────┼───────────────────────────────────┼────────────────────────────────────────────────┤
 │ Paid LLM     │ BYOK — user links their own       │                                                │
 │              │ Anthropic/OpenAI/etc. API key     │                                                │
 ├──────────────┼───────────────────────────────────┼────────────────────────────────────────────────┤
 │ Search       │ PostgreSQL full-text search       │ Already in RDS, simpler ops, good enough for   │
 │              │                                   │ this use case.                                 │
 ├──────────────┼───────────────────────────────────┼────────────────────────────────────────────────┤
 │ Keynote      │ Port theta_old's OpenCV code      │ Battle-tested shape detection, unique          │
 │ Extraction   │                                   │ value-add.                                     │
 ├──────────────┼───────────────────────────────────┼────────────────────────────────────────────────┤
 │ CSI          │ Port theta_old's keyword matching │ Simple, effective, keep as-is.                 │
 │ Detection    │                                   │                                                │
 ├──────────────┼───────────────────────────────────┼────────────────────────────────────────────────┤
 │ Auto Page    │ Textract + heuristics on title    │ Simpler than theta_old's SVM model, more       │
 │ Naming       │ block region (bottom-right of     │ accurate with Textract.                        │
 │              │ page)                             │                                                │
 └──────────────┴───────────────────────────────────┴────────────────────────────────────────────────┘

 ---
 Feature List — What blueprintparser_2 Must Have

 Core Viewer (P0 — Must Ship)

 1. pdf.js PDF Viewer — canvas rendering, lazy page loading, progressive resolution on zoom
 2. Smooth zoom/pan — mouse wheel zoom anchored to cursor, click-drag pan, fit-to-width/fit-to-page
 3. Page sidebar — thumbnails (rendered from pdf.js), auto-named from title block (e.g., "A-100"),
 editable names
 4. Page navigation — arrows, keyboard shortcuts (PageUp/Down, Home/End), click thumbnail

 OCR & Search (P0)

 5. Amazon Textract OCR — runs during processing, extracts word-level text + bounding boxes per page
 6. Full-text search — PostgreSQL tsvector/tsquery, search across all pages in a project
 7. Search result highlighting — yellow boxes at exact word coordinates on current page
 8. Page filtering on search — sidebar shows only pages with matches, match count badges
 9. Text panel — show extracted text for current page (like theta_old's text view)

 Keynotes & CSI (P0)

 10. Keynote extraction — OpenCV shape detection (circles, rectangles, diamonds, etc.) + Tesseract for
 text inside shapes
 11. Keynote overlay — color-coded shapes on page, click to search for that keynote across pages
 12. CSI code detection — keyword matching against csi.tsv database
 13. CSI/Trade dropdown — filter pages by trade/division (e.g., "show me all Division 8 sheets")

 LLM Chat (P1 — Ship Soon After)

 14. Chat sidebar panel — collapsible chat interface in the viewer
 15. Page-scoped chat — sends current page's OCR text as context, fast + cheap
 16. Project-wide chat — sends all pages' OCR text, expensive but powerful (paid tier only)
 17. Free tier — Groq API (Llama 3), page-scoped only, no account required
 18. BYOK paid tier — user connects their own Anthropic/OpenAI/Groq API key, stored encrypted per-user
 19. Chat history — persist per-project chat messages

 Annotations & Detection (P1)

 20. Bounding box annotations — draw, label, color-code, edit, delete
 21. Annotation table — bottom panel showing all annotations on current page
 22. Annotation search — search by label name, show matching pages
 23. YOLO object detection — run models on uploaded blueprints, display results as overlay
 24. Detection confidence slider — filter detections by confidence threshold

 Auto Page Naming (P1)

 25. Title block extraction — use Textract output to find drawing number in title block region (typically
  bottom-right)
 26. Heuristic classifier — look for patterns like "A-100", "E-345", "S-201" in the title block area
 27. Auto-populate page names — set page names from extracted drawing numbers, user can override

 User Management (P0)

 28. NextAuth JWT auth — email/password, same pattern as blueprintparser_current
 29. Company/tenant isolation — multi-tenant with access keys for registration
 30. User roles — admin vs member
 31. Demo mode — no account needed, can view a sample project and use free LLM chat
 32. BYOK API key management — settings page to add/remove API keys per provider

 Admin Panel (P1)

 33. Feature flags — toggle YOLO, LLM, Textract per company
 34. YOLO model management — upload/register models, select hardware (GPU type), set default
 35. Processing job dashboard — view running/completed/failed jobs
 36. Usage monitoring — Textract pages processed, LLM tokens used, per company
 37. Company management — create companies, regenerate access keys

 Project Management (P0)

 38. PDF upload — presigned S3 upload, progress bar
 39. Processing pipeline — Step Functions: Textract OCR + keynote extraction + (optional) YOLO
 40. Project list/grid — thumbnails, search, status indicators
 41. Project info editing — name, address (with geocoding)
 42. PDF download — download original PDF from viewer

 ---
 Processing Pipeline Architecture

 User uploads PDF to S3
         |
         v
 Step Functions State Machine
         |
         +---> 1. PDF Split (CPU pipeline - ECS Fargate)
         |         - Split PDF into pages
         |         - Generate thumbnails via pdf.js or Ghostscript
         |
         +---> 2. Textract OCR (AWS API call)
         |         - Submit PDF to Textract async API
         |         - Get word-level bounding boxes per page
         |         - Store results in pages.textract_data (JSONB)
         |
         +---> 3. Keynote Extraction (CPU pipeline)
         |         - Rasterize pages to images
         |         - Run OpenCV shape detection
         |         - Run Tesseract on detected shapes
         |         - Store keynotes in pages.keynotes (JSONB)
         |
         +---> 4. Text Analysis (CPU pipeline)
         |         - CSI code detection from OCR text
         |         - Auto page naming from title block
         |         - Build PostgreSQL tsvector for search
         |
         +---> 5. YOLO Detection (optional - SageMaker GPU)
                   - Run selected models on page images
                   - Tile-and-merge for large images
                   - Store detections in annotations table
         |
         v
 Webhook → Update project status → Ready to view

 ---
 Database Schema Changes (vs blueprintparser_current)

 -- Add to pages table:
 textract_data  JSONB    -- Raw Textract output (words + bounding boxes)
 keynotes       JSONB    -- Extracted keynotes [{shape, text, bbox}]
 csi_codes      JSONB    -- Detected CSI codes [{code, description, trade}]
 drawing_number TEXT     -- Auto-extracted page name (e.g., "A-100")

 -- Add new table: chat_messages
 chat_messages (
   id            SERIAL PRIMARY KEY,
   project_id    INTEGER REFERENCES projects(id),
   page_number   INTEGER NULL,       -- NULL = project-wide chat
   role          TEXT,                -- 'user' | 'assistant'
   content       TEXT,
   model         TEXT,                -- which model was used
   user_id       INTEGER REFERENCES users(id),
   created_at    TIMESTAMP
 )

 -- Add new table: user_api_keys
 user_api_keys (
   id            SERIAL PRIMARY KEY,
   user_id       INTEGER REFERENCES users(id),
   provider      TEXT,                -- 'anthropic' | 'openai' | 'groq'
   encrypted_key TEXT,                -- AES-256 encrypted API key
   created_at    TIMESTAMP
 )

 -- Add to companies table:
 features       JSONB    -- Feature flags: {yolo: true, llm: true, textract: true}

 ---
 Key Files to Port from theta_old

 ┌───────────────────────────────────────────┬────────────────────────┬──────────────────────────────┐
 │                   File                    │        Purpose         │        Changes Needed        │
 ├───────────────────────────────────────────┼────────────────────────┼──────────────────────────────┤
 │ keynote_extraction/extract_keynotes.py    │ Shape detection + text │ Minor: update output format, │
 │                                           │  extraction            │  add error handling          │
 ├───────────────────────────────────────────┼────────────────────────┼──────────────────────────────┤
 │ pdf-processing-app/src/detect_csi.py      │ CSI code detection     │ None — works as-is           │
 ├───────────────────────────────────────────┼────────────────────────┼──────────────────────────────┤
 │ pdf-processing-app/src/create_overview.py │ Aggregate page         │ Adapt for Textract output    │
 │                                           │ metadata               │ format                       │
 ├───────────────────────────────────────────┼────────────────────────┼──────────────────────────────┤
 │ pdf-processing-app/csi.tsv                │ CSI code database      │ None — keep as-is            │
 └───────────────────────────────────────────┴────────────────────────┴──────────────────────────────┘

 ---
 Key Files to Reuse from blueprintparser_current

 ┌───────────────────────────────┬───────────────────────┬───────────────────────────────────────────┐
 │             File              │        Purpose        │              Changes Needed               │
 ├───────────────────────────────┼───────────────────────┼───────────────────────────────────────────┤
 │ infrastructure/terraform/*.tf │ All Terraform IaC     │ Add Textract IAM permissions, update task │
 │                               │                       │  definitions                              │
 ├───────────────────────────────┼───────────────────────┼───────────────────────────────────────────┤
 │ src/lib/db/schema.ts          │ Database schema       │ Add new tables/columns listed above       │
 ├───────────────────────────────┼───────────────────────┼───────────────────────────────────────────┤
 │ src/lib/auth.ts               │ NextAuth config       │ Minor: add BYOK key management            │
 ├───────────────────────────────┼───────────────────────┼───────────────────────────────────────────┤
 │ src/lib/s3.ts                 │ S3 presigned uploads  │ None                                      │
 ├───────────────────────────────┼───────────────────────┼───────────────────────────────────────────┤
 │ src/lib/processing.ts         │ Step Functions        │ Update state machine definition           │
 │                               │ integration           │                                           │
 ├───────────────────────────────┼───────────────────────┼───────────────────────────────────────────┤
 │ deploy.sh                     │ Deployment script     │ Update image names                        │
 ├───────────────────────────────┼───────────────────────┼───────────────────────────────────────────┤
 │ Dockerfile                    │ App container         │ Minor tweaks                              │
 ├───────────────────────────────┼───────────────────────┼───────────────────────────────────────────┤
 │ docker-compose.yml            │ Local dev             │ Same                                      │
 └───────────────────────────────┴───────────────────────┴───────────────────────────────────────────┘

 ---
 New Components to Build

 ┌─────────────────────┬─────────────────────────────────────────────────────────────────────────────┐
 │      Component      │                                 Description                                 │
 ├─────────────────────┼─────────────────────────────────────────────────────────────────────────────┤
 │ PDFViewer.tsx       │ New pdf.js-based viewer with canvas rendering, lazy loading, progressive    │
 │                     │ zoom                                                                        │
 ├─────────────────────┼─────────────────────────────────────────────────────────────────────────────┤
 │ ChatPanel.tsx       │ LLM chat sidebar with page/project toggle                                   │
 ├─────────────────────┼─────────────────────────────────────────────────────────────────────────────┤
 │ ChatMessage.tsx     │ Individual chat message bubble                                              │
 ├─────────────────────┼─────────────────────────────────────────────────────────────────────────────┤
 │ APIKeySettings.tsx  │ User settings page for BYOK API key management                              │
 ├─────────────────────┼─────────────────────────────────────────────────────────────────────────────┤
 │ LLMProxy (API       │ Routes chat requests to correct provider based on user's configured key     │
 │ route)              │                                                                             │
 ├─────────────────────┼─────────────────────────────────────────────────────────────────────────────┤
 │ TextractProcessor   │ Lambda/ECS task that calls Textract API and stores results                  │
 ├─────────────────────┼─────────────────────────────────────────────────────────────────────────────┤
 │ TitleBlockExtractor │ Heuristic to find drawing number from Textract output in title block region │
 └─────────────────────┴─────────────────────────────────────────────────────────────────────────────┘

 ---
 Implementation Phases

 Phase 1: Foundation (Week 1-2)

 - Initialize new Next.js project in blueprintparser_2/
 - Set up Drizzle schema, PostgreSQL, NextAuth
 - Build pdf.js viewer with smooth zoom/pan (the hardest UI piece)
 - Basic page sidebar with thumbnails
 - PDF upload to S3

 Phase 2: OCR & Search (Week 2-3)

 - Integrate Amazon Textract into processing pipeline
 - Store word-level bounding boxes in database
 - Build PostgreSQL full-text search
 - Search highlighting on viewer (yellow boxes at word coordinates)
 - Page filtering in sidebar

 Phase 3: Keynote & CSI (Week 3-4)

 - Port keynote extraction Python code
 - Port CSI detection
 - Build keynote overlay component
 - Build CSI/trade dropdown filter
 - Auto page naming from title block

 Phase 4: LLM Chat (Week 4-5)

 - Build chat panel UI
 - Groq API integration (free tier)
 - BYOK API key management (settings page + encrypted storage)
 - Page-scoped vs project-wide toggle
 - Chat history persistence

 Phase 5: Annotations & YOLO (Week 5-6)

 - Port annotation system
 - YOLO pipeline integration
 - Detection overlay + confidence slider
 - Admin panel for model management

 Phase 6: Admin & Polish (Week 6-7)

 - Feature flags per company
 - Usage monitoring
 - Demo mode
 - Deploy to AWS

 ---
 Verification / Testing Plan

 1. PDF Viewer: Upload a 200+ page blueprint PDF → verify smooth zoom to 8x without distortion, lazy page
  loading, cursor-anchored zoom
 2. OCR: Upload PDF → verify Textract extracts text with bounding boxes → search for a word → verify
 yellow highlight appears at correct position on page
 3. Keynotes: Upload blueprint with keynote symbols → verify shapes detected and text extracted → click
 keynote to search across pages
 4. CSI: Verify CSI codes detected from OCR text → trade dropdown shows correct divisions → filtering
 works
 5. Auto Page Naming: Upload blueprint → verify pages auto-named from title block (A-100, E-345, etc.)
 6. LLM Chat: Open chat → ask about current page → verify contextual response → switch to project-wide →
 verify cross-page answer
 7. BYOK: Add Anthropic API key in settings → verify chat uses that key → remove key → verify falls back
 to Groq
 8. Search: Search for a term → verify matching pages highlighted in sidebar with counts → verify
 word-level highlighting on page
 9. Demo Mode: Access without login → verify can view sample project and use free LLM chat
 10. Admin: Toggle YOLO off for a company → verify YOLO option hidden in their viewer
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌