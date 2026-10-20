#!/usr/bin/env node
// verify-csi-kb.mjs — refuse a missing, stub or stale CSI v2 lookup table before it ships.
//
// `src/data/csi-kb.json` is GITIGNORED BUT SHIPPED (owner ruling D1, 2026-10-20): its ~11,500
// MasterFormat phrases are not redistributed on the public GitHub repo, yet the image must carry
// it, and the image is built from the working tree. Git can therefore not vouch for it, so this
// does. It is the one gate every image build passes — the Dockerfile builder stage runs it, so
// `./deploy-aws.sh release`, `bootstrap` and a bare `./deploy.sh publish` are all covered — and
// deploy-aws.sh runs it again up front so a release refuses before docker or AWS is touched.
//
// Checks: the file exists, is non-empty, parses, is schema `csi-kb/2` with non-empty `codes` and
// `patterns`, and `header.sources` records the raw-byte sha256 of every repo input it was built
// from — all four of REQUIRED_SOURCES, nothing else but the PDF — and each matches the tree it is
// about to ship with. The tokenizer is checked here although the runtime loader skips it
// (CSI_KB_BUILD_ONLY_SOURCES in src/lib/csi-kb.ts): at build time its source IS the shipped code.
// The PDF is build-only and not in the repo, so its entry is not hashed.
//
// Usage: node scripts/verify-csi-kb.mjs [kbFile]   (inputs resolve against the repo this file is in)
// Exit 0 with one "ok" line, or exit 1 with every reason and the rebuild instructions.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CSI_KB_REL = "src/data/csi-kb.json";
export const CSI_KB_SCHEMA = "csi-kb/2";
/** Must equal [...CSI_KB_RUNTIME_SOURCES, ...CSI_KB_BUILD_ONLY_SOURCES] (src/lib/csi-kb.ts); csi-kb-loader.test.ts pins that. */
export const REQUIRED_SOURCES = [
  "src/data/csi-masterformat.tsv",
  "src/data/csi.tsv",
  "src/data/csi_terms.tsv",
  "src/lib/csi-tokenize.ts",
];
export const REBUILD_HINT =
  `${CSI_KB_REL} is gitignored by design (owner ruling D1: MasterFormat phrases are not redistributed on GitHub) ` +
  "but MUST ship in the image. Rebuild it from the MasterFormat PDF — see the header of eval/csi/build-kb-v2.ts " +
  "(npx esbuild … --outfile=build/csi-kbv2-build.js, then node build/csi-kbv2-build.js [pdfPath])";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Returns the list of problems (empty = shippable). `root` is the tree the KB will ship with. */
export function csiKbProblems(kbFile, root) {
  let raw;
  try {
    raw = readFileSync(kbFile);
  } catch {
    return [`${kbFile} is missing or unreadable`];
  }
  if (raw.length === 0) return [`${kbFile} is empty`];
  let kb;
  try {
    kb = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    return [`${kbFile} is not valid JSON (${err.message})`];
  }
  const problems = [];
  const header = kb && typeof kb === "object" ? kb.header : undefined;
  if (!header || header.schemaVersion !== CSI_KB_SCHEMA) {
    problems.push(`header.schemaVersion is ${JSON.stringify(header?.schemaVersion)}, not "${CSI_KB_SCHEMA}"`);
  }
  for (const key of ["codes", "patterns"]) {
    if (!Array.isArray(kb?.[key]) || kb[key].length === 0) problems.push(`"${key}" is missing or empty (a stub, not a built KB)`);
  }
  const sources = Array.isArray(header?.sources) ? header.sources : null;
  if (!sources) return [...problems, "header.sources is not an array"];
  const recorded = new Map();
  for (const s of sources) {
    const p = typeof s?.path === "string" ? s.path : "";
    if (p.toLowerCase().endsWith(".pdf")) continue;
    if (!REQUIRED_SOURCES.includes(p)) problems.push(`header.sources lists "${p}", which this check does not know — update REQUIRED_SOURCES`);
    else recorded.set(p, s.sha256);
  }
  for (const rel of REQUIRED_SOURCES) {
    const want = recorded.get(rel);
    if (!want) {
      problems.push(`header.sources has no entry for "${rel}"`);
      continue;
    }
    let got;
    try {
      got = sha256(readFileSync(join(root, rel)));
    } catch {
      problems.push(`input "${rel}" is missing from ${root}`);
      continue;
    }
    if (got !== want) problems.push(`STALE: "${rel}" has sha256 ${got} but the KB was built from ${want} — rebuild the KB`);
  }
  return problems;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  const root = resolve(dirname(self), "..");
  const kbFile = resolve(process.argv[2] ?? join(root, CSI_KB_REL));
  const problems = csiKbProblems(kbFile, root);
  if (problems.length === 0) {
    console.log(`verify-csi-kb: ok — ${kbFile} is ${CSI_KB_SCHEMA} and current against ${REQUIRED_SOURCES.length} inputs`);
  } else {
    console.error(`verify-csi-kb: FAIL — the CSI lookup table cannot ship:`);
    for (const p of problems) console.error(`    ${p}`);
    console.error(`  ${REBUILD_HINT}`);
    process.exitCode = 1;
  }
}
