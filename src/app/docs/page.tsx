"use client";

import Link from "next/link";
import { useEffect, useState, useRef } from "react";

/* ------------------------------------------------------------------ */
/*  Table of Contents definition                                       */
/* ------------------------------------------------------------------ */
const TOC = [
  { id: "introduction", label: "Introduction", group: "Getting Started" },
  { id: "getting-started", label: "Getting Started", group: "Getting Started" },
  { id: "viewer", label: "PDF Viewer & Navigation", group: "User Guide" },
  { id: "yolo", label: "YOLO Object Detection", group: "User Guide" },
  { id: "tables", label: "Table & Schedule Parsing", group: "User Guide" },
  { id: "keynotes", label: "Keynote Parsing", group: "User Guide" },
  { id: "qto", label: "Quantity Takeoff (QTO)", group: "User Guide" },
  { id: "symbol-search", label: "Symbol Search", group: "User Guide" },
  { id: "llm-chat", label: "LLM Chat", group: "User Guide" },
  { id: "csi-panel", label: "CSI Codes Panel", group: "User Guide" },
  { id: "text-panel", label: "Text & Annotations", group: "User Guide" },
  { id: "page-intelligence", label: "Page Intelligence", group: "User Guide" },
  { id: "settings", label: "Settings & Menu", group: "User Guide" },
  { id: "admin", label: "Admin Dashboard", group: "User Guide" },
  { id: "architecture", label: "Architecture Overview", group: "Technical" },
  { id: "pipeline", label: "Processing Pipeline", group: "Technical" },
  { id: "yolo-engine", label: "YOLO Detection Engine", group: "Technical" },
  { id: "csi-engine", label: "CSI Mapping Engine", group: "Technical" },
  { id: "table-pipeline", label: "Table Parsing Pipeline", group: "Technical" },
  { id: "llm-context", label: "LLM Context System", group: "Technical" },
  { id: "heuristics", label: "Domain Knowledge & Heuristics", group: "Technical" },
  { id: "api-reference", label: "API Reference", group: "API & Agents" },
  { id: "agent-tools", label: "LLM Agent Tools", group: "API & Agents" },
  { id: "database", label: "Database Schema", group: "API & Agents" },
  { id: "security", label: "Security", group: "API & Agents" },
];

/* ------------------------------------------------------------------ */
/*  Scroll-spy hook                                                    */
/* ------------------------------------------------------------------ */
function useScrollSpy(ids: string[]) {
  const [activeId, setActiveId] = useState(ids[0]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length > 0) {
          const sorted = visible.sort(
            (a, b) =>
              a.boundingClientRect.top - b.boundingClientRect.top
          );
          setActiveId(sorted[0].target.id);
        }
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: 0.1 }
    );

    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [ids]);

  return activeId;
}

/* ------------------------------------------------------------------ */
/*  Reusable components                                                */
/* ------------------------------------------------------------------ */
function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 mb-16">
      <h2 className="text-2xl font-bold mb-4 text-[var(--fg)] border-b border-[var(--border)] pb-2">
        {title}
      </h2>
      <div className="space-y-4 text-[var(--muted)] leading-relaxed">{children}</div>
    </section>
  );
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-6">
      <h3 className="text-lg font-semibold mb-2 text-[var(--fg)]">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4 overflow-x-auto text-sm font-mono text-[var(--fg)]">
      {children}
    </pre>
  );
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="bg-[var(--surface)] border border-[var(--border)] rounded px-1.5 py-0.5 text-sm font-mono text-[var(--accent)]">
      {children}
    </code>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border border-[var(--border)] rounded-lg overflow-hidden">
        <thead>
          <tr className="bg-[var(--surface)]">
            {headers.map((h, i) => (
              <th key={i} className="px-3 py-2 text-left font-semibold text-[var(--fg)] border-b border-[var(--border)]">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={i % 2 === 1 ? "bg-[var(--surface)]/50" : ""}>
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2 border-b border-[var(--border)] text-[var(--muted)]">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ApiEndpoint({ method, path, auth, desc }: { method: string; path: string; auth: string; desc: string }) {
  const methodColor =
    method === "GET" ? "text-green-400" :
    method === "POST" ? "text-blue-400" :
    method === "PUT" ? "text-yellow-400" :
    method === "PATCH" ? "text-orange-400" :
    "text-red-400";
  return (
    <div className="flex flex-wrap items-baseline gap-2 py-1.5 border-b border-[var(--border)]/50">
      <span className={`font-mono font-bold text-sm ${methodColor}`}>{method}</span>
      <span className="font-mono text-sm text-[var(--fg)]">{path}</span>
      <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--surface)] border border-[var(--border)] text-[var(--muted)]">{auth}</span>
      <span className="text-sm text-[var(--muted)]">{desc}</span>
    </div>
  );
}

function ToolDoc({ name, desc, params, returns, useCase }: { name: string; desc: string; params: string; returns: string; useCase: string }) {
  return (
    <div className="border border-[var(--border)] rounded-lg p-4 mb-3 bg-[var(--surface)]/30">
      <div className="font-mono font-bold text-[var(--accent)] mb-1">{name}</div>
      <p className="text-sm text-[var(--muted)] mb-2">{desc}</p>
      <div className="text-xs space-y-1">
        <div><span className="text-[var(--fg)] font-semibold">Params:</span> <span className="text-[var(--muted)]">{params}</span></div>
        <div><span className="text-[var(--fg)] font-semibold">Returns:</span> <span className="text-[var(--muted)]">{returns}</span></div>
        <div><span className="text-[var(--fg)] font-semibold">Use case:</span> <span className="text-[var(--muted)] italic">{useCase}</span></div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main page                                                          */
/* ------------------------------------------------------------------ */
export default function DocsPage() {
  const activeId = useScrollSpy(TOC.map((t) => t.id));
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const groups = [...new Set(TOC.map((t) => t.group))];

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
    setSidebarOpen(false);
  };

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-[var(--bg)]/95 backdrop-blur border-b border-[var(--border)] px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button
            className="lg:hidden p-1.5 rounded hover:bg-[var(--surface)]"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <Link href="/" className="text-lg font-bold text-[var(--accent)] hover:opacity-80">
            BlueprintParser
          </Link>
          <span className="text-sm text-[var(--muted)]">Documentation</span>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="https://github.com/goodmorningcoffee"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-[var(--muted)] hover:text-[var(--accent)] transition-colors"
          >
            GitHub
          </a>
          <Link href="/demo" className="text-sm text-[var(--muted)] hover:text-[var(--accent)] transition-colors">
            Demo
          </Link>
        </div>
      </header>

      <div className="flex pt-14">
        {/* Sidebar */}
        <aside
          className={`fixed top-14 bottom-0 w-64 border-r border-[var(--border)] bg-[var(--bg)] overflow-y-auto z-40 transition-transform lg:translate-x-0 ${
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <nav className="p-4 text-sm">
            {groups.map((group) => (
              <div key={group} className="mb-4">
                <div className="text-xs font-bold uppercase tracking-wider text-[var(--muted)] mb-2">
                  {group}
                </div>
                {TOC.filter((t) => t.group === group).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => scrollTo(t.id)}
                    className={`block w-full text-left px-2 py-1.5 rounded transition-colors ${
                      activeId === t.id
                        ? "bg-[var(--accent)]/10 text-[var(--accent)] font-medium"
                        : "text-[var(--muted)] hover:text-[var(--fg)] hover:bg-[var(--surface)]"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>
        </aside>

        {/* Overlay for mobile sidebar */}
        {sidebarOpen && (
          <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setSidebarOpen(false)} />
        )}

        {/* Main content */}
        <main className="flex-1 lg:ml-64 px-6 md:px-12 py-10 max-w-4xl">

          {/* ============================================================ */}
          {/* SECTION 1: INTRODUCTION                                       */}
          {/* ============================================================ */}
          <Section id="introduction" title="Introduction">
            <p className="text-[var(--fg)] text-lg">
              BlueprintParser is an open-source, AI-powered construction blueprint analysis platform.
              Upload PDF blueprints and get automatic text extraction (OCR), object detection (YOLO),
              page classification, table/schedule parsing, CSI code mapping, spatial analysis,
              multi-provider LLM chat, and quantity takeoff &mdash; all self-hostable and multi-tenant.
            </p>
            <p>
              Built for construction estimators, project managers, and anyone who works with architectural drawings.
              BlueprintParser turns static PDFs into structured, queryable, AI-readable data.
            </p>
            <div className="flex flex-wrap gap-3 mt-4">
              <a
                href="https://github.com/goodmorningcoffee"
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg hover:opacity-90 transition-opacity font-medium text-sm"
              >
                GitHub
              </a>
              <Link
                href="/demo"
                className="px-4 py-2 border border-[var(--border)] rounded-lg hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors font-medium text-sm"
              >
                Live Demo
              </Link>
            </div>

            <SubSection title="Quick Start">
              <Code>{`git clone https://github.com/goodmorningcoffee/BlueprintParser.git
cd BlueprintParser/blueprintparser_2
cp .env.example .env.local       # Edit DATABASE_URL, NEXTAUTH_SECRET at minimum
docker compose up -d              # PostgreSQL on port 5433
npm install
npx drizzle-kit migrate           # Create database tables
bash scripts/setup.sh             # Create root admin account (interactive)
npm run dev                       # http://localhost:3000`}</Code>
              <p>
                For full AWS deployment (Textract, S3, SageMaker, ECS), run the interactive setup wizard:
              </p>
              <Code>{`bash install_setup.sh             # Configure all services interactively
bash deploy.sh                    # Build + push to ECR + update ECS`}</Code>
              <p>
                Works without AWS credentials &mdash; PDF viewing, annotations, table parsing, QTO, and search
                are all functional locally. For the full pipeline, add: <InlineCode>GROQ_API_KEY</InlineCode> (free-tier LLM chat),
                AWS credentials (Textract OCR, S3 storage, SageMaker YOLO inference).
              </p>
            </SubSection>

            <SubSection title="Deployment Tiers">
              <Table
                headers={["Tier", "What You Get", "Est. Cost"]}
                rows={[
                  ["Local only (Docker Compose)", "PDF viewer, annotations, table parsing, QTO, search, LLM chat (Groq free tier)", "$0"],
                  ["Minimal AWS (S3 only)", "+ Cloud storage for PDFs and thumbnails", "~$5/month"],
                  ["Full AWS (ECS + RDS + SageMaker)", "+ Textract OCR, YOLO inference, Step Functions, multi-tenant", "~$150\u2013300/month"],
                  ["SageMaker GPU (on-demand)", "YOLO model inference jobs (ml.g4dn.xlarge)", "~$0.75/hour per run"],
                ]}
              />
            </SubSection>
          </Section>

          {/* ============================================================ */}
          {/* SECTION 2: GETTING STARTED                                    */}
          {/* ============================================================ */}
          <Section id="getting-started" title="Getting Started">
            <SubSection title="Uploading a Blueprint">
              <p>
                From the home dashboard, drag and drop a PDF file onto the upload area or click &ldquo;Choose files&rdquo;.
                The PDF is uploaded to storage and the processing pipeline begins automatically. You&rsquo;ll see a
                progress indicator while pages are rasterized and OCR-processed.
              </p>
            </SubSection>

            <SubSection title="How Processing Works">
              <p>
                When you upload a blueprint PDF, each page goes through a multi-stage pipeline:
              </p>
              <ol className="list-decimal list-inside space-y-1">
                <li>Pages are rasterized to PNG images</li>
                <li>OCR extracts every word with its position on the page (AWS Textract with Tesseract fallback)</li>
                <li>Drawing numbers are extracted from title blocks</li>
                <li>CSI MasterFormat codes are detected from the text</li>
                <li>Text annotations are classified (phone numbers, equipment names, dimensions, etc.)</li>
                <li>Page intelligence is computed (discipline classification, cross-references, note blocks)</li>
                <li>Full-text search index is built</li>
                <li>Project-wide analysis runs (discipline breakdown, CSI graph, reference graph)</li>
              </ol>
              <p>All of this happens automatically. YOLO object detection is a separate step you trigger manually.</p>
            </SubSection>

            <SubSection title="Navigating the Viewer">
              <p>
                The viewer is the main workspace. The center shows the PDF page, the left sidebar shows page thumbnails,
                and the right side hosts toggleable panels for different tools.
              </p>
              <Table
                headers={["Toolbar Button", "Panel", "Color When Active"]}
                rows={[
                  ["TEXT", "OCR text, annotations, markups, graph", "Green"],
                  ["CSI", "CSI MasterFormat codes", "Green"],
                  ["LLM Chat", "AI chat assistant", "Green"],
                  ["QTO", "Quantity takeoff tools", "Green"],
                  ["Schedules Tables", "Table/schedule parsing", "Pink"],
                  ["Keynotes", "Keynote parsing", "Amber"],
                  ["YOLO", "Object detection results", "Green/Red"],
                ]}
              />
            </SubSection>
          </Section>

          {/* ============================================================ */}
          {/* SECTION 3: PDF VIEWER & NAVIGATION                            */}
          {/* ============================================================ */}
          <Section id="viewer" title="PDF Viewer & Navigation">
            <SubSection title="Toolbar Controls">
              <p>The toolbar sits at the top of the viewer and contains:</p>
              <ul className="list-disc list-inside space-y-1">
                <li><strong>Back arrow</strong> &mdash; Return to the dashboard</li>
                <li><strong>Project name</strong> &mdash; Click to rename the project</li>
                <li><strong>Zoom controls</strong> &mdash; &minus;/+, percentage display, and Fit button</li>
                <li><strong>Mode toggle</strong> &mdash; Pointer Select, Pan Zoom, and Markup (three-state button group)</li>
                <li><strong>Symbol Search</strong> &mdash; Toggle symbol search mode (see Symbol Search section)</li>
                <li><strong>Search bar</strong> &mdash; Full-text search with live autocomplete. Wrap terms in quotes for exact phrase matching.</li>
                <li><strong>Trade filter</strong> &mdash; Filter by detected construction trade</li>
                <li><strong>CSI filter</strong> &mdash; Searchable dropdown grouped by CSI division</li>
                <li><strong>Panel buttons</strong> &mdash; Toggle each right-side panel (TEXT, CSI, LLM Chat, QTO, Schedules Tables, Keynotes)</li>
                <li><strong>YOLO button</strong> &mdash; Toggle detection overlay + panel. Dropdown arrow for per-model confidence sliders.</li>
                <li><strong>Menu</strong> &mdash; Data Labeling, Settings, Page Intelligence, Admin, Help</li>
              </ul>
            </SubSection>

            <SubSection title="Page Sidebar">
              <p>The left sidebar shows page thumbnails in a virtual-scrolled list. Features:</p>
              <ul className="list-disc list-inside space-y-1">
                <li>Click a thumbnail to jump to that page</li>
                <li>Right-click to rename a page</li>
                <li>&ldquo;Group by Sheet&rdquo; toggle groups pages by discipline prefix (A-, S-, M-, E-, etc.)</li>
                <li>Badges indicate content (annotations, keynotes, CSI codes)</li>
                <li>Pages are highlighted/filtered when search, CSI, trade, or keynote filters are active</li>
              </ul>
            </SubSection>

            <SubSection title="Keyboard Shortcuts">
              <Table
                headers={["Key", "Action"]}
                rows={[
                  ["Arrow Left/Right", "Previous/next page"],
                  ["Ctrl+F", "Focus search bar"],
                  ["Space", "Toggle pan mode"],
                  ["Escape", "Clear selections and filters"],
                  ["Scroll wheel", "Zoom in/out (cursor-centric)"],
                ]}
              />
            </SubSection>

            <SubSection title="Canvas Overlays">
              <p>Multiple overlay layers render on top of the PDF canvas:</p>
              <ul className="list-disc list-inside space-y-1">
                <li><strong>Search highlights</strong> &mdash; Yellow background on matching text</li>
                <li><strong>Text annotations</strong> &mdash; Color-coded detected text patterns</li>
                <li><strong>Keynote overlay</strong> &mdash; Keynote markers with key numbers</li>
                <li><strong>Annotation overlay</strong> &mdash; YOLO detections, user markups, QTO annotations</li>
                <li><strong>Parse region layer</strong> &mdash; Table/keynote bounding boxes with cell grid visualization</li>
                <li><strong>Guided parse overlay</strong> &mdash; Draggable grid lines during guided parsing</li>
                <li><strong>Drawing preview</strong> &mdash; Real-time feedback while drawing bounding boxes</li>
              </ul>
            </SubSection>
          </Section>

          {/* ============================================================ */}
          {/* SECTION 4: YOLO OBJECT DETECTION                              */}
          {/* ============================================================ */}
          <Section id="yolo" title="YOLO Object Detection">
            <p>
              BlueprintParser uses YOLOv8 models to detect objects on blueprint pages. Three pre-trained models
              are included:
            </p>
            <Table
              headers={["Model", "Classes", "Use"]}
              rows={[
                ["yolo_medium (136 MB)", "7: doors, tables, drawings, text boxes, title blocks, symbol legends", "General layout analysis"],
                ["yolo_precise (137 MB)", "2: door_single, door_double", "Precise door detection"],
                ["yolo_primitive (137 MB)", "16: circles, rectangles, triangles, hexagons, ovals, etc.", "Keynote symbol detection"],
              ]}
            />

            <SubSection title="Running a Detection Job">
              <ol className="list-decimal list-inside space-y-1">
                <li>Click the <strong>YOLO</strong> button in the toolbar</li>
                <li>In the dropdown, select a model</li>
                <li>Click <strong>Run</strong> to start a SageMaker processing job (GPU-accelerated)</li>
                <li>Wait for results to load &mdash; detections appear as colored bounding boxes on the canvas</li>
              </ol>
              <p>
                Each detection has a class name (e.g., &ldquo;circle&rdquo;, &ldquo;door_single&rdquo;),
                a confidence score (0&ndash;100%), and a bounding box.
              </p>
            </SubSection>

            <SubSection title="Models Tab">
              <p>The Detection panel&rsquo;s Models tab shows a hierarchy: Model &rarr; Class &rarr; Annotations.</p>
              <ul className="list-disc list-inside space-y-1">
                <li><strong>Min confidence slider</strong> &mdash; Filter detections below a threshold</li>
                <li><strong>Eye icon</strong> &mdash; Toggle visibility per model or class</li>
                <li><strong>Filter button</strong> &mdash; Click to filter the canvas to a single class</li>
                <li><strong>CSI Tags</strong> &mdash; Expandable section to assign CSI codes per class</li>
              </ul>
            </SubSection>

            <SubSection title="Tags Tab">
              <p>Tags are named YOLO+OCR bindings &mdash; a detected shape linked to the text inside it.</p>
              <ul className="list-disc list-inside space-y-1">
                <li><strong>Create Tag</strong> &mdash; Enter tag-picking mode, click a YOLO annotation on the canvas</li>
                <li><strong>Class scan</strong> &mdash; Scan all instances of a class to discover unique text values</li>
                <li><strong>Tag items</strong> &mdash; Show tag name, source (keynote/schedule/manual), instance count, per-page locations</li>
                <li><strong>Rename/delete</strong> &mdash; Expand a tag to edit its name or remove it</li>
                <li><strong>+ Add Missing</strong> &mdash; Manually add tag instances not auto-detected</li>
              </ul>
            </SubSection>
          </Section>

          {/* ============================================================ */}
          {/* SECTION 5: TABLE & SCHEDULE PARSING                           */}
          {/* ============================================================ */}
          <Section id="tables" title="Table & Schedule Parsing">
            <p>
              The Schedules/Tables panel has five tabs for extracting structured data from blueprint tables
              (door schedules, finish schedules, material schedules, etc.).
            </p>

            <SubSection title="Auto Parse">
              <ol className="list-decimal list-inside space-y-1">
                <li>Switch to the <strong>Auto Parse</strong> tab</li>
                <li>Draw bounding box(es) around table regions on the canvas</li>
                <li>Click <strong>Process Regions</strong> &mdash; runs the 7-method parsing pipeline</li>
                <li>Review the parsed grid (headers + rows) in the results view</li>
                <li>Optionally click <strong>Map Tags</strong> to create YOLO tags from a tag column</li>
                <li>Click <strong>Save</strong> to persist the parsed table</li>
              </ol>
            </SubSection>

            <SubSection title="Guided Parse">
              <p>
                Draw a bounding box, and the system proposes row/column grid lines. You can drag lines
                to reposition them, use &ldquo;Repeat Down&rdquo; / &ldquo;Repeat Right&rdquo; to tile uniform rows/columns,
                and adjust with live sliders:
              </p>
              <Table
                headers={["Slider", "Controls", "Default"]}
                rows={[
                  ["Row Sensitivity", "rowTolerance in row clustering", "0.006"],
                  ["Column Sensitivity", "minColGap in column detection", "0.015"],
                  ["Column Confidence", "minHitsRatio for keeping weak columns", "0.3"],
                  ["Expected Columns", "Force exact column count", "Auto"],
                ]}
              />
            </SubSection>

            <SubSection title="Manual Parse">
              <p>
                Enter table data directly in an editable grid. Add/remove rows and columns,
                rename headers, then save.
              </p>
            </SubSection>

            <SubSection title="Compare / Edit Cells">
              <p>
                Side-by-side view: the PDF region image on the left, the editable grid on the right.
                Click a cell in the grid to highlight the corresponding region on the PDF. Click a region
                on the PDF to jump to that cell in the grid.
              </p>
            </SubSection>

            <SubSection title="All Tables">
              <p>
                Project-wide list of all parsed tables with name, category, page number, and row/column counts.
                Click to navigate and edit. <strong>Export CSV</strong> button to download selected tables.
              </p>
            </SubSection>

            <SubSection title="Parsing Options (Advanced)">
              <p>
                The Auto Parse and Guided Parse tabs expose 8 adjustable controls that tune the parsing pipeline:
              </p>
              <Table
                headers={["Control", "What It Does"]}
                rows={[
                  ["rowTolerance", "How close words must be vertically to form a row"],
                  ["minColGap", "Minimum horizontal gap to split columns"],
                  ["colHitRatio", "Column must appear in this % of rows to be kept"],
                  ["headerMode", "First row as header vs. auto-detect"],
                  ["minHLineLengthRatio", "Min horizontal line length for grid detection"],
                  ["minVLineLengthRatio", "Min vertical line length for grid detection"],
                  ["clusteringTolerance", "Tolerance for clustering grid lines"],
                  ["mergerEditDistance", "Edit distance for cell text matching across methods"],
                ]}
              />
              <p>
                After adjusting, click <strong>Reparse Table</strong> to re-run with new settings. The workflow is
                designed to be iterative: parse &rarr; review &rarr; adjust &rarr; reparse.
              </p>
            </SubSection>

            <SubSection title="On-Canvas Visualization">
              <p>
                Toggle color modes in the panel header: <strong>Off</strong>, <strong>Rows</strong> (alternating row colors),
                or <strong>Grid</strong> (individual cell fills). Clickable tag cells on the canvas highlight all
                instances of that tag across pages.
              </p>
            </SubSection>

            <SubSection title="Tag Mapping">
              <p>
                After parsing, select a YOLO class from the dropdown (e.g., &ldquo;circle&rdquo;) and click <strong>Map Tags</strong>.
                The system matches tag column values (like &ldquo;D-01&rdquo;, &ldquo;D-02&rdquo;) against YOLO detections + OCR text
                across the project, creating tag instances that link schedule entries to their locations on drawings.
              </p>
            </SubSection>

            <SubSection title="Cell Structure Detection (TATR)">
              <p>
                The <strong>Detect Cell Structure</strong> button runs Microsoft&rsquo;s Table Transformer model
                to detect individual cells, rows, columns, and spanning cells. Results render as dashed cyan borders
                on the canvas. Click a cell to search by its text; double-click to toggle highlight.
              </p>
            </SubSection>
          </Section>

          {/* ============================================================ */}
          {/* SECTION 6: KEYNOTE PARSING                                    */}
          {/* ============================================================ */}
          <Section id="keynotes" title="Keynote Parsing">
            <p>
              Keynotes are two-column key:description tables commonly found on architectural drawings
              (e.g., &ldquo;1 &mdash; PAINT FINISH GWB&rdquo;). The Keynotes panel has three tabs:
            </p>
            <ul className="list-disc list-inside space-y-1">
              <li><strong>All Keynotes</strong> &mdash; Project-wide list of parsed keynotes with CSV export</li>
              <li><strong>Guided</strong> &mdash; Draw a bounding box, adjust grid lines, extract key:description pairs</li>
              <li><strong>Manual</strong> &mdash; Enter keynotes directly in a 2-column editable grid</li>
            </ul>
            <p>
              After parsing, use <strong>Map Tags</strong> to link keynote keys to YOLO-detected symbols
              on the drawings. The on-canvas keynote overlay shows keynote markers with their key numbers.
            </p>
          </Section>

          {/* ============================================================ */}
          {/* SECTION 7: QUANTITY TAKEOFF (QTO)                              */}
          {/* ============================================================ */}
          <Section id="qto" title="Quantity Takeoff (QTO)">
            <p>
              The QTO panel provides tools for counting, measuring areas, and measuring linear distances on blueprints.
            </p>

            <SubSection title="Count Takeoff">
              <p>
                Switch to Markup mode, draw count markers on the canvas (shapes: circle, square, triangle,
                pentagon, hexagon). Each placement increments the count. Markers scale with zoom so they stay
                visible at any zoom level.
              </p>
            </SubSection>

            <SubSection title="Area Takeoff">
              <p>
                Draw polygons on the canvas to measure areas. After calibration (setting a known real-world
                distance), areas are displayed in square feet. Polygons are filled with a semi-transparent color.
              </p>
            </SubSection>

            <SubSection title="Linear Takeoff">
              <p>
                Draw polylines to measure linear distances. After calibration, lengths display in feet.
                Each linear item has a visibility toggle (eye icon) to show/hide.
              </p>
            </SubSection>

            <SubSection title="Calibration">
              <p>
                Set the scale by clicking two points of a known distance (e.g., a dimension line on the drawing),
                then entering the real-world distance. All area and linear measurements use this calibration.
              </p>
            </SubSection>

            <SubSection title="CSV Export">
              <p>
                Click <strong>Export CSV</strong> to open an editable spreadsheet modal with all takeoff items.
                Columns: Item Name, Type, Shape, Color, Quantity, Unit, Pages, Notes.
                Editable columns: Name, Color, Notes. Text wrapping is togglable.
              </p>
            </SubSection>
          </Section>

          {/* ============================================================ */}
          {/* SECTION 8: SYMBOL SEARCH                                      */}
          {/* ============================================================ */}
          <Section id="symbol-search" title="Symbol Search">
            <p>
              Find all instances of a specific symbol across all blueprint pages using template matching.
            </p>
            <ol className="list-decimal list-inside space-y-1">
              <li>Click the <strong>Symbol</strong> button in the toolbar</li>
              <li>Draw a bounding box around the symbol you want to find</li>
              <li>Configure search parameters: confidence threshold, multi-scale matching, SIFT fallback</li>
              <li>Click <strong>Run Search</strong> &mdash; results stream in page-by-page</li>
              <li>Results show per-page groups with confidence scores and detection method (SIFT/ORB)</li>
              <li>Adjust the confidence slider post-search to refine results</li>
              <li>Dismiss false positives with the &times; button per match</li>
            </ol>

            <SubSection title="Advanced Options">
              <Table
                headers={["Option", "Description", "Default"]}
                rows={[
                  ["Min Scale", "Minimum scale factor for multi-scale matching", "0.8"],
                  ["Max Scale", "Maximum scale factor", "1.5"],
                  ["NMS Threshold", "Non-max suppression to remove overlapping matches", "0.3"],
                  ["Max Results/Page", "Cap results per page to prevent false positive floods", "50"],
                ]}
              />
            </SubSection>
          </Section>

          {/* ============================================================ */}
          {/* SECTION 9: LLM CHAT                                           */}
          {/* ============================================================ */}
          <Section id="llm-chat" title="LLM Chat">
            <p>
              Chat with an AI assistant about your blueprints. The assistant has access to all extracted data
              (OCR text, YOLO detections, CSI codes, parsed tables, page intelligence) and can call tools
              to search, navigate, and annotate.
            </p>
            <ul className="list-disc list-inside space-y-1">
              <li><strong>Scope toggle</strong> &mdash; &ldquo;Page&rdquo; for single-page context, &ldquo;Project&rdquo; for full project</li>
              <li><strong>Suggested prompts</strong> &mdash; Quick-click buttons tailored to the page discipline</li>
              <li><strong>Streaming responses</strong> &mdash; Responses stream in real-time</li>
              <li><strong>Tool calls</strong> &mdash; The assistant can search pages, look up CSI codes, navigate to pages, and highlight regions</li>
              <li><strong>Clear</strong> &mdash; Reset the conversation history</li>
            </ul>
            <p>
              Supports multiple LLM providers: Anthropic Claude, OpenAI GPT-4o, Groq Llama, or custom
              OpenAI-compatible endpoints. Configure in the Admin &rarr; LLM/Context tab.
            </p>
          </Section>

          {/* ============================================================ */}
          {/* SECTION 10: CSI CODES PANEL                                   */}
          {/* ============================================================ */}
          <Section id="csi-panel" title="CSI Codes Panel">
            <p>
              <strong>CSI MasterFormat</strong> is the standard classification system for construction specifications.
              BlueprintParser auto-detects CSI codes from OCR text, YOLO detections, and parsed tables.
              Codes are organized into divisions (e.g., Division 08 = Openings, Division 22 = Plumbing).
            </p>
            <ul className="list-disc list-inside space-y-1">
              <li><strong>Scope toggle</strong> &mdash; View codes for the current page or the entire project</li>
              <li><strong>Search</strong> &mdash; Filter by code number or description (e.g., &ldquo;08&rdquo;, &ldquo;door&rdquo;, &ldquo;plumbing&rdquo;)</li>
              <li><strong>Division grouping</strong> &mdash; Collapsible groups by CSI division</li>
              <li><strong>Network graph</strong> &mdash; Shows CSI division co-occurrence relationships and clusters (MEP, Architectural, Structural, Site)</li>
              <li><strong>Click a code</strong> &mdash; Activates a filter that highlights pages containing that code</li>
            </ul>
          </Section>

          {/* ============================================================ */}
          {/* SECTION 11: TEXT & ANNOTATIONS                                 */}
          {/* ============================================================ */}
          <Section id="text-panel" title="Text & Annotations Panel">
            <p>The Text panel has four tabs:</p>
            <ul className="list-disc list-inside space-y-1">
              <li><strong>OCR</strong> &mdash; Raw Textract-extracted lines for the current page, with search term highlighting</li>
              <li><strong>Annotations</strong> &mdash; Auto-detected text patterns grouped by category: Contact info, Codes, CSI, Dimensions, Equipment, References, Trade, Abbreviations, Notes, Rooms (37+ detector types)</li>
              <li><strong>Markups</strong> &mdash; User-drawn markup annotations with labels</li>
              <li><strong>Graph</strong> &mdash; Network visualization of text region relationships</li>
            </ul>
            <p>Click any annotation to filter/highlight it on the canvas.</p>
          </Section>

          {/* ============================================================ */}
          {/* SECTION 12: PAGE INTELLIGENCE                                  */}
          {/* ============================================================ */}
          <Section id="page-intelligence" title="Page Intelligence">
            <p>
              Access via <strong>Menu &rarr; Page Intelligence</strong>. Shows all computed intelligence for the current page:
            </p>
            <ul className="list-disc list-inside space-y-1">
              <li><strong>Classification</strong> &mdash; Discipline (Architectural, Structural, etc.), drawing type, series, confidence</li>
              <li><strong>Cross-References</strong> &mdash; Links to other sheets (&ldquo;SEE A-501&rdquo;, &ldquo;DETAIL 3/A-501&rdquo;)</li>
              <li><strong>Note Blocks</strong> &mdash; Extracted general notes with titles and content</li>
              <li><strong>Heuristic Inferences</strong> &mdash; Rule-based detections (e.g., &ldquo;This page contains a door schedule&rdquo;) with confidence and evidence</li>
              <li><strong>Classified Tables</strong> &mdash; Detected table types (door-schedule, finish-schedule, material-schedule, etc.)</li>
              <li><strong>Text Regions</strong> &mdash; Classified text blocks (paragraph, table-like, key-value)</li>
              <li><strong>Parsed Regions</strong> &mdash; Saved parsed tables/keynotes with headers and CSI tags</li>
            </ul>
            <p>Use the <strong>Copy</strong> button to copy a plain-text summary to clipboard.</p>
          </Section>

          {/* ============================================================ */}
          {/* SECTION 13: SETTINGS & MENU                                   */}
          {/* ============================================================ */}
          <Section id="settings" title="Settings & Menu">
            <SubSection title="Settings Modal (Menu > Settings)">
              <ul className="list-disc list-inside space-y-1">
                <li>Three dark themes: Midnight, Slate, Graphite</li>
                <li>Grid display mode: striped, checkerboard, none</li>
                <li>Text wrapping toggle for editable grids</li>
                <li>Annotation opacity slider</li>
              </ul>
            </SubSection>

            <SubSection title="Data Labeling (Menu > Data Labeling)">
              <p>
                Wizard for creating Label Studio annotation projects. Select shape type,
                draw shapes on the canvas, assign labels, and export to Label Studio format
                for training custom YOLO models.
              </p>
            </SubSection>

            <SubSection title="Other Menu Items">
              <ul className="list-disc list-inside space-y-1">
                <li><strong>Page Intelligence</strong> &mdash; Opens the Page Intelligence panel</li>
                <li><strong>Admin</strong> &mdash; Navigate to the admin dashboard</li>
                <li><strong>Help</strong> &mdash; Toggle help tips overlay</li>
              </ul>
            </SubSection>
          </Section>

          {/* ============================================================ */}
          {/* SECTION 14: ADMIN DASHBOARD                                   */}
          {/* ============================================================ */}
          <Section id="admin" title="Admin Dashboard">
            <p>
              The admin dashboard (<InlineCode>/admin</InlineCode>) provides full control over the platform.
              Access requires admin role.
            </p>
            <Table
              headers={["Tab", "Purpose"]}
              rows={[
                ["Overview", "Project list, reprocess controls (Page Names, Text Annotations + CSI, Intelligence), system status"],
                ["Pipeline", "Processing step toggles, page concurrency, CSI spatial grid resolution, table proposals config"],
                ["AI Models", "YOLO model registry, S3 upload, run/load/status per project"],
                ["Heuristics", "Rule editor: YOLO class picker, text keywords, spatial conditions, CSI affinity"],
                ["LLM / Context", "4 panels: section control (toggle/priority/%), system prompt editor, budget config, context preview tool"],
                ["CSI Codes", "CSI database browser, class-level CSI tagging for YOLO models"],
                ["Text Annotations", "Detector toggle (30+ types), preview per page"],
                ["Page Intelligence", "Classification results, heuristic inferences, reprocess by scope"],
                ["Users", "User management, roles, invites, password resets, API key management"],
                ["Settings", "Feature toggles (SageMaker, Quota), toggle password, admin password change"],
              ]}
            />
            <p>
              Root admins see additional tabs: <strong>Companies / Users</strong> (multi-tenant management)
              and <strong>AI RBAC</strong> (model permissions).
            </p>
          </Section>

          {/* ============================================================ */}
          {/*  TECHNICAL DOCUMENTATION                                      */}
          {/* ============================================================ */}
          <div className="mt-20 mb-10 border-t border-[var(--border)] pt-10">
            <h1 className="text-3xl font-bold text-[var(--fg)]">Technical Documentation</h1>
            <p className="text-[var(--muted)] mt-2">
              Deep-dive into the processing pipeline, detection engines, and context system.
            </p>
          </div>

          {/* ============================================================ */}
          {/* SECTION 15: ARCHITECTURE OVERVIEW                              */}
          {/* ============================================================ */}
          <Section id="architecture" title="Architecture Overview">
            <SubSection title="System Architecture">
              <Code>{`                                 +------------------+
                                 |   CloudFront     |
                                 |  (assets CDN)    |
                                 +--------+---------+
                                          |
+-------------+    HTTPS    +-------------+-----------+    S3     +------------------+
|   Browser   +------------>+   ALB (TLS termination) +---------->+  S3 Data Bucket  |
|  (pdf.js +  |             +-------------+-----------+           |  (PDFs, thumbs,  |
|   Zustand)  |                           |                       |   YOLO results,  |
+-------------+                           v                       |   model weights) |
                            +-------------+-----------+           +------------------+
                            |   ECS Fargate (2vCPU)   |
                            |   Next.js 16 + API      |
                            |   77+ endpoints          |
                            +--+--------+----------+--+
                               |        |          |
                  +------------+   +----+----+   +-+-----------+
                  |                |         |   |             |
                  v                v         v   v             v
           +------+------+  +-----+---+ +---+---+--+  +-------+--------+
           |  RDS PG 16  |  | Textract| | Secrets  |  | Step Functions  |
           |  (14 tables)|  | (OCR)   | | Manager  |  | (orchestrator)  |
           +-------------+  +---------+ +----------+  +-------+--------+
                                                               |
                                                               v
                                                    +----------+---------+
                                                    | ECS Task (8vCPU)   |
                                                    | CPU Processing     |
                                                    +--------------------+
                                                    +--------------------+
                                                    | SageMaker GPU      |
                                                    | ml.g4dn.xlarge     |
                                                    | (YOLOv8 inference) |
                                                    +--------------------+`}</Code>
            </SubSection>

            <SubSection title="Tech Stack">
              <Table
                headers={["Layer", "Technology"]}
                rows={[
                  ["Runtime", "Next.js 16 (App Router), React 19, TypeScript 5"],
                  ["State", "Zustand 5 (single store, 15 slice selectors, useShallow() memoization)"],
                  ["PDF Rendering", "pdfjs-dist 4, HTML5 Canvas (7 overlay layers), CSS transform zoom"],
                  ["Styling", "Tailwind 4, 3 dark themes (Midnight/Slate/Graphite)"],
                  ["Database", "PostgreSQL 16, Drizzle ORM, 15 migrations"],
                  ["Auth", "NextAuth 5 (credentials + Google OAuth), bcrypt, JWT"],
                  ["AI/LLM", "Multi-provider (Groq/Anthropic/OpenAI/Custom), streaming SSE, priority-ordered context"],
                  ["Computer Vision", "OpenCV (table lines, keynotes), Tesseract (fallback OCR), YOLOv8/ultralytics"],
                  ["Search", "PostgreSQL tsvector + GIN index, ts_rank + ts_headline, global cross-project"],
                  ["Infrastructure", "Terraform, ECS Fargate, S3/CloudFront, RDS, SageMaker, Step Functions"],
                ]}
              />
            </SubSection>

            <SubSection title="Frontend Component Hierarchy">
              <Code>{`PDFViewer (root — scroll, zoom, keyboard shortcuts)
├── ViewerToolbar (mode, zoom, search, panel toggles)
├── PageSidebar (thumbnails, page filtering, lazy-loaded)
├── SymbolSearchPanel (floating popup, 4 states)
├── PDFPage (canvas + overlays)
│   ├── SearchHighlightOverlay — search + CSI word highlights
│   ├── TextAnnotationOverlay — auto-detected text patterns
│   ├── KeynoteOverlay — keynote markers
│   ├── GuidedParseOverlay — draggable grid lines
│   ├── ParseRegionLayer — table/keynote parse bounding boxes
│   └── AnnotationOverlay (orchestrator — ALL mouse events)
│       └── DrawingPreviewLayer — in-progress BB/polygon/calibration
├── Right panels (toggled):
│   ├── TextPanel, ChatPanel, TakeoffPanel, DetectionPanel
│   ├── CsiPanel, PageIntelligencePanel
│   ├── TableParsePanel (5 tabs)
│   ├── KeynotePanel (3 tabs)
│   └── TableCompareModal (side-by-side)
└── MarkupDialog (modal)`}</Code>
            </SubSection>
          </Section>

          {/* ============================================================ */}
          {/* SECTION 16: PROCESSING PIPELINE                                */}
          {/* ============================================================ */}
          <Section id="pipeline" title="Processing Pipeline">
            <p>
              The processing pipeline transforms raw PDF pixels into structured, LLM-consumable intelligence
              through six interconnected systems. Each system adds signal while reducing noise, outputting
              confidence scores rather than binary decisions.
            </p>

            <SubSection title="Pipeline Flow">
              <Code>{`Raw pixels → OCR words → spatial clusters → semantic regions →
classified tables → YOLO-text bindings → tag patterns →
page intelligence → project graph → LLM context`}</Code>
            </SubSection>

            <SubSection title="Upload Processing (per page, 8 concurrent)">
              <ol className="list-decimal list-inside space-y-2">
                <li><strong>PDF Rasterization</strong> &mdash; Ghostscript converts each page to PNG at 300 DPI</li>
                <li><strong>OCR with Fallback Chain</strong>
                  <ul className="list-disc list-inside ml-6 mt-1">
                    <li>Tier 1: AWS Textract at full resolution (with 3-retry exponential backoff)</li>
                    <li>Tier 2: Textract at 50% resolution (handles large/high-res PDFs)</li>
                    <li>Tier 3: Local Tesseract OCR (when Textract unavailable)</li>
                  </ul>
                </li>
                <li><strong>Drawing Number Extraction</strong> &mdash; Regex + position scoring on title block region</li>
                <li><strong>CSI Code Detection</strong> &mdash; 3-tier matching against 8,951-row MasterFormat database</li>
                <li><strong>Text Annotation Detection</strong> &mdash; 30+ regex detectors (phone, email, equipment, dimensions, etc.)</li>
                <li><strong>Page Intelligence</strong> (3 sub-systems):
                  <ul className="list-disc list-inside ml-6 mt-1">
                    <li>System 1: Text region classification (OCR clustering &rarr; table-like, notes, key-value)</li>
                    <li>System 2: Heuristic engine (rule-based: text keywords + YOLO spatial + CSI affinity)</li>
                    <li>System 3: Table meta-classifier (combines Systems 1+2 &rarr; door-schedule, finish-schedule, etc.)</li>
                  </ul>
                </li>
                <li><strong>CSI Spatial Heatmap</strong> &mdash; NxN grid (configurable, default 3x3) with title-block and right-margin zones</li>
                <li><strong>Full-Text Search Index</strong> &mdash; PostgreSQL tsvector generation with GIN index</li>
                <li><strong>Project-Level Analysis</strong> &mdash; Discipline breakdown, reference graph, CSI topology, auto-generated summaries</li>
              </ol>
              <p className="mt-3">
                Each step is wrapped in an independent try-catch. One step failing does not block the pipeline.
                Page concurrency defaults to 8 (configurable via admin, Textract limit: 10 TPS).
              </p>
            </SubSection>

            <SubSection title="Post-YOLO Processing (user-triggered)">
              <Code>{`POST /api/yolo/run → SageMaker Processing Job (ml.g4dn.xlarge GPU)
  │
  v
POST /api/yolo/load → Load results from S3
  ├── Create annotations (source='yolo') with class-level CSI codes
  ├── Re-run heuristic engine with YOLO spatial signals (phase 2)
  ├── Reclassify tables with YOLO-enriched heuristic data
  └── Merge YOLO CSI codes into page-level csiCodes`}</Code>
            </SubSection>
          </Section>

          {/* ============================================================ */}
          {/* SECTION 17: YOLO DETECTION ENGINE                              */}
          {/* ============================================================ */}
          <Section id="yolo-engine" title="YOLO Detection Engine">
            <SubSection title="Architecture">
              <p>
                YOLO runs as SageMaker Processing Jobs on <InlineCode>ml.g4dn.xlarge</InlineCode> GPU instances.
                Models are stored in S3, and each job processes all pages of a project in batch.
              </p>
              <Code>{`SageMaker Processing Job →
  Reads page images from S3: s3://bucket/companyKey/projectHash/pages/
  Reads model from S3: s3://bucket/models/model-name/
  Runs YOLOv8 inference with config
  Outputs JSON per page: s3://bucket/.../yolo-output/model-name/page_X.json`}</Code>
            </SubSection>

            <SubSection title="Model Configuration">
              <Table
                headers={["Parameter", "Default", "Description"]}
                rows={[
                  ["confidence", "0.10", "Minimum detection confidence"],
                  ["iou", "0.60", "Intersection-over-union threshold for NMS"],
                  ["imgsz", "1280", "Input image size for inference"],
                  ["classes", "(per model)", "List of class names (e.g., circle, oval, table)"],
                ]}
              />
            </SubSection>

            <SubSection title="Detection Output">
              <p>
                Per-page JSON with bounding boxes in normalized 0-1 coordinates (top-left origin):
              </p>
              <Code>{`{
  "annotations": [
    {
      "name": "circle",
      "bbox": [0.12, 0.34, 0.15, 0.37],  // [x1, y1, x2, y2]
      "confidence": 0.87
    }
  ]
}`}</Code>
            </SubSection>

            <SubSection title="Tag Matching Engine (yolo-tag-engine.ts)">
              <p>
                Maps YOLO shape detections to nearby OCR text, creating tag instances:
              </p>
              <ol className="list-decimal list-inside space-y-1">
                <li>Find all OCR words whose center falls inside the YOLO bbox</li>
                <li>Sort left-to-right, concatenate &rarr; candidate text</li>
                <li>Match against target tag:
                  <ul className="list-disc list-inside ml-6 mt-1">
                    <li>Exact match &rarr; confidence 1.0</li>
                    <li>Edit distance &le; 1 (text &ge; 3 chars) &rarr; confidence 0.9</li>
                    <li>Short tags (1-2 chars) require exact match only</li>
                  </ul>
                </li>
              </ol>
              <p>
                <strong>Fuzzy matching</strong> handles OCR confusion: 0&harr;O, 1&harr;l/I, 5&harr;S, but rejects
                digit-to-digit substitutions to prevent false positives.
              </p>
              <p>
                <strong>Free-floating mode</strong>: For tags without YOLO shapes, scans all OCR words directly.
                Single-word tags scan all words on page; multi-word tags use a sliding window with bbox merging.
              </p>
            </SubSection>

            <SubSection title="Tag Pattern Detection">
              <Code>{`Input: 5 circles containing "T-01", "T-02", "T-03", "T-04", "T-05"
  1. For each YOLO detection, extract overlapping OCR text
  2. Extract prefix pattern: "T-01" → prefix "T-"
  3. Group by (yoloClass, prefix): "circle__T-" → 5 instances
  4. Build TagGroup: { pattern: "T-\\d+", instances: 5 }`}</Code>
            </SubSection>
          </Section>

          {/* ============================================================ */}
          {/* SECTION 18: CSI MAPPING ENGINE                                 */}
          {/* ============================================================ */}
          <Section id="csi-engine" title="CSI Mapping Engine">
            <p>
              CSI MasterFormat codes are the universal embedding layer that connects every system.
              OCR text, YOLO detections, parsed tables, spatial zones, and LLM context are all tagged
              with CSI codes &mdash; enabling 40:1 compression of raw OCR into structured navigation.
            </p>

            <SubSection title="3-Tier Detection Algorithm">
              <Table
                headers={["Tier", "Method", "Confidence", "Description"]}
                rows={[
                  ["1", "Exact subphrase", "0.95", "Consecutive significant words from CSI description appear together in text"],
                  ["2", "Bag-of-words", "up to 0.75", "Score = (matched/total)\u00B2 \u2014 squared penalty rewards near-complete overlap"],
                  ["3", "Keyword anchors", "up to 0.50", "Rare words weighted by inverse document frequency (IDF-like)"],
                ]}
              />
              <p>
                Multi-tier boost: +0.05 when both Tier 2 and Tier 3 agree independently.
                Matches run against an 8,951-row MasterFormat 2004 database.
              </p>
            </SubSection>

            <SubSection title="CSI Embedding Strategy">
              <p>Every element in the system gets CSI-tagged:</p>
              <Code>{`Textract words → CSI codes (via csi-detect)
YOLO detections → CSI codes (via model config classCsiCodes)
Parsed table rows → CSI codes (via content matching)
Text annotations → CSI tags (via csi-detect on annotation text)
Spatial zones → CSI divisions (via csi-spatial heatmap)
User markups → CSI codes (via manual tagging in annotation editor)`}</Code>
              <p>
                All sources merge into page-level <InlineCode>csiCodes</InlineCode>. The CSI co-occurrence
                graph tracks which divisions appear together across pages, building clusters
                (MEP, Architectural, Structural, Site) with cross-reference edges.
              </p>
            </SubSection>

            <SubSection title="CSI Spatial Heatmap">
              <p>
                Each page is divided into a configurable NxN grid (3x3 default, up to 12x12) plus
                special zones: title-block (y &gt; 0.85), right-margin (x &gt; 0.75). All CSI-tagged
                elements are binned by bbox center into zones.
              </p>
              <p>
                Output: per-zone division breakdown + natural language summary (e.g., &ldquo;Door-related
                content (Div 08) clusters in center drawing area; Plumbing (Div 22) clusters in bottom-right&rdquo;).
                Fed to the LLM at priority 7.0 in context builder.
              </p>
            </SubSection>
          </Section>

          {/* ============================================================ */}
          {/* SECTION 19: TABLE PARSING PIPELINE                             */}
          {/* ============================================================ */}
          <Section id="table-pipeline" title="Table Parsing Pipeline (7-Method Merge)">
            <p>
              Seven independent extraction methods run on user-drawn bounding boxes. Results are merged by a
              grid merger that selects the highest-confidence alignment and fills cells from multiple sources.
            </p>

            <SubSection title="The Seven Methods">
              <Table
                headers={["#", "Method", "Technology", "Best For"]}
                rows={[
                  ["1", "OCR Word Positions", "TypeScript (Textract words)", "Any table with readable text"],
                  ["2", "OpenCV Line Detection", "Python (Hough transform)", "Tables with visible rule lines"],
                  ["3", "Textract Native Tables", "AWS API", "Well-structured PDF tables"],
                  ["4", "img2table", "Python (Hough + morphology)", "Image-based tables with borders"],
                  ["5", "Camelot Lattice", "Python (PDF vector lines)", "Native PDFs with ruled lines"],
                  ["6", "Camelot Stream", "Python (text positioning)", "Borderless tables"],
                  ["7", "pdfplumber", "Python (PDF line/rect objects)", "Raw PDF geometry with sub-pixel precision"],
                ]}
              />
            </SubSection>

            <SubSection title="Grid Merger Algorithm">
              <ol className="list-decimal list-inside space-y-1">
                <li>Sort methods by confidence (highest first)</li>
                <li>Use highest-confidence grid as base</li>
                <li>Grid shape guard: exclude methods with wildly different col/row counts (&gt;50% difference)</li>
                <li>Row alignment check: sample row content similarity before merging</li>
                <li>For each cell: check agreement across methods</li>
                <li>Fill empty cells from first non-empty method</li>
                <li>Flag disagreements (multiple methods disagree on cell value)</li>
                <li>Final confidence = base_conf &times; 0.6 + agreement_rate &times; 0.3 + method_bonus (0&ndash;0.15)</li>
              </ol>
            </SubSection>

            <SubSection title="TATR Post-Processing">
              <p>
                Microsoft Table Transformer (<InlineCode>table-transformer-structure-recognition-v1.1-all</InlineCode>, 115MB)
                runs as a manual step (&ldquo;Detect Cell Structure&rdquo; button). It detects rows, columns,
                headers, and spanning cells as bounding boxes. Cell text is filled from Textract OCR words.
              </p>
            </SubSection>

            <SubSection title="Output Format">
              <Code>{`{
  "headers": ["NO", "TAG", "DESCRIPTION", "QTY"],
  "rows": [
    {"NO": "1", "TAG": "D-01", "DESCRIPTION": "SINGLE DOOR 3070", "QTY": "5"},
    {"NO": "2", "TAG": "D-02", "DESCRIPTION": "DOUBLE DOOR 6070", "QTY": "2"}
  ],
  "tagColumn": "TAG",
  "confidence": 0.85,
  "methods": [
    {"name": "ocr-positions", "confidence": 0.82, "gridShape": [12, 4]},
    {"name": "camelot-lattice", "confidence": 0.91, "gridShape": [12, 4]}
  ],
  "disagreements": [
    {"row": 5, "col": "QTY", "values": [{"method": "ocr", "value": "3"}, {"method": "camelot", "value": "8"}]}
  ]
}`}</Code>
            </SubSection>
          </Section>

          {/* ============================================================ */}
          {/* SECTION 20: LLM CONTEXT SYSTEM                                */}
          {/* ============================================================ */}
          <Section id="llm-context" title="LLM Context System">
            <p>
              The core compression engine. Transforms ~250K tokens of raw OCR into ~6K tokens of structured,
              priority-ordered context &mdash; a <strong>40:1 compression ratio</strong> that makes small
              models (Haiku, Llama) viable for blueprint Q&amp;A.
            </p>

            <SubSection title="Context Sections (Priority-Ordered)">
              <Table
                headers={["Priority", "Section", "Source"]}
                rows={[
                  ["0.5", "Project Intelligence Report", "Auto-generated summary"],
                  ["1.0", "YOLO Detection Counts", "annotations (source='yolo')"],
                  ["1.0", "CSI Network Graph", "Division co-occurrence graph"],
                  ["1.5", "Page Classification", "Discipline, drawing type, series"],
                  ["2.0", "User Annotations", "annotations (source='user')"],
                  ["3.0", "Takeoff Notes", "takeoffItems"],
                  ["3.5", "Cross-References", "Sheet-to-sheet links"],
                  ["4.0", "CSI Codes", "Page-level CSI codes"],
                  ["5.0", "Text Annotations", "37 detected types"],
                  ["5.5", "Note Blocks", "Extracted general notes"],
                  ["5.8", "Parsed Tables/Keynotes", "parsedRegions"],
                  ["6.0", "Detected Regions", "classifiedTables"],
                  ["7.0", "CSI Spatial Distribution", "Zone-based heatmap"],
                  ["8.0", "Spatial OCR\u2192YOLO Context", "OCR words mapped to YOLO regions"],
                  ["10.0", "Raw OCR Text", "Full text (fallback, often truncated)"],
                ]}
              />
            </SubSection>

            <SubSection title="Dynamic Budgeting">
              <p>
                Context budget is determined by model:
              </p>
              <Table
                headers={["Provider", "Model", "Budget"]}
                rows={[
                  ["Anthropic", "Claude Opus", "200K chars"],
                  ["Anthropic", "Claude Sonnet", "80K chars"],
                  ["OpenAI", "GPT-4o", "60K chars"],
                  ["Groq", "Llama 3.3 70B", "24K chars"],
                ]}
              />
              <p>
                Each section gets a percentage of the budget. Unused allocation flows to a shared overflow
                pool that redistributes to sections needing more space. Three presets:
              </p>
              <ul className="list-disc list-inside space-y-1">
                <li><strong>Balanced</strong> &mdash; Equal distribution across sections</li>
                <li><strong>Structured</strong> &mdash; Parsed tables 25%, CSI spatial 8%, spatial context 12%, raw OCR 5%</li>
                <li><strong>Verbose</strong> &mdash; Raw OCR 40%, spatial 15%, parsed tables 10%</li>
              </ul>
              <p>
                All configurable via admin LLM/Context tab (4 panels: section control, system prompt,
                budget config, context preview tool).
              </p>
            </SubSection>

            <SubSection title="Multi-Provider Support">
              <p>
                Resolution chain: User API key &rarr; Company config &rarr; Environment variable. All providers
                stream via SSE.
              </p>
              <Table
                headers={["Provider", "Models", "Tool-Use"]}
                rows={[
                  ["Anthropic", "Claude Opus/Sonnet/Haiku", "Planned"],
                  ["OpenAI", "GPT-4o, o1/o3", "Planned"],
                  ["Groq", "Llama 3.3 70B", "Partial"],
                  ["Custom/Ollama", "Any OpenAI-compatible", "Context-only"],
                ]}
              />
            </SubSection>
          </Section>

          {/* ============================================================ */}
          {/* SECTION 21: DOMAIN KNOWLEDGE & HEURISTICS                      */}
          {/* ============================================================ */}
          <Section id="heuristics" title="Domain Knowledge & Heuristics">
            <SubSection title="Drawing Conventions">
              <Table
                headers={["Prefix", "Discipline"]}
                rows={[
                  ["G-xxx", "General"],
                  ["C-xxx", "Civil"],
                  ["A-xxx", "Architectural"],
                  ["S-xxx", "Structural"],
                  ["M-xxx", "Mechanical"],
                  ["E-xxx", "Electrical"],
                  ["P-xxx", "Plumbing"],
                ]}
              />
              <p>
                Series conventions: x-0xx (General/Cover), x-1xx (Plans), x-2xx (Elevations),
                x-3xx (Sections), x-4xx+ (Details/Schedules).
              </p>
            </SubSection>

            <SubSection title="Heuristic Rule Components">
              <p>
                Rules are JSON-based (no code required). Each rule consists of:
              </p>
              <ul className="list-disc list-inside space-y-1">
                <li><InlineCode>yoloRequired[]</InlineCode> &mdash; Must have these YOLO classes detected</li>
                <li><InlineCode>textKeywords[]</InlineCode> &mdash; OCR text must contain these words</li>
                <li><InlineCode>spatialConditions[]</InlineCode> &mdash; &ldquo;contains&rdquo;, &ldquo;overlaps&rdquo;, &ldquo;near&rdquo;, &ldquo;aligned&rdquo;</li>
                <li><InlineCode>textRegionType</InlineCode> &mdash; Match classified text region type</li>
                <li><InlineCode>csiDivisionsRequired[]</InlineCode> &mdash; CSI divisions that must be present</li>
                <li><InlineCode>outputLabel</InlineCode> &mdash; Inference type (e.g., &ldquo;door-schedule&rdquo;)</li>
                <li><InlineCode>minConfidence</InlineCode> &mdash; Threshold (0.5&ndash;0.9)</li>
              </ul>
            </SubSection>

            <SubSection title="Two-Phase Execution">
              <p>
                <strong>Phase 1 (during OCR processing):</strong> Rules work in text-only mode using OCR keywords
                and text region classifications. No YOLO data available yet.
              </p>
              <p>
                <strong>Phase 2 (after YOLO load):</strong> Same rules are re-scored with YOLO spatial signals.
                A door schedule inference at 0.6 from Phase 1 might boost to 0.85 if YOLO detects
                &ldquo;table&rdquo; + &ldquo;grid&rdquo; classes overlapping the text region.
              </p>
            </SubSection>

            <SubSection title="Built-in Rules">
              <ul className="list-disc list-inside space-y-1">
                <li>Keynote table detection (horizontal_area + oval + &ldquo;KEYNOTE&rdquo; keyword)</li>
                <li>Door schedule (table + grid + &ldquo;DOOR SCHEDULE&rdquo;) &rarr; CSI 08 11 16</li>
                <li>Finish schedule &rarr; CSI 09 00 00</li>
                <li>Symbol legend (table + &ldquo;SYMBOL&rdquo; keyword)</li>
                <li>General notes (vertical text box + &ldquo;NOTES&rdquo; keyword)</li>
                <li>Title block (right margin, drawing number pattern)</li>
              </ul>
            </SubSection>
          </Section>

          {/* ============================================================ */}
          {/*  API & AGENTS DOCUMENTATION                                   */}
          {/* ============================================================ */}
          <div className="mt-20 mb-10 border-t border-[var(--border)] pt-10">
            <h1 className="text-3xl font-bold text-[var(--fg)]">API &amp; Agent Reference</h1>
            <p className="text-[var(--muted)] mt-2">
              REST API endpoints, LLM agent tools, database schema, and security model.
            </p>
          </div>

          {/* ============================================================ */}
          {/* SECTION 22: API REFERENCE                                      */}
          {/* ============================================================ */}
          <Section id="api-reference" title="API Reference">
            <p>
              All endpoints are relative to the application root. Authentication uses JWT sessions via NextAuth.
              Endpoints marked &ldquo;Admin&rdquo; require admin role; &ldquo;Root&rdquo; requires root admin.
            </p>

            <SubSection title="Authentication & Users">
              <div className="space-y-1">
                <ApiEndpoint method="POST" path="/api/register" auth="Public" desc="Register user with company access key" />
                <ApiEndpoint method="POST" path="/api/auth/forgot-password" auth="Public" desc="Request password reset email" />
                <ApiEndpoint method="POST" path="/api/auth/reset-password" auth="Public" desc="Reset password with token" />
                <ApiEndpoint method="GET" path="/api/admin/users" auth="Admin" desc="List all users in company" />
                <ApiEndpoint method="POST" path="/api/admin/users/reset-password" auth="Admin" desc="Force reset user password" />
                <ApiEndpoint method="POST" path="/api/invite" auth="Public" desc="Submit invite request (rate-limited 5/15min)" />
              </div>
            </SubSection>

            <SubSection title="Projects">
              <div className="space-y-1">
                <ApiEndpoint method="POST" path="/api/projects" auth="Auth" desc="Create project + trigger processing pipeline" />
                <ApiEndpoint method="GET" path="/api/projects" auth="Auth" desc="List all projects" />
                <ApiEndpoint method="GET" path="/api/projects/[id]" auth="Auth" desc="Get full project data (pages, takeoff, chat)" />
                <ApiEndpoint method="PUT" path="/api/projects/[id]" auth="Auth" desc="Update project metadata" />
                <ApiEndpoint method="DELETE" path="/api/projects/[id]" auth="Auth" desc="Delete project + all associated data" />
                <ApiEndpoint method="POST" path="/api/s3/credentials" auth="Auth" desc="Get presigned S3 POST for PDF upload (100MB max)" />
              </div>
            </SubSection>

            <SubSection title="Pages & Data">
              <div className="space-y-1">
                <ApiEndpoint method="GET" path="/api/pages/textract" auth="Auth" desc="Lazy-load Textract data for single page" />
                <ApiEndpoint method="POST" path="/api/pages/update" auth="Auth" desc="Update page name/drawing number" />
                <ApiEndpoint method="PATCH" path="/api/pages/intelligence" auth="Auth" desc="Persist pageIntelligence updates (deep merge)" />
              </div>
            </SubSection>

            <SubSection title="Search">
              <div className="space-y-1">
                <ApiEndpoint method="GET" path="/api/search" auth="Auth" desc='Full-text search with word-level bboxes. Supports "phrase" mode.' />
                <ApiEndpoint method="GET" path="/api/search/global" auth="Auth" desc="Cross-project full-text search" />
              </div>
            </SubSection>

            <SubSection title="Annotations">
              <div className="space-y-1">
                <ApiEndpoint method="POST" path="/api/annotations" auth="Auth" desc="Create annotation (YOLO/user/takeoff)" />
                <ApiEndpoint method="GET" path="/api/annotations" auth="Auth" desc="Get annotations for project/page" />
                <ApiEndpoint method="PUT" path="/api/annotations/[id]" auth="Auth" desc="Update annotation" />
                <ApiEndpoint method="DELETE" path="/api/annotations/[id]" auth="Auth" desc="Delete annotation" />
              </div>
            </SubSection>

            <SubSection title="Table Parsing">
              <div className="space-y-1">
                <ApiEndpoint method="POST" path="/api/table-parse" auth="Auth" desc="Parse table from region (7-method pipeline)" />
                <ApiEndpoint method="POST" path="/api/table-parse/propose" auth="Auth" desc="Auto-propose grid lines for region" />
                <ApiEndpoint method="POST" path="/api/table-structure" auth="Auth" desc="TATR cell structure detection" />
              </div>
            </SubSection>

            <SubSection title="Takeoff">
              <div className="space-y-1">
                <ApiEndpoint method="GET" path="/api/takeoff-items" auth="Auth" desc="Get all takeoff items for project" />
                <ApiEndpoint method="POST" path="/api/takeoff-items" auth="Auth" desc="Create takeoff item" />
                <ApiEndpoint method="PUT" path="/api/takeoff-items/[id]" auth="Auth" desc="Update takeoff item" />
                <ApiEndpoint method="DELETE" path="/api/takeoff-items/[id]" auth="Auth" desc="Delete takeoff item" />
                <ApiEndpoint method="GET" path="/api/takeoff-groups" auth="Auth" desc="Get takeoff groups" />
                <ApiEndpoint method="POST" path="/api/takeoff-groups" auth="Auth" desc="Create takeoff group" />
                <ApiEndpoint method="GET" path="/api/qto-workflows" auth="Auth" desc="List QTO workflows" />
                <ApiEndpoint method="POST" path="/api/qto-workflows" auth="Auth" desc="Create QTO workflow" />
              </div>
            </SubSection>

            <SubSection title="AI Chat">
              <div className="space-y-1">
                <ApiEndpoint method="POST" path="/api/ai/chat" auth="Auth" desc="Chat with LLM (SSE stream). Scope: page/project/global" />
                <ApiEndpoint method="DELETE" path="/api/ai/chat" auth="Auth" desc="Clear chat history" />
                <ApiEndpoint method="POST" path="/api/demo/chat" auth="Public" desc="Demo chat endpoint (rate-limited 10/min)" />
                <ApiEndpoint method="GET" path="/api/admin/llm/config" auth="Admin" desc="Get LLM configuration" />
                <ApiEndpoint method="PUT" path="/api/admin/llm/config" auth="Admin" desc="Update LLM configuration" />
                <ApiEndpoint method="POST" path="/api/admin/llm/preview" auth="Admin" desc="Preview assembled context" />
                <ApiEndpoint method="POST" path="/api/admin/llm-config/test" auth="Admin" desc="Test LLM connection" />
              </div>
            </SubSection>

            <SubSection title="YOLO Detection">
              <div className="space-y-1">
                <ApiEndpoint method="POST" path="/api/yolo/run" auth="Auth" desc="Start SageMaker YOLO processing job" />
                <ApiEndpoint method="GET" path="/api/yolo/status" auth="Auth" desc="Poll YOLO job status" />
                <ApiEndpoint method="POST" path="/api/yolo/load" auth="Admin" desc="Load YOLO results from S3 into DB" />
                <ApiEndpoint method="POST" path="/api/yolo/purge" auth="Admin" desc="Delete YOLO annotations" />
              </div>
            </SubSection>

            <SubSection title="Symbol Search">
              <div className="space-y-1">
                <ApiEndpoint method="POST" path="/api/symbol-search" auth="Auth" desc="Template matching search (SSE stream per page)" />
              </div>
            </SubSection>

            <SubSection title="CSI">
              <div className="space-y-1">
                <ApiEndpoint method="POST" path="/api/csi/detect" auth="Public" desc="Detect CSI codes from text or grid" />
              </div>
            </SubSection>

            <SubSection title="Admin">
              <div className="space-y-1">
                <ApiEndpoint method="GET" path="/api/admin/companies" auth="Root" desc="List all companies" />
                <ApiEndpoint method="POST" path="/api/admin/companies" auth="Root" desc="Create company" />
                <ApiEndpoint method="GET" path="/api/admin/toggles" auth="Admin" desc="Get feature toggles" />
                <ApiEndpoint method="PUT" path="/api/admin/toggles" auth="Admin" desc="Update feature toggles" />
                <ApiEndpoint method="GET" path="/api/admin/models" auth="Admin" desc="List YOLO models" />
                <ApiEndpoint method="POST" path="/api/admin/heuristics/config" auth="Admin" desc="Configure heuristic rules" />
                <ApiEndpoint method="POST" path="/api/admin/text-annotations/config" auth="Admin" desc="Configure text pattern detectors" />
                <ApiEndpoint method="POST" path="/api/admin/pipeline/route" auth="Admin" desc="Configure processing pipeline" />
                <ApiEndpoint method="GET" path="/api/admin/running-jobs" auth="Admin" desc="List active processing jobs" />
              </div>
            </SubSection>

            <SubSection title="Demo">
              <div className="space-y-1">
                <ApiEndpoint method="GET" path="/api/demo/config" auth="Public" desc="Get demo configuration" />
                <ApiEndpoint method="GET" path="/api/demo/projects" auth="Public" desc="List demo projects" />
                <ApiEndpoint method="GET" path="/api/demo/projects/[id]" auth="Public" desc="Get demo project details" />
                <ApiEndpoint method="POST" path="/api/demo/search" auth="Public" desc="Search demo projects" />
              </div>
            </SubSection>

            <SubSection title="Processing & Health">
              <div className="space-y-1">
                <ApiEndpoint method="POST" path="/api/processing/webhook" auth="Bearer" desc="Receive processing results from Step Functions" />
                <ApiEndpoint method="POST" path="/api/processing/dev" auth="Auth" desc="Trigger dev-mode processing" />
                <ApiEndpoint method="GET" path="/api/health" auth="Public" desc="Health check" />
              </div>
            </SubSection>
          </Section>

          {/* ============================================================ */}
          {/* SECTION 23: LLM AGENT TOOLS                                    */}
          {/* ============================================================ */}
          <Section id="agent-tools" title="LLM Agent Tools">
            <p>
              When tool use is enabled, the LLM chat agent can call 20 tools to query data,
              manage tags, and take actions in the viewer. These tools are defined in
              {" "}<InlineCode>src/lib/llm/tools.ts</InlineCode>.
            </p>

            <SubSection title="Data Retrieval Tools">
              <ToolDoc
                name="getProjectOverview"
                desc="Get complete project map. Should be called first to orient the LLM."
                params="(none)"
                returns="{name, numPages, disciplines[], trades[], csiDivisions[], scheduleIndex[], pageClassifications[], crossReferences, textAnnotationCounts, takeoffSummary, pageIndexes}"
                useCase="First tool call — gives the LLM a complete structural picture of the project"
              />
              <ToolDoc
                name="searchPages"
                desc="Full-text search blueprint pages by content."
                params='{query: string} — 2+ chars, supports "phrases" in quotes'
                returns="{pages: [{pageNumber, snippet, rank, matchCount}]}"
                useCase='"Find pages about doors" → lists matching pages with relevance scores'
              />
              <ToolDoc
                name="getPageDetails"
                desc="Comprehensive page intelligence for a single page."
                params="{pageNumber: number}"
                returns="{classification, noteBlocks, textRegions, heuristicInferences, classifiedTables, parsedScheduleData, csiSpatialMap, csiCodes, textAnnotations, keynotes}"
                useCase="Deep dive into a specific page — all extracted intelligence in one call"
              />
              <ToolDoc
                name="lookupPagesByIndex"
                desc="O(1) instant lookup using pre-computed indexes."
                params='{index: "csi"|"trade"|"keynote"|"textAnnotation", key: string}'
                returns="{pages: [pageNumber, ...]}"
                useCase='"Which pages have Division 08?" → instant list without searching'
              />
              <ToolDoc
                name="getAnnotations"
                desc="Get YOLO detections and user markups with optional filters."
                params="{pageNumber?: number, className?: string, source?: string, minConfidence?: number}"
                returns="[{id, name, bbox, confidence, csiCodes, keywords}]"
                useCase="Get all door detections above 80% confidence on page 3"
              />
              <ToolDoc
                name="getParsedSchedule"
                desc="Get structured table data (door schedules, finish schedules, etc.)."
                params="{pageNumber: number, category?: string}"
                returns="{headers: [], rows: [{}], tagColumn?, csiTags: [{code, description}]}"
                useCase='"Extract the door schedule" → structured table with rows and CSI tags'
              />
              <ToolDoc
                name="getCsiSpatialMap"
                desc="Zone-based heatmap of CSI divisions on a page."
                params="{pageNumber: number}"
                returns="{zones: [{name, divisions: [{code, count}]}]}"
                useCase={`"What's in the top-right corner?" → CSI codes by spatial zone`}
              />
              <ToolDoc
                name="getCrossReferences"
                desc="Sheet-to-sheet reference graph."
                params="{pageNumber?: number} — omit for full project graph"
                returns="{edges: [{from, to}], hubs: [...], leaves: [...]}"
                useCase='"What references sheet A-501?" → pages that point to it'
              />
              <ToolDoc
                name="getSpatialContext"
                desc="OCR text mapped into YOLO spatial regions."
                params="{pageNumber: number}"
                returns='{regions: [{type: "title_block"|"legend"|"drawing_area", text}]}'
                useCase={`"What's in the legend?" → reads OCR text from the legend region`}
              />
              <ToolDoc
                name="getPageOcrText"
                desc="Raw full OCR text for a page."
                params="{pageNumber: number}"
                returns="{text: string}"
                useCase="Fallback when structured tools are insufficient"
              />
              <ToolDoc
                name="detectCsiFromText"
                desc="Run CSI MasterFormat code detection on arbitrary text."
                params="{text: string}"
                returns="{codes: [{code, description, trade, division}]}"
                useCase='"What CSI codes are in this text?" → identifies construction categories'
              />
            </SubSection>

            <SubSection title="Tag Tools">
              <ToolDoc
                name="scanYoloClassTexts"
                desc="Find all unique OCR texts inside YOLO annotations of a specific class."
                params="{yoloClass: string, yoloModel?: string, pageNumber?: number}"
                returns="{texts: [{text, confidence, count}]}"
                useCase='"What labels are inside all circles?" → lists all unique circle contents'
              />
              <ToolDoc
                name="mapTagsToPages"
                desc="Find every instance of specific tag values across the project."
                params='{tags: "D-01,D-02,D-03", yoloClass?: string, pageNumber?: number}'
                returns="{matches: [{pageNumber, bbox, confidence}]}"
                useCase='"Find all instances of D-01, D-02, D-03" → locations across all pages'
              />
              <ToolDoc
                name="detectTagPatterns"
                desc="Auto-discover repeating YOLO+OCR patterns (e.g., numbered tags in circles)."
                params="(none)"
                returns="{patterns: [{yoloClass, example_text, values: [...], count, confidence}]}"
                useCase='"What tag sequences appear?" → finds patterns like T-01, T-02, T-03...'
              />
              <ToolDoc
                name="getOcrTextInRegion"
                desc="Read OCR text in a specific rectangular region."
                params="{pageNumber, minX, minY, maxX, maxY} — 0-1 normalized coordinates"
                returns="{text: string}"
                useCase='"Read the title block" → extracts text from specified coordinates'
              />
            </SubSection>

            <SubSection title="Action Tools">
              <ToolDoc
                name="navigateToPage"
                desc="Navigate the viewer to a specific page."
                params="{pageNumber: number}"
                returns="{action: 'navigate', pageNumber}"
                useCase="Agent navigates user to the page it's discussing"
              />
              <ToolDoc
                name="highlightRegion"
                desc="Highlight a rectangular region with a pulsing cyan outline."
                params="{pageNumber, minX, minY, maxX, maxY, label?: string}"
                returns="{action: 'highlight', pageNumber, bbox, label}"
                useCase="Agent highlights the area of the drawing it's referring to"
              />
              <ToolDoc
                name="createMarkup"
                desc="Create a persistent markup annotation."
                params="{pageNumber, minX, minY, maxX, maxY, name, note?: string}"
                returns="{action: 'createMarkup', id, pageNumber, name}"
                useCase="Agent marks up a region for future reference"
              />
              <ToolDoc
                name="addNoteToAnnotation"
                desc="Append a note to an existing annotation (never overwrites)."
                params="{annotationId: number, note: string}"
                returns="{success: true}"
                useCase="Agent adds context to a YOLO detection or user markup"
              />
              <ToolDoc
                name="batchAddNotes"
                desc="Append a note to all annotations matching a filter."
                params="{note: string, pageNumber?: number, className?: string, source?: string, minConfidence?: number}"
                returns="{updated: number}"
                useCase='"Add a note to all door detections" → bulk annotation'
              />
            </SubSection>
          </Section>

          {/* ============================================================ */}
          {/* SECTION 24: DATABASE SCHEMA                                    */}
          {/* ============================================================ */}
          <Section id="database" title="Database Schema">
            <p>
              PostgreSQL 16 with Drizzle ORM. 14 tables, 15 migrations. JSONB columns are used extensively
              for flexible, schema-less data.
            </p>
            <Table
              headers={["Table", "Purpose", "Key JSONB Fields"]}
              rows={[
                ["companies", "Multi-tenant organizations", "pipelineConfig, features"],
                ["users", "Auth + permissions", "role (admin/member), canRunModels"],
                ["userApiKeys", "BYOK LLM keys", "provider, encryptedKey (AES-256-GCM)"],
                ["projects", "PDF documents", "projectIntelligence, isDemo"],
                ["pages", "Per-page OCR data", "textractData, csiCodes, pageIntelligence, search_vector (GIN)"],
                ["annotations", "YOLO + user markups", "data (CSI codes, keywords, confidence)"],
                ["takeoffItems", "QTO categories", "name, shape, color, size, notes"],
                ["takeoffGroups", "Takeoff groups", "kind (count/area/linear)"],
                ["qtoWorkflows", "Auto-QTO state machine", "step, parsedSchedule, lineItems, userEdits"],
                ["chatMessages", "Chat history", "role, content, model, pageNumber"],
                ["processingJobs", "Step Functions tracking", "status, stepFunctionArn"],
                ["models", "YOLO model registry", "config (classCsiCodes, classKeywords)"],
                ["llmConfigs", "LLM provider config", "provider, model, encryptedApiKey, baseUrl"],
                ["inviteRequests", "Signup queue", "email, name, company"],
              ]}
            />
            <SubSection title="Entity Relationships">
              <Code>{`companies
  └── users
  └── projects
        └── pages (textractData, pageIntelligence, csiCodes)
        └── annotations (YOLO detections + user markups)
        └── takeoffItems → takeoffGroups
        └── chatMessages
        └── processingJobs
        └── qtoWorkflows`}</Code>
            </SubSection>
          </Section>

          {/* ============================================================ */}
          {/* SECTION 25: SECURITY                                           */}
          {/* ============================================================ */}
          <Section id="security" title="Security">
            <Table
              headers={["Layer", "Implementation"]}
              rows={[
                ["Authentication", "NextAuth 5 credentials + Google OAuth, bcrypt (cost 12), JWT (24hr)"],
                ["Brute Force", "5 failures = 15min lockout, 10 = 1hr lockout, per email"],
                ["Rate Limiting", "In-memory middleware per-endpoint (auth: 3-5/15min, chat: 30/hr, YOLO: 5/hr, general: 120/min)"],
                ["Multi-Tenancy", "All queries scoped by companyId. Registration requires company access key"],
                ["API Key Encryption", "AES-256-GCM with random IV + auth tag"],
                ["Quotas", "Per-company daily: uploads (3 member/10 admin), YOLO (5), chat (200)"],
                ["Secrets", "AWS Secrets Manager via ECS task definition"],
                ["Webhooks", "HMAC-SHA256 + timestamp validation (reject > 5min old)"],
                ["Audit Logging", "Login, registration, create/delete, YOLO runs, password changes"],
                ["Security Headers", "nosniff, DENY frame, XSS protection, strict referrer"],
                ["WAF", "AWS WAF on ALB: rate limit (1000/IP), SQLi rules, IP reputation"],
                ["Monitoring", "CloudWatch alarms (5xx, unhealthy hosts, CPU), GuardDuty, CloudTrail"],
              ]}
            />

            <SubSection title="Password Policy">
              <ul className="list-disc list-inside space-y-1">
                <li>Minimum 10 characters</li>
                <li>At least 1 uppercase letter</li>
                <li>At least 1 digit</li>
                <li>Passwords hashed with bcrypt (cost factor 12)</li>
              </ul>
            </SubSection>

            <SubSection title="Rate Limiting by Endpoint">
              <Table
                headers={["Endpoint", "Limit"]}
                rows={[
                  ["POST /api/register", "3 per 15 min per IP"],
                  ["POST /api/auth/forgot-password", "3 per 15 min per IP"],
                  ["POST /api/ai/chat", "30 per hour per user"],
                  ["POST /api/yolo/run", "Configurable (toggle)"],
                  ["POST /api/projects", "10 per hour per user"],
                  ["POST /api/takeoff-items", "50 per hour per user"],
                  ["POST /api/demo/chat", "10 per minute per IP"],
                  ["General API", "120 per minute per IP"],
                ]}
              />
            </SubSection>
          </Section>

          {/* ============================================================ */}
          {/*  FOOTER                                                       */}
          {/* ============================================================ */}
          <footer className="mt-20 border-t border-[var(--border)] pt-8 pb-16 text-center text-sm text-[var(--muted)]">
            <p>
              BlueprintParser is open source under the MIT License.
            </p>
            <p className="mt-2">
              <a
                href="https://github.com/goodmorningcoffee"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--accent)] hover:underline"
              >
                github.com/goodmorningcoffee
              </a>
            </p>
          </footer>
        </main>
      </div>
    </div>
  );
}
