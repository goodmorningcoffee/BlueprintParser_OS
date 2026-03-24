 Here's the quick summary for your questions:

  Migration — npx tsx src/lib/db/migrate.ts runs all SQL files in drizzle/.
  But Bug #7 means our search_vector migration won't run yet (fixing it).

  Credentials — You need 3 things in .env.local:
  1. Fix DATABASE_URL to postgresql://beaver:beaver@localhost:5433/beaverdb
  (matches docker-compose)
  2. Add AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (needs Textract + S3 read
  permissions)
  3. Add DEV_PROCESSING_ENABLED=true

  DEV_PROCESSING_ENABLED — Goes in
  /workspaces/Theta_2018/blueprintparser_2/.env.local alongside all the other
   env vars.

  Login — After seeding: demo@demo.
  com / password123

  Code review found 7 real bugs — The critical ones are:
  - Processing trigger won't auth properly (fire-and-forget cookie issue)
  - Page count function is broken (bad PostScript)
  - Migration won't run (not in Drizzle's journal)
  - Search highlights too many words (.includes() too broad)
  - Zoom breaks highlight alignment (missing CSS transform)
  - XSS risk in text panel
  - Temp dirs leak (wrong cleanup function)

─────────────────────────────────────────────────────────────────────────────
 Ready to code?                                                            
                          
 Here is Claude's plan:
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Phase 2 Bug Fixes + Testing Guide
                                                                             
 Context                                                

 Code review found 7 real bugs in the Phase 2 implementation. Also answering
  the user's setup/testing questions.

 ---
 Testing Guide (How to Run Everything)

 1. Start PostgreSQL

 cd /workspaces/Theta_2018/blueprintparser_2
 docker compose up -d
 This starts PostgreSQL on port 5433 (user: beaver, password: beaver, db:
 beaverdb).

 2. Fix DATABASE_URL

 The .env.local currently has postgresql://vscode@localhost:5433/beaverdb
 which won't auth correctly against the Docker Postgres that expects
 beaver:beaver. Fix to:
 DATABASE_URL=postgresql://beaver:beaver@localhost:5433/beaverdb

 3. Run Drizzle Migrations

 npx tsx src/lib/db/migrate.ts
 This runs all .sql files in drizzle/ folder. BUT — see Bug #7 below, our
 search_vector migration won't be picked up by Drizzle automatically.

 4. Seed Demo Data

 npx tsx src/lib/db/seed.ts
 This creates:
 - Company: "Demo Company"
 - User: demo@demo.com / password123
 - Sample project with 3 pages

 5. Add env vars to .env.local

 DEV_PROCESSING_ENABLED=true
 AWS_ACCESS_KEY_ID=<your AWS key>
 AWS_SECRET_ACCESS_KEY=<your AWS secret>
 - DEV_PROCESSING_ENABLED goes in .env.local (same file as DATABASE_URL)
 - AWS credentials need Textract permissions (textract:AnalyzeDocument)
 - You also need S3 read access to download uploaded PDFs

 6. Start Dev Server

 npm run dev
 Open http://localhost:3000, sign in with demo@demo.com / password123.

 7. Upload a PDF

 Click "Upload PDF" → select a blueprint → it uploads to S3 and triggers
 processing.

 ---
 7 Bugs to Fix

 Bug 1: getPdfPageCount() is broken

 File: src/lib/pdf-rasterize.ts (lines 53-88)

 The PostScript command for page counting is fragile — path escaping issues,
  unused first GS call. Replace with a simpler approach using qpdf
 --show-npages or a single GS command with proper argument handling.

 Fix: Rewrite getPdfPageCount() to use a reliable single GS invocation. Also
  fix temp dir cleanup to use rm() with { recursive: true } instead of
 unlink() on directories.

 ---
 Bug 2: Fire-and-forget processing trigger auth failure

 File: src/app/api/projects/route.ts (lines 33-49)

 The fetch() to /api/processing/dev forwards cookies, but the dev processing
  route calls auth() which may not resolve the session from forwarded
 cookies in a server-to-server context.

 Fix: Instead of HTTP self-call, import and call the processing logic
 directly as an async function. Extract the core processing logic from the
 route handler into a shared function in src/lib/processing.ts, then call it
  directly from the projects route (fire-and-forget with .catch()).

 ---
 Bug 3: Search word matching too broad

 File: src/app/api/search/route.ts (lines 82-89)

 .includes() causes "cat" to match "catalog", "concatenate", etc. Users will
  see false-positive yellow highlights.

 Fix: Use regex word-boundary matching:
 const regex = new RegExp(`\\b${escapeRegex(term)}\\b`, "i");
 if (regex.test(word.text)) { wordMatches.push(...); }

 ---
 Bug 4: XSS in TextPanel via dangerouslySetInnerHTML

 File: src/components/viewer/TextPanel.tsx (line 65)

 OCR text is inserted as raw HTML without escaping. If OCR extracts
 something like <script> or <img onerror=...>, it executes.

 Fix: HTML-escape the line text BEFORE doing the <mark> regex replacement:
 function escapeHtml(str: string): string {
   return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g,
 '&gt;').replace(/"/g, '&quot;');
 }
 let html = escapeHtml(line.text);
 // then do regex <mark> replacement on the escaped string

 ---
 Bug 5: Search overlay missing CSS transform during zoom

 File: src/components/viewer/SearchHighlightOverlay.tsx +
 src/components/viewer/PDFPage.tsx

 The PDF canvas has transform: scale(cssScale) for instant zoom feedback,
 but the overlay canvas doesn't. During zoom transitions, highlights are
 misaligned.

 Fix: The overlay canvas needs the same CSS transform. Either:
 - Pass cssScale to the overlay and apply it, OR
 - Move the overlay inside a shared transform wrapper with the PDF canvas

 Simplest: apply the same transform and transformOrigin styles to the
 overlay canvas.

 ---
 Bug 6: Temp directory cleanup uses unlink() on directories

 File: src/lib/pdf-rasterize.ts (lines 42-47, 84-86)

 unlink() only works on files. Calling it on a directory silently fails,
 leaking temp dirs.

 Fix: Use rm() with { recursive: true, force: true } on the temp directory
 (handles both files and the directory).

 ---
 Bug 7: Migration not tracked by Drizzle

 File: drizzle/0001_add_search_vector.sql + drizzle/meta/_journal.json

 Drizzle's migrate() only applies files listed in _journal.json. Our
 manually-created 0001_add_search_vector.sql isn't listed, so it'll never
 run.

 Fix: Either:
 - (A) Add an entry to _journal.json manually, OR
 - (B) Run the SQL directly in the seed/setup script, OR
 - (C) Run it as a separate setup step

 Recommend (A) — add the journal entry so it runs automatically with the
 rest of migrations.

 ---
 Files to Modify

 ┌──────────────────────────────────────────────────┬────────────────────┐
 │                       File                       │     Bugs Fixed     │
 ├──────────────────────────────────────────────────┼────────────────────┤
 │ src/lib/pdf-rasterize.ts                         │ #1 (page count),   │
 │                                                  │ #6 (temp cleanup)  │
 ├──────────────────────────────────────────────────┼────────────────────┤
 │ src/app/api/projects/route.ts                    │ #2 (processing     │
 │                                                  │ trigger)           │
 ├──────────────────────────────────────────────────┼────────────────────┤
 │ src/lib/processing.ts (NEW)                      │ #2 (extracted      │
 │                                                  │ processing logic)  │
 ├──────────────────────────────────────────────────┼────────────────────┤
 │ src/app/api/processing/dev/route.ts              │ #2 (simplified to  │
 │                                                  │ use shared logic)  │
 ├──────────────────────────────────────────────────┼────────────────────┤
 │ src/app/api/search/route.ts                      │ #3 (word boundary  │
 │                                                  │ matching)          │
 ├──────────────────────────────────────────────────┼────────────────────┤
 │ src/components/viewer/TextPanel.tsx              │ #4 (HTML escaping) │
 ├──────────────────────────────────────────────────┼────────────────────┤
 │ src/components/viewer/SearchHighlightOverlay.tsx │ #5 (CSS transform) │
 ├──────────────────────────────────────────────────┼────────────────────┤
 │ src/components/viewer/PDFPage.tsx                │ #5 (pass cssScale  │
 │                                                  │ to overlay)        │
 ├──────────────────────────────────────────────────┼────────────────────┤
 │ drizzle/meta/_journal.json                       │ #7 (add migration  │
 │                                                  │ entry)             │
 ├──────────────────────────────────────────────────┼────────────────────┤
 │ .env.local                                       │ Fix DATABASE_URL   │
 │                                                  │ credentials        │
 └──────────────────────────────────────────────────┴────────────────────┘

 ---
 False Positives from Audit (NOT bugs)

 - Textract block ID tracking — The wordById map correctly maps block.Id →
 TextractWord. LINE child IDs resolve to words correctly. Code is fine.
 - Textract coordinate normalization — AWS Textract returns 0-1 normalized
 BoundingBox values. This is documented behavior. Code is correct.
 - SQL injection in search — Drizzle's sql template tag parameterizes all
 values. plainto_tsquery() also escapes input. Safe.
 - DPR handling in overlay — Same pattern as PDFPage.tsx (buffer at DPR,
 draw at logical pixels). Correct. The only issue is the missing CSS
 transform (#5).

 ---
 Verification

 1. npx tsc --noEmit — zero type errors
 2. npx next build — clean build
 3. Start Postgres + run migrations + seed → login works
 4. Upload PDF → project goes to "processing" → eventually "completed"
 5. Open project → Text panel shows extracted text
 6. Search → yellow highlights at correct positions, sidebar filters pages
 7. Zoom while searching → highlights stay aligned