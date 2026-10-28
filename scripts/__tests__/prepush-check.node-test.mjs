// prepush-check.node-test.mjs — the private-MasterFormat half of scripts/prepush-check.sh: the KB
// (owner ruling D1, 2026-10-20: src/data/csi-kb.json is gitignored but shipped) and the parser test
// fixture (owner ruling 2026-10-20, same as D1: src/lib/__tests__/fixtures/csi-v2/mf-pages-excerpt.json
// is gitignored, not shipped). Each case builds a throwaway git repo and runs the real script against
// it, in manual mode (every local branch) or hook mode (only the refs git names on stdin).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

// Check 8 (AUTHORS) refuses any identity outside the allowlist, so the fixture commits as the owner's noreply identity.
const ID = { GIT_AUTHOR_NAME: "goodmorningcoffee", GIT_AUTHOR_EMAIL: "goodmorningcoffee@users.noreply.github.com", GIT_COMMITTER_NAME: "goodmorningcoffee", GIT_COMMITTER_EMAIL: "goodmorningcoffee@users.noreply.github.com" };
function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...ID },
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
// No private-terms list unless a case supplies one (check 9 then WARNs and passes); `env` adds to that.
const run = (repo, stdin = "", env = {}, args = []) =>
  spawnSync("bash", [SCRIPT, ...args], {
    cwd: repo,
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, BP_PREPUSH_TERMS_FILE: "/nonexistent/forbidden-terms.txt", BP_PREPUSH_REQUIRE_TERMS: "", ...env },
  });

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

// ── check 8 (AUTHORS): every commit new to the remote carries an allowlisted author and committer ──

const BAD_MAIL = "someone.private@mail.invalid";
/** Commit `rel` with the given identity overrides (env), leaving the rest of ID in place. */
function commitAs(repo, rel, idOverride) {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", `add ${rel}`], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...ID, ...idOverride },
  });
  assert.equal(r.status, 0, r.stderr);
  return git(repo, "rev-parse", "--short", "HEAD");
}

test("authors: a commit with a personal author e-mail is refused; only the sha and the field are printed", async () => {
  const repo = await repoWith(IGNORE_OK);
  try {
    await put(repo, "a.txt", "a\n");
    git(repo, "add", "a.txt");
    const bad = commitAs(repo, "a.txt", { GIT_AUTHOR_EMAIL: BAD_MAIL });
    const r = run(repo);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`non-allowlisted identity[\\s\\S]*\\n\\s+${bad} author-email\\n`, "u"));
    assert.doesNotMatch(r.stderr, /committer-email/u);
    assert.ok(!r.stderr.includes(BAD_MAIL) && !r.stdout.includes(BAD_MAIL), "the address itself is never printed");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("authors: a bad committer alone is refused, and so is a first name with a noreply address", async () => {
  const repo = await repoWith(IGNORE_OK);
  try {
    await put(repo, "a.txt", "a\n");
    git(repo, "add", "a.txt");
    const c1 = commitAs(repo, "a.txt", { GIT_COMMITTER_EMAIL: BAD_MAIL });
    await put(repo, "b.txt", "b\n");
    git(repo, "add", "b.txt");
    const c2 = commitAs(repo, "b.txt", { GIT_AUTHOR_NAME: "firstname" });
    const r = run(repo);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`\\n\\s+${c1} committer-email\\n`, "u"));
    assert.match(r.stderr, new RegExp(`\\n\\s+${c2} author-name\\n`, "u"));
    assert.ok(!r.stderr.includes("firstname"), "the name itself is never printed");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("authors: a bad commit the remote already has (behind a remote-tracking ref) is not new and passes", async () => {
  const repo = await repoWith(IGNORE_OK);
  try {
    await put(repo, "a.txt", "a\n");
    git(repo, "add", "a.txt");
    commitAs(repo, "a.txt", { GIT_AUTHOR_EMAIL: BAD_MAIL, GIT_COMMITTER_EMAIL: BAD_MAIL });
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    await put(repo, "b.txt", "b\n");
    git(repo, "add", "b.txt");
    git(repo, "commit", "-q", "-m", "good on top");
    const r = run(repo);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /prepush-check: clean[^\n]*author and committer allowlisted/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("authors: hook mode excludes commits below the remote sha git names, and still catches a bad one above it", async () => {
  const repo = await repoWith(IGNORE_OK);
  try {
    await put(repo, "a.txt", "a\n");
    git(repo, "add", "a.txt");
    commitAs(repo, "a.txt", { GIT_AUTHOR_EMAIL: BAD_MAIL });
    const remote = git(repo, "rev-parse", "HEAD");
    await put(repo, "b.txt", "b\n");
    git(repo, "add", "b.txt");
    git(repo, "commit", "-q", "-m", "good");
    const good = git(repo, "rev-parse", "HEAD");
    const ok = run(repo, `refs/heads/main ${good} refs/heads/main ${remote}\n`);
    assert.equal(ok.status, 0, ok.stderr);
    await put(repo, "c.txt", "c\n");
    git(repo, "add", "c.txt");
    const bad = commitAs(repo, "c.txt", { GIT_COMMITTER_EMAIL: BAD_MAIL });
    const refused = run(repo, `refs/heads/main ${git(repo, "rev-parse", "HEAD")} refs/heads/main ${remote}\n`);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, new RegExp(`\\n\\s+${bad} committer-email\\n`, "u"));
    assert.equal((refused.stderr.match(/^ {4}[0-9a-f]{7,} /gmu) ?? []).length, 1, "the commit below the remote sha is not named");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("authors: a contributor's identity is admitted only through this clone's prepush.allowedEmail/allowedName config", async () => {
  const repo = await repoWith(IGNORE_OK);
  try {
    await put(repo, "a.txt", "a\n");
    git(repo, "add", "a.txt");
    commitAs(repo, "a.txt", { GIT_AUTHOR_NAME: "contrib", GIT_AUTHOR_EMAIL: "1+Contrib@users.noreply.github.com" });
    assert.equal(run(repo).status, 1);
    git(repo, "config", "--add", "prepush.allowedEmail", "1+contrib@users.noreply.github.com");
    git(repo, "config", "--add", "prepush.allowedName", "contrib");
    const r = run(repo);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ── check 9 (PRIVATE-TERMS): the optional out-of-repo list ──

const TERM = "Privateclient Holdings";
async function termsFile(dir, body = `# comment line\n\n  ${TERM.toLowerCase()}  \r\nanother-term\n`) {
  const f = path.join(dir, "forbidden-terms.txt");
  await writeFile(f, body);
  return f;
}

test("terms: a term added and later deleted is still refused (every commit's diff is scanned); the term is never printed", async () => {
  const repo = await repoWith(IGNORE_OK);
  const dir = await mkdtemp(path.join(tmpdir(), "prepush-terms-"));
  try {
    await put(repo, "notes/a.txt", `line one\nfrom ${TERM.toUpperCase()} drawings\n`);
    git(repo, "add", "notes/a.txt");
    git(repo, "commit", "-q", "-m", "add notes");
    const added = git(repo, "rev-parse", "--short", "HEAD");
    await put(repo, "notes/a.txt", "line one\n");
    git(repo, "commit", "-q", "-am", "scrub notes");
    const r = run(repo, "", { BP_PREPUSH_TERMS_FILE: await termsFile(dir) });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`private terms[\\s\\S]*\\n\\s+${added}  notes/a\\.txt\\n`, "u"));
    assert.equal((r.stderr.match(/notes\/a\.txt/gu) ?? []).length, 1, "the scrubbing commit only removes lines and is not named");
    assert.ok(!r.stderr.toLowerCase().includes("privateclient"), "the term is never printed");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("terms: a term in a commit message or in a path is refused", async () => {
  const repo = await repoWith(IGNORE_OK);
  const dir = await mkdtemp(path.join(tmpdir(), "prepush-terms-"));
  try {
    await put(repo, "a.txt", "a\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", `parse the ${TERM} set`);
    const msg = git(repo, "rev-parse", "--short", "HEAD");
    await put(repo, "eval/another-term.json", "{}\n");
    git(repo, "add", "eval/another-term.json");
    git(repo, "commit", "-q", "-m", "fixture");
    const p = git(repo, "rev-parse", "--short", "HEAD");
    const r = run(repo, "", { BP_PREPUSH_TERMS_FILE: await termsFile(dir) });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`\\n\\s+${msg}  \\(commit message or identity\\)\\n`, "u"));
    assert.match(r.stderr, new RegExp(`\\n\\s+${p}  [^\\n]*eval/another-term\\.json`, "u"));
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("terms: a term only inside a binary blob is not scanned (documented limit, like grep -I)", async () => {
  const repo = await repoWith(IGNORE_OK);
  const dir = await mkdtemp(path.join(tmpdir(), "prepush-terms-"));
  try {
    await put(repo, "img.png", Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(TERM)]));
    git(repo, "add", "img.png");
    git(repo, "commit", "-q", "-m", "binary");
    const r = run(repo, "", { BP_PREPUSH_TERMS_FILE: await termsFile(dir) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no private term \(2 in the list\)/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("terms: a missing list is a WARN and passes; with BP_PREPUSH_REQUIRE_TERMS=1 it is fatal", async () => {
  const repo = await repoWith(IGNORE_OK);
  try {
    const warn = run(repo);
    assert.equal(warn.status, 0, warn.stderr);
    assert.match(warn.stderr, /WARN — no private-terms list at \/nonexistent\/forbidden-terms\.txt; check 9 skipped/u);
    assert.match(warn.stdout, /private-terms check skipped \(no list, WARN\)/u);
    const required = run(repo, "", { BP_PREPUSH_REQUIRE_TERMS: "1" });
    assert.equal(required.status, 1);
    assert.match(required.stderr, /BP_PREPUSH_REQUIRE_TERMS=1 but the private-terms list is missing/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("terms: the default list path is <toplevel>/../../gitignore/projects/github_publish/forbidden-terms.txt", async () => {
  const outer = await mkdtemp(path.join(tmpdir(), "prepush-layout-"));
  try {
    const repo = path.join(outer, "projects", "repo");
    await mkdir(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    await put(repo, ".gitignore", IGNORE_OK);
    await put(repo, "a.txt", `${TERM}\n`);
    git(repo, "add", ".gitignore", "a.txt");
    git(repo, "commit", "-q", "-m", "init");
    await put(outer, "gitignore/projects/github_publish/forbidden-terms.txt", `${TERM}\n`);
    const r = spawnSync("bash", [SCRIPT], { cwd: repo, input: "", encoding: "utf8", env: { ...process.env, BP_PREPUSH_TERMS_FILE: "", BP_PREPUSH_REQUIRE_TERMS: "" } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /private terms[\s\S]*a\.txt/u);
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

// ── --install: pre-push AND pre-commit; the pre-commit hook refuses a non-allowlisted identity ──

/** git without the fixture's core.hooksPath=/dev/null, so installed hooks run. */
const gitHooked = (repo, env, ...args) =>
  spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, ...ID, ...env } });

test("install: writes both hooks; pre-commit refuses a bad --author, -c user.email or committer, accepts the noreply identity", async () => {
  const repo = await repoWith(IGNORE_OK);
  try {
    await mkdir(path.join(repo, "scripts"), { recursive: true });
    await copyFile(SCRIPT, path.join(repo, "scripts/prepush-check.sh"));
    const inst = run(repo, "", {}, ["--install"]);
    assert.equal(inst.status, 0, inst.stderr);
    assert.match(inst.stdout, /installed .*pre-push and .*pre-commit/u);
    const again = run(repo, "", {}, ["--install"]);
    assert.equal(again.status, 0, "idempotent");
    assert.match(await readFile(path.join(repo, ".git/hooks/pre-commit"), "utf8"), /--pre-commit/u);

    await put(repo, "a.txt", "a\n");
    git(repo, "add", "a.txt");
    const byAuthor = gitHooked(repo, {}, "commit", "-q", "-m", "x", `--author=x <${BAD_MAIL}>`);
    assert.notEqual(byAuthor.status, 0);
    assert.match(byAuthor.stderr, /GIT_AUTHOR_IDENT e-mail is not allowlisted/u);
    assert.ok(!byAuthor.stderr.includes(BAD_MAIL));
    const byConfig = gitHooked(repo, { GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_EMAIL: "" }, "-c", `user.email=${BAD_MAIL}`, "commit", "-q", "-m", "x");
    assert.notEqual(byConfig.status, 0);
    const byCommitter = gitHooked(repo, { GIT_COMMITTER_EMAIL: BAD_MAIL }, "commit", "-q", "-m", "x");
    assert.notEqual(byCommitter.status, 0);
    assert.match(byCommitter.stderr, /GIT_COMMITTER_IDENT e-mail is not allowlisted/u);
    const good = gitHooked(repo, {}, "commit", "-q", "-m", "good");
    assert.equal(good.status, 0, good.stderr);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("install: refuses to overwrite a pre-commit hook it did not write", async () => {
  const repo = await repoWith(IGNORE_OK);
  try {
    await put(repo, ".git/hooks/pre-commit", "#!/bin/sh\necho theirs\n");
    const r = run(repo, "", {}, ["--install"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /pre-commit exists and is not ours/u);
    assert.equal(await readFile(path.join(repo, ".git/hooks/pre-commit"), "utf8"), "#!/bin/sh\necho theirs\n");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
