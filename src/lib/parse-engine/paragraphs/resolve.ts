/**
 * Reference resolution (PLAN §1.7; C2-M3, C3-M4; pure, deterministic).
 *
 * A reference `R` on page `P` with key `k`, an optional explicit sheet `S`, a kind hint `K` and an
 * optional spec section `Σ` resolves against slices of `PJ.structureIndex` plus the sheet → page map
 * the service builds at read time (`ResolverIndex`). This module never reads a database and never runs
 * the segmenter: the service (WP-4.F) feeds it the slices and runs the read-time fallback on the pages
 * an `unresolved` outcome names.
 *
 * Order (§1.7): explicit sheet → spec section → bare: same region (a schedule's footnotes) → same sheet
 * (plus `(CONT.)` chains, rule 5) → general notes (same discipline first, then the project's general
 * sheets). Exactly one candidate → `resolved`; several → `ambiguous`, ordered by same discipline, then
 * nearest sheet number (rule 6); none → `unresolved` with the pages the fallback should read.
 *
 * Keyed-item kinds: a `note` hint matches `notes` paragraphs and the footnote paragraphs of a schedule /
 * keynote / legend region (a `p…` target inside a table-kind region); `keynote` matches `keynote` rows and
 * `notes` blocks headed KEYNOTES; `general-note` matches `notes` blocks whose header contains GENERAL;
 * `spec` matches `spec` paragraphs. Capability `refs` (ledger `eval/parse-engine/capabilities/refs.json`).
 */

import { centreIn } from "../geometry";
import type { StructureIndexKeyEntry, StructureIndexRegion, StructureKind, StructureParagraphDoc } from "../types";
import type { RefKindHint, ReferenceQuery, ResolveLevel, ResolveOutcome, ResolvedCandidate, ResolverBlock, ResolverIndex, ResolverSheet } from "../types-paragraphs";
import { sheetDistance, sheetKey, sheetOrdinal, sheetPrefix } from "./address";
import { isGeneralNotesHeader, normaliseKey, sectionNorm } from "./keys";

const TABLE_KINDS: ReadonlySet<StructureKind> = new Set<StructureKind>(["schedule", "keynote", "legend"]);

/** §1.7 rule 1: the kind hint a reference phrase carries ("SEE KEYNOTE 12" → keynote; "SECTION 08 71 00 PARA 2.3" → spec). */
export function kindHintFromPhrase(phrase: string): RefKindHint {
  const p = phrase.toUpperCase();
  if (/\bKEY\s?NOTES?\b/.test(p)) return "keynote";
  if (/\b(?:SPEC(?:IFICATION)?S?|SECTION\s+\d{2}\s?\d{2}\s?\d{2})\b/.test(p)) return "spec";
  if (/\bGEN(?:ERAL|\.)?\s+NOTES?\b/.test(p)) return "general-note";
  return "note";
}

/** The resolver's block slice for one committed paragraph document (for the index builder, WP-3.H). */
export function blocksSliceOf(regionId: string, doc: Pick<StructureParagraphDoc, "blocks">): ResolverBlock[] {
  return doc.blocks.map((b) => {
    const out: ResolverBlock = { regionId, blockId: b.id, headerNorm: b.headerNorm };
    if (b.continued) out.continued = true;
    return out;
  });
}

/** A printed reference key as a path: "2.3.A" → ["2.3", "A"]; "1.01 › A › 1" → ["1.01", "A", "1"]; "K-01" → ["K-01"]. */
export function splitKeyPath(key: string): string[] {
  const out: string[] = [];
  for (const tok of key.trim().split(/\s*[›>/]\s*/).filter((t) => t !== "")) {
    let rest = tok;
    const art = /^(\d{1,2}\.\d{1,2})(?:\.(.*))?$/.exec(rest);
    if (art) {
      out.push(art[1]);
      rest = art[2] ?? "";
    }
    if (rest !== "") out.push(...rest.split(".").filter((t) => t !== ""));
  }
  return out;
}

/** The keyNorm variants a printed reference key is looked up under: a path as a whole ("2.3.A"), then its leaf ("A"). */
export function keyLookupVariants(key: string): string[] {
  const parts = splitKeyPath(key);
  if (parts.length === 0) return normaliseKey(key) === "" ? [] : [normaliseKey(key)];
  if (parts.length === 1) return [normaliseKey(parts[0])];
  const path = parts.map((p) => normaliseKey(p)).join(".");
  const leaf = normaliseKey(parts[parts.length - 1]);
  return leaf === path ? [path] : [path, leaf];
}

interface Ctx {
  index: ResolverIndex;
  sheetOf: Map<number, ResolverSheet>;
  keyOf: Map<number, string | null>;
  /** page → pages chained to it through `(CONT.)` blocks (rule 5), as "page:regionId" members. */
  chains: Map<number, Set<string>>;
  pageOrder: number[];
}

function pageKey(s: ResolverSheet): string | null {
  return sheetKey(s.raw);
}

/** Sheets in sheet order (discipline, then number), pages without a key last by page number. */
function orderPages(sheets: readonly ResolverSheet[]): number[] {
  return [...sheets]
    .sort((a, b) => {
      const ka = pageKey(a);
      const kb = pageKey(b);
      if (ka === null || kb === null) return ka === kb ? a.page - b.page : ka === null ? 1 : -1;
      const pa = sheetPrefix(ka) ?? "";
      const pb = sheetPrefix(kb) ?? "";
      if (pa !== pb) return pa < pb ? -1 : 1;
      return (sheetOrdinal(ka) ?? 0) - (sheetOrdinal(kb) ?? 0) || a.page - b.page;
    })
    .map((s) => s.page);
}

/** Rule 5: a continued block chains to the same-header block on the previous page in sheet order. */
function buildChains(index: ResolverIndex, pageOrder: readonly number[]): Map<number, Set<string>> {
  const chains = new Map<number, Set<string>>();
  const blocks = index.blocks;
  if (!blocks) return chains;
  const link = (a: number, ra: string, b: number, rb: string) => {
    const ma = `${a}:${ra}`;
    const mb = `${b}:${rb}`;
    const set = new Set<string>([...(chains.get(a) ?? []), ...(chains.get(b) ?? []), ma, mb]);
    for (const m of set) chains.set(parseInt(m.split(":")[0], 10), set);
  };
  for (let i = 0; i < pageOrder.length; i++) {
    const page = pageOrder[i];
    for (const b of blocks[String(page)] ?? []) {
      if (!b.continued || b.headerNorm === null) continue;
      for (let j = i - 1; j >= 0; j--) {
        const prev = pageOrder[j];
        const match = (blocks[String(prev)] ?? []).find((pb) => pb.headerNorm === b.headerNorm);
        if (match) {
          link(prev, match.regionId, page, b.regionId);
          break;
        }
      }
    }
  }
  return chains;
}

function regionsOn(index: ResolverIndex, page: number): StructureIndexRegion[] {
  return index.regions[String(page)] ?? [];
}

function originOf(index: ResolverIndex, page: number, regionId: string): "committed" | "classic" {
  const r = regionsOn(index, page).find((x) => x.regionId === regionId);
  return r?.origin === "classic" ? "classic" : "committed";
}

/** Does an index entry match the kind hint? */
function kindMatches(hint: RefKindHint, e: StructureIndexKeyEntry): boolean {
  const [, kind, targetId, header] = e;
  switch (hint) {
    case "note":
      return kind === "notes" || (TABLE_KINDS.has(kind) && targetId.startsWith("p"));
    case "general-note":
      return kind === "notes" && isGeneralNotesHeader(header);
    case "keynote":
      return kind === "keynote" || (kind === "notes" && header !== null && /\bKEY\s?NOTES?\b/.test(header));
    case "spec":
      return kind === "spec";
  }
}

/** Entries on `page` under any of the key variants, filtered by kind and (optionally) by region. */
function entriesOn(ctx: Ctx, page: number, variants: readonly string[], hint: RefKindHint, level: ResolveLevel, regionIds?: ReadonlySet<string>): ResolvedCandidate[] {
  const keys = ctx.index.keys[String(page)];
  if (!keys) return [];
  const out: ResolvedCandidate[] = [];
  const seen = new Set<string>();
  for (const v of variants) {
    for (const e of keys[v] ?? []) {
      const [regionId, kind, targetId, blockHeaderNorm] = e;
      if (regionIds && !regionIds.has(regionId)) continue;
      if (!kindMatches(hint, e)) continue;
      const id = `${regionId}/${targetId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ page, sheet: ctx.keyOf.get(page) ?? null, regionId, kind, targetId, blockHeaderNorm, origin: originOf(ctx.index, page, regionId), level });
    }
    if (out.length > 0) break; // the whole-path form wins over its leaf
  }
  return out;
}

/** Same-sheet candidates on `page` plus the regions chained to its blocks on other pages (rule 5). */
function sameSheetEntries(ctx: Ctx, page: number, variants: readonly string[], hint: RefKindHint, level: ResolveLevel): ResolvedCandidate[] {
  const out = entriesOn(ctx, page, variants, hint, level);
  const chain = ctx.chains.get(page);
  if (chain) {
    const byPage = new Map<number, Set<string>>();
    for (const m of chain) {
      const [p, r] = m.split(":");
      const pn = parseInt(p, 10);
      if (pn === page) continue;
      if (!byPage.has(pn)) byPage.set(pn, new Set());
      byPage.get(pn)!.add(r);
    }
    for (const [pn, regions] of byPage) out.push(...entriesOn(ctx, pn, variants, hint, level, regions));
  }
  return out;
}

/** Rule 6 ordering: same discipline as `fromKey` first, then nearest sheet number, then page, region, target. */
export function orderCandidates(cands: readonly ResolvedCandidate[], fromKey: string | null): ResolvedCandidate[] {
  const fromPrefix = sheetPrefix(fromKey);
  const rank = (c: ResolvedCandidate): [number, number] => {
    const same = fromPrefix !== null && sheetPrefix(c.sheet) === fromPrefix ? 0 : 1;
    const d = sheetDistance(fromKey, c.sheet);
    return [same, d ?? Number.POSITIVE_INFINITY];
  };
  return [...cands].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || a.page - b.page || (a.regionId < b.regionId ? -1 : a.regionId > b.regionId ? 1 : 0) || (a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0);
  });
}

function outcome(cands: ResolvedCandidate[], level: ResolveLevel, fromKey: string | null): ResolveOutcome | null {
  if (cands.length === 0) return null;
  const ordered = orderCandidates(cands, fromKey);
  if (ordered.length === 1) return { status: "resolved", level, hit: ordered[0] };
  return { status: "ambiguous", level, candidates: ordered };
}

/** Pages whose title or blocks say GENERAL NOTES (rule 4c, "the project's general sheets"). */
function generalPages(ctx: Ctx): number[] {
  const out: number[] = [];
  for (const page of ctx.pageOrder) {
    const s = ctx.sheetOf.get(page);
    const titleHit = typeof s?.title === "string" && isGeneralNotesHeader(s.title.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim());
    const blockHit = (ctx.index.blocks?.[String(page)] ?? []).some((b) => isGeneralNotesHeader(b.headerNorm));
    const keyHit = Object.values(ctx.index.keys[String(page)] ?? {}).some((entries) => entries.some((e) => e[1] === "notes" && isGeneralNotesHeader(e[3])));
    if (titleHit || blockHit || keyHit) out.push(page);
  }
  return out;
}

/** Resolve one reference against the index slices (§1.7). */
export function resolveReference(q: ReferenceQuery, index: ResolverIndex): ResolveOutcome {
  const pageOrder = orderPages(index.sheets);
  const sheetOf = new Map<number, ResolverSheet>(index.sheets.map((s) => [s.page, s]));
  const keyOf = new Map<number, string | null>(index.sheets.map((s) => [s.page, pageKey(s)]));
  const ctx: Ctx = { index, sheetOf, keyOf, chains: buildChains(index, pageOrder), pageOrder };
  const fromKey = keyOf.get(q.page) ?? null;
  const variants = keyLookupVariants(q.key);

  // 2. explicit sheet
  if (q.sheet && q.sheet.trim() !== "") {
    const sk = sheetKey(q.sheet);
    const pages = sk === null ? [] : pageOrder.filter((p) => keyOf.get(p) === sk);
    if (pages.length === 0) return { status: "unresolved", reason: "no-sheet", fallbackPages: [] };
    const cands: ResolvedCandidate[] = [];
    for (const p of pages) cands.push(...sameSheetEntries(ctx, p, variants, q.kind, "explicit-sheet"));
    return outcome(dedupe(cands), "explicit-sheet", fromKey) ?? { status: "unresolved", reason: "no-candidates", fallbackPages: pages };
  }

  // 3. spec section
  if (q.section && sectionNorm(q.section) !== "") {
    const list = index.specSections[sectionNorm(q.section)] ?? [];
    if (list.length === 0) return { status: "unresolved", reason: "no-section", fallbackPages: [] };
    const cands: ResolvedCandidate[] = [];
    for (const [page, regionId] of list) {
      if (variants.length === 0) {
        cands.push({ page, sheet: keyOf.get(page) ?? null, regionId, kind: "spec", targetId: regionId, blockHeaderNorm: null, origin: originOf(index, page, regionId), level: "spec-section" });
        continue;
      }
      cands.push(...entriesOn(ctx, page, variants, "spec", "spec-section", new Set([regionId])));
    }
    return outcome(dedupe(cands), "spec-section", fromKey) ?? { status: "unresolved", reason: "no-candidates", fallbackPages: [...new Set(list.map(([p]) => p))] };
  }

  // 4. bare reference
  if (q.kind === "note" || q.kind === "general-note") {
    // a. same region: the mention lies inside a table-kind region with footnotes
    const hosts = new Set(
      regionsOn(index, q.page)
        .filter((r) => TABLE_KINDS.has(r.kind) && ((q.regionId && r.regionId === q.regionId) || (q.b && centreIn(q.b, r.bbox))))
        .map((r) => r.regionId),
    );
    if (hosts.size > 0) {
      const o = outcome(entriesOn(ctx, q.page, variants, "note", "same-region", hosts), "same-region", fromKey);
      if (o) return o;
    }
  }
  // b. same sheet (+ chains)
  {
    const o = outcome(dedupe(sameSheetEntries(ctx, q.page, variants, q.kind, "same-sheet")), "same-sheet", fromKey);
    if (o) return o;
  }
  // c. general notes: same discipline, then the project's general sheets
  if (q.kind === "note" || q.kind === "general-note") {
    const prefix = sheetPrefix(fromKey);
    const sameDiscipline = prefix === null ? [] : pageOrder.filter((p) => p !== q.page && sheetPrefix(keyOf.get(p)) === prefix);
    const cands: ResolvedCandidate[] = [];
    for (const p of sameDiscipline) cands.push(...entriesOn(ctx, p, variants, "general-note", "general-notes"));
    let o = outcome(dedupe(cands), "general-notes", fromKey);
    if (o) return o;
    const general = generalPages(ctx).filter((p) => p !== q.page);
    const gc: ResolvedCandidate[] = [];
    for (const p of general) gc.push(...entriesOn(ctx, p, variants, "general-note", "general-notes"));
    o = outcome(dedupe(gc), "general-notes", fromKey);
    if (o) return o;
    return { status: "unresolved", reason: "no-candidates", fallbackPages: [q.page, ...general] };
  }
  return { status: "unresolved", reason: "no-candidates", fallbackPages: [q.page] };
}

function dedupe(cands: readonly ResolvedCandidate[]): ResolvedCandidate[] {
  const seen = new Set<string>();
  const out: ResolvedCandidate[] = [];
  for (const c of cands) {
    const id = `${c.page}/${c.regionId}/${c.targetId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(c);
  }
  return out;
}

