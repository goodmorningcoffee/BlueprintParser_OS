/**
 * select-gold-frame.ts — picks WHICH corpus pages get gold labels (PLAN §3 P1).
 *
 * The rules this implements live in LABELING_PROTOCOL.md; read that first. The
 * load-bearing one is §3.1: strata are NOT built from the old engine's emitted
 * divisions. The old engine cannot tag whole code families at all (plan 2 §1
 * BRITTLE-1), so a frame shaped by its output would sample away from exactly the
 * pages where its misses live, and then report excellent recall for never having
 * looked. Discipline and bundle are engine-independent; output VOLUME is used
 * only to floor the two failure-mode extremes (silent pages / 151+ pages), never
 * to decide which divisions appear.
 *
 * DETERMINISM: every ordering is by sha256(bundle + ":" + page) or by a sorted
 * key. No RNG, no clock, no corpus-order dependence. Re-running on the same
 * corpus reproduces the manifest byte-for-byte apart from `generatedAt`.
 *
 * Build + run (from blueprintparser_2/):
 *   npx esbuild eval/csi/select-gold-frame.ts --bundle --platform=node \
 *     --target=node20 --outfile=build/csi-select.js
 *   node build/csi-select.js <corpus.ndjson> eval/csi/baseline-old-engine.json \
 *     eval/csi/gold-frame.json
 */
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";

const TARGET_PAGES = 240; // PLAN §3 P1 asks 150–300; middle, with room to drop
const FLOOR_PER_STRATUM = 3;
const PILOT_SIZE = 20;

type DisciplineGroup = "A" | "MEP" | "S" | "OTHER";

// LABELING_PROTOCOL.md §3.2. Anything unlisted falls to OTHER.
const DISCIPLINE_GROUPS: Record<string, DisciplineGroup> = {
  A: "A", ID: "A",
  M: "MEP", E: "MEP", P: "MEP", FP: "MEP", FA: "MEP", H: "MEP", HG: "MEP", K: "MEP", T: "MEP",
  S: "S", SP: "S", C: "S", B: "S", BR: "S", Q: "S", R: "S",
};

const VOLUME_BUCKETS = ["0", "1-10", "11-50", "51-150", "151+"] as const;
type VolumeBucket = (typeof VOLUME_BUCKETS)[number];

function bucketOf(n: number): VolumeBucket {
  if (n === 0) return "0";
  if (n <= 10) return "1-10";
  if (n <= 50) return "11-50";
  if (n <= 150) return "51-150";
  return "151+";
}

interface CorpusPage {
  bundle: string;
  pageNumber: number;
  drawingNumber: string | null;
  discipline: string | null;
  rawText: string | null;
}

interface FramePage {
  bundle: string;
  page: number;
  drawingNumber: string | null;
  discipline: string | null;
  disciplineGroup: DisciplineGroup;
  bucket: VolumeBucket;
  stratum: string;
  hash: string;
  oldEngineCodeCount: number;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Discipline for stratification: the classifier's prefix, else the first letter
 * of the drawing number. Both are engine-independent (LABELING_PROTOCOL §3.2).
 */
function disciplineOf(p: CorpusPage): string | null {
  if (p.discipline) return p.discipline;
  const d = p.drawingNumber?.trim();
  if (d && /^[A-Za-z]/.test(d)) return d[0].toUpperCase();
  return null;
}

function groupOf(discipline: string | null): DisciplineGroup {
  if (!discipline) return "OTHER";
  return DISCIPLINE_GROUPS[discipline.toUpperCase()] ?? "OTHER";
}

/**
 * Drawing SERIES — the correlation unit for the dev/test split. "A-601.00" and
 * "A-602" are both `A6`: same sheet family, same title block, same keynote
 * legend, largely the same vocabulary. Pages without a drawing number fall back
 * to a contiguous 8-page block, which is the best proxy available.
 */
function seriesOf(p: { drawingNumber: string | null; page: number }): string {
  const d = (p.drawingNumber ?? "").trim();
  const m = /^([A-Za-z]+)[\s\-.]*(\d)/.exec(d);
  return m ? `${m[1].toUpperCase()}${m[2]}` : `blk${Math.floor(p.page / 8)}`;
}

/**
 * Largest-remainder allocation with a per-stratum floor and a population cap,
 * then a deterministic fix-up so the total lands exactly on TARGET_PAGES.
 */
function allocate(strata: { key: string; population: number }[], target: number): Map<string, number> {
  const totalPop = strata.reduce((n, s) => n + s.population, 0);
  const alloc = new Map<string, number>();

  for (const s of strata) {
    const raw = (target * s.population) / totalPop;
    alloc.set(s.key, Math.min(s.population, Math.max(FLOOR_PER_STRATUM, Math.round(raw))));
  }

  // Fix-up. Sorted key order keeps every adjustment deterministic.
  const ordered = [...strata].sort((a, b) => b.population - a.population || a.key.localeCompare(b.key));
  let sum = [...alloc.values()].reduce((a, b) => a + b, 0);

  while (sum > target) {
    const victim = ordered.find(s => (alloc.get(s.key) ?? 0) > FLOOR_PER_STRATUM);
    if (!victim) break; // every stratum is at its floor — target is below the floor sum
    alloc.set(victim.key, alloc.get(victim.key)! - 1);
    sum--;
    ordered.sort((a, b) => (alloc.get(b.key)! - alloc.get(a.key)!) || a.key.localeCompare(b.key));
  }
  while (sum < target) {
    const lucky = ordered.find(s => (alloc.get(s.key) ?? 0) < s.population);
    if (!lucky) break; // every stratum exhausted — frame is smaller than target
    alloc.set(lucky.key, alloc.get(lucky.key)! + 1);
    sum++;
    ordered.sort((a, b) => (alloc.get(a.key)! - alloc.get(b.key)!) || a.key.localeCompare(b.key));
  }

  return alloc;
}

/**
 * Order a stratum's pages so no single project dominates: group by bundle, sort
 * each bundle's pages by hash, then interleave round-robin across bundles in
 * sorted bundle order (LABELING_PROTOCOL §3.2).
 */
function bundleInterleaved(pages: FramePage[]): FramePage[] {
  const byBundle = new Map<string, FramePage[]>();
  for (const p of pages) {
    const list = byBundle.get(p.bundle) ?? [];
    list.push(p);
    byBundle.set(p.bundle, list);
  }
  const queues = [...byBundle.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, list]) => list.sort((a, b) => a.hash.localeCompare(b.hash)));

  const out: FramePage[] = [];
  for (let i = 0; out.length < pages.length; i++) {
    for (const q of queues) if (i < q.length) out.push(q[i]);
  }
  return out;
}

async function main(): Promise<void> {
  const [corpusPath, baselinePath, outPath] = process.argv.slice(2);
  if (!corpusPath || !baselinePath || !outPath) {
    console.error("usage: node csi-select.js <corpus.ndjson> <baseline.json> <out.json>");
    process.exit(1);
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as {
    pages: { bundle: string; page: number; codes: string[] }[];
  };
  const codesByPage = new Map(baseline.pages.map(p => [`${p.bundle}:${p.page}`, p.codes]));

  const frame: FramePage[] = [];
  const excluded: { bundle: string; page: number; reason: string }[] = [];

  const rl = createInterface({ input: createReadStream(corpusPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const p = JSON.parse(line) as CorpusPage;
    const key = `${p.bundle}:${p.pageNumber}`;

    // LABELING_PROTOCOL §2: the engine's own `< 10 chars` guard returns [] here,
    // so these pages measure nothing about matching quality.
    if (!p.rawText || p.rawText.length < 10) {
      excluded.push({ bundle: p.bundle, page: p.pageNumber, reason: "no usable OCR text" });
      continue;
    }

    const codes = codesByPage.get(key) ?? [];
    const discipline = disciplineOf(p);
    const group = groupOf(discipline);
    const bucket = bucketOf(codes.length);

    frame.push({
      bundle: p.bundle,
      page: p.pageNumber,
      drawingNumber: p.drawingNumber,
      discipline,
      disciplineGroup: group,
      bucket,
      stratum: `${group}|${bucket}`,
      hash: sha256(key),
      oldEngineCodeCount: codes.length,
    });
  }

  // ── strata ──
  const byStratum = new Map<string, FramePage[]>();
  for (const p of frame) {
    const list = byStratum.get(p.stratum) ?? [];
    list.push(p);
    byStratum.set(p.stratum, list);
  }
  const strataMeta = [...byStratum.entries()]
    .map(([key, pages]) => ({ key, population: pages.length }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const alloc = allocate(strataMeta, TARGET_PAGES);

  // ── select ──
  const picked: (FramePage & { rank: number })[] = [];
  for (const s of strataMeta) {
    const ordered = bundleInterleaved(byStratum.get(s.key)!);
    const take = alloc.get(s.key)!;
    for (let i = 0; i < take; i++) picked.push({ ...ordered[i], rank: i });
  }

  // ── split, at CLUSTER granularity (LABELING_PROTOCOL §8) ──
  //
  // The first version of this split assigned by parity of rank within the
  // stratum. That was wrong twice over, and an adversarial review caught both:
  //   (a) `bundleInterleaved` makes rank ≡ bundle index mod (#bundles), so with
  //       an even bundle count the parity rule mapped WHOLE PROJECTS to one
  //       side — 4 of 20 strata ended up with disjoint dev/test bundle sets.
  //   (b) 54 pairs of consecutive sheets straddled the split. Consecutive
  //       sheets of one drawing series share title blocks, keynote legends and
  //       vocabulary; tuning on A-804 and testing on A-805 is testing on train.
  //
  // Both are fixed by never splitting a CLUSTER. A cluster is the transitive
  // closure of "same drawing series" and "adjacent page number in the same
  // bundle", so correlated sheets travel together to one side.
  const clusterOf = new Map<string, string>(); // page key → cluster root
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const nx = parent.get(x)!; parent.set(x, r); x = nx; }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra > rb ? ra : rb, ra > rb ? rb : ra); // lexically smaller root wins → deterministic
  };

  const pkey = (p: { bundle: string; page: number }) => `${p.bundle}:${p.page}`;
  for (const p of picked) parent.set(pkey(p), pkey(p));

  const bySeries = new Map<string, string[]>();
  const byBundlePage = new Map<string, (typeof picked)[number]>();
  for (const p of picked) {
    const s = `${p.bundle}|${seriesOf(p)}`;
    const list = bySeries.get(s) ?? [];
    list.push(pkey(p));
    bySeries.set(s, list);
    byBundlePage.set(pkey(p), p);
  }
  for (const list of bySeries.values()) for (let i = 1; i < list.length; i++) union(list[0], list[i]);
  for (const p of picked) {
    const next = byBundlePage.get(`${p.bundle}:${p.page + 1}`);
    if (next) union(pkey(p), pkey(next));
  }
  for (const p of picked) clusterOf.set(pkey(p), find(pkey(p)));

  // Greedy, stratum-aware: walk clusters in hash order and give each to
  // whichever side is currently thinner in the strata that cluster touches.
  // Stratum balance is preserved without ever splitting a cluster.
  const clusters = new Map<string, (typeof picked)[number][]>();
  for (const p of picked) {
    const root = clusterOf.get(pkey(p))!;
    const list = clusters.get(root) ?? [];
    list.push(p);
    clusters.set(root, list);
  }
  const orderedClusters = [...clusters.entries()].sort((a, b) => sha256(a[0]).localeCompare(sha256(b[0])));

  // Cost balances BOTH dimensions at once. Stratum-only balancing was tried
  // first and let a whole project (13 pages) land in dev with zero pages in
  // test — trading the adjacency confound for a project confound. Bundle load
  // carries equal weight here because a test half dominated by one project's
  // title-block vocabulary measures that project, not the tagger.
  //
  // Largest clusters are placed first: a 15-page cluster has no good home once
  // the halves are nearly full, so it must choose while both sides are open.
  const countByStratum: Record<"dev" | "test", Map<string, number>> = { dev: new Map(), test: new Map() };
  const countByBundle: Record<"dev" | "test", Map<string, number>> = { dev: new Map(), test: new Map() };
  const totalBy: Record<"dev" | "test", number> = { dev: 0, test: 0 };
  const splitOf = new Map<string, "dev" | "test">();

  const placementOrder = [...orderedClusters].sort(
    (a, b) => b[1].length - a[1].length || sha256(a[0]).localeCompare(sha256(b[0])),
  );

  for (const [, members] of placementOrder) {
    const cost = (side: "dev" | "test") =>
      members.reduce(
        (n, m) => n + (countByStratum[side].get(m.stratum) ?? 0) + (countByBundle[side].get(m.bundle) ?? 0),
        0,
      );
    const cDev = cost("dev");
    const cTest = cost("test");
    const side: "dev" | "test" =
      cDev !== cTest ? (cDev < cTest ? "dev" : "test") : totalBy.dev <= totalBy.test ? "dev" : "test";
    for (const m of members) {
      splitOf.set(pkey(m), side);
      countByStratum[side].set(m.stratum, (countByStratum[side].get(m.stratum) ?? 0) + 1);
      countByBundle[side].set(m.bundle, (countByBundle[side].get(m.bundle) ?? 0) + 1);
      totalBy[side]++;
    }
  }

  const selected = picked.map(p => ({ ...p, split: splitOf.get(pkey(p))! }));

  const strataOut = strataMeta.map(s => {
    const take = alloc.get(s.key)!;
    const inStratum = selected.filter(p => p.stratum === s.key);
    return {
      stratum: s.key,
      population: s.population,
      /** population / selected — multiply per-stratum metrics by this to reweight to the 466-page frame. */
      weight: +(s.population / take).toFixed(4),
      selected: take,
      dev: inStratum.filter(p => p.split === "dev").length,
      test: inStratum.filter(p => p.split === "test").length,
    };
  });

  // ── pilot (LABELING_PROTOCOL §9.1): dev-only, spans all 4 discipline groups
  // and both volume extremes. ──
  //
  // An earlier version also required a page touching a "thin division", chosen
  // from the OLD ENGINE's emitted divisions — which quietly violated §3.1, the
  // rule this file exists to enforce. A division the old engine cannot emit
  // could never satisfy that check, so it selected for the engine's blind spots
  // rather than against them. Thin-division coverage is now verified AFTER
  // labeling, against the gold labels, which are the only valid source for it.
  const devPages = selected
    .filter(p => p.split === "dev")
    .sort((a, b) => a.hash.localeCompare(b.hash));
  const pilot: typeof devPages = [];
  const pushIf = (pred: (p: (typeof devPages)[number]) => boolean) => {
    const hit = devPages.find(p => pred(p) && !pilot.includes(p));
    if (hit) pilot.push(hit);
  };
  for (const g of ["A", "MEP", "S", "OTHER"] as const) pushIf(p => p.disciplineGroup === g);
  pushIf(p => p.bucket === "0");
  pushIf(p => p.bucket === "151+");
  for (const p of devPages) {
    if (pilot.length >= PILOT_SIZE) break;
    if (!pilot.includes(p)) pilot.push(p);
  }

  const manifest = {
    schemaVersion: "csi-gold-frame/1",
    what: "Which corpus pages get gold CSI labels, and how they are stratified.",
    protocol: "eval/csi/LABELING_PROTOCOL.md",
    generatedAt: new Date().toISOString(),
    generatedAtGitSha: (() => {
      try {
        return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
      } catch {
        return "unknown";
      }
    })(),
    corpusSha: sha256(readFileSync(corpusPath, "utf-8")),
    baselineSha: sha256(readFileSync(baselinePath, "utf-8")),
    params: {
      targetPages: TARGET_PAGES,
      floorPerStratum: FLOOR_PER_STRATUM,
      pilotSize: PILOT_SIZE,
      ordering: "sha256(bundle + ':' + page), bundle round-robin within stratum",
      splitRule: "parity of rank within stratum",
    },
    frame: {
      corpusPages: frame.length + excluded.length,
      framePages: frame.length,
      excluded,
      selectedPages: selected.length,
      dev: selected.filter(p => p.split === "dev").length,
      test: selected.filter(p => p.split === "test").length,
    },
    // Split quality — the numbers an adversarial review checked by hand once, now
    // emitted every run so the tests can assert them instead of a human noticing.
    splitQuality: {
      clusters: clusters.size,
      clusterRule: "transitive closure of (same bundle+drawing series) and (adjacent page in same bundle)",
      /** Consecutive-page pairs landing on opposite sides. MUST be 0 — see §8. */
      adjacentPairsStraddling: selected.filter(
        p => splitOf.get(`${p.bundle}:${p.page + 1}`) && splitOf.get(`${p.bundle}:${p.page + 1}`) !== p.split,
      ).length,
      /** Per-project dev/test counts. A project appearing on only one side is a confound. */
      perBundle: [...new Set(selected.map(p => p.bundle))].sort().map(bundle => ({
        bundle,
        dev: selected.filter(p => p.bundle === bundle && p.split === "dev").length,
        test: selected.filter(p => p.bundle === bundle && p.split === "test").length,
      })),
      /** Strata whose dev and test halves share NO project — the §3 confound. */
      strataWithDisjointBundles: strataMeta
        .map(s => {
          const inS = selected.filter(p => p.stratum === s.key);
          const dev = new Set(inS.filter(p => p.split === "dev").map(p => p.bundle));
          const test = new Set(inS.filter(p => p.split === "test").map(p => p.bundle));
          const shared = [...dev].some(b => test.has(b));
          return dev.size && test.size && !shared ? s.key : null;
        })
        .filter((x): x is string => x !== null),
    },
    strata: strataOut,
    pilot: pilot.map(p => ({ bundle: p.bundle, page: p.page, stratum: p.stratum, drawingNumber: p.drawingNumber })),
    pages: selected
      .sort((a, b) => a.bundle.localeCompare(b.bundle) || a.page - b.page)
      .map(p => ({
        bundle: p.bundle,
        page: p.page,
        drawingNumber: p.drawingNumber,
        discipline: p.discipline,
        disciplineGroup: p.disciplineGroup,
        stratum: p.stratum,
        split: p.split,
        oldEngineCodeCount: p.oldEngineCodeCount,
      })),
  };

  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
  console.error(
    `[select] frame ${frame.length} pages (${excluded.length} excluded) · ` +
      `${strataOut.length} strata · selected ${selected.length} ` +
      `(dev ${manifest.frame.dev} / test ${manifest.frame.test}) · pilot ${pilot.length} → ${outPath}`,
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
