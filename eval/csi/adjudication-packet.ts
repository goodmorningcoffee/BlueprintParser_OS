/**
 * adjudication-packet.ts — turns the two pilot labeling passes into a document a
 * human can actually work through (PLAN §3 P1, LABELING_PROTOCOL §9).
 *
 * The pilot produced two independent opinions per page and measured how far apart
 * they are. Neither is certified. This renders the *disagreements* into a form
 * where a reviewer decides once per dispute rather than re-reading twenty pages
 * of JSON.
 *
 * ── DESIGN DECISION: the old engine's output is DELIBERATELY ABSENT ──
 *
 * The obvious move is to show what the current tagger emitted alongside each
 * page, and the plan for this step originally said to. It is a trap. The old
 * engine emits a mean of 42 codes per page — it over-fires massively — so putting
 * its output in front of a reviewer who is deciding "is this group real?" anchors
 * them toward "the engine found it, so probably yes". That is backwards: the
 * gold set exists to judge the engine, not to be judged by it.
 *
 * Engine output has exactly one legitimate use here — proposing NEGATIVES
 * (`should_not_codes`, protocol §4.3) — and that is a separate pass, done after
 * the positives are settled. Keeping the two apart is what makes the negatives
 * meaningful.
 *
 * Build + run (from blueprintparser_2/):
 *   npx esbuild eval/csi/adjudication-packet.ts --bundle --platform=node \
 *     --target=node20 --outfile=build/csi-packet.js
 *   node build/csi-packet.js eval/csi/gold-pilot.json eval/csi/PILOT_ADJUDICATION_PACKET.md
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

interface Group {
  id: string;
  tier: "primary" | "secondary" | "tertiary";
  division: string;
  codes: string[];
  evidence?: string;
  note?: string;
}
interface Pass {
  groups: Group[];
  confidence: string;
  sheetSubject: string | null;
  note: string | null;
}
interface GroupMatch {
  a: Group | null;
  b: Group | null;
  matched: boolean;
  codesDiffer: boolean;
  tiersDiffer: boolean;
}
interface Page {
  bundle: string;
  page: number;
  drawingNumber: string | null;
  stratum: string;
  passA: Pass | null;
  passB: Pass | null;
  groupMatches: GroupMatch[] | null;
  agreement: {
    sectionJaccard: number | null;
    sectionContainment: number | null;
    divisionJaccard: number | null;
    sharedSections: string[];
    onlyA: string[];
    onlyB: string[];
  };
  reviewed_by: string | null;
}
interface Pilot {
  summary: { meanSectionJaccard: number };
  pages: Page[];
}

const sectionOf = (code: string) => code.replace(/[\s.\-]/g, "").slice(0, 4);
/** Groups whose codes touch a given section — how a section maps back to a name. */
const groupsForSection = (groups: Group[], sec: string) => groups.filter(g => g.codes.some(c => sectionOf(c) === sec));

function renderGroup(g: Group): string {
  const ev = g.evidence ? ` — _"${g.evidence.replace(/\s+/g, " ").slice(0, 110)}"_` : "";
  return `\`${g.codes.join(" / ")}\` **${g.id}** (${g.tier})${ev}`;
}

function main(): void {
  const [inPath, outPath, corpusPath] = process.argv.slice(2);
  if (!inPath || !outPath) {
    console.error("usage: node csi-packet.js <gold-pilot.json> <out.md> [corpus.ndjson]");
    process.exit(1);
  }
  const pilot = JSON.parse(readFileSync(inPath, "utf-8")) as Pilot;

  // Page text, if the corpus is available. Without it the reviewer is asked
  // "is this group real?" while holding only a truncated evidence quote — which
  // is not enough to catch a labeler that invented something. The appendix is
  // what makes the packet answerable rather than merely readable.
  const textByPage = new Map<string, string>();
  if (corpusPath && existsSync(corpusPath)) {
    for (const line of readFileSync(corpusPath, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      const p = JSON.parse(line) as { bundle: string; pageNumber: number; rawText: string | null };
      textByPage.set(`${p.bundle}:${p.pageNumber}`, p.rawText ?? "");
    }
  }
  const anchorOf = (p: Page) => `page-${p.bundle.slice(0, 8)}-${p.page}`;

  const scored = pilot.pages.filter(p => p.agreement.sectionJaccard !== null);
  // Order by what actually costs the reviewer: groups one labeler MISSED, then
  // total open questions. Sorting by section-Jaccard put S-200.00 first as the
  // "worst" page when both labelers had in fact found all five of its systems and
  // merely named them differently — the metric was ranking vocabulary disputes
  // above missed work.
  const missedOf = (p: Page) => (p.groupMatches ?? []).filter(m => !m.matched).length;
  const ordered = [...scored].sort(
    (a, b) =>
      missedOf(b) - missedOf(a) ||
      (b.groupMatches ?? []).length - (a.groupMatches ?? []).length ||
      a.agreement.sectionJaccard! - b.agreement.sectionJaccard!,
  );
  // A page needs the owner only if a group was MISSED by one pass, or a matched
  // pair disagrees on codes or tier. Sections are not the unit — that was the
  // defect a usability review found: it counted one shared system named by two
  // different codes as several disagreements.
  const openCount = (p: Page) =>
    (p.groupMatches ?? []).filter(m => !m.matched || m.codesDiffer || m.tiersDiffer).length;
  const disputed = ordered.filter(p => openCount(p) > 0);
  const clean = ordered.filter(p => openCount(p) === 0);
  const totalDisputes = disputed.reduce((n, p) => n + openCount(p), 0);
  const missedTotal = disputed.reduce((n, p) => n + (p.groupMatches ?? []).filter(m => !m.matched).length, 0);

  const L: string[] = [];
  const w = (s = "") => L.push(s);

  w("# Pilot adjudication packet");
  w();
  w("**What this is.** Twenty pages were labeled twice, independently and blind, by");
  w("two LLM labelers. Neither opinion is certified. Below are the places they");
  w("**disagreed** — decide each one and the pilot becomes a certified gold set.");
  w();
  w("**What it is not.** This is not a request to re-label from scratch. The passes");
  w(`agreed on most of the work (mean section agreement ${pilot.summary.meanSectionJaccard}); only the`);
  w("differences are shown.");
  w();
  w("---");
  w();
  w("## How to work through this");
  w();
  w("For each disputed item, write one of these on the `DECIDE:` line:");
  w();
  w("| write | meaning |");
  w("|---|---|");
  w("| `keep` | the group is real — it belongs in the gold set |");
  w("| `drop` | not real, or not scoped work on this sheet |");
  w("| `tier <primary\\|secondary\\|tertiary>` | real, but retier it |");
  w("| `merge <other-group-id>` | it is the same system as another group, not its own |");
  w("| `?` | you cannot tell from the text — I will mark the page low-confidence and exclude it |");
  w();
  w("`?` is a real answer and a useful one. A page you cannot adjudicate is a page");
  w("the tagger cannot fairly be scored on.");
  w();
  w("---");
  w();
  w("## The rules the labelers were given");
  w();
  w("Printed here because three test reviewers all had to fall back on personal");
  w("judgment without them — which produces decisions that cannot be audited against");
  w("the rules they were meant to apply. Full text: `eval/csi/GRANULARITY_RUBRIC.md`.");
  w();
  w("**What counts as ONE group** — one distinct constructed system that a different");
  w("trade, or a different spec section, would be responsible for.");
  w();
  w("| | |");
  w("|---|---|");
  w("| R1 | **Trade test.** Different subcontractor prices it? Separate group. Same sub? One group. |");
  w("| R2 | **Merge variants.** PT-5 and PT-6 are both painting. Three partition types are one gypsum system. |");
  w("| R3 | **Merge code alternatives.** Several codes naming one thing = one group with several `codes`. |");
  w("| R4 | **Split materials.** Gypsum partitions and CMU partitions are two groups — two trades. |");
  w("| R5 | **Accessories are not groups.** Fasteners, anchors, backing, blocking belong to the system they serve, unless the sheet is *about* them. |");
  w("| R6 | **Title-block content is NEVER a group.** Consultants, addresses, revision history, project name, scale, disclaimers. |");
  w("| R7 | More than ~8 groups usually means grouping per mention. |");
  w("| R8 | A page with construction content has ≥1 group; if none, it is unlabelable. |");
  w();
  w("**Tiers**");
  w();
  w("- `primary` — the sheet is substantially about it; usually named in the drawing title.");
  w("- `secondary` — genuinely present; a competent estimator tags it.");
  w("- `tertiary` — defensible but thin; one generic token, no corroboration.");
  w();
  w("**Two places the rules are known to be thin** — your call here sets the precedent,");
  w("so a one-line reason helps more than usual:");
  w();
  w("1. **Which code goes gold** when both labelers found the same system but filed it");
  w("   differently (e.g. `03 30 00` vs `03 81 00` for a topping trench). R3 says keep");
  w("   both as alternatives; the test reviewers wanted a way to pick one. Say which you prefer.");
  w("2. **The by-others line.** Equipment shown on a sheet but supplied by the owner or");
  w("   another contract, where the GC still scopes rough-in. R5 is silent and the");
  w("   labelers split on it repeatedly (HVAC units, foodservice equipment, AV racks).");
  w();
  w("**Please record how long this takes you.** Three test reviewers worked this");
  w("packet and averaged ~10.6 minutes per page — and notably their time barely");
  w("varied with the number of decisions. The cost driver was hunting evidence in the");
  w("OCR text, not deciding. Your real rate replaces that estimate, and it is what");
  w("decides whether a 240-page gold set is affordable.");
  w();
  w("> **The current tagger's output is deliberately not shown here.** It emits ~42");
  w("> codes per page — it over-fires badly — and seeing it while deciding *\"is this");
  w("> group real?\"* would anchor you toward whatever it happened to find. The gold");
  w("> set exists to judge the tagger, not the reverse. Its output is used later, and");
  w("> only to propose things the tagger got *wrong*.");
  w();
  w("---");
  w();
  w("## Scope");
  w();
  w(`| | |`);
  w(`|---|---|`);
  w(`| pages needing decisions | **${disputed.length}** of ${scored.length} |`);
  w(`| **groups one labeler missed entirely** (the decisions that matter) | **${missedTotal}** |`);
  w(`| open questions in total, incl. code and tier | ${totalDisputes} |`);
  w(`| pages fully agreed | ${clean.length} — listed at the end, nothing to decide |`);
  w();
  w("Ordered by how many groups one labeler **missed entirely** — the decisions that");
  w("change the gold set most. Pages further down mostly ask which code or which tier,");
  w("which matter less. If you stop early, you have spent your time well.");
  w();
  w("---");
  w();

  for (const [i, p] of disputed.entries()) {
    const a = p.passA!;
    const b = p.passB!;
    const ag = p.agreement;
    const ms = p.groupMatches ?? [];

    const missed = ms.filter(m => !m.matched);
    const codeQs = ms.filter(m => m.matched && m.codesDiffer);
    const tierQs = ms.filter(m => m.matched && m.tiersDiffer && !m.codesDiffer);
    const settled = ms.filter(m => m.matched && !m.codesDiffer && !m.tiersDiffer);

    let gid = 0;
    const nextId = () => `${i + 1}.${++gid}`;

    w(`## ${i + 1}. ${p.drawingNumber ?? "(no sheet no.)"} — page ${p.page} *(${p.bundle.slice(0, 8)})*`);
    w();
    w(`*stratum ${p.stratum} · group agreement ${settled.length + codeQs.length + tierQs.length}/${ms.length}*`);
    w();
    if (textByPage.size) w(`**[↓ full sheet text](#${anchorOf(p)})**`);
    w();
    w(`- A calls this sheet: ${a.sheetSubject ?? "—"} *(confidence ${a.confidence})*`);
    w(`- B calls this sheet: ${b.sheetSubject ?? "—"} *(confidence ${b.confidence})*`);
    w();

    if (missed.length) {
      w(`### Only one labeler saw these — is it real? *(${missed.length})*`);
      w();
      w(`These are the decisions that matter most: one labeler found a system the other`);
      w(`missed entirely.`);
      w();
      for (const m of missed) {
        const g = (m.a ?? m.b)!;
        const who = m.a ? "A only" : "B only";
        w(`- **[${nextId()}]** \`${g.codes.join(" / ")}\` **${g.id}** (${g.tier}) — *${who}*`);
        if (g.evidence) w(`  - evidence: _"${g.evidence.replace(/\s+/g, " ")}"_`);
        w(`  - DECIDE: `);
      }
      w();
    }

    if (codeQs.length) {
      w(`### Both saw it — which code names it? *(${codeQs.length})*`);
      w();
      w(`Both labelers found the same system and differ only on which MasterFormat`);
      w(`entry to file it under. Answer with \`A\`, \`B\`, \`both\` (keep as alternatives),`);
      w(`or a code of your own.`);
      w();
      for (const m of codeQs) {
        w(`- **[${nextId()}]** **${m.a!.id}** / **${m.b!.id}**${m.tiersDiffer ? " *(tiers also differ)*" : ""}`);
        w(`  - A: \`${m.a!.codes.join(" / ")}\` (${m.a!.tier})`);
        w(`  - B: \`${m.b!.codes.join(" / ")}\` (${m.b!.tier})`);
        if (m.a!.evidence) w(`  - evidence: _"${m.a!.evidence.replace(/\s+/g, " ")}"_`);
        w(`  - DECIDE: `);
      }
      w();
    }

    if (tierQs.length) {
      w(`### Both saw it, same codes — how important is it? *(${tierQs.length})*`);
      w();
      w(`Answer \`primary\`, \`secondary\` or \`tertiary\`. Definitions are in the header.`);
      w();
      for (const m of tierQs) {
        w(`- **[${nextId()}]** \`${m.a!.codes.join(" / ")}\` **${m.a!.id}** — A says **${m.a!.tier}**, B says **${m.b!.tier}**`);
        if (m.a!.evidence) w(`  - evidence: _"${m.a!.evidence.replace(/\s+/g, " ")}"_`);
        w(`  - DECIDE: `);
      }
      w();
    }

    if (settled.length) {
      w(`<details><summary>Fully agreed — same system, same codes, same tier (${settled.length}) — nothing to decide</summary>`);
      w();
      for (const m of settled) w(`- \`${m.a!.codes.join(" / ")}\` **${m.a!.id}** (${m.a!.tier})`);
      w();
      w(`</details>`);
      w();
    }

    const notes = [a.note ? `**A:** ${a.note}` : null, b.note ? `**B:** ${b.note}` : null].filter(Boolean);
    if (notes.length) {
      w(`<details><summary>Labeler notes — their own doubts, often the fastest way to see the issue</summary>`);
      w();
      for (const n of notes) w(`> ${n!.replace(/\s+/g, " ")}`);
      w();
      w(`</details>`);
      w();
    }

    w(`MINUTES SPENT: `);
    w();
    w("---");
    w();
  }

  if (clean.length) {
    w("## Pages where both labelers agreed exactly");
    w();
    w("Nothing to decide. Listed so you can see the whole pilot is accounted for, and");
    w("so you can spot-check one or two if you want to sanity-check the labelers.");
    w();
    for (const p of clean) {
      const n = p.passA!.groups.length;
      w(`- **${p.drawingNumber ?? "(no sheet no.)"}** (page ${p.page}) — ${n} groups, ` +
        `both passes identical: ${p.passA!.groups.map(g => g.id).join(", ")}`);
    }
    w();
  }

  if (textByPage.size) {
    w("---");
    w();
    w("# Appendix — full sheet text");
    w();
    w("The OCR text each labeler saw, verbatim. It is messy: real Textract output on");
    w("construction drawings, with garbled words and title-block content interleaved.");
    w("That is exactly what the tagger sees, so it is what the gold set must be judged");
    w("against — **not** the drawing image, which the engine never gets.");
    w();
    for (const p of [...disputed, ...clean]) {
      const t = textByPage.get(`${p.bundle}:${p.page}`) ?? "";
      w(`<a id="${anchorOf(p)}"></a>`);
      w();
      w(`### ${p.drawingNumber ?? "(no sheet no.)"} — page ${p.page}`);
      w();
      w("```text");
      w(t.replace(/\n/g, " | ").replace(/`/g, "'"));
      w("```");
      w();
    }
  }

  w("---");
  w();
  w("## When you are done");
  w();
  w("Leave the file where it is — I will read your `DECIDE:` and `MINUTES SPENT:`");
  w("lines, fold the decisions into `gold-pilot.json`, set `reviewed_by`, and replace");
  w("the Q5 estimate with your measured rate. Partial answers are fine; I apply what");
  w("is there and leave the rest uncertified.");

  writeFileSync(outPath, L.join("\n") + "\n");
  console.error(
    `[packet] ${disputed.length} pages needing decisions · ${totalDisputes} disputes · ` +
      `${clean.length} clean → ${outPath}`,
  );
}

main();
