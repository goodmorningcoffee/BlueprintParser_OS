/**
 * mf-fixture-extract.ts — regenerates the public parser fixture
 * `src/lib/__tests__/fixtures/csi-v2/mf-pages-excerpt.json` from the MasterFormat PDF,
 * so `csi-mf-parse.test.ts` runs without the PDF and the excerpt stays reproducible.
 *
 * Content is MasterFormat text only (numbers, titles, explanations, keyword index).
 *
 *   npx esbuild eval/csi/mf-fixture-extract.ts --bundle --platform=node --target=node20 \
 *     --alias:@=./src --external:pg-native --outfile=build/csi-mf-fixture.js
 *   node build/csi-mf-fixture.js [pdfPath] [outPath]
 *
 * Pages and why:
 *   40, 46  master list: the Level-2 listing's last row "48 80 00 to 48 90 00 Unassigned"
 *           (p.40) followed by the first full-list division page, whose side note "May be
 *           used as Division level Section" sits ABOVE the first code (p.46) — the over-grab
 *           that TITLE_STRIP_RE removes. Also two range rows (Unassigned counter).
 *   179     Division 08: Includes / Alternate Terms / See blocks, "for …" See rows.
 *   560     division title printed as one ~20 pt item that wraps, sharing a baseline with
 *           the explanation column ("Purification, and" + "handling, purifying, …").
 *   629     "09 91 00 acrylic latex paint" / "acrylic plastic" + subs: a new uncoded head
 *           right under a coded entry (not a wrap).
 *   640     "33 82 53 cleaning, lubrication" / "chemicals, communications" / "cleaning
 *           concrete" + subs: the run is [wrapped tail] + [new head].
 *   642     index golden: cleaning, maintenance, concrete → 03 01 00 (coded head).
 *   653     index golden: dry cleaning (11 21 73) must not take head "epoxy mortar";
 *           also the wrapped coded head "equal employment / opportunity".
 *   665     index golden: air cleaning devices, HVAC → 23 40 00.
 * No split-word page: pdfjs shows no split-word artifacts in this PDF (measured 0).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_PDF, extractPages } from "./mf-parse";

export const FIXTURE_PAGES = [40, 46, 179, 560, 629, 640, 642, 653, 665];
export const FIXTURE_OUT = "src/lib/__tests__/fixtures/csi-v2/mf-pages-excerpt.json";

async function main(): Promise<void> {
  const pdf = process.argv[2] ?? DEFAULT_PDF;
  const out = process.argv[3] ?? FIXTURE_OUT;
  if (!existsSync(pdf)) throw new Error(`[mf-fixture] PDF not found: ${pdf}`);
  const sha256 = createHash("sha256").update(readFileSync(pdf)).digest("hex");
  const pages = await extractPages(pdf, FIXTURE_PAGES);
  mkdirSync(dirname(out), { recursive: true });
  const header = {
    source: "MasterFormat 2018 PDF (gitignore/csi_masterformat.pdf), pdfjs-dist legacy getTextContent",
    pdfSha256: sha256,
    generator: "eval/csi/mf-fixture-extract.ts",
  };
  // One item per line: small, and a re-extraction diffs line-by-line.
  const pagesJson = pages
    .map((p) => {
      const items = p.items.map((i) => `    ${JSON.stringify(i)}`).join(",\n");
      return `  { "page": ${p.page}, "width": ${p.width}, "height": ${p.height}, "items": [\n${items}\n  ] }`;
    })
    .join(",\n");
  const head = JSON.stringify(header, null, 1);
  writeFileSync(out, `${head.slice(0, -2)},\n "pages": [\n${pagesJson}\n ]\n}\n`);
  JSON.parse(readFileSync(out, "utf-8")); // fail loud if the hand-rolled layout is not JSON
  console.error(`[mf-fixture] ${pages.length} pages, ${pages.reduce((n, p) => n + p.items.length, 0)} items → ${out}`);
}

// Entry guard — importing this from a test must not run the CLI (see score.ts).
if (process.argv[1]?.includes("csi-mf-fixture")) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
