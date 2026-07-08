/**
 * GET/POST/PUT/DELETE /api/admin/users  (user administration: list, create, update,
 * delete with reassign/cascade)
 *
 * [refactor jul8 S058] Thin shells — behavior lives in services/admin-users.ts (listUsers /
 * createUser / updateUser / deleteUser). auth:"admin" on all 4 (A). GET has no body (bare
 * ARRAY response passes through the shell un-enveloped) → no E. POST/PUT/DELETE
 * body:zLooseBody (E: legacy `await req.json()` threw on malformed → shell "Invalid JSON
 * body"). B ×3 (DR002): the POST:109 + DELETE:270 err.message leaks and the PUT:149 fixed
 * "Update failed" literal are retired → shell generic INTERNAL 500; the DELETE
 * "[user-delete] Failed" logger breadcrumb survives in-service (try/log/re-throw). Every
 * in-body isRootAdmin gate (company scope, role/company moves, cascade select scope) stays
 * in-service. Solo fold (char: admin-users.route.test.ts US-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { listUsers, createUser, updateUser, deleteUser } from "@/server/services/admin-users";

export const GET = defineRoute({
  auth: "admin",
  handler: ({ session }) => listUsers(session!),
});

export const POST = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ body, session }) => createUser(session!, body),
});

export const PUT = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ body, session }) => updateUser(session!, body),
});

export const DELETE = defineRoute({
  auth: "admin",
  body: zLooseBody,
  handler: ({ body, session }) => deleteUser(session!, body),
});
