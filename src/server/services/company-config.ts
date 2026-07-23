// [refactor jul23 P4.1 U11] Company-scoped pipelineConfig FOR-UPDATE write wrapper.
//
// WHY (Stage B): every companies.pipelineConfig writer has been a NON-ATOMIC
// read-modify-write since the S037 fold — the H2/DR002 lost-update class the code
// already self-flags (company-settings.ts:14-15, csi-upload.ts:20-25 header,
// llm-config.ts:22-23 header). Two concurrent admin PUTs to DIFFERENT subtrees
// (e.g. a demo toggle + a csi threshold) both read the same base, then the second
// UPDATE silently clobbers the first subtree's change. This wrapper closes that the
// SAME way pages.ts (DR002) and regions.ts:160-171 (promote) close it for project
// rows: a `SELECT ... FOR UPDATE` on the companies row inside `db.transaction`, so
// concurrent writers SERIALIZE (the second blocks, then RE-READS the first's
// committed state) instead of racing. Last-write-wins PER SUBTREE stays the frozen
// merge semantic — no write is ever TORN, and no sibling subtree is silently lost.
//
// COMPANY-scoped, NOT project-scoped: pipelineConfig hangs off `companies`, has no
// project and no ProjectWriteCapability, so `withProjectWrite` CANNOT be reused (it
// locks the `projects` row + requires a capability — project-write-capability.ts:
// withProjectWritesOnTransaction). This is the FIRST companies-row FOR UPDATE in the
// repo; the raw `db.transaction` + `.for("update")` shape is copied from
// demo.ts:66-92 and admin-users.ts:255-292 (both lock a non-project parent row
// directly, no capability layer).
//
// I-1 (async-outside-lock): callers that do S3 / cache / formData work
// (csi-upload.ts uploadCsiDatabase / revertCsiDatabase) keep that work OUTSIDE this
// wrapper — the mutator must stay pure/synchronous CPU; no async detect/S3
// dependency runs while the row lock is held (the regions.ts:155-158 precedent).
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
// [refactor jul23 P4.1 U11-D] log-mode shape observation at the sink (Stage D).
import { logger } from "@/lib/logger";
import { PIPELINE_SUBTREE_SCHEMAS } from "@/types/shapes";

/** The non-null `companies.pipelineConfig` column type (the jsonb `$type` union). */
export type PipelineConfig = NonNullable<typeof companies.$inferSelect.pipelineConfig>;

/**
 * Atomically read-modify-write `companies.pipelineConfig` under a row lock.
 *
 * @param companyId  the company whose pipelineConfig column is mutated.
 * @param mutate     pure transform of the CURRENT (FOR-UPDATE'd) config into the
 *                   value to persist. Runs INSIDE the tx AFTER the lock is held, so
 *                   it observes the latest committed state — never a stale read.
 *                   Must stay synchronous/pure (no I/O): the row lock is held for
 *                   its duration (I-1).
 * @param opts.touchUpdatedAt  when true, ALSO bumps `companies.updatedAt`. Preserves
 *                   the frozen per-writer split (heuristics / text-annotations /
 *                   llm-settings touch it; demo / pipeline / llm / csi / upload /
 *                   revert do NOT).
 *
 * Empty-default: a missing/null column reads as `{}` (matches readPipelineConfig's
 * `company?.pipelineConfig || {}` — company-settings.ts:56).
 */
export async function updatePipelineConfig(
  companyId: number,
  mutate: (current: PipelineConfig) => PipelineConfig,
  opts: { touchUpdatedAt?: boolean } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ pipelineConfig: companies.pipelineConfig })
      .from(companies)
      .where(eq(companies.id, companyId))
      .for("update") // ← the regions.ts:170 / pages.ts:170 row lock, on companies
      .limit(1);
    const current = (row?.pipelineConfig || {}) as PipelineConfig;
    const updated = mutate(current);
    await tx
      .update(companies)
      .set(
        opts.touchUpdatedAt
          ? { pipelineConfig: updated, updatedAt: new Date() }
          : { pipelineConfig: updated },
      )
      .where(eq(companies.id, companyId));
    // [refactor jul23 P4.1 U11-D] observe what was just persisted (log-only, never
    // throws — pure CPU zod under the lock is accepted, the RD-U10 in-tx-classifier
    // precedent). NO v-gate / NO 400: no pipelineConfig writer stamps a `v`, so this
    // is pure log-mode canary (Verdict 2); the shell-level zCsiConfigPut 400 and the
    // imperative in-service 400s (company-settings.ts) stay verbatim upstream.
    observePipelineConfig(updated, "pipelineConfig.write");
  });
}

// ─── Stage D: log-mode subtree observation ───────────────────────────────────
// [refactor jul23 P4.1 U11-D] Classify the persisted config BY TOP-LEVEL SUBTREE KEY
// and validate each RECOGNIZED subtree against its `.loose()` registry schema
// (src/types/shapes/pipeline-config.ts). ONE aggregated `[shape-registry]` warn per
// call; paths+codes only, NEVER blob values (admin config can carry user prompt text
// in llm.systemPrompt / heuristics). Unknown top-level siblings (e.g. `__sentinel`,
// `ensemble`, `disabledSteps`) have no sibling schema → skipped, never warned. This
// is the pipelineConfig analogue of annotation-data-observe.ts (U1).

/** Cap issue detail per log entry — enough to locate the field, no value dumps. */
const MAX_LOGGED_ISSUES = 5;

/**
 * Observe the shape of a persisted pipelineConfig at the wrapper sink. Never throws;
 * the write has ALREADY happened — this is a read-only canary. `.loose()` schemas
 * mean only wrong-TYPED known keys drift; unknown keys/siblings round-trip silently.
 */
function observePipelineConfig(config: PipelineConfig, sink: string): void {
  const cfg = config as Record<string, unknown>;
  const drifted: string[] = [];
  const issues: string[] = [];
  let issueCount = 0;
  for (const [subtree, schema] of Object.entries(PIPELINE_SUBTREE_SCHEMAS)) {
    if (!(subtree in cfg) || cfg[subtree] === undefined) continue;
    const result = schema.safeParse(cfg[subtree]);
    if (result.success) continue;
    drifted.push(subtree);
    issueCount += result.error.issues.length;
    // Prefix every issue path with its subtree so the aggregated warn is locatable.
    for (const i of result.error.issues) {
      issues.push(`${subtree}.${i.path.join(".") || "(root)"}:${i.code}`);
    }
  }
  if (drifted.length === 0) return;
  logger.warn(`[shape-registry] v0 pipelineConfig write failed subtree validation (log-only)`, {
    sink,
    subtrees: drifted,
    issueCount,
    issues: issues.slice(0, MAX_LOGGED_ISSUES),
  });
}
