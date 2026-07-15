import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const CHECKER = path.join(
  REPO_ROOT,
  "scripts/check-architecture-guardrails.mjs",
);

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "bp-architecture-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeRoute(root, relative, source) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, source, "utf8");
}

function runChecker(root) {
  return spawnSync(process.execPath, [CHECKER], {
    cwd: root,
    encoding: "utf8",
  });
}

test("a dead canonical sentinel call cannot authorize a raw HTTP export", async (t) => {
  const root = await fixture(t);
  const route = "src/app/api/example/route.ts";
  await writeRoute(
    root,
    route,
    `import { defineRoute } from "@/server/api/defineRoute";
const canonical = defineRoute({ auth: "none", handler: () => ({ ok: true }) });
export const GET = canonical;
`,
  );
  assert.equal(runChecker(root).status, 0, "canonical alias should pass");

  await writeRoute(
    root,
    route,
    `import { defineRoute } from "@/server/api/defineRoute";
defineRoute({ auth: "none", handler: () => ({ sentinel: true }) });
export async function GET() { return new Response("raw"); }
`,
  );
  const mutated = runChecker(root);
  assert.equal(mutated.status, 1);
  assert.match(
    mutated.stderr,
    /example\/route\.ts GET export is not structurally bound/u,
  );
});

test("each exported method is checked even when a sibling is canonical", async (t) => {
  const root = await fixture(t);
  await writeRoute(
    root,
    "src/app/api/mixed/route.ts",
    `import { defineRoute } from "@/server/api/defineRoute";
export const POST = defineRoute({ auth: "none", handler: () => ({ ok: true }) });
export async function GET() { return new Response("raw"); }
`,
  );

  const result = runChecker(root);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /mixed\/route\.ts GET export is not structurally bound/u,
  );
  assert.doesNotMatch(result.stderr, /mixed\/route\.ts POST export/u);
});

test("a reviewed response-policy import may wrap its canonical handler", async (t) => {
  const root = await fixture(t);
  await writeRoute(
    root,
    "src/app/api/wrapped/route.ts",
    `import { defineRoute } from "@/server/api/defineRoute";
import { withProjectAssetResponsePolicy as policy } from "@/server/services/project-assets";
const get = defineRoute({ auth: "none", kind: "raw", handler: () => new Response() });
export const GET: typeof get = async (request, context) => policy(await get(request, context));
`,
  );

  assert.equal(runChecker(root).status, 0);
});

test("an arbitrary wrapper cannot discard a canonical handler result", async (t) => {
  const root = await fixture(t);
  await writeRoute(
    root,
    "src/app/api/discarded-wrapper/route.ts",
    `import { defineRoute } from "@/server/api/defineRoute";
const get = defineRoute({ auth: "none", kind: "raw", handler: () => new Response() });
const discard = (_response: Response) => new Response("raw");
export const GET: typeof get = async (request, context) => discard(await get(request, context));
`,
  );

  const result = runChecker(root);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /discarded-wrapper\/route\.ts GET export is not structurally bound/u,
  );
});

test("a discarded canonical call cannot authorize a later raw return", async (t) => {
  const root = await fixture(t);
  await writeRoute(
    root,
    "src/app/api/discarded-call/route.ts",
    `import { defineRoute } from "@/server/api/defineRoute";
const get = defineRoute({ auth: "none", kind: "raw", handler: () => new Response() });
export const GET: typeof get = async (request, context) => {
  await get(request, context);
  return new Response("raw");
};
`,
  );

  const result = runChecker(root);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /discarded-call\/route\.ts GET export is not structurally bound/u,
  );
});

test("a dead assignment cannot taint a raw return", async (t) => {
  const root = await fixture(t);
  await writeRoute(
    root,
    "src/app/api/dead-assignment/route.ts",
    `import { defineRoute } from "@/server/api/defineRoute";
const get = defineRoute({ auth: "none", kind: "raw", handler: () => new Response() });
export const GET: typeof get = async (request, context) => {
  let response = new Response("raw");
  if (false) response = await get(request, context);
  return response;
};
`,
  );

  const result = runChecker(root);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /dead-assignment\/route\.ts GET export is not structurally bound/u,
  );
});

test("the raw OPTIONS allowance is restricted to the classified preflight", async (t) => {
  const root = await fixture(t);
  await writeRoute(
    root,
    "src/app/api/label-assets/[id]/route.ts",
    `import { defineRoute } from "@/server/api/defineRoute";
export const GET = defineRoute({ auth: "none", handler: () => ({ ok: true }) });
export async function OPTIONS() { return new Response(null, { status: 204 }); }
`,
  );
  assert.equal(runChecker(root).status, 0, "classified preflight should pass");

  await writeRoute(
    root,
    "src/app/api/unclassified/route.ts",
    `import { defineRoute } from "@/server/api/defineRoute";
export const GET = defineRoute({ auth: "none", handler: () => ({ ok: true }) });
export async function OPTIONS() { return new Response(null, { status: 204 }); }
`,
  );
  const result = runChecker(root);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /unclassified\/route\.ts OPTIONS export is not structurally bound/u,
  );
});

test("classified framework, health, and raw-route exceptions remain explicit", async (t) => {
  const root = await fixture(t);
  await writeRoute(
    root,
    "src/app/api/health/route.ts",
    `export async function GET() { return Response.json({ ok: true }); }
`,
  );

  assert.equal(runChecker(root).status, 0);
});

test("a classified route exception rejects extra HTTP methods", async (t) => {
  const root = await fixture(t);
  await writeRoute(
    root,
    "src/app/api/health/route.ts",
    `export async function GET() { return Response.json({ ok: true }); }
export async function POST() { return Response.json({ ok: true }); }
`,
  );

  const result = runChecker(root);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /health\/route\.ts health exception method inventory drifted: expected GET; observed GET, POST/u,
  );
});

test("database-backed authority belongs in the server service layer", async (t) => {
  const root = await fixture(t);
  const authority = `import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
export function refreshAuthority() { return db.select().from(users); }
`;

  await writeRoute(
    root,
    "src/server/services/auth-jwt-authority.ts",
    authority,
  );
  assert.equal(runChecker(root).status, 0, "server service should pass");

  await writeRoute(root, "src/lib/auth-jwt-authority.ts", authority);
  const misplaced = runChecker(root);
  assert.equal(misplaced.status, 1);
  assert.match(
    misplaced.stderr,
    /\[db-placement\] src\/lib\/auth-jwt-authority\.ts has 2 unapproved occurrences/u,
  );
});
