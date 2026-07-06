/**
 * POST /api/csi/detect
 *
 * [refactor jul6 S032] Thin shell — behavior lives in services/csi.ts (csiDetect).
 * auth:"none" — DELIBERATELY PUBLIC (pure local text matching; the docs' public entry;
 * legacy behavior preserved; its dead `auth` import dropped). body:zLooseBody — shell
 * owns body-parse (diff E; legacy req.json-inside-try leaked SyntaxError messages).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { csiDetect } from "@/server/services/csi";

export const POST = defineRoute({
  auth: "none",
  body: zLooseBody,
  handler: ({ body }) => csiDetect(body),
});
