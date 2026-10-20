// prepush-check.node-test.mjs — the private-MasterFormat half of scripts/prepush-check.sh: the KB
// (owner ruling D1, 2026-10-20: src/data/csi-kb.json is gitignored but shipped) and the parser test
// fixture (owner ruling 2026-10-20, same as D1: src/lib/__tests__/fixtures/csi-v2/mf-pages-excerpt.json
// is gitignored, not shipped). Each case builds a throwaway git repo and runs the real script against
// it, in manual mode (every local branch) or hook mode (only the refs git names on stdin).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const SCRIPT = path.join(ROOT, "scripts/prepush-check.sh");
const FX = "src/lib/__tests__/fixtures/csi-v2/mf-pages-excerpt.json";
const KB_GEN = "eval/csi/build-kb-v2.ts";
const FX_GEN = "eval/csi/mf-fixture-extract.ts";
const IGNORE_OK = `/models/\n/src/data/csi-kb.json\n/${FX}\n`;
const IGNORE_NO_KB = `/models/\n/${FX}\n`;
const IGNORE_NO_FX = "/models/\n/src/data/csi-kb.json\n";
const FX_LINE_RE = "'/src/lib/__tests__/fixtures/csi-v2/mf-pages-excerpt\\.json'";

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" },
  });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
async function put(repo, rel, body) {
  await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
  await writeFile(path.join(repo, rel), body);
}
/** A repo on branch `main` with the given generators (default: both) and committed .gitignore. */
async function repoWith(committedIgnore, generators = [KB_GEN, FX_GEN]) {
  const repo = await mkdtemp(path.join(tmpdir(), "prepush-check-"));
  git(repo, "init", "-q", "-b", "main");
  await put(repo, ".gitignore", committedIgnore);
  for (const g of generators) await put(repo, g, "// generator\n");
  git(repo, "add", ".gitignore", ...generators);
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}
const run = (repo, stdin = "") => spawnSync("bash", [SCRIPT], { cwd: repo, input: stdin, encoding: "utf8" });

test("clean: the KB and fixture lines are in the working tree and committed at every tip with their generators", async () => {
  const repo = await repoWith(IGNORE_OK);
  try {
    const r = run(repo);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /prepush-check: clean/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a KB line only in the WORKING-TREE .gitignore is refused: GitHub would receive none", async () => {
  const repo = await repoWith(IGNORE_NO_KB);
  try {
    await put(repo, ".gitignore", IGNORE_OK); // uncommitted
    const r = run(repo);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /COMMITTED \.gitignore lacks '\/src\/data\/csi-kb\.json'[\s\S]*commit \.gitignore/u);
    assert.doesNotMatch(r.stderr, /no longer carries the anchored line '\/src\/data\/csi-kb\.json'/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a working tree that drops the KB line is refused even when the commit still has it", async () => {
  const repo = await repoWith(IGNORE_OK);
  try {
    await put(repo, ".gitignore", IGNORE_NO_KB);
    const r = run(repo);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no longer carries the anchored line '\/src\/data\/csi-kb\.json'/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("only pushed tips that carry the builder are held to the committed line; hook mode checks only the named refs", async () => {
  const repo = await repoWith(IGNORE_OK);
  try {
    // an older branch with neither the builder nor the line: not held to it
    git(repo, "checkout", "-q", "--orphan", "old");
    git(repo, "rm", "-q", "-r", "--cached", ".");
    await rm(path.join(repo, "eval"), { recursive: true, force: true });
    await put(repo, ".gitignore", IGNORE_NO_KB);
    await put(repo, "README", "old\n");
    git(repo, "add", ".gitignore", "README");
    git(repo, "commit", "-q", "-m", "old");
    // a branch with the builder whose committed .gitignore lost the line
    git(repo, "checkout", "-q", "main");
    git(repo, "checkout", "-q", "-b", "bad");
    await put(repo, ".gitignore", IGNORE_NO_KB);
    git(repo, "commit", "-q", "-am", "drop line");
    const badSha = git(repo, "rev-parse", "--short=12", "HEAD");
    git(repo, "checkout", "-q", "main");

    const manual = run(repo);
    assert.equal(manual.status, 1);
    assert.match(manual.stderr, new RegExp(`COMMITTED \\.gitignore lacks[^\\n]*\\n\\s+${badSha}\\s*\\n`, "u"));
    assert.equal((manual.stderr.match(/^ {4}[0-9a-f]{12}$/gmu) ?? []).length, 1, "only the builder-carrying tip is named");

    const sha = (ref) => git(repo, "rev-parse", ref);
    const z = "0".repeat(40);
    const hookMain = run(repo, `refs/heads/main ${sha("main")} refs/heads/main ${z}\nrefs/heads/old ${sha("old")} refs/heads/old ${z}\n`);
    assert.equal(hookMain.status, 0, hookMain.stderr);
    const hookBad = run(repo, `refs/heads/bad ${sha("bad")} refs/heads/bad ${z}\n`);
    assert.equal(hookBad.status, 1);
    assert.match(hookBad.stderr, /COMMITTED \.gitignore lacks/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("the KB itself is refused while tracked and after removal, while it is still in the pushed history", async () => {
  const repo = await repoWith(IGNORE_OK);
  try {
    await put(repo, "src/data/csi-kb.json", "{}\n");
    git(repo, "add", "-f", "src/data/csi-kb.json");
    git(repo, "commit", "-q", "-m", "oops");
    const tracked = run(repo);
    assert.equal(tracked.status, 1);
    assert.match(tracked.stderr, /MasterFormat KB, ruling D1[\s\S]*src\/data\/csi-kb\.json/u);
    git(repo, "rm", "-q", "--cached", "src/data/csi-kb.json");
    git(repo, "commit", "-q", "-m", "untrack");
    const history = run(repo);
    assert.equal(history.status, 1);
    assert.match(history.stderr, /back in the index or the pushed history:\n\s+src\/data\/csi-kb\.json/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ── the MasterFormat parser fixture (owner ruling 2026-10-20, same treatment as D1) ──

test("fixture: a line only in the WORKING-TREE .gitignore is refused: GitHub would receive none", async () => {
  const repo = await repoWith(IGNORE_NO_FX);
  try {
    await put(repo, ".gitignore", IGNORE_OK); // uncommitted
    const r = run(repo);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`carry eval/csi/mf-fixture-extract\\.ts but their COMMITTED \\.gitignore lacks ${FX_LINE_RE}[\\s\\S]*commit \\.gitignore`, "u"));
    assert.doesNotMatch(r.stderr, /no longer carries the anchored line/u);
    assert.doesNotMatch(r.stderr, /lacks '\/src\/data\/csi-kb\.json'/u, "the KB line is committed: only the fixture is named");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("fixture: a working tree that drops the line is refused even when the commit still has it", async () => {
  const repo = await repoWith(IGNORE_OK);
  try {
    await put(repo, ".gitignore", IGNORE_NO_FX);
    const r = run(repo);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`no longer carries the anchored line ${FX_LINE_RE}`, "u"));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("fixture: a tip without the fixture extractor is not held to the committed fixture line", async () => {
  const repo = await repoWith(IGNORE_NO_FX, [KB_GEN]);
  try {
    await put(repo, ".gitignore", IGNORE_OK); // the working tree still carries both lines
    const r = run(repo);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /prepush-check: clean/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("fixture: refused while tracked and after removal, while it is still in the pushed history", async () => {
  const repo = await repoWith(IGNORE_OK);
  try {
    await put(repo, FX, "{}\n");
    git(repo, "add", "-f", FX);
    git(repo, "commit", "-q", "-m", "oops");
    const tracked = run(repo);
    assert.equal(tracked.status, 1);
    assert.match(tracked.stderr, /MasterFormat parser fixture, ruling 2026-10-20[\s\S]*src\/lib\/__tests__\/fixtures\/csi-v2\/mf-pages-excerpt\.json/u);
    git(repo, "rm", "-q", "--cached", FX);
    git(repo, "commit", "-q", "-m", "untrack");
    const history = run(repo);
    assert.equal(history.status, 1);
    assert.match(history.stderr, /back in the index or the pushed history:\n\s+src\/lib\/__tests__\/fixtures\/csi-v2\/mf-pages-excerpt\.json/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
