// [feat 2026-10-22 dedupe-v2] Admin › Data tools › Duplicate projects (ROOT only).
// Owner: "we need the ability to delete duplicate uploaded projects: first check if any project
// is named exactly the same, next look at … the CHEAPEST thing to compare whether two uploaded
// PDFs are actually the same."
//
//   scan   → groups of likely duplicate projects per company, cheapest tiers first:
//            name / normalized name / upload sizes / page-text hash come from Postgres alone
//            (the text hash is computed IN Postgres — only 32 hex chars per project come back);
//            then, for group members only, one S3 HeadObject each on `${dataUrl}/original.pdf`
//            (ETag + size), and a streamed SHA-256 only where ETags cannot be compared.
//            Nothing outside a group is ever read from S3. Changes nothing.
//   delete → dry run (the plan, per project: delete / blocked / refused, + a planDigest) or, with
//            the typed phrase and the dry run's digest, the real run: each non-keeper goes through
//            the ONE project-deletion path (deleteProjectFully). A refusal there (labeling
//            session, running job, upload fence, …) is reported per project, never fails the batch.
//
// Safety: root only (route auth:"root" + rootOnly here); demo projects are never in scope; a
// keeper is never deleted; a project that shares no signal with its keeper is refused; the real
// run recomputes the plan and refuses (409) unless it matches the dry run the admin reviewed.
// No file hash is stored at upload (projects has no column for it; see DEDUPE_V2 notes): the
// ETag of original.pdf is already its MD5 (single PutObject, SSE-S3 bucket).

import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { AuthSession } from "@/lib/api-utils";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import {
  annotations,
  companies,
  labelingSessions,
  labelStudioProjectIntents,
  processingJobs,
  projectMutationLeases,
  projects,
  takeoffItems,
  users,
} from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { deleteProjectFully } from "@/lib/project-delete";
import {
  defaultKeeper,
  fileKeys,
  groupProjects,
  hashKey,
  matchLevel,
  type FileHead,
  type ProjectFingerprint,
  type ProjectMatchLevel,
} from "@/lib/project-dedup";
import { PROJECT_UPLOAD_PUBLICATION_FENCE_SECONDS } from "@/lib/project-upload-authority";
import { getS3ObjectStream, headS3Object } from "@/lib/s3";
import { ApiError } from "@/server/api/envelope";
import { assertProjectWritable } from "@/server/api/project-write-capability";
import { HUMAN_ANNOTATION_SOURCES, resolveCompanyScope } from "./page-duplicates";

const MAX_PROJECTS = 2000;
const TEXT_BATCH = 100;
const HEAD_CONCURRENCY = 8;
/** Streamed-hash budget per request; beyond it a file stays "not compared". */
const MAX_HASH_BYTES = 2 * 1024 * 1024 * 1024;
/** A text hash needs text on at least half the pages and this many characters overall. */
const MIN_TEXT_CHARS = 50;
export const DELETE_CONFIRM = "DELETE";

export interface DuplicateProjectMember extends ProjectFingerprint {
  status: string;
  numPages: number | null;
  companyName: string;
  owner: string | null;
  userAnnotations: number;
  takeoffItems: number;
  /** Why deleteProjectFully would refuse right now, or null. */
  blocked: string | null;
  /** original.pdf bytes; null = not checked or missing. */
  fileSize: number | null;
  fileNote: string | null;
}

interface LoadedProject extends DuplicateProjectMember {
  id: number;
  dataUrl: string;
  jobId: string | null;
  isDemo: boolean;
  lifecycleEpoch: number;
}

function rootOnly(session: AuthSession): void {
  if (!session.user.isRootAdmin) throw new ApiError("FORBIDDEN", "Root only");
}

/** Passed as a bind parameter so no layer re-escapes the backslash. */
const WHITESPACE_RUN = "\\s+";
const idList = (ids: readonly number[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);

/** Text hash + page count per project, computed in Postgres (one surviving row per page number). */
async function textFingerprints(ids: readonly number[]): Promise<Map<number, { pages: number; hash: string | null }>> {
  const out = new Map<number, { pages: number; hash: string | null }>();
  for (let i = 0; i < ids.length; i += TEXT_BATCH) {
    const batch = ids.slice(i, i + TEXT_BATCH);
    const res = await db.execute(sql`
      SELECT project_id,
             count(*)::int AS pages,
             count(*) FILTER (WHERE length(btrim(coalesce(raw_text, ''))) > 0)::int AS text_pages,
             coalesce(sum(length(coalesce(raw_text, ''))), 0)::bigint AS chars,
             md5(string_agg(md5(regexp_replace(lower(coalesce(raw_text, '')), ${WHITESPACE_RUN}, ' ', 'g')), ',' ORDER BY page_number)) AS hash
        FROM (SELECT DISTINCT ON (project_id, page_number) project_id, page_number, raw_text
                FROM pages WHERE project_id IN (${idList(batch)})
               ORDER BY project_id, page_number, id) p
       GROUP BY project_id`);
    for (const row of res.rows as { project_id: number; pages: number; text_pages: number; chars: string | number; hash: string }[]) {
      const enough = row.text_pages * 2 >= row.pages && Number(row.chars) >= MIN_TEXT_CHARS;
      out.set(Number(row.project_id), { pages: row.pages, hash: enough ? row.hash : null });
    }
  }
  return out;
}

async function countBy(ids: number[], query: (ids: number[]) => Promise<{ projectId: number; n: number }[]>) {
  const out = new Map<number, number>();
  if (ids.length) for (const r of await query(ids)) out.set(r.projectId, Number(r.n));
  return out;
}

/** Non-demo projects in scope with every DB signal. With `publicIds`, each must resolve (404). */
async function loadProjects(companyId: number | null, publicIds: readonly string[] | null): Promise<LoadedProject[]> {
  const filters: SQL[] = [eq(projects.isDemo, false)];
  if (companyId !== null) filters.push(eq(projects.companyId, companyId));
  if (publicIds) filters.push(inArray(projects.publicId, [...new Set(publicIds)]));
  const rows = await db
    .select({
      id: projects.id, publicId: projects.publicId, name: projects.name, companyId: projects.companyId,
      companyName: companies.name, owner: users.email, status: projects.status, numPages: projects.numPages,
      createdAt: projects.createdAt, dataUrl: projects.dataUrl, jobId: projects.jobId, isDemo: projects.isDemo,
      lifecycleEpoch: projects.lifecycleEpoch, stagingManifest: projects.stagingManifest,
      fenceOpen: sql<boolean>`${projects.createdAt} IS NULL OR ${projects.createdAt} + (${PROJECT_UPLOAD_PUBLICATION_FENCE_SECONDS} * INTERVAL '1 second') > CURRENT_TIMESTAMP`,
    })
    .from(projects)
    .innerJoin(companies, eq(companies.id, projects.companyId))
    .leftJoin(users, eq(users.id, projects.authorId))
    .where(and(...filters))
    .orderBy(asc(projects.id))
    .limit(MAX_PROJECTS);
  if (publicIds && rows.length !== new Set(publicIds).size) throw new ApiError("NOT_FOUND", "Project not found");
  const ids = rows.map((r) => r.id);

  const text = ids.length ? await textFingerprints(ids) : new Map();
  const userAnnotations = await countBy(ids, (ids) => db
    .select({ projectId: annotations.projectId, n: sql<number>`count(*)::int` }).from(annotations)
    .where(and(inArray(annotations.projectId, ids), inArray(annotations.source, [...HUMAN_ANNOTATION_SOURCES])))
    .groupBy(annotations.projectId));
  const takeoffs = await countBy(ids, (ids) => db
    .select({ projectId: takeoffItems.projectId, n: sql<number>`count(*)::int` }).from(takeoffItems)
    .where(inArray(takeoffItems.projectId, ids)).groupBy(takeoffItems.projectId));
  const labeling = await countBy(ids, (ids) => db
    .select({ projectId: labelingSessions.projectId, n: sql<number>`count(*)::int` }).from(labelingSessions)
    .where(inArray(labelingSessions.projectId, ids)).groupBy(labelingSessions.projectId));
  const intents = await countBy(ids, (ids) => db
    .select({ projectId: labelStudioProjectIntents.projectId, n: sql<number>`count(*)::int` }).from(labelStudioProjectIntents)
    .where(inArray(labelStudioProjectIntents.projectId, ids)).groupBy(labelStudioProjectIntents.projectId));
  const running = await countBy(ids, (ids) => db
    .select({ projectId: processingJobs.projectId, n: sql<number>`count(*)::int` }).from(processingJobs)
    .where(and(inArray(processingJobs.projectId, ids), eq(processingJobs.status, "running"))).groupBy(processingJobs.projectId));
  const leases = await countBy(ids, (ids) => db
    .select({ projectId: projectMutationLeases.projectId, n: sql<number>`count(*)::int` }).from(projectMutationLeases)
    .where(and(inArray(projectMutationLeases.projectId, ids), eq(projectMutationLeases.status, "active"))).groupBy(projectMutationLeases.projectId));

  return rows.map((r) => {
    const t = text.get(r.id);
    const manifest = Array.isArray(r.stagingManifest) ? r.stagingManifest : [];
    const sizes = manifest.map((f) => Number(f?.size)).filter((n) => Number.isFinite(n) && n > 0);
    const ann = userAnnotations.get(r.id) ?? 0;
    const tko = takeoffs.get(r.id) ?? 0;
    const blocked = labeling.has(r.id) ? "labeling session"
      : intents.has(r.id) ? "Label Studio provisioning pending"
      : running.has(r.id) ? "processing job running"
      : leases.has(r.id) ? "project busy (active job lease)"
      : r.fenceOpen ? "uploaded too recently (upload window still open)"
      : null;
    return {
      id: r.id, publicId: r.publicId, name: r.name, companyId: r.companyId, companyName: r.companyName,
      owner: r.owner ?? null, status: r.status, numPages: r.numPages,
      createdAt: r.createdAt ? r.createdAt.toISOString() : null,
      dataUrl: r.dataUrl, jobId: r.jobId, isDemo: r.isDemo, lifecycleEpoch: r.lifecycleEpoch,
      pageCount: t?.pages ?? 0, textHash: t?.hash ?? null,
      uploadSizes: sizes.length && sizes.length === manifest.length ? sizes.join(",") : null,
      userAnnotations: ann, takeoffItems: tko, userWork: ann + tko,
      blocked, fileKey: null, fileSize: null, fileNote: null,
    };
  });
}

async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function sha256Of(key: string): Promise<string> {
  const { body } = await getS3ObjectStream(key);
  const hash = createHash("sha256");
  const reader = body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    hash.update(value);
  }
  return hash.digest("hex");
}

/**
 * The byte tier, for the given groups' members ONLY: HeadObject each original.pdf, key equal-size
 * comparable ETags, stream SHA-256 where they are not comparable. Mutates fileKey/fileSize/fileNote.
 */
async function confirmFiles(groups: readonly LoadedProject[][]): Promise<{ checked: number; missing: number; hashed: number; errors: number }> {
  const stats = { checked: 0, missing: 0, hashed: 0, errors: 0 };
  const heads = new Map<string, FileHead>();
  await pool(groups.flat(), HEAD_CONCURRENCY, async (m) => {
    try {
      const head = await headS3Object(`${m.dataUrl}/original.pdf`);
      stats.checked++;
      if (!head.exists) { stats.missing++; m.fileNote = "no original.pdf"; }
      m.fileSize = head.exists ? (head.size ?? null) : null;
      heads.set(m.publicId, { publicId: m.publicId, size: m.fileSize, eTag: head.exists ? (head.eTag ?? null) : null });
    } catch (err) {
      stats.errors++;
      m.fileNote = "file check failed";
      logger.warn("[project-duplicates] HeadObject failed", { projectPublicId: m.publicId, err: String(err) });
    }
  });
  let hashBudget = MAX_HASH_BYTES;
  for (const group of groups) {
    const { keys, needHash } = fileKeys(group.flatMap((m) => heads.get(m.publicId) ?? []));
    for (const m of group) m.fileKey = keys.get(m.publicId) ?? null;
    for (const m of group.filter((x) => needHash.includes(x.publicId))) {
      if (m.fileSize === null || m.fileSize > hashBudget) { m.fileNote = "not compared (hash budget)"; continue; }
      try {
        hashBudget -= m.fileSize;
        m.fileKey = hashKey(m.fileSize, await sha256Of(`${m.dataUrl}/original.pdf`));
        stats.hashed++;
      } catch (err) {
        stats.errors++;
        m.fileNote = "file hash failed";
        logger.warn("[project-duplicates] hash failed", { projectPublicId: m.publicId, err: String(err) });
      }
    }
  }
  return stats;
}

/** What the browser sees: no internal id, storage root or job id. */
function publicMember(m: LoadedProject): DuplicateProjectMember {
  return {
    publicId: m.publicId, companyId: m.companyId, companyName: m.companyName, name: m.name, owner: m.owner,
    status: m.status, createdAt: m.createdAt, numPages: m.numPages, pageCount: m.pageCount, textHash: m.textHash,
    uploadSizes: m.uploadSizes, userAnnotations: m.userAnnotations, takeoffItems: m.takeoffItems, userWork: m.userWork,
    blocked: m.blocked, fileKey: m.fileKey, fileSize: m.fileSize, fileNote: m.fileNote,
  };
}

/** POST /api/admin/project-duplicates/scan — read-only. {checkFiles?: boolean} (default true). */
export async function scanProjectDuplicates(
  session: AuthSession,
  body: { checkFiles?: boolean },
  query: { companyId?: string },
): Promise<unknown> {
  rootOnly(session);
  const companyId = resolveCompanyScope(session, query.companyId);
  const loaded = await loadProjects(companyId, null);
  const groups = groupProjects(loaded);
  const files = body.checkFiles === false ? null : await confirmFiles(groups);
  // A byte match can join projects no DB signal linked only if they were already candidates, so
  // regrouping after the file tier only ever merges groups — it never pulls in a non-candidate.
  const final = files ? groupProjects(groups.flat()) : groups;
  const byCompany = new Map<number, { companyId: number; companyName: string; groups: unknown[] }>();
  for (const group of final) {
    const keeper = defaultKeeper(group);
    const entry = byCompany.get(keeper.companyId) ?? { companyId: keeper.companyId, companyName: keeper.companyName, groups: [] };
    entry.groups.push({ id: `g-${group[0].publicId}`, defaultKeeper: keeper.publicId, members: group.map(publicMember) });
    byCompany.set(keeper.companyId, entry);
  }
  return {
    scannedProjects: loaded.length,
    truncated: loaded.length >= MAX_PROJECTS,
    files,
    companies: [...byCompany.values()].sort((a, b) => a.companyName.localeCompare(b.companyName)),
  };
}

// ── delete ────────────────────────────────────────────────────────────────────────────────

export interface DeleteGroupRequest {
  keeper: string;
  remove: string[];
}

interface PlanItem {
  publicId: string;
  name: string;
  level: ProjectMatchLevel | null;
  userWork: number;
  action: "delete" | "blocked" | "refused";
  reason: string | null;
}

function planItems(keeper: LoadedProject, victims: LoadedProject[]): PlanItem[] {
  return victims.map((v) => {
    const level = matchLevel(v, keeper);
    const base = { publicId: v.publicId, name: v.name, level, userWork: v.userWork };
    if (!level) return { ...base, action: "refused", reason: "shares no duplicate signal with the keeper" };
    if (v.blocked) return { ...base, action: "blocked", reason: v.blocked };
    return { ...base, action: "delete", reason: null };
  });
}

function planDigest(plan: { keeper: string; items: PlanItem[] }[]): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

/** "blocked: labeling session" etc. from a deleteProjectFully refusal. */
function refusalReason(message: string): string {
  if (/labeling session/i.test(message)) return "labeling session";
  if (/label studio/i.test(message)) return "Label Studio provisioning pending";
  return message;
}

/**
 * POST /api/admin/project-duplicates/delete — {groups:[{keeper, remove}], dryRun, planDigest?,
 * confirm?}. Dry run writes nothing. The real run needs confirm === "DELETE" and the dry run's
 * planDigest (recomputed now; any change → 409, run the dry run again).
 */
export async function deleteProjectDuplicates(
  session: AuthSession,
  body: { groups: DeleteGroupRequest[]; dryRun: boolean; planDigest?: string; confirm?: string },
  query: { companyId?: string },
): Promise<unknown> {
  rootOnly(session);
  const companyId = resolveCompanyScope(session, query.companyId);
  const seen = new Set<string>();
  for (const g of body.groups) {
    for (const id of [g.keeper, ...g.remove]) {
      if (seen.has(id)) throw new ApiError("VALIDATION", "A project may appear once (as a keeper or a removal)");
      seen.add(id);
    }
    if (!g.remove.length) throw new ApiError("VALIDATION", "Each group needs at least one project to remove");
  }
  if (!body.dryRun) {
    if (body.confirm !== DELETE_CONFIRM) throw new ApiError("VALIDATION", `Type ${DELETE_CONFIRM} to confirm`);
    if (!body.planDigest) throw new ApiError("VALIDATION", "Run the dry run first and pass its planDigest");
  }

  const loaded = await loadProjects(companyId, [...seen]);
  const byId = new Map(loaded.map((p) => [p.publicId, p]));
  const resolved = body.groups.map((g) => ({ keeper: byId.get(g.keeper)!, victims: g.remove.map((id) => byId.get(id)!) }));
  await confirmFiles(resolved.map((g) => [g.keeper, ...g.victims]));
  const plan = resolved.map((g) => ({ keeper: g.keeper.publicId, items: planItems(g.keeper, g.victims) }));
  const digest = planDigest(plan);
  const summary = {
    delete: plan.reduce((n, g) => n + g.items.filter((i) => i.action === "delete").length, 0),
    blocked: plan.reduce((n, g) => n + g.items.filter((i) => i.action === "blocked").length, 0),
    refused: plan.reduce((n, g) => n + g.items.filter((i) => i.action === "refused").length, 0),
  };
  if (body.dryRun) return { dryRun: true, planDigest: digest, summary, groups: plan };
  if (body.planDigest !== digest) throw new ApiError("CONFLICT", "Projects changed since the dry run; run the dry run again");

  const results: { publicId: string; name: string; keeper: string; result: "deleted" | "blocked" | "refused" | "failed"; reason: string | null }[] = [];
  for (const group of plan) {
    for (const item of group.items) {
      const base = { publicId: item.publicId, name: item.name, keeper: group.keeper };
      if (item.action !== "delete") { results.push({ ...base, result: item.action, reason: item.reason }); continue; }
      const project = byId.get(item.publicId)!;
      try {
        await deleteProjectFully(
          { id: project.id, dataUrl: project.dataUrl, jobId: project.jobId, name: project.name },
          assertProjectWritable(project),
        );
        results.push({ ...base, result: "deleted", reason: null });
        audit("project_deleted", {
          userId: session.user.dbId,
          companyId: project.companyId,
          details: { projectId: project.publicId, name: project.name, via: "admin.project-duplicates", keeper: group.keeper, match: item.level },
        });
      } catch (err) {
        if (err instanceof ApiError && err.status < 500) {
          results.push({ ...base, result: "blocked", reason: refusalReason(err.message) });
        } else {
          logger.error("[project-duplicates] delete failed", { projectPublicId: project.publicId, err: String(err) });
          results.push({ ...base, result: "failed", reason: err instanceof Error ? err.message.slice(0, 200) : "unknown error" });
        }
      }
    }
  }
  return { dryRun: false, results };
}
