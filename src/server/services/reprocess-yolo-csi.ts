// [fix 2026-10-21 reprocess-persistence] YOLO class → CSI codes for the admin FULL reprocess.
//
// yoloLoad (services/yolo.ts) merges every loaded model's `config.classCsiCodes` into
// pages.csiCodes as {description:"From YOLO class config"}. The full reprocess then rewrote
// pages.csiCodes from text detection ALONE, silently dropping those codes, and no admin
// reprocess path re-applied them (the "YOLO CSI Code Merge" pipeline step had no reprocess).
// The full scope now keeps the page's previously merged YOLO codes AND re-applies the current
// class config of every model whose detections are loaded in the project — the same "every
// page of the project" semantics yoloLoad uses.
import { db } from "@/lib/db";
import { annotations, models } from "@/lib/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { mergeCsiCodes } from "@/lib/csi-utils";
import type { CsiCode } from "@/types";

export const YOLO_CSI_DESCRIPTION = "From YOLO class config";

export interface ProjectYoloCsi {
  codes: { code: string; description: string }[];
  models: number;
}

/** Class→CSI codes of every YOLO model whose detections are loaded in this project. */
export async function loadProjectYoloCsiCodes(projectId: number): Promise<ProjectYoloCsi> {
  const rows = await db
    .selectDistinct({ modelId: sql<string | null>`${annotations.data}->>'modelId'` })
    .from(annotations)
    .where(and(eq(annotations.projectId, projectId), eq(annotations.source, "yolo")));
  const ids = rows.map((r) => Number(r.modelId)).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return { codes: [], models: 0 };
  const loaded = await db.select({ config: models.config }).from(models).where(inArray(models.id, ids));
  const codes = new Set<string>();
  for (const m of loaded) {
    for (const list of Object.values(m.config?.classCsiCodes ?? {})) {
      for (const code of list) if (code) codes.add(code);
    }
  }
  return { codes: [...codes].map((code) => ({ code, description: YOLO_CSI_DESCRIPTION })), models: loaded.length };
}

/** Text-detected codes + the page's previously merged YOLO-class codes + the models' current ones. */
export function withYoloCsiCodes(
  detected: CsiCode[],
  previous: CsiCode[] | null | undefined,
  projectYolo: ProjectYoloCsi,
): CsiCode[] {
  const kept = (previous ?? []).filter((c) => c.description === YOLO_CSI_DESCRIPTION);
  if (kept.length === 0 && projectYolo.codes.length === 0) return detected;
  return mergeCsiCodes(mergeCsiCodes(detected, kept), projectYolo.codes);
}
