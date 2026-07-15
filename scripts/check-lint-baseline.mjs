#!/usr/bin/env node

/**
 * Blocking no-growth gate for accepted ordinary-lint debt.
 *
 * The baseline is exact by relative file, rule, severity, and count. A lint
 * finding may disappear or its count may fall, but it may not move to another
 * tuple or grow. Fatal ESLint results are never baselineable.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ESLint } from "eslint";

export const PROJECT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const BASELINE_PATH = resolve(
  PROJECT_ROOT,
  "scripts/lint-baseline.json",
);

const VALID_SEVERITIES = new Set(["error", "warning"]);

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function compareLintEntries(left, right) {
  return (
    compareStrings(left.file, right.file) ||
    compareStrings(left.rule ?? "", right.rule ?? "") ||
    compareStrings(left.severity, right.severity)
  );
}

function tupleKey(entry) {
  return JSON.stringify([entry.file, entry.rule, entry.severity]);
}

function tupleDescription(entry) {
  return `${entry.file} :: ${entry.rule ?? "<no rule>"} :: ${entry.severity}`;
}

function assertPortableRelativePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:\//.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a canonical portable relative path`);
  }
}

function validateEntry(entry, label) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${label} must be an object`);
  }
  assertPortableRelativePath(entry.file, `${label}.file`);
  if (
    entry.rule !== null &&
    (typeof entry.rule !== "string" || entry.rule.length === 0)
  ) {
    throw new Error(`${label}.rule must be a non-empty string or null`);
  }
  if (!VALID_SEVERITIES.has(entry.severity)) {
    throw new Error(`${label}.severity must be "error" or "warning"`);
  }
  if (!Number.isSafeInteger(entry.count) || entry.count <= 0) {
    throw new Error(`${label}.count must be a positive safe integer`);
  }
}

function validateSortedEntries(entries, label) {
  if (!Array.isArray(entries)) {
    throw new Error(`${label} must be an array`);
  }
  for (let index = 0; index < entries.length; index += 1) {
    validateEntry(entries[index], `${label}[${index}]`);
    if (
      index > 0 &&
      compareLintEntries(entries[index - 1], entries[index]) >= 0
    ) {
      throw new Error(
        `${label} must be strictly sorted and contain no duplicate tuples near index ${index}`,
      );
    }
  }
}

export function validateLintBaseline(baseline) {
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) {
    throw new Error("lint baseline must be an object");
  }
  if (baseline.schemaVersion !== 1) {
    throw new Error("lint baseline schemaVersion must be exactly 1");
  }
  validateSortedEntries(baseline.entries, "lint baseline entries");
  return baseline;
}

export function readLintBaseline(baselinePath = BASELINE_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read lint baseline ${baselinePath}: ${message}`);
  }
  return validateLintBaseline(parsed);
}

export function normalizeLintPath(projectRoot, filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error("ESLint returned an empty or non-string file path");
  }
  const absoluteRoot = resolve(projectRoot);
  const absoluteFile = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(absoluteRoot, filePath);
  const relativeFile = relative(absoluteRoot, absoluteFile);
  if (
    relativeFile.length === 0 ||
    relativeFile === ".." ||
    relativeFile.startsWith(`..${sep}`) ||
    isAbsolute(relativeFile)
  ) {
    throw new Error(`ESLint returned a path outside the project root: ${filePath}`);
  }
  const portablePath = relativeFile.split(sep).join("/");
  assertPortableRelativePath(portablePath, "normalized ESLint file path");
  return portablePath;
}

function severityName(severity) {
  if (severity === 2) return "error";
  if (severity === 1) return "warning";
  throw new Error(`ESLint returned unsupported severity ${String(severity)}`);
}

export function createLintSnapshot(results, projectRoot = PROJECT_ROOT) {
  if (!Array.isArray(results)) {
    throw new Error("ESLint did not return a results array");
  }

  const counts = new Map();
  let fatalCount = 0;
  for (const [resultIndex, result] of results.entries()) {
    if (!result || typeof result !== "object") {
      throw new Error(`ESLint result ${resultIndex} is not an object`);
    }
    const file = normalizeLintPath(projectRoot, result.filePath);
    if (!Array.isArray(result.messages)) {
      throw new Error(`ESLint result for ${file} has no messages array`);
    }
    for (const countName of [
      "errorCount",
      "warningCount",
      "fatalErrorCount",
    ]) {
      if (!Number.isSafeInteger(result[countName]) || result[countName] < 0) {
        throw new Error(`ESLint result for ${file} has invalid ${countName}`);
      }
    }

    const messageErrors = result.messages.filter(
      (message) => message?.severity === 2,
    ).length;
    const messageWarnings = result.messages.filter(
      (message) => message?.severity === 1,
    ).length;
    const messageFatal = result.messages.filter(
      (message) => message?.fatal === true,
    ).length;
    if (
      messageErrors !== result.errorCount ||
      messageWarnings !== result.warningCount ||
      messageFatal !== result.fatalErrorCount
    ) {
      throw new Error(`ESLint result counts disagree with messages for ${file}`);
    }
    fatalCount += result.fatalErrorCount;

    for (const [messageIndex, message] of result.messages.entries()) {
      if (!message || typeof message !== "object") {
        throw new Error(`ESLint message ${messageIndex} for ${file} is invalid`);
      }
      const severity = severityName(message.severity);
      if (
        message.ruleId !== null &&
        (typeof message.ruleId !== "string" || message.ruleId.length === 0)
      ) {
        throw new Error(
          `ESLint message ${messageIndex} for ${file} has an invalid ruleId`,
        );
      }
      if (message.fatal === true) continue;
      const entry = { file, rule: message.ruleId, severity, count: 1 };
      const key = tupleKey(entry);
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, entry);
      }
    }
  }

  return {
    fileCount: results.length,
    fatalCount,
    entries: [...counts.values()].sort(compareLintEntries),
  };
}

function validateLintSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("lint snapshot must be an object");
  }
  if (!Number.isSafeInteger(snapshot.fileCount) || snapshot.fileCount < 0) {
    throw new Error("lint snapshot fileCount must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(snapshot.fatalCount) || snapshot.fatalCount < 0) {
    throw new Error("lint snapshot fatalCount must be a non-negative safe integer");
  }
  validateSortedEntries(snapshot.entries, "lint snapshot entries");
  return snapshot;
}

export function compareLintBaseline(baseline, snapshot) {
  validateLintBaseline(baseline);
  validateLintSnapshot(snapshot);

  const allowed = new Map(
    baseline.entries.map((entry) => [tupleKey(entry), entry]),
  );
  const observed = new Map(
    snapshot.entries.map((entry) => [tupleKey(entry), entry]),
  );
  const violations = [];
  const improvements = [];

  if (snapshot.fatalCount > 0) {
    violations.push(
      `${snapshot.fatalCount} fatal ESLint error${snapshot.fatalCount === 1 ? "" : "s"} observed`,
    );
  }

  for (const entry of snapshot.entries) {
    const baselineEntry = allowed.get(tupleKey(entry));
    if (!baselineEntry) {
      violations.push(
        `new tuple ${tupleDescription(entry)} has count ${entry.count}`,
      );
    } else if (entry.count > baselineEntry.count) {
      violations.push(
        `${tupleDescription(entry)} grew from ${baselineEntry.count} to ${entry.count}`,
      );
    }
  }

  for (const entry of baseline.entries) {
    const currentCount = observed.get(tupleKey(entry))?.count ?? 0;
    if (currentCount < entry.count) {
      improvements.push(
        `${tupleDescription(entry)} fell from ${entry.count} to ${currentCount}`,
      );
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    improvements,
  };
}

function severityTotal(entries, severity) {
  return entries
    .filter((entry) => entry.severity === severity)
    .reduce((total, entry) => total + entry.count, 0);
}

export async function runLintBaseline({
  projectRoot = PROJECT_ROOT,
  baselinePath = BASELINE_PATH,
  ESLintClass = ESLint,
} = {}) {
  const baseline = readLintBaseline(baselinePath);
  const results = await new ESLintClass({ cwd: projectRoot }).lintFiles(["."]);
  const snapshot = createLintSnapshot(results, projectRoot);
  const comparison = compareLintBaseline(baseline, snapshot);

  if (!comparison.ok) {
    console.error(
      `Lint baseline FAILED (${snapshot.fileCount} files; ${snapshot.fatalCount} fatal):\n` +
        comparison.violations.map((violation) => `- ${violation}`).join("\n"),
    );
    return 1;
  }

  const errorCount = severityTotal(snapshot.entries, "error");
  const warningCount = severityTotal(snapshot.entries, "warning");
  console.log(
    `Lint baseline OK: ${errorCount} errors; ${warningCount} warnings; ` +
      `${snapshot.entries.length} tuples across ${snapshot.fileCount} files; 0 fatal.`,
  );
  if (comparison.improvements.length > 0) {
    console.log(
      `Baseline improvement available for ${comparison.improvements.length} tuple(s); ` +
        "lower or remove their checked-in entries.",
    );
  }
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    process.exitCode = await runLintBaseline();
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(`Lint baseline FAILED before comparison:\n${message}`);
    process.exitCode = 1;
  }
}
