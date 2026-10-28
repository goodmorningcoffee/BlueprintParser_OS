/**
 * POST /api/projects/[id]/parse-engine/parse — parse one box of one page with the parse engine (the
 * Tables & Notes workspace). Compute only: no project or page row is written. Thin shell — behavior
 * lives in services/parse-engine/run.ts. [TP-3 WP-3.E]
 * allowDemo:true: a demo viewer may parse (instant / standard); `thorough` (paid) is refused for demo
 * projects and signed-out callers, and demo / signed-out calls never write the crop cache
 * (PUBLIC_DEMO_SURFACES "parse-engine-parse"). Rate: middleware rule `parse-engine-parse` (exact regex)
 * + its own parser burst bucket; per-caller in-flight cap in services/parse-engine/concurrency.ts.
 */
import { defineRoute } from "@/server/api/defineRoute";
import { zParseRequest } from "@/lib/parse-engine/schema";
import { postParseEngineParse } from "@/server/services/parse-engine/run";

export const POST = defineRoute({
  auth: { project: { param: "id", allowDemo: true } },
  body: zParseRequest,
  handler: ({ req, body, project, session, scope }) =>
    postParseEngineParse({ req, body, project: project!, session, scope }),
});
