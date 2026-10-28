/**
 * One page's inbox slice, derived (table pipeline TP-3 WP-3.F; PLAN §2.1 `StructureIndexV1.inbox`, §2.2
 * "project index", §2.3 "Text regions"; C1-B2, C2-M12, K30, K58).
 *
 * `deriveInboxForPage` is the ONE pure function that turns a page's stored intelligence into its
 * `PJ.structureIndex.inbox[page]` entries. Two callers, one rule set:
 *   - the verdict routes refresh one page's slice after a verdict (`server/services/parse-engine/inbox-slice.ts`);
 *   - the summaries pass derives every visible page's slice with `deriveInboxIndex` (WP-3.H `index-derive.ts`
 *     delegates to it at integration and passes the stored `PJ.structureIndex.inbox` as `prevInbox`, so the
 *     legacy-reject bindings survive a recompute; WP-3.F fix round, verify HIGH-1).
 *
 * Visible set: `deriveInboxIndex` writes a key for EVERY page it is given, an empty array included. The
 * summaries pass gives it the visible pages only, so the inbox's page keys ARE the visible set, which the
 * scope=all items read relies on (it reads no page row; a hidden duplicate page has no key).
 *
 * Entries:
 *   - **proposals** (`classifierProposals`) whose target is a table or a notes block; state from the user's
 *     verdict (`reject` → rejected) and from the saved region the verdict names (`proposalVerdicts[pid].regionId`,
 *     WP-2.F, K58), else a same-family saved region at IoU ≥ .5 (the fallback the plan names);
 *   - **text regions** of an inbox kind (`textRegionInboxKind`), keyed by content (`tr:…`). State from the
 *     content-keyed `textRegionVerdicts` first (a reject reads rejected; an accept reads parsed only while a
 *     saved region carries it, else todo: verify LOW-1), then the classic `rejectedTextRegionIds`, then a saved
 *     region promoted from it (`sourceTextRegionId`) or overlapping it.
 *
 * A legacy (positional) reject is honoured only while the IoU check holds (C2-M12): the classic Reject records
 * an id and no box, so the slice binds the reject to a box (`legacyRejectB`): the box an earlier slice saw that
 * id at, else, on first sight, the region's current box. If the region now carrying that id has IoU < .7 with
 * the bound box, a reprocess renumbered the regions and the reject belongs to another region: it is NOT
 * honoured. The binding is carried forward, so the check keeps failing on later derives. Limit: a classic
 * reject made AFTER a renumbering, of an id the slice had already bound, stays bound to the old box.
 *
 * Pure and deterministic: the same input gives the same entries in the same order. Saved parsed regions are
 * NOT inbox entries (they live in `structureIndex.regions`); they only decide states here.
 */

import {
  findTextRegionVerdict,
  iouMinMax,
  kindFamily,
  storedTextRegionVerdicts,
  TEXT_REGION_VERDICT_IOU,
  textRegionInboxKind,
  textRegionKey,
  textRegionMinMax,
  type TextRegionLike,
} from "./text-region-verdicts";
import { parsedRegionMinMax } from "@/lib/parsed-region-bbox";
import type { BboxMinMax, InboxSlim, StructureKind } from "./types";

/** A saved region overlapping an item at IoU ≥ this (same kind family) parses it (fallback join). */
export const REGION_JOIN_IOU = 0.5;

/**
 * The page keys `deriveInboxForPage` reads. A caller that projects page intelligence before deriving (the
 * summaries pass's in-lock re-read) must project at least these; widen it whenever the derive reads a new key.
 */
export const INBOX_DERIVE_PI_KEYS = [
  "textRegions", "rejectedTextRegionIds", "textRegionVerdicts", "parsedRegions", "classifierProposals", "proposalVerdicts",
] as const;

/** An inbox entry: `InboxSlim` plus the fields the items service and the legacy check need (sibling type). */
export interface InboxEntry extends InboxSlim {
  /** Proposals: the class (null when it fell back). */
  classId?: string | null;
  /** Proposals: the table-ness head. */
  tableP?: number;
  /** Proposals: the user's verdict kind. */
  verdict?: "accept" | "reject" | "rename";
  /** Text regions: the stored (positional) id, recorded with `b` for the legacy-reject IoU check. */
  legacyId?: string;
  /** Text regions: the stored `TextRegion.type`. */
  regionType?: string;
  /** Text regions whose `legacyId` is in `rejectedTextRegionIds`: the box that classic reject is bound to. */
  legacyRejectB?: BboxMinMax;
}

type Rec = Record<string, unknown>;
const records = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter((x): x is Rec => !!x && typeof x === "object" && !Array.isArray(x)) : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const KINDS: readonly StructureKind[] = ["schedule", "keynote", "legend", "notes", "spec"];

/** A saved region's stored MinMax box (K04: stored MinMax, never re-interpreted), or null. */
function savedBox(b: unknown): BboxMinMax | null {
  if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => num(v) !== null)) return null;
  return [b[0], b[1], b[2], b[3]];
}

/**
 * True for a whole-page box: a page-unit recipe's proposal (`[0,0,1,1]`) names a sheet, not a block, so it is
 * never an inbox item (verify LOW-6).
 */
export function isPageUnitBox(b: readonly number[]): boolean {
  return b[0] <= 0.001 && b[1] <= 0.001 && b[2] >= 0.999 && b[3] >= 0.999;
}

/**
 * The best same-family item of `pool` overlapping `b` at IoU ≥ .5 (ties by id), or null. One rule for the
 * region join here, and for the dedupe and the text-region fold of the items service and the verdict route.
 */
export function bestOverlap<T extends { b: BboxMinMax; kind: StructureKind }>(
  pool: readonly T[],
  kind: StructureKind,
  b: BboxMinMax,
  idOf: (t: T) => string,
): T | null {
  let best: { t: T; iou: number } | null = null;
  for (const t of pool) {
    if (kindFamily(t.kind) !== kindFamily(kind)) continue;
    const iou = iouMinMax(t.b, b);
    if (iou >= REGION_JOIN_IOU && (!best || iou > best.iou || (iou === best.iou && idOf(t) < idOf(best.t)))) best = { t, iou };
  }
  return best?.t ?? null;
}

/** Inbox kind of a classifier proposal, or null when its target is not a structure (page units, plans, cuts). */
export function proposalInboxKind(target: unknown, classId: unknown): StructureKind | null {
  const cls = typeof classId === "string" ? classId : "";
  switch (target) {
    case "schedule": return "schedule";
    case "keynote-table": return "keynote";
    case "symbol-legend": return "legend";
    case "general-notes": return "notes";
    case "text-region":
      if (cls === "keynotes") return "keynote";
      if (cls === "symbol-legend" || cls === "abbreviations") return "legend";
      return "notes";
    default: return null;
  }
}

interface SavedRegion { id: string; kind: StructureKind; b: BboxMinMax; sourceTextRegionId: string | null }

function savedRegions(pi: Rec): SavedRegion[] {
  const out: SavedRegion[] = [];
  for (const r of records(pi.parsedRegions)) {
    const id = str(r.id);
    const b = parsedRegionMinMax(r as { bbox?: readonly number[] }); // the one ParsedRegion bbox reader (K04; WP-3.H LOW-6, integrate g2b)
    if (!id || !b) continue;
    const kind = KINDS.includes(r.type as StructureKind) ? (r.type as StructureKind) : "schedule";
    out.push({ id, kind, b, sourceTextRegionId: str(r.sourceTextRegionId) });
  }
  return out;
}

/** The best same-family saved region overlapping `b` at IoU ≥ .5 (ties by id), or null. */
function overlappingRegion(regions: readonly SavedRegion[], kind: StructureKind, b: BboxMinMax): SavedRegion | null {
  return bestOverlap(regions, kind, b, (r) => r.id);
}

/**
 * The legacy reject check (C2-M12). `recorded` is the box this id's reject is bound to: the box an earlier
 * slice bound it to (`legacyRejectB`), else the box an earlier slice saw that id at, else (first sight) the
 * region's current box. The reject holds while the region now carrying the id has IoU ≥ .7 with it. The
 * binding is carried forward on every derive, so a renumbering keeps failing the check instead of re-binding
 * the reject to whichever region took the id.
 */
export function legacyReject(
  legacyId: string,
  b: BboxMinMax,
  prev: readonly InboxSlim[] | null | undefined,
): { holds: boolean; recorded: BboxMinMax } {
  const mine = (prev ?? []).filter((e) => (e as InboxEntry).legacyId === legacyId) as InboxEntry[];
  const bound = mine.find((e) => Array.isArray(e.legacyRejectB))?.legacyRejectB;
  const seen = mine.find((e) => Array.isArray(e.b))?.b;
  const recorded = bound ?? seen ?? b;
  return { holds: iouMinMax(recorded, b) >= TEXT_REGION_VERDICT_IOU, recorded };
}

/** True when the legacy reject of `legacyId` still applies to a region at `b` (see `legacyReject`). */
export function legacyRejectHolds(legacyId: string, b: BboxMinMax, prev: readonly InboxSlim[] | null | undefined): boolean {
  return legacyReject(legacyId, b, prev).holds;
}

function proposalEntries(pi: Rec, regions: readonly SavedRegion[]): InboxEntry[] {
  const block = pi.classifierProposals as { proposals?: unknown } | undefined;
  const verdicts = (pi.proposalVerdicts && typeof pi.proposalVerdicts === "object" ? pi.proposalVerdicts : {}) as Record<string, Rec | undefined>;
  const out: InboxEntry[] = [];
  for (const p of records(block?.proposals)) {
    const id = str(p.id);
    const kind = proposalInboxKind(p.target, p.classId);
    const b = savedBox(p.bbox);
    if (!id || !kind || !b || isPageUnitBox(b)) continue;
    const v = verdicts[id];
    const verdict = v && (v.verdict === "accept" || v.verdict === "reject" || v.verdict === "rename") ? v.verdict : undefined;
    // K58 join: the region the save-time accept named, when it still exists; else the IoU fallback.
    const named = str(v?.regionId);
    const region = (named ? regions.find((r) => r.id === named) : undefined) ?? overlappingRegion(regions, kind, b);
    const state: InboxSlim["state"] = verdict === "reject" ? "rejected" : region ? "parsed" : "todo";
    const tableP = num(p.tableP);
    out.push({
      id, origin: "proposal", kind, b, title: str(p.displayName) ?? str(p.className), p: num(p.p) ?? 0, state,
      proposalId: id,
      ...(region && state === "parsed" ? { regionId: region.id } : {}),
      classId: str(p.classId),
      ...(tableP !== null ? { tableP } : {}),
      ...(verdict ? { verdict } : {}),
    });
  }
  return out;
}

function textRegionEntries(pi: Rec, regions: readonly SavedRegion[], prev: readonly InboxSlim[] | null | undefined): InboxEntry[] {
  const verdicts = storedTextRegionVerdicts(pi);
  const legacy = new Set(Array.isArray(pi.rejectedTextRegionIds) ? pi.rejectedTextRegionIds.filter((x): x is string => typeof x === "string") : []);
  const out: InboxEntry[] = [];
  const seen = new Set<string>();
  for (const tr of records(pi.textRegions) as TextRegionLike[]) {
    const type = str(tr.type);
    const kind = textRegionInboxKind(tr);
    const b = textRegionMinMax(tr);
    if (!type || !kind || !b) continue;
    const key = textRegionKey(type, b);
    if (seen.has(key)) continue; // two stored regions with one content key are one item
    seen.add(key);
    const legacyId = str(tr.id);
    const verdict = findTextRegionVerdict(verdicts, type, b);
    const promoted = (legacyId ? regions.find((r) => r.sourceTextRegionId === legacyId && iouMinMax(r.b, b) >= REGION_JOIN_IOU) : undefined)
      ?? overlappingRegion(regions, kind, b);
    const legacyCheck = legacyId && legacy.has(legacyId) ? legacyReject(legacyId, b, prev) : null;
    let state: InboxSlim["state"];
    if (verdict) state = verdict.verdict === "reject" ? "rejected" : promoted ? "parsed" : "todo";
    else if (legacyCheck?.holds) state = "rejected";
    else state = promoted ? "parsed" : "todo";
    out.push({
      id: key, origin: "text-region", kind, b, title: str(tr.headerText), p: num(tr.confidence) ?? 0, state,
      ...(promoted && state === "parsed" ? { regionId: promoted.id } : {}),
      ...(legacyId ? { legacyId } : {}),
      regionType: type,
      ...(legacyCheck ? { legacyRejectB: legacyCheck.recorded } : {}),
    });
  }
  return out;
}

/**
 * The inbox entries of one page (see the header). `prev` is the page's current slice, when there is one;
 * it supplies the boxes recorded for legacy reject ids. `page` is the page number (for the caller's key).
 */
export function deriveInboxForPage(input: { page: number; pageIntelligence: unknown; prev?: readonly InboxSlim[] | null }): InboxEntry[] {
  const pi = (input.pageIntelligence && typeof input.pageIntelligence === "object" ? input.pageIntelligence : {}) as Rec;
  const regions = savedRegions(pi);
  const entries = [...proposalEntries(pi, regions), ...textRegionEntries(pi, regions, input.prev)];
  // Deterministic order: proposals first (stored order is already stable), then text regions by key.
  return entries.sort((a, b) =>
    a.origin === b.origin ? (a.origin === "proposal" ? 0 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.origin === "proposal" ? -1 : 1);
}

/**
 * The text-region entries that fold into the proposal `proposalId` (items service rule 3): a text region whose
 * best same-family proposal at IoU ≥ .5 is that proposal is shown as that proposal's item, so a verdict on the
 * item must reach the text region too (C2-M12; verify MED-2).
 */
export function foldedTextRegions(entries: readonly InboxEntry[], proposalId: string): InboxEntry[] {
  const proposals = entries.filter((e) => e.origin === "proposal");
  return entries.filter((e) => e.origin === "text-region" && bestOverlap(proposals, e.kind, e.b, (p) => p.id)?.id === proposalId);
}

/** A page as the summaries pass loads it. */
export interface InboxPageInput {
  pageNumber: number;
  pageIntelligence: unknown;
}

/**
 * The whole `PJ.structureIndex.inbox` from the VISIBLE pages (the caller filters hidden duplicates). Every
 * page gets a key, an empty array included, so the page keys are the visible set (see the header). `prevInbox`
 * is the stored inbox, which carries the legacy-reject bindings forward (`legacyReject`).
 */
export function deriveInboxIndex(
  pages: readonly InboxPageInput[],
  prevInbox?: Readonly<Record<string, readonly InboxSlim[] | undefined>> | null,
): Record<string, InboxEntry[]> {
  const out: Record<string, InboxEntry[]> = {};
  for (const page of [...pages].sort((a, b) => a.pageNumber - b.pageNumber)) {
    const key = String(page.pageNumber);
    const prev = prevInbox && Array.isArray(prevInbox[key]) ? prevInbox[key] : null;
    out[key] = deriveInboxForPage({ page: page.pageNumber, pageIntelligence: page.pageIntelligence, prev });
  }
  return out;
}
