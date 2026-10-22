// [2026-10-21 owner ask] Past-run timing for the YOLO cost estimate (src/lib/yolo-cost.ts): startup
// seconds + seconds per page, fitted per model × instance and per instance (any model) from completed
// YOLO processing_jobs. ROOT-ONLY consumer (GET /api/admin/yolo-instance/options), all companies.
//
//   seconds  = model_config.runSeconds (provider CreationTime→ProcessingEndTime, recorded at the
//              terminal PUT since 2026-10-22) else completed_at − started_at (DB; can lag by a poll)
//   instance = model_config.instanceType else ml.g4dn.xlarge (the only type before the picker)
//   pages    = the sagemaker compute_usage row for the job, else the project's page count
// Never throws: a failed read returns [] and the estimate falls back to its stated defaults.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { DEFAULT_YOLO_INSTANCE_TYPE } from "@/lib/yolo-instances";
import { fitYoloRunTiming, type YoloRunSample, type YoloRunStat } from "@/lib/yolo-cost";

const SAMPLE_LIMIT = 500;
const MIN_SECONDS = 10;
const MAX_SECONDS = 90_000;

export interface YoloRunRow {
  modelId: number;
  instanceType: string;
  pages: number;
  seconds: number;
}

/** Group + fit. Exported for tests. */
export function yoloRunStatsFromRows(rows: readonly YoloRunRow[]): YoloRunStat[] {
  const groups = new Map<string, { modelId: number | null; instanceType: string; samples: YoloRunSample[] }>();
  const add = (modelId: number | null, instanceType: string, sample: YoloRunSample) => {
    const key = `${modelId ?? "*"}|${instanceType}`;
    const g = groups.get(key) ?? { modelId, instanceType, samples: [] };
    g.samples.push(sample);
    groups.set(key, g);
  };
  for (const r of rows) {
    if (!(r.pages > 0) || !(r.seconds >= MIN_SECONDS && r.seconds <= MAX_SECONDS)) continue;
    add(r.modelId, r.instanceType, { pages: r.pages, seconds: r.seconds });
    add(null, r.instanceType, { pages: r.pages, seconds: r.seconds });
  }
  const out: YoloRunStat[] = [];
  for (const g of groups.values()) {
    const fit = fitYoloRunTiming(g.samples);
    if (fit) out.push({ modelId: g.modelId, instanceType: g.instanceType, ...fit });
  }
  return out;
}

export async function getYoloRunStats(): Promise<YoloRunStat[]> {
  try {
    const result = await db.execute(sql`
      SELECT
        pj.model_config->>'modelId' AS "modelId",
        COALESCE(pj.model_config->>'instanceType', ${DEFAULT_YOLO_INSTANCE_TYPE}) AS "instanceType",
        CASE WHEN pj.model_config->>'runSeconds' ~ '^[0-9]+(\\.[0-9]+)?$'
             THEN (pj.model_config->>'runSeconds')::double precision
             ELSE EXTRACT(EPOCH FROM (pj.completed_at - pj.started_at)) END AS "seconds",
        COALESCE(cu.pages, p.num_pages) AS "pages"
      FROM processing_jobs pj
      JOIN projects p ON p.id = pj.project_id
      LEFT JOIN (
        SELECT job_id, MAX(pages) AS pages FROM compute_usage
        WHERE resource = 'sagemaker' AND job_id IS NOT NULL GROUP BY job_id
      ) cu ON cu.job_id = pj.execution_id
      WHERE pj.status = 'completed'
        AND pj.model_config IS NOT NULL
        AND pj.error IS NULL
        AND pj.started_at IS NOT NULL
        AND pj.completed_at IS NOT NULL
      ORDER BY pj.completed_at DESC
      LIMIT ${SAMPLE_LIMIT}
    `);
    const rows: YoloRunRow[] = [];
    for (const raw of result.rows as Array<Record<string, unknown>>) {
      const modelId = Number(raw.modelId);
      const row = {
        modelId,
        instanceType: String(raw.instanceType ?? DEFAULT_YOLO_INSTANCE_TYPE),
        pages: Number(raw.pages),
        seconds: Number(raw.seconds),
      };
      if (Number.isInteger(modelId)) rows.push(row);
    }
    return yoloRunStatsFromRows(rows);
  } catch (err) {
    logger.warn("[yolo] run-history read failed; cost estimates use the default assumption", { error: String(err).slice(0, 300) });
    return [];
  }
}
