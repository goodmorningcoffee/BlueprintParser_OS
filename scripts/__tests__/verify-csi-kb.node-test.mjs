// verify-csi-kb.node-test.mjs — the gate that stands in for git on src/data/csi-kb.json (owner
// ruling D1, 2026-10-20: gitignored but shipped). Hermetic: every KB here is synthetic and the
// inputs live in a temp tree, so it runs on a fresh clone (GitHub CI) that has no real KB.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { REQUIRED_SOURCES, csiKbProblems } from "../verify-csi-kb.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const sha = (s) => createHash("sha256").update(s).digest("hex");
let tree;

before(async () => {
  tree = await mkdtemp(path.join(tmpdir(), "verify-csi-kb-"));
  for (const rel of REQUIRED_SOURCES) {
    await mkdir(path.join(tree, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(tree, rel), `contents of ${rel}\r\n`);
  }
});
after(async () => {
  await rm(tree, { recursive: true, force: true });
});

const goodKb = () => ({
  header: {
    schemaVersion: "csi-kb/2",
    sources: [{ path: "csi_masterformat.pdf", sha256: "0".repeat(64) }, ...REQUIRED_SOURCES.map((p) => ({ path: p, sha256: sha(`contents of ${p}\r\n`) }))],
  },
  codes: [{ code: "08 11 13" }],
  patterns: [{ id: 0 }],
});
async function problemsFor(body, name = "kb.json") {
  const file = path.join(tree, name);
  await writeFile(file, typeof body === "string" ? body : JSON.stringify(body));
  return csiKbProblems(file, tree);
}

test("a KB whose recorded raw-byte hashes match the tree is shippable; the PDF entry is not hashed", async () => {
  assert.deepEqual(await problemsFor(goodKb()), []);
});

test("missing, empty, unparseable, wrong-schema and stub KBs are refused, each with its reason", async () => {
  assert.match(csiKbProblems(path.join(tree, "absent.json"), tree).join("\n"), /missing or unreadable/u);
  assert.match((await problemsFor("")).join("\n"), /is empty/u);
  assert.match((await problemsFor('{"header":{"schemaVersion":"csi-kb/2"')).join("\n"), /not valid JSON/u);
  const v1 = goodKb();
  v1.header.schemaVersion = "csi-kb/1";
  assert.match((await problemsFor(v1)).join("\n"), /schemaVersion is "csi-kb\/1"/u);
  // the 40-byte stub the deploy harness once accepted
  const stub = (await problemsFor('{"header":{"schemaVersion":"csi-kb/2"}}\n')).join("\n");
  assert.match(stub, /"codes" is missing or empty/u);
  assert.match(stub, /"patterns" is missing or empty/u);
  assert.match(stub, /header\.sources is not an array/u);
});

test("a stale KB is refused: one input edited without a rebuild, the tokenizer included", async () => {
  for (const rel of REQUIRED_SOURCES) {
    const kb = goodKb();
    kb.header.sources.find((s) => s.path === rel).sha256 = "f".repeat(64);
    const problems = await problemsFor(kb);
    assert.equal(problems.length, 1, rel);
    assert.match(problems[0], new RegExp(`^STALE: "${rel.replace(/\./gu, "\\.")}"`, "u"));
  }
});

test("a dropped or an unknown source entry is refused, so a builder change cannot slip past", async () => {
  const dropped = goodKb();
  dropped.header.sources = dropped.header.sources.filter((s) => s.path !== "src/data/csi.tsv");
  assert.deepEqual(await problemsFor(dropped), ['header.sources has no entry for "src/data/csi.tsv"']);
  const extra = goodKb();
  extra.header.sources.push({ path: "src/data/new-input.tsv", sha256: "a".repeat(64) });
  assert.match((await problemsFor(extra)).join("\n"), /lists "src\/data\/new-input\.tsv", which this check does not know/u);
});

test("the CLI exits 1 with the D1 rebuild instructions, and 0 with one ok line", async () => {
  const bad = spawnSync(process.execPath, [path.join(ROOT, "scripts/verify-csi-kb.mjs"), path.join(tree, "absent.json")], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /FAIL[\s\S]*missing or unreadable[\s\S]*gitignored by design \(owner ruling D1[\s\S]*eval\/csi\/build-kb-v2\.ts/u);
  // The CLI hashes the REAL tree's inputs, so the ok path needs a KB built from them.
  const real = goodKb();
  real.header.sources = [
    real.header.sources[0],
    ...(await Promise.all(REQUIRED_SOURCES.map(async (p) => ({ path: p, sha256: sha(await readFile(path.join(ROOT, p))) })))),
  ];
  const file = path.join(tree, "real.json");
  await writeFile(file, JSON.stringify(real));
  const ok = spawnSync(process.execPath, [path.join(ROOT, "scripts/verify-csi-kb.mjs"), file], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^verify-csi-kb: ok — .* is csi-kb\/2 and current against 4 inputs\n$/u);
});

test("the Dockerfile runs it in the builder stage, after the tree is copied and before next build", async () => {
  const lines = (await readFile(path.join(ROOT, "Dockerfile"), "utf8")).split("\n");
  const at = (pred, from = 0) => lines.findIndex((l, i) => i >= from && pred(l.trim()));
  const builder = at((l) => /^FROM \S+ AS builder$/u.test(l));
  const copy = at((l) => l === "COPY . .", builder);
  const verify = at((l) => l === "RUN node scripts/verify-csi-kb.mjs", builder);
  const build = at((l) => l === "npm run build", builder);
  const nextStage = at((l) => l.startsWith("FROM "), builder + 1);
  assert.ok(builder >= 0 && copy > builder && verify > copy && build > verify && nextStage > build, JSON.stringify({ builder, copy, verify, build, nextStage }));
  // and the verifier is not excluded from the build context
  const ignore = (await readFile(path.join(ROOT, ".dockerignore"), "utf8")).split("\n").map((l) => l.trim());
  assert.ok(!ignore.some((l) => l === "scripts" || l === "scripts/" || l === "*.mjs" || l === "src/data"), "scripts/*.mjs and src/data reach the builder");
});
