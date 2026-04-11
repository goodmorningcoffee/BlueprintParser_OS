"use client";

import { useState } from "react";
import { ApiEndpoint } from "../ApiEndpoint";

/** All 80+ BP API routes, grouped by domain. Count verified via
 *  `find src/app/api -name route.ts | wc -l` = 84. */
interface ApiRow {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  auth?: "public" | "session" | "admin" | "root";
  desc: string;
  params?: { name: string; type: string; required?: boolean; desc: string }[];
}

const GROUPS: { id: string; label: string; endpoints: ApiRow[] }[] = [
  {
    id: "auth",
    label: "Auth & Accounts",
    endpoints: [
      { method: "GET", path: "/api/auth/[...nextauth]", auth: "public", desc: "NextAuth session handlers (sign-in/out, session, providers, callbacks)." },
      { method: "POST", path: "/api/register", auth: "public", desc: "Self-registration; company inferred from email domain." },
      { method: "POST", path: "/api/auth/forgot-password", auth: "public", desc: "Send reset-password email via SES." },
      { method: "POST", path: "/api/auth/reset-password", auth: "public", desc: "Consume a reset token and set new password." },
      { method: "POST", path: "/api/invite", auth: "admin", desc: "Invite a user to the current company." },
      { method: "GET", path: "/api/admin/invites", auth: "admin", desc: "List pending invites." },
    ],
  },
  {
    id: "health",
    label: "Health & Status",
    endpoints: [
      { method: "GET", path: "/api/health", auth: "public", desc: "Liveness probe for ECS / ALB health check." },
      { method: "GET", path: "/api/admin/parser-health", auth: "admin", desc: "Pipeline health: Textract reachability, queue depth, recent errors." },
      { method: "GET", path: "/api/admin/yolo-status", auth: "admin", desc: "SageMaker YOLO job status + quota." },
      { method: "GET", path: "/api/admin/sagemaker-details", auth: "admin", desc: "Raw SageMaker Processing job details for a given job id." },
    ],
  },
  {
    id: "projects",
    label: "Projects & Pages",
    endpoints: [
      { method: "GET", path: "/api/projects", auth: "session", desc: "List projects visible to the current user/company." },
      { method: "POST", path: "/api/projects", auth: "session", desc: "Create project: uploads PDF to S3 and kicks off the processing state machine." },
      { method: "GET", path: "/api/projects/[id]", auth: "session", desc: "Fetch a project by publicId with status, pages, and metadata." },
      { method: "PUT", path: "/api/projects/[id]", auth: "session", desc: "Rename or update project metadata." },
      { method: "DELETE", path: "/api/projects/[id]", auth: "session", desc: "Delete a project and its data." },
      { method: "GET", path: "/api/projects/[id]/pages", auth: "session", desc: "List pages in a project with classifications and CSI counts." },
      { method: "POST", path: "/api/projects/[id]/map-tags", auth: "session", desc: "Bind a single tag value to matching YOLO shapes." },
      { method: "POST", path: "/api/projects/[id]/map-tags-batch", auth: "session", desc: "Bind all rows of a parsed schedule's tag column to YOLO shapes (the core Map Tags call)." },
      { method: "POST", path: "/api/projects/[id]/classify-regions", auth: "session", desc: "Re-run spatial classification using current YOLO + OCR data." },
      { method: "GET", path: "/api/projects/[id]/thumbnail/[page]", auth: "session", desc: "Pre-signed redirect to the page thumbnail on CloudFront." },
      { method: "POST", path: "/api/pages/intelligence", auth: "session", desc: "Re-run analyzePageIntelligence on a specific page." },
      { method: "POST", path: "/api/pages/textract", auth: "session", desc: "Re-run Textract on a specific page." },
      { method: "POST", path: "/api/pages/update", auth: "session", desc: "Bulk update page names, drawing numbers, series." },
    ],
  },
  {
    id: "annotations",
    label: "Annotations & Takeoff",
    endpoints: [
      { method: "GET", path: "/api/annotations", auth: "session", desc: "List annotations (YOLO + user) optionally filtered by page/class/source." },
      { method: "POST", path: "/api/annotations", auth: "session", desc: "Create a user markup or takeoff annotation." },
      { method: "PUT", path: "/api/annotations/[id]", auth: "session", desc: "Edit annotation (name, notes, bbox, class)." },
      { method: "DELETE", path: "/api/annotations/[id]", auth: "session", desc: "Delete annotation." },
      { method: "GET", path: "/api/takeoff-groups", auth: "session", desc: "List takeoff groups (buckets for takeoff items)." },
      { method: "POST", path: "/api/takeoff-groups", auth: "session", desc: "Create a takeoff group." },
      { method: "PUT", path: "/api/takeoff-groups/[id]", auth: "session", desc: "Rename or re-order a takeoff group." },
      { method: "DELETE", path: "/api/takeoff-groups/[id]", auth: "session", desc: "Delete a takeoff group." },
      { method: "GET", path: "/api/takeoff-items", auth: "session", desc: "List takeoff items (count / area / linear)." },
      { method: "POST", path: "/api/takeoff-items", auth: "session", desc: "Create a takeoff item." },
      { method: "PUT", path: "/api/takeoff-items/[id]", auth: "session", desc: "Update a takeoff item (name, color, notes)." },
      { method: "DELETE", path: "/api/takeoff-items/[id]", auth: "session", desc: "Delete a takeoff item." },
    ],
  },
  {
    id: "qto",
    label: "Auto-QTO Workflows",
    endpoints: [
      { method: "GET", path: "/api/qto-workflows", auth: "session", desc: "List Auto-QTO workflows for a project." },
      { method: "POST", path: "/api/qto-workflows", auth: "session", desc: "Create a new workflow at step 'select-schedule'." },
      { method: "GET", path: "/api/qto-workflows/[id]", auth: "session", desc: "Fetch workflow state (step, parsedSchedule, lineItems, userEdits)." },
      { method: "PUT", path: "/api/qto-workflows/[id]", auth: "session", desc: "Advance the workflow state machine or save edits." },
      { method: "DELETE", path: "/api/qto-workflows/[id]", auth: "session", desc: "Delete a workflow." },
    ],
  },
  {
    id: "csi",
    label: "CSI",
    endpoints: [
      { method: "GET", path: "/api/csi", auth: "session", desc: "Aggregate CSI codes across the current company's projects." },
      { method: "POST", path: "/api/csi/detect", auth: "session", desc: "Run the 3-tier CSI matcher on arbitrary text.", params: [{ name: "text", type: "string", required: true, desc: "Text to analyze." }] },
      { method: "GET", path: "/api/admin/csi/config", auth: "admin", desc: "Per-company CSI detection thresholds and custom database config." },
      { method: "POST", path: "/api/admin/csi/upload", auth: "admin", desc: "Upload a custom CSI MasterFormat TSV." },
    ],
  },
  {
    id: "tables",
    label: "Table Parse & Shape",
    endpoints: [
      { method: "POST", path: "/api/table-parse", auth: "session", desc: "Run the multi-method parser (Camelot / img2table / TATR / OCR grid) and return the merged grid." },
      { method: "POST", path: "/api/table-parse/propose", auth: "session", desc: "Propose row/column boundaries for a user-drawn region (Guided Parse)." },
      { method: "POST", path: "/api/table-structure", auth: "session", desc: "Raw TATR (Table Transformer) structure inference for debugging." },
      { method: "POST", path: "/api/shape-parse", auth: "session", desc: "Detect keynote shapes (circles, hexagons, etc.) on a page for the Shape sub-tab." },
      { method: "POST", path: "/api/symbol-search", auth: "session", desc: "Find all instances of a user-drawn symbol across all pages." },
      { method: "POST", path: "/api/bucket-fill", auth: "session", desc: "Flood-fill from a seed point; returns polygon vertices in normalized 0-1 coordinates.", params: [{ name: "projectId", type: "string", required: true, desc: "Public project id." }, { name: "pageNumber", type: "number", required: true, desc: "1-indexed page." }, { name: "seedX", type: "number", required: true, desc: "Normalized 0-1 seed point." }, { name: "seedY", type: "number", required: true, desc: "Normalized 0-1 seed point." }, { name: "barriers", type: "array", desc: "Optional line segments to seal open doorways." }] },
    ],
  },
  {
    id: "search",
    label: "Search",
    endpoints: [
      { method: "GET", path: "/api/search", auth: "session", desc: "Full-text tsvector search within a project's pages." },
      { method: "GET", path: "/api/search/global", auth: "session", desc: "Cross-project search across all projects visible to the user." },
    ],
  },
  {
    id: "ai",
    label: "AI Chat",
    endpoints: [
      { method: "POST", path: "/api/ai/chat", auth: "session", desc: "SSE-streamed chat with tool-use. Scope can be 'page', 'project', or 'global'.", params: [{ name: "projectId", type: "string", desc: "Project publicId (omit for 'global')." }, { name: "pageNumber", type: "number", desc: "Current page for scope='page'." }, { name: "scope", type: "string", required: true, desc: "'page' | 'project' | 'global'." }, { name: "message", type: "string", required: true, desc: "User message." }] },
      { method: "DELETE", path: "/api/ai/chat", auth: "session", desc: "Clear conversation history for a scope." },
    ],
  },
  {
    id: "yolo",
    label: "YOLO / SageMaker",
    endpoints: [
      { method: "POST", path: "/api/yolo/run", auth: "admin", desc: "Start a SageMaker Processing job for a project and model. The ONLY way to run YOLO." },
      { method: "GET", path: "/api/yolo/status", auth: "admin", desc: "Poll job status by execution id." },
      { method: "POST", path: "/api/yolo/load", auth: "session", desc: "Ingest YOLO results from S3 into the annotations table (called by the webhook)." },
      { method: "DELETE", path: "/api/admin/yolo-purge", auth: "admin", desc: "Purge all YOLO annotations for a project." },
    ],
  },
  {
    id: "processing",
    label: "Processing & Webhooks",
    endpoints: [
      { method: "POST", path: "/api/processing/webhook", auth: "public", desc: "Signed webhook from Step Functions / SageMaker (HMAC-SHA256 signature)." },
      { method: "POST", path: "/api/processing/dev", auth: "admin", desc: "Dev-mode inline processing trigger (bypasses Step Functions)." },
      { method: "POST", path: "/api/s3/credentials", auth: "session", desc: "Return short-lived pre-signed S3 credentials for direct client uploads." },
    ],
  },
  {
    id: "labeling",
    label: "Labeling (Label Studio)",
    endpoints: [
      { method: "POST", path: "/api/labeling/create", auth: "admin", desc: "Provision a Label Studio labeling session for a project." },
      { method: "GET", path: "/api/labeling/sessions", auth: "admin", desc: "List active labeling sessions." },
      { method: "GET", path: "/api/labeling/credentials", auth: "admin", desc: "Return credentials for embedding the Label Studio iframe." },
      { method: "POST", path: "/api/labeling/sessions/[id]", auth: "admin", desc: "Fetch or update a specific labeling session." },
    ],
  },
  {
    id: "admin",
    label: "Admin Configuration",
    endpoints: [
      { method: "GET", path: "/api/admin/app-settings", auth: "root", desc: "Global key/value settings (root admin only)." },
      { method: "POST", path: "/api/admin/toggles", auth: "admin", desc: "Feature toggles (sagemakerEnabled, demoMode, quotaEnforced). Requires admin password for destructive ones." },
      { method: "GET", path: "/api/admin/pipeline", auth: "admin", desc: "Company pipeline config (page concurrency, CSI spatial grid)." },
      { method: "POST", path: "/api/admin/pipeline", auth: "admin", desc: "Save pipeline config." },
      { method: "GET", path: "/api/admin/heuristics/config", auth: "admin", desc: "Built-in and custom heuristic rules." },
      { method: "POST", path: "/api/admin/heuristics/config", auth: "admin", desc: "Save heuristic rules." },
      { method: "GET", path: "/api/admin/text-annotations/config", auth: "admin", desc: "Enable/disable the 10 text-annotation detector modules and tune their regex patterns." },
      { method: "POST", path: "/api/admin/text-annotations/config", auth: "admin", desc: "Save text-annotation detector config." },
      { method: "GET", path: "/api/admin/llm-config", auth: "admin", desc: "Configured LLM providers and models." },
      { method: "POST", path: "/api/admin/llm-config", auth: "admin", desc: "Create/update an LLM provider config (API key stored encrypted)." },
      { method: "POST", path: "/api/admin/llm-config/test", auth: "admin", desc: "Ping the configured LLM to verify credentials and model availability." },
      { method: "GET", path: "/api/admin/models", auth: "admin", desc: "List YOLO models registered in the `models` table." },
      { method: "POST", path: "/api/admin/models", auth: "admin", desc: "Register a new YOLO model (S3 path + config)." },
      { method: "PUT", path: "/api/admin/models/[id]", auth: "admin", desc: "Update model config (confidence, IoU, classes, class→CSI map)." },
      { method: "POST", path: "/api/admin/models/reprocess-csi", auth: "admin", desc: "Re-run CSI assignment on all annotations (after editing class→CSI mappings)." },
      { method: "POST", path: "/api/admin/reprocess", auth: "admin", desc: "Re-trigger the processing pipeline for a project." },
      { method: "GET", path: "/api/admin/recent-parses", auth: "admin", desc: "Recent parsing job history." },
      { method: "GET", path: "/api/admin/running-jobs", auth: "admin", desc: "Currently-running YOLO and processing jobs." },
      { method: "POST", path: "/api/admin/users/reset-password", auth: "admin", desc: "Reset a user's password." },
    ],
  },
  {
    id: "demo",
    label: "Demo (public read-only)",
    endpoints: [
      { method: "GET", path: "/api/demo/config", auth: "public", desc: "Demo mode feature flags." },
      { method: "GET", path: "/api/demo/projects", auth: "public", desc: "List publicly visible demo projects." },
      { method: "POST", path: "/api/demo/chat", auth: "public", desc: "Rate-limited LLM chat scoped to demo projects." },
      { method: "GET", path: "/api/demo/csi", auth: "public", desc: "CSI codes for demo projects." },
      { method: "GET", path: "/api/demo/search", auth: "public", desc: "Search within demo projects." },
    ],
  },
];

export function ApiEndpointList() {
  const total = GROUPS.reduce((s, g) => s + g.endpoints.length, 0);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(GROUPS.map((g) => [g.id, true])),
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between text-[11px] text-[var(--muted)]">
        <span>
          Listed here: <span className="text-[var(--fg)] font-mono">{total}</span> endpoints across {GROUPS.length} domains. Actual route count: <span className="text-[var(--fg)] font-mono">84</span> (some admin/util routes are omitted).
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setOpenGroups(Object.fromEntries(GROUPS.map((g) => [g.id, true])))}
            className="text-[11px] text-[var(--muted)] hover:text-[var(--fg)] underline"
          >
            Expand all
          </button>
          <span className="text-[var(--muted)]/40">/</span>
          <button
            onClick={() => setOpenGroups(Object.fromEntries(GROUPS.map((g) => [g.id, false])))}
            className="text-[11px] text-[var(--muted)] hover:text-[var(--fg)] underline"
          >
            Collapse all
          </button>
        </div>
      </div>

      {GROUPS.map((g) => (
        <div key={g.id}>
          <button
            onClick={() => setOpenGroups((o) => ({ ...o, [g.id]: !o[g.id] }))}
            className="flex items-center gap-2 text-[12px] uppercase tracking-wider text-[var(--muted)] hover:text-[var(--fg)] w-full text-left border-b border-[var(--border)] pb-1 mb-2 font-semibold"
          >
            <span>{openGroups[g.id] ? "▾" : "▸"}</span>
            <span>{g.label}</span>
            <span className="text-[var(--muted)]/60">({g.endpoints.length})</span>
          </button>
          {openGroups[g.id] && (
            <div>
              {g.endpoints.map((e) => (
                <ApiEndpoint
                  key={`${e.method}-${e.path}`}
                  method={e.method}
                  path={e.path}
                  auth={e.auth}
                  desc={e.desc}
                  params={e.params}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
