/**
 * GET/POST/PUT/DELETE /api/admin/companies  (root-only company administration)
 *
 * [refactor jul6 S043] Thin shells — behavior lives in services/companies.ts (getCompanies /
 * createCompany / updateCompany / deleteCompany). auth:"root" (A). POST/PUT/DELETE
 * body:zLooseBody (E: legacy `await req.json()` threw on malformed → shell "Invalid JSON
 * body"). The crypto accessKey+dataKey-slug generation, the GET count aggregates, the PUT
 * conditional updates, and the DELETE empty-check guards stay in-service. Solo fold (char:
 * admin-companies.route.test.ts CO-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { getCompanies, createCompany, updateCompany, deleteCompany } from "@/server/services/companies";

export const GET = defineRoute({
  auth: "root",
  handler: () => getCompanies(),
});

export const POST = defineRoute({
  auth: "root",
  body: zLooseBody,
  handler: ({ body }) => createCompany(body),
});

export const PUT = defineRoute({
  auth: "root",
  body: zLooseBody,
  handler: ({ body }) => updateCompany(body),
});

export const DELETE = defineRoute({
  auth: "root",
  body: zLooseBody,
  handler: ({ body }) => deleteCompany(body),
});
