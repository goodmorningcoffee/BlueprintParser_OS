/**
 * span-measure.ts — CSI tagger v2, S3 measurement harness for the REAL span matcher
 * (`src/lib/csi-span-match.ts`). Replaces every number the crude S2 comparator produced
 * (`gitignore/projects/csi_tagger_v2/tools/fold_exp_compare.ts.txt`: titles exact 6,791 / present
 * 8,579 / empty 0; corpus 13,182 units with a code / 18,066 assignments).
 *
 * Contains NO drawing text. Every path comes from argv; client text read from a corpus is written
 * ONLY to the `--priv` directory (per-unit records), never to stdout or `--out`.
 *
 *   npx esbuild eval/csi/span-measure.ts --bundle --platform=node --target=node24 \
 *     --alias:@=./src --outfile=build/csi-span-measure.js
 *   node build/csi-span-measure.js src/data/csi-kb.json [--corpus <corpus.ndjson>] \
 *     [--priv <private dir>] [--out <aggregates.txt>] [--ts <timestamp for file names>]
 *
 * Prints: titles ALL + S400 (frontier = post-E13 survivors, and owned), the E13 variants
 * (guard / plain / off, composed from the exported passes — the matcher itself has no knobs),
 * index/alt/see/term self-tests, and, with --corpus: corpus aggregates with and without page
 * discipline as context, by division and by source, per-unit timing, the J21 unowned-tie
 * counter, the E14 counts, and a categorised diff against the crude comparator (counts only).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCsiKbFromFile } from "@/lib/csi-kb";
import { splitTextUnits, tokenize } from "@/lib/csi-tokenize";
import { traceUnit, unitFromText, type MatchTrace, type Span } from "@/lib/csi-span-match";
import {
  EPS, applyDescendantRule, groupRanges, isAncestorIdx, ownRanges, prepareKb,
  type SupportedSpan,
} from "@/lib/csi-span-own";

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const kbPath = argv[0];
const opt = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
if (!kbPath) { console.error("usage: csi-span-measure.js <kb.json> [--corpus f] [--priv dir] [--out f] [--ts stamp]"); process.exit(2); }
const corpusPath = opt("--corpus"), privDir = opt("--priv"), outPath = opt("--out"), ts = opt("--ts") ?? "run";

const kb = loadCsiKbFromFile(kbPath);
const prep = prepareKb(kb);
const P = kb.patterns;
const lines: string[] = [];
const say = (s: string) => { lines.push(s); console.log(s); };
const codesOf = (spans: Span[]) => [...new Set(spans.map((s) => s.code))].sort();
const supCodes = (ss: SupportedSpan[]) => [...new Set(ss.map((s) => prep.codes[s.codeIdx]))].sort();
const isAnc = (a: string, d: string) => {
  const ai = prep.codeIndex.get(a), di = prep.codeIndex.get(d);
  return ai !== undefined && di !== undefined && isAncestorIdx(prep, ai, di);
};
const inc = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
const top = (m: Map<string, number>, n: number) => [...m].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, n).map(([k, v]) => `${k}×${v}`).join(" ");

/** E13 variants composed from the exported passes (the shipped matcher is `guard`). */
type DescVariant = "guard" | "plain" | "off";
function ownedUnder(t: MatchTrace, v: DescVariant): Span[] {
  if (v === "guard") return t.spans;
  const fr = t.frontier;
  const surv = v === "off" ? fr : fr.filter((x) => !fr.some((y) => y !== x && y.codeIdx !== x.codeIdx
    && x.lo <= y.hi && y.lo <= x.hi && isAncestorIdx(prep, x.codeIdx, y.codeIdx)));
  const ranges = ownRanges(prep, groupRanges(surv), undefined, new Set());
  return ranges.flatMap((r) => (r.owner ? [r.owner] : []));
}

// ── M1 titles fed back ──────────────────────────────────────────────────────
const titles = P.filter((p) => p.source === "title" && p.kind === "tokens" && p.tokens.length >= 2);
const step = Math.floor(titles.length / 400);
const s400 = titles.filter((_, i) => i % step === 0).slice(0, 400);
say(`# S3 span-measure — KB ${kb.header.builderVersion}, ${P.length} patterns`);
say(`\n## M1 titles fed back as units (multi-token titles n=${titles.length}; S400 = stride ${step})`);
const titleTraces = new Map<number, MatchTrace>();
for (const t of titles) titleTraces.set(t.id, traceUnit(unitFromText(t.text, kb), kb));
for (const [sn, set] of [["ALL", titles], ["S400", s400]] as const) {
  for (const v of ["guard", "plain", "off"] as const) {
    let exF = 0, prF = 0, exO = 0, prO = 0, fam = 0, emp = 0, multi = 0, rangesT = 0, ownedT = 0, unownedT = 0, viol = 0, parentBeside = 0;
    for (const t of set) {
      const tr = titleTraces.get(t.id);
      if (!tr) continue;
      const surv = v === "guard" ? tr.survivors : v === "off" ? tr.frontier : null;
      const owned = ownedUnder(tr, v);
      if (surv) { const f = supCodes(surv); if (f.length === 1 && f[0] === t.code) exF++; if (f.includes(t.code)) prF++; }
      const oc = codesOf(owned);
      if (oc.length === 1 && oc[0] === t.code) exO++;
      if (oc.includes(t.code)) prO++;
      if (oc.length > 1) multi++;
      if (owned.some((w) => w.familyOf?.includes(t.code))) fam++;
      if (!owned.length) emp++;
      if (v === "guard") {
        rangesT += tr.ranges.length; ownedT += owned.length; unownedT += tr.ranges.filter((r) => !r.owner).length;
        if (owned.length > tr.ranges.length) viol++;
        for (const a of owned) for (const b of owned) if (a !== b && a.tokenStart <= b.tokenEnd && b.tokenStart <= a.tokenEnd && isAnc(a.code, b.code)) parentBeside++;
      }
    }
    const fr = v === "plain" ? "" : `FRONTIER exact ${exF} present ${prF} | `;
    const inv = v === "guard" ? ` | ranges ${rangesT} owned ${ownedT} unowned ${unownedT} viol ${viol} parentBeside ${parentBeside}` : "";
    say(`${sn} E13=${v}${v === "guard" ? " (shipped)" : ""} n=${set.length}: ${fr}OWNED exact ${exO} present ${prO} family ${fam} empty ${emp} multi ${multi}${inv}`);
  }
}

// ── M2 self-tests by source ─────────────────────────────────────────────────
say(`\n## M2 self-tests (multi-token patterns fed back; PASS = own code, an ancestor, or familyOf)`);
for (const src of ["index", "alt", "see", "term"] as const) {
  const pats = P.filter((p) => p.source === src && p.kind === "tokens" && p.tokens.length >= 2);
  let own = 0, anc = 0, fam = 0, other = 0, empty = 0;
  for (const p of pats) {
    const sp = traceUnit(unitFromText(p.text, kb), kb).spans;
    const cs = codesOf(sp);
    if (cs.includes(p.code)) own++;
    else if (cs.some((x) => isAnc(x, p.code))) anc++;
    else if (sp.some((w) => w.familyOf?.includes(p.code))) fam++;
    else if (!cs.length) empty++;
    else other++;
  }
  const pass = own + anc + fam;
  say(`${src} n=${pats.length}: own ${own} · ancestor ${anc} · familyOf ${fam} · PASS ${pass} (${(100 * pass / pats.length).toFixed(2)}%) · other ${other} · empty ${empty}`);
}

// ── crude comparator (port of fold_exp_compare.ts `run`, R2symNum; bag of words) ──
interface Crude { sup: string[]; front: string[]; final: string[]; supPids: number[] }
const crudeVocab = new Set(P.flatMap((p) => p.tokens));
const crudePost = new Map<string, number[]>();
P.forEach((p) => { if (p.kind === "tokens") for (const t of new Set(p.tokens)) { const a = crudePost.get(t); if (a) a.push(p.id); else crudePost.set(t, [p.id]); } });
const upMemo = new Map<number, Set<number>>();
const upStar = (q: number): Set<number> => {
  let s = upMemo.get(q); if (s) return s; s = new Set<number>(); upMemo.set(q, s);
  for (const u of P[q].up) { s.add(u); for (const x of upStar(u)) s.add(x); }
  return s;
};
function crudeBagSupports(p: (typeof P)[number], U: Set<string>): boolean {
  if (p.hintOnly || p.kind !== "tokens") return false;
  if (!p.diff.every((i) => U.has(p.tokens[i]))) return false;
  if (p.anchor === null && !p.tokens.every((t) => U.has(t))) return false;
  const tot = p.mass.reduce((a, b) => a + b, 0), got = p.tokens.reduce((a, t, i) => a + (U.has(t) ? p.mass[i] : 0), 0);
  return got >= 0.8 * tot - 1e-9;
}
function crude(text: string): Crude {
  const U = new Set(tokenize(text, crudeVocab).map((t) => t.t));
  const cand = new Set<number>(); for (const t of U) for (const id of crudePost.get(t) ?? []) cand.add(id);
  const sup = new Map<number, Set<string>>();
  for (const id of cand) if (crudeBagSupports(P[id], U)) sup.set(id, new Set(P[id].tokens.filter((t) => U.has(t))));
  const ids = [...sup.keys()]; const dead = new Set<number>();
  for (const q of ids) for (const p of ids) {
    if (P[p].code === P[q].code || !upStar(q).has(p)) continue;
    const own = new Set(P[p].tokens); const mq = sup.get(q);
    if (mq && [...mq].some((t) => !own.has(t))) dead.add(p); else dead.add(q);
  }
  const front = [...new Set(ids.filter((i) => !dead.has(i)).map((i) => P[i].code))];
  const final = front.filter((a) => !front.some((d) => d !== a && isAnc(a, d))).sort();
  return { sup: [...new Set(ids.map((i) => P[i].code))].sort(), front: front.sort(), final, supPids: ids };
}
{
  let ex = 0, pr = 0, em = 0;
  for (const t of titles) { const g = crude(t.text).final; if (g.length === 1 && g[0] === t.code) ex++; if (g.includes(t.code)) pr++; if (!g.length) em++; }
  say(`\n## M1c crude comparator re-run on the same KB (port check; S2 recorded 6791 / 8579 / 0): titles exact ${ex} · present ${pr} · empty ${em}`);
}

// ── why a code the crude comparator supported is NOT supported by the real matcher ──
function unsupportedReason(text: string, t: MatchTrace, code: string, cr: Crude): string {
  const toks = tokenize(text, prep.vocab, kb.known);
  const crudeToks = tokenize(text, crudeVocab);
  const sameTok = toks.length === crudeToks.length && toks.every((x, i) => x.t === crudeToks[i].t);
  const live = t.negated ? toks.filter((x) => x.start < t.negFrom) : toks;
  const segs: Set<string>[] = [];
  let cur = new Set<string>();
  live.forEach((x, i) => { if (i > 0 && x.boundaryBefore) { segs.push(cur); cur = new Set(); } cur.add(x.t); });
  segs.push(cur);
  const allLive = new Set(live.map((x) => x.t));
  const reasons: string[] = [];
  for (const pid of cr.supPids) {
    const p = P[pid];
    if (p.code !== code) continue;
    if (!crudeBagSupports(p, allLive)) { reasons.push(sameTok ? "negation mask" : "tokenization (known abbrev)"); continue; }
    const present = p.tokens.filter((x) => allLive.has(x)).length;
    if (p.tokens.length >= 2 && present === 1) { reasons.push("one-word hit (J5)"); continue; }
    if (!segs.some((s) => crudeBagSupports(p, s))) { reasons.push("boundary (segment)"); continue; }
    reasons.push("window / placement (E5)");
  }
  const order = ["window / placement (E5)", "boundary (segment)", "one-word hit (J5)", "negation mask", "tokenization (known abbrev)"];
  for (const r of order) if (reasons.includes(r)) return `not supported: ${r}`;
  return "not supported: other";
}
function lostReason(text: string, t: MatchTrace, code: string, cr: Crude): string {
  if (t.spans.some((w) => w.familyOf?.includes(code))) return "ownership: absorbed by family owner";
  if (supCodes(t.survivors).includes(code)) {
    const r = t.ranges.find((x) => x.members.some((m) => prep.codes[m.codeIdx] === code));
    if (!r) return "ownership: other";
    if (!r.owner) return "ownership: unowned cross-division range";
    const mine = r.members.filter((m) => prep.codes[m.codeIdx] === code);
    const ownerSpan = r.top[0];
    if (!r.top.some((m) => prep.codes[m.codeIdx] === code)) {
      return mine.every((m) => !m.contiguous) && ownerSpan && ownerSpan.contiguous ? "contiguity (×0.85 lost at maxS)" : "ownership: lower s lost at maxS";
    }
    return `ownership: ${r.rule}`;
  }
  if (supCodes(t.frontier).includes(code)) return "descendant rule (E13 guard)";
  if (supCodes(t.supported).includes(code)) return "frontier (E4 subset dominance)";
  return unsupportedReason(text, t, code, cr);
}
function gainedReason(t: MatchTrace, code: string, cr: Crude): string {
  const w = t.spans.find((x) => x.code === code);
  if (w?.familyOf) return "family owner (E11)";
  if (w && P[w.patternId].kind === "regex") return "regex term row (E7)";
  if (cr.front.includes(code)) return "descendant rule (crude plain E13 dropped it)";
  if (cr.sup.includes(code)) return "frontier (crude up* dominance dropped it)";
  return "crude unsupported (tokenization / generic / other)";
}

// ── M1d title delta vs crude, by category ───────────────────────────────────
{
  const lost = new Map<string, number>(), gainedExact = new Map<string, number>(), lostExact = new Map<string, number>();
  for (const p of titles) {
    const cr = crude(p.text);
    const t = titleTraces.get(p.id);
    if (!t) continue;
    const real = codesOf(t.spans);
    const crExact = cr.final.length === 1 && cr.final[0] === p.code, reExact = real.length === 1 && real[0] === p.code;
    if (cr.final.includes(p.code) && !real.includes(p.code)) inc(lost, lostReason(p.text, t, p.code, cr));
    if (!crExact && reExact) {
      const r = t.ranges.find((x) => x.owner?.code === p.code);
      const killedBy = cr.final.filter((c) => c !== p.code).map((c) => (supCodes(t.supported).includes(c) ? (supCodes(t.frontier).includes(c) ? (supCodes(t.survivors).includes(c) ? "ownership maxS" : "E13 guard") : "E4 subset") : "not supported")).sort();
      inc(gainedExact, cr.final.includes(p.code) ? `crude had ${cr.final.length} codes; extras removed by: ${[...new Set(killedBy)].join(" + ")}${r ? ` (range rule ${r.rule})` : ""}` : "crude lacked the code (its up* frontier or plain E13 dropped it)");
    }
    if (crExact && !reExact) inc(lostExact, real.length ? "real owns another/extra code" : "real owns nothing");
  }
  say(`\n## M1d titles: real vs crude, by category (crude exact 6791 / present 8579 → real 8446 / 8446)`);
  say(`exact GAINED (crude not exact → real exact) ${[...gainedExact.values()].reduce((a, b) => a + b, 0)}:`);
  for (const [k, v] of [...gainedExact].sort((a, b) => b[1] - a[1])) say(`  ${String(v).padStart(6)}  ${k}`);
  say(`exact LOST (crude exact → real not) ${[...lostExact.values()].reduce((a, b) => a + b, 0)}: ${top(lostExact, 5)}`);
  say(`own code LOST (crude present → real absent) ${[...lost.values()].reduce((a, b) => a + b, 0)}:`);
  for (const [k, v] of [...lost].sort((a, b) => b[1] - a[1])) say(`  ${String(v).padStart(6)}  ${k}`);
}

// ── M3 corpus ───────────────────────────────────────────────────────────────
if (corpusPath) {
  if (!privDir) { console.error("--corpus requires --priv (client text is written only there)"); process.exit(2); }
  mkdirSync(privDir, { recursive: true });
  const recs = readFileSync(corpusPath, "utf-8").split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { rawText?: string; publicId?: string; pageNumber?: number; discipline?: string | null });
  const units: { u: string; d?: string; page: string }[] = [];
  let pages = 0;
  for (const r of recs) {
    if (!r.rawText) continue;
    pages++;
    for (const u of splitTextUnits(r.rawText, kb.known)) if (u.length <= 300) units.push({ u, d: r.discipline ?? undefined, page: `${r.publicId}#${r.pageNumber}` });
  }
  say(`\n## M3 corpus: pages ${pages} · units (≤300 chars) ${units.length}`);
  const perUnit: { codes: string[]; hints: string[]; spans: Span[] }[] = [];
  for (const useCtx of [false, true]) {
    let hit = 0, assign = 0, ranges = 0, unowned = 0, fam = 0, strong = 0, byo = 0, hintT = 0, sup = 0, front = 0, e13 = 0, owns061733 = 0, hvac = 0, hvacNone = 0;
    const byDiv = new Map<string, number>(), bySrc = new Map<string, number>(), byRule = new Map<string, number>(), ties = new Map<string, number>();
    const ms: number[] = [];
    for (const x of units) {
      const unit = unitFromText(x.u, kb);
      const ctx = useCtx && x.d ? { discipline: x.d } : undefined;
      const t0 = performance.now();
      const t = traceUnit(unit, kb, ctx);
      ms.push(performance.now() - t0);
      const cs = codesOf(t.spans);
      if (!useCtx) perUnit.push({ codes: cs, hints: t.divisionHints, spans: t.spans });
      if (cs.length) hit++;
      assign += cs.length;
      ranges += t.ranges.length;
      for (const r of t.ranges) {
        inc(byRule, r.rule);
        if (!r.owner) { unowned++; inc(ties, supCodes(r.top).join(" | ")); }
      }
      for (const w of t.spans) {
        inc(byDiv, w.code.slice(0, 2));
        inc(bySrc, w.familyOf ? `family(${w.source})` : P[w.patternId].kind === "regex" ? "term(regex)" : w.source);
        if (w.familyOf) { fam++; if (w.s >= 0.8 - EPS) strong++; }
        if (w.scope) byo++;
      }
      if (cs.includes("06 17 33")) owns061733++;
      if (/VENTILAT/i.test(x.u) && /AIR\s+CONDITION/i.test(x.u)) { hvac++; if (!cs.length) hvacNone++; }
      hintT += t.divisionHints.length;
      sup += t.supported.length; front += t.frontier.length; e13 += t.frontier.length - t.survivors.length;
    }
    ms.sort((a, b) => a - b);
    const q = (f: number) => ms[Math.min(ms.length - 1, Math.floor(f * ms.length))].toFixed(4);
    say(`ctx=${useCtx ? "page discipline" : "none"}: units≥1code ${hit} · assignments ${assign} · ranges ${ranges} · unownedRanges ${unowned} · familyOwners ${fam} (strong ${strong}) · byOthers ${byo} · hintTotal ${hintT} · supported ${sup} · frontier ${front} · E13drops ${e13} · per-unit ms p50 ${q(0.5)} p90 ${q(0.9)} p99 ${q(0.99)}`);
    say(`  by division (assignments): ${top(byDiv, 60)}`);
    say(`  by source (owned spans): ${top(bySrc, 20)}`);
    say(`  by range rule: ${top(byRule, 10)}`);
    say(`  J21 unowned-tie counter: ${unowned} ranges, ${ties.size} distinct top-code sets; top 15: ${top(ties, 15)}`);
    say(`  E14: units owning 06 17 33 "Wood I-Joists" ${owns061733} · HVAC-phrase units (VENTILAT… + AIR CONDITION…) ${hvac}, of which with NO code ${hvacNone}`);
  }

  // diff vs the crude comparator (no ctx); unit text only to the private file
  let crHit = 0, crAssign = 0, changed = 0, gainedOnly = 0, lostOnly = 0, swapped = 0, hvacOnlyNoCode = 0;
  const lostCat = new Map<string, number>(), gainCat = new Map<string, number>();
  const priv: string[] = [], privAll: string[] = [];
  units.forEach((x, i) => {
    const cr = crude(x.u);
    const real = perUnit[i];
    if (cr.final.length) crHit++;
    crAssign += cr.final.length;
    if (cr.final.length === 1 && cr.final[0] === "23 00 00" && !real.codes.length) hvacOnlyNoCode++;
    if (real.codes.length || real.hints.length || cr.final.length) {
      privAll.push(JSON.stringify({ page: x.page, unit: x.u, codes: real.spans.map((w) => `${w.code}@${w.s.toFixed(3)} ${w.source}${w.familyOf ? " family" : ""}${w.scope ? " by_others" : ""} [${w.tokenStart}-${w.tokenEnd}]`), hints: real.hints, crude: cr.final }));
    }
    if (real.codes.join() === cr.final.join()) return;
    changed++;
    const g = real.codes.filter((c) => !cr.final.includes(c)), l = cr.final.filter((c) => !real.codes.includes(c));
    if (g.length && !l.length) gainedOnly++; else if (l.length && !g.length) lostOnly++; else swapped++;
    const t = traceUnit(unitFromText(x.u, kb), kb);
    const cats: string[] = [];
    for (const c of l) { const r = lostReason(x.u, t, c, cr); inc(lostCat, r); cats.push(`-${c} ${r}`); }
    for (const c of g) { const r = gainedReason(t, c, cr); inc(gainCat, r); cats.push(`+${c} ${r}`); }
    priv.push(JSON.stringify({ page: x.page, unit: x.u, real: real.codes.map((c) => `${c} ${kb.byCode.get(c)?.title}`), crude: cr.final.map((c) => `${c} ${kb.byCode.get(c)?.title}`), why: cats }));
  });
  say(`\n## M4 real matcher vs crude comparator (no ctx; S2 recorded crude 13,182 / 18,066 on this corpus)`);
  say(`crude re-run: units≥1code ${crHit} · assignments ${crAssign}`);
  say(`units whose code set differs: ${changed} (real gained-only ${gainedOnly} · lost-only ${lostOnly} · swapped ${swapped})`);
  const lostN = [...lostCat.values()].reduce((a, b) => a + b, 0), gainN = [...gainCat.values()].reduce((a, b) => a + b, 0);
  say(`codes LOST vs crude (${lostN}) by category:`);
  for (const [k, v] of [...lostCat].sort((a, b) => b[1] - a[1])) say(`  ${String(v).padStart(6)}  ${k}`);
  say(`codes GAINED vs crude (${gainN}) by category:`);
  for (const [k, v] of [...gainCat].sort((a, b) => b[1] - a[1])) say(`  ${String(v).padStart(6)}  ${k}`);
  say(`E14: units where crude gave exactly [23 00 00] and the real matcher gives no code: ${hvacOnlyNoCode}`);
  writeFileSync(join(privDir, `s3-corpus-units-${ts}.ndjson`), privAll.join("\n") + "\n");
  writeFileSync(join(privDir, `s3-crude-diff-units-${ts}.ndjson`), priv.join("\n") + "\n");
  say(`private per-unit records: ${privAll.length} units → s3-corpus-units-${ts}.ndjson; ${priv.length} diff units → s3-crude-diff-units-${ts}.ndjson (in --priv)`);
}

if (outPath) writeFileSync(outPath, lines.join("\n") + "\n");

