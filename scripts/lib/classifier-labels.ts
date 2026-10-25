/**
 * scripts/lib/classifier-labels.ts — the kind-label loaders shared by classifier-measure.ts and
 * classifier-fit.ts: the labels file (clf-kind-labels/1, track L), the page list (research sample +
 * the labeller's pages.json), and the label → proposal join (regionId, else bbox IoU ≥ .5 on the same
 * page). Nothing here prints OCR text; projects are "set N".
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BboxMinMax } from "@/types";
import { iou } from "@/lib/region-classifier-v2/geometry";
import { readSample, type SamplePage } from "./corpus-v2-marks";

export const DEFAULT_LABELS = "/workspaces/projects/gitignore/projects/classifier_builder/labels/kinds.v1.json";

export interface KindLabel { set: number; page: number; regionId?: string; bbox?: BboxMinMax; kind: string; name?: string; printedTitle?: string | null; note?: string | null }

export type NoteGroup = "schedule" | "legend-keynote" | "title-block" | "notes" | "other-nonschedule";

/**
 * [shape-tags] The not-a-schedule sub-group from the labeller's free-text note (shape_tags/tools/extract_features.py
 * note_group, verbatim): approximate, single labeller. "legend-keynote" boxes are TABLES too (owner), so table-ness
 * = schedule ∪ legend-keynote.
 */
export function noteGroup(l: Pick<KindLabel, "kind" | "note">): NoteGroup {
  if (l.kind !== "not-a-schedule") return "schedule";
  const n = (l.note ?? "").toLowerCase();
  if (["legend", "symbol", "keynote", "key note", "coded note", "abbrev"].some((w) => n.includes(w))) return "legend-keynote";
  if (["title block", "revision", "stamp", "consultant"].some((w) => n.includes(w))) return "title-block";
  if (n.includes("note")) return "notes";
  return "other-nonschedule";
}
export const isTableLabel = (l: Pick<KindLabel, "kind" | "note">): boolean => { const g = noteGroup(l); return g === "schedule" || g === "legend-keynote"; };

/** The labels file (an array, or {labeller, labels | items}); "unreadable" and malformed rows dropped. Null when the file is absent. */
export function readKindLabels(path = DEFAULT_LABELS): { labeller: string; items: KindLabel[] } | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const r = raw as { items?: unknown[]; labels?: unknown[]; labeller?: unknown };
  const items = (Array.isArray(raw) ? raw : r.labels ?? r.items ?? []) as KindLabel[];
  const labeller = Array.isArray(raw) ? "unknown" : String(r.labeller ?? "unknown");
  return {
    labeller,
    items: items.filter((l) => l && typeof l.kind === "string" && l.kind !== "unreadable" && typeof l.set === "number" && typeof l.page === "number")
      .map((l) => ({ ...l, name: l.name ?? (typeof l.printedTitle === "string" ? l.printedTitle : undefined) })),
  };
}

/** Research-sample pages plus the labeller's page list (labels/tools/out/pages.json: set + page → pid), deduped. */
export function labelledSamplePages(research: string, labelsPath = DEFAULT_LABELS, pageList = dirname(labelsPath) + "/tools/out/pages.json"): SamplePage[] {
  const all = readSample(research);
  const seen = new Set(all.map((s) => `${s.set}:${s.page}`));
  if (existsSync(pageList)) {
    for (const p of JSON.parse(readFileSync(pageList, "utf8")) as Array<{ pid: string; set: number; page: number }>) {
      if (!seen.has(`${p.set}:${p.page}`)) { seen.add(`${p.set}:${p.page}`); all.push({ pid: p.pid, set: p.set, page: p.page, run: "" }); }
    }
  }
  return all;
}

/** Labels keyed "set:page". */
export function labelsByPage(items: readonly KindLabel[]): Map<string, KindLabel[]> {
  const out = new Map<string, KindLabel[]>();
  for (const l of items) { const k = `${l.set}:${l.page}`; (out.get(k) ?? out.set(k, []).get(k)!).push(l); }
  return out;
}

/** The proposal a label names: same regionId, else bbox IoU ≥ .5. */
export function matchLabel<P extends { regionId?: string; bbox: BboxMinMax }>(proposals: readonly P[], l: KindLabel): P | undefined {
  return proposals.find((x) => (l.regionId && x.regionId === l.regionId) || (l.bbox && iou(x.bbox, l.bbox) >= 0.5));
}
