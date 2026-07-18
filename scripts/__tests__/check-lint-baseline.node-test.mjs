import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  PROJECT_ROOT,
  compareLintBaseline,
  compareLintEntries,
  createLintSnapshot,
  normalizeLintPath,
  readLintBaseline,
  validateLintBaseline,
} from "../check-lint-baseline.mjs";

const baseline = readLintBaseline();

function clonedEntries() {
  return baseline.entries.map((entry) => ({ ...entry }));
}

function snapshot(entries, fatalCount = 0) {
  return {
    fileCount: 1,
    fatalCount,
    entries: entries
      .filter((entry) => entry.count > 0)
      .sort(compareLintEntries),
  };
}

test("the checked-in baseline is exact, canonical, and complete", () => {
  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.entries.length, 50);
  assert.equal(
    baseline.entries
      .filter((entry) => entry.severity === "error")
      .reduce((total, entry) => total + entry.count, 0),
    60,
  );
  assert.equal(
    baseline.entries
      .filter((entry) => entry.severity === "warning")
      .reduce((total, entry) => total + entry.count, 0),
    53,
  );
});

test("a new tuple is rejected even when the aggregate count is unchanged", () => {
  const entries = clonedEntries();
  const donor = entries.find(
    (entry) => entry.severity === "warning" && entry.count > 1,
  );
  assert.ok(donor);
  donor.count -= 1;
  entries.push({
    file: "src/new-location.ts",
    rule: donor.rule,
    severity: donor.severity,
    count: 1,
  });

  const comparison = compareLintBaseline(baseline, snapshot(entries));
  assert.equal(comparison.ok, false);
  assert.match(comparison.violations.join("\n"), /new tuple src\/new-location\.ts/);
  assert.doesNotMatch(comparison.violations.join("\n"), /grew from/);
});

test("tuple growth is rejected even when another tuple shrinks by the same count", () => {
  const entries = clonedEntries();
  const growing = entries.find(
    (entry) => entry.severity === "warning" && entry.count > 1,
  );
  const shrinking = entries.find(
    (entry) =>
      entry !== growing && entry.severity === growing?.severity && entry.count > 1,
  );
  assert.ok(growing);
  assert.ok(shrinking);
  growing.count += 1;
  shrinking.count -= 1;

  const comparison = compareLintBaseline(baseline, snapshot(entries));
  assert.equal(comparison.ok, false);
  assert.match(comparison.violations.join("\n"), /grew from/);
  assert.equal(comparison.violations.length, 1);
});

test("count reductions and complete tuple removals are allowed", () => {
  const entries = clonedEntries();
  const reduced = entries.find((entry) => entry.count > 1);
  const removed = entries.find((entry) => entry !== reduced && entry.count === 1);
  assert.ok(reduced);
  assert.ok(removed);
  reduced.count -= 1;
  removed.count = 0;

  const comparison = compareLintBaseline(baseline, snapshot(entries));
  assert.equal(comparison.ok, true);
  assert.deepEqual(comparison.violations, []);
  assert.equal(comparison.improvements.length, 2);
});

test("fatal ESLint results fail closed and cannot become baseline debt", () => {
  const fatalSnapshot = createLintSnapshot(
    [
      {
        filePath: join(PROJECT_ROOT, "src", "fatal-fixture.ts"),
        errorCount: 1,
        warningCount: 0,
        fatalErrorCount: 1,
        messages: [
          {
            ruleId: null,
            severity: 2,
            fatal: true,
          },
        ],
      },
    ],
    PROJECT_ROOT,
  );
  const comparison = compareLintBaseline(baseline, fatalSnapshot);
  assert.equal(comparison.ok, false);
  assert.match(comparison.violations.join("\n"), /1 fatal ESLint error observed/);
});

test("result paths are deterministic, project-relative, and containment-checked", () => {
  assert.equal(
    normalizeLintPath(
      PROJECT_ROOT,
      join(PROJECT_ROOT, "src", "nested", "fixture.ts"),
    ),
    "src/nested/fixture.ts",
  );
  assert.equal(
    normalizeLintPath(PROJECT_ROOT, "src/nested/fixture.ts"),
    "src/nested/fixture.ts",
  );
  assert.throws(
    () => normalizeLintPath(PROJECT_ROOT, join(PROJECT_ROOT, "..", "escape.ts")),
    /outside the project root/,
  );
});

test("malformed or duplicate checked-in tuples fail closed", () => {
  const duplicate = { ...baseline.entries[0] };
  assert.throws(
    () =>
      validateLintBaseline({
        schemaVersion: 1,
        entries: [duplicate, { ...duplicate }],
      }),
    /strictly sorted and contain no duplicate tuples/,
  );
  assert.throws(
    () =>
      validateLintBaseline({
        schemaVersion: 1,
        entries: [
          {
            file: "../outside.ts",
            rule: "fixture/rule",
            severity: "error",
            count: 1,
          },
        ],
      }),
    /canonical portable relative path/,
  );
});
