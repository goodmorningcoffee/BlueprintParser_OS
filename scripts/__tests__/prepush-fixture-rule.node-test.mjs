// prepush-fixture-rule.node-test.mjs — check 7 (FIXTURES) of scripts/prepush-check.sh: parse-engine test
// data stays synthetic (table-pipeline PLAN §1.6 rule 12, WP-2.0a). Under any __fixtures__/ of
// src/lib/parse-engine only *.synthetic.json; under eval/parse-engine/ only intended-diffs.md,
// baseline.json, profile.json and capabilities/<name>.json. Each case builds a throwaway git repo and runs
// the real script against it, in manual mode (every local branch) or hook mode (refs named on stdin).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const SCRIPT = path.join(ROOT, "scripts/prepush-check.sh");
const IGNORE_OK = "/models/\n/src/data/csi-kb.json\n/src/lib/__tests__/fixtures/csi-v2/mf-pages-excerpt.json\n";
const GOOD = [
  "src/lib/parse-engine/__fixtures__/syn-a.synthetic.json",
  "src/lib/parse-engine/__fixtures__/legacy-goldens.synthetic.json",
  "src/lib/parse-engine/rows/__fixtures__/syn-b.synthetic.json",
  "eval/parse-engine/intended-diffs.md",
  "eval/parse-engine/baseline.json",
  "eval/parse-engine/profile.json",
  "eval/parse-engine/capabilities/rows.json",
  "src/lib/other/__fixtures__/not-ours.json",
  "src/lib/parse-engine/__tests__/legacy-golden.test.ts",
];

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" },
  });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
async function put(repo, rel, body = "{}\n") {
  await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
  await writeFile(path.join(repo, rel), body);
}
async function repoWith(files) {
  const repo = await mkdtemp(path.join(tmpdir(), "prepush-fixture-"));
  git(repo, "init", "-q", "-b", "main");
  await put(repo, ".gitignore", IGNORE_OK);
  for (const f of files) await put(repo, f);
  git(repo, "add", ".gitignore", ...files);
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}
const run = (repo, stdin = "") => spawnSync("bash", [SCRIPT], { cwd: repo, input: stdin, encoding: "utf8" });

test("clean: synthetic fixtures, the eval allow-list, and __fixtures__ outside parse-engine", async () => {
  const repo = await repoWith(GOOD);
  try {
    const r = run(repo);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /prepush-check: clean — parse-engine fixtures synthetic-only/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a non-synthetic fixture under any parse-engine __fixtures__ is refused", async () => {
  for (const bad of [
    "src/lib/parse-engine/__fixtures__/real-page.json",
    "src/lib/parse-engine/__fixtures__/page.synthetic.json.bak",
    "src/lib/parse-engine/rows/__fixtures__/slice.json",
    "src/lib/parse-engine/__fixtures__/goldens/real.md",
  ]) {
    const repo = await repoWith([...GOOD, bad]);
    try {
      const r = run(repo);
      assert.equal(r.status, 1, `${bad} should be refused`);
      assert.match(r.stderr, /parse-engine fixtures must be \*\.synthetic\.json/u);
      assert.ok(r.stderr.includes(`    ${bad}`), `${bad} is named: ${r.stderr}`);
      assert.equal((r.stderr.match(/^ {4}\S/gmu) ?? []).length, 1, "only the bad path is listed");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }
});

test("eval/parse-engine holds only the allow-listed files", async () => {
  for (const bad of [
    "eval/parse-engine/report.md",
    "eval/parse-engine/gold.jsonl",
    "eval/parse-engine/capabilities/nested/rows.json",
    "eval/parse-engine/capabilities/rows.md",
  ]) {
    const repo = await repoWith([...GOOD, bad]);
    try {
      const r = run(repo);
      assert.equal(r.status, 1, `${bad} should be refused`);
      assert.ok(r.stderr.includes(`    ${bad}`), `${bad} is named: ${r.stderr}`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }
});

test("history: a real slice added then deleted is still refused; hook mode checks only the pushed refs", async () => {
  const repo = await repoWith(GOOD);
  try {
    git(repo, "checkout", "-q", "-b", "leak");
    await put(repo, "src/lib/parse-engine/__fixtures__/real.json");
    git(repo, "add", "src/lib/parse-engine/__fixtures__/real.json");
    git(repo, "commit", "-q", "-m", "add real slice");
    git(repo, "rm", "-q", "src/lib/parse-engine/__fixtures__/real.json");
    git(repo, "commit", "-q", "-m", "remove it again");
    git(repo, "checkout", "-q", "main");

    const manual = run(repo); // every local branch, so `leak` is in scope
    assert.equal(manual.status, 1);
    assert.ok(manual.stderr.includes("    src/lib/parse-engine/__fixtures__/real.json"), manual.stderr);

    const mainSha = git(repo, "rev-parse", "main");
    const leakSha = git(repo, "rev-parse", "leak");
    const pushMain = run(repo, `refs/heads/main ${mainSha} refs/heads/main ${"0".repeat(40)}\n`);
    assert.equal(pushMain.status, 0, pushMain.stderr);
    const pushLeak = run(repo, `refs/heads/leak ${leakSha} refs/heads/leak ${"0".repeat(40)}\n`);
    assert.equal(pushLeak.status, 1);
    assert.match(pushLeak.stderr, /real slices belong in the private docs repo/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
