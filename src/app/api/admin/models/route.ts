/**
 * GET/POST/PUT/DELETE/PATCH /api/admin/models  (YOLO model registry: list, presign-upload,
 * register, config-merge, delete, share/toggle)
 *
 * [refactor jul8 S057] Thin shells — behavior lives in services/models.ts (listModels /
 * registerModel / updateModelConfig / deleteModel / shareModel). auth:"admin" on all 5 (A).
 * GET is bespoke-lite: reads searchParams (NO body → no zLooseBody, no E) — the presign
 * root-gate + kill-switch, the access-query root fall-through, and the WEIGHTS-2 s3Path:NULL
 * shared-listing mask all stay in-service. POST/PUT/DELETE/PATCH body:zLooseBody (E: legacy
 * `await req.json()` threw on malformed → shell "Invalid JSON body"). ★ S051 owner-sanctioned
 * ordering flip: the POST ALLOW_MODEL_UPLOAD kill-switch, pre-auth in legacy, now runs
 * in-service AFTER auth (signed-out+disabled 403→401; authed literal byte-identical). NO B —
 * legacy had zero catch-500s. The PUT jsonb spread-merge, unscoped-fetch-then-JS-tenancy-404,
 * and PATCH company-level-only upsert stay in-service verbatim. Solo fold (char:
 * admin-models.route.test.ts MD-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import {
  listModels,
  registerModel,
  updateModelConfig,
  deleteModel,
  shareModel,
} from "@/server/services/models";

export const GET = defineRoute({
  auth: "admin",
  handler: ({ req, session }) => listModels(req, session!),
});

export const POST = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ body, session }) => registerModel(session!, body),
});

export const PUT = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ body, session }) => updateModelConfig(session!, body),
});

export const DELETE = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ body, session }) => deleteModel(session!, body),
});

export const PATCH = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ body, session }) => shareModel(session!, body),
});
