#!/usr/bin/env node

/**
 * Freeze-first L5 project security policy checker.
 *
 * This parses TypeScript syntax for application policy and a stable SQL trigger inventory for the
 * database backstop. It validates the checked-in manifest, follows same-file helper calls,
 * classifies project-owned Drizzle/raw-SQL writes, and enforces explicit semantic markers for the
 * policies whose runtime behavior is frozen by the focused route/component tests.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import ts from "typescript";
import {
  CANONICAL_DEMO_WRITE_ERROR,
  DEMO_WRITE_TRIGGER_INVENTORY,
  DEMO_WRITE_TRIGGER_MIGRATION,
  DURABLE_MUTATION_DOMAINS,
  EDGE_CLIENT_IP_POLICY,
  EXPLICIT_NON_PUBLIC_DEMO_SURFACES,
  INTERNAL_MUTATION_SINKS,
  LABEL_STUDIO_PROVIDER_PATHS,
  LABEL_STUDIO_PROVIDER_TASKS,
  LIFECYCLE_EXCEPTIONS,
  MUTATION_SURFACES,
  DEMO_RESOLVER_SHARED_DEPENDENCIES,
  PROJECT_FK_TABLE_EXEMPTIONS,
  PROJECT_OWNED_TABLES,
  PROVIDER_JOB_STATUS_AUTHORITIES,
  PUBLIC_DEMO_SHARED_DEPENDENCIES,
  PUBLIC_DEMO_SURFACES,
  TOMBSTONED_HTTP_SURFACES,
} from "./project-security-policy-manifest.mjs";
import { hasCanonicalProjectAssetFinalization } from "./project-asset-delivery-policy-ast.mjs";

const ROOT = process.cwd();
const violations = [];
const sourceCache = new Map();
const MUTATION_POLICIES = new Set([
  "batch-non-demo",
  "batch-tenant-non-demo",
  "demo-aware-lifecycle",
  "demo-read-only",
  "indirect-session-guard",
  "inline-demo-denial",
  "lifecycle-exception",
  "new-private-project",
  "shared-guard",
]);
const INTERNAL_SINK_POLICIES = new Set([
  "atomic-or-no-persist",
  "atomic-project-storage-write",
  "atomic-project-write",
  "atomic-tool-write",
  "leased-reclaimable-session-retirement",
  "parent-locked-project-intent",
  "project-write-transaction-helper",
]);
const ATOMIC_WRITE_CALLS = new Set([
  "withProjectStorageWrite",
  "withProjectStorageWritesInTransaction",
  "withProjectWrite",
  "withProjectWrites",
  "withProjectWritesInTransaction",
]);
const LABEL_STUDIO_GRANT_TRANSACTION_HELPERS = new Set([
  "activateLabelStudioAssetGrants",
  "deleteIntentLabelStudioAssetGrants",
  "deleteSessionLabelStudioAssetGrants",
  "revokeIntentLabelStudioAssetGrants",
  "revokeSessionLabelStudioAssetGrants",
]);
const PUBLIC_POLICIES = new Set([
  "anonymous-bearer-asset",
  "owner-threat-model-debt",
  "public-asset",
  "requires-auth",
  "requires-empty-or-redaction",
  "requires-private-canary-exclusion",
  "requires-public-input-filter",
  "requires-redaction",
  "requires-zero-persistence",
  "strict-public-shape",
]);

function report(code, message, file, node) {
  let location = file ?? "scripts/project-security-policy-manifest.mjs";
  if (file && node) {
    const source = sourceCache.get(file)?.source;
    if (source) {
      const { line, character } = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      );
      location += `:${line + 1}:${character + 1}`;
    }
  }
  violations.push({ code, message, location });
}

async function walk(dir) {
  const entries = await readdir(path.join(ROOT, dir), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      files.push(...(await walk(relative)));
    } else if (
      /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(entry.name) &&
      !/\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/u.test(entry.name) &&
      !/\.d\.(?:[cm]?ts|tsx)$/u.test(entry.name)
    ) {
      files.push(relative);
    }
  }
  return files;
}

function braceBlocks(text, keyword) {
  const blocks = [];
  const matcher = new RegExp(`\\b${keyword}\\s*\\{`, "gu");
  for (const match of text.matchAll(matcher)) {
    const start = match.index;
    const open = text.indexOf("{", start);
    let depth = 0;
    for (let index = open; index < text.length; index += 1) {
      if (text[index] === "{") depth += 1;
      else if (text[index] === "}") depth -= 1;
      if (depth === 0) {
        blocks.push(text.slice(start, index + 1));
        break;
      }
    }
  }
  return blocks;
}

function terraformResourceBlock(text, type, name) {
  const signature = `resource "${type}" "${name}"`;
  const start = text.indexOf(signature);
  if (start < 0) return null;
  const open = text.indexOf("{", start + signature.length);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }
  return null;
}

function terraformVariableBlock(text, name) {
  const signature = `variable "${name}"`;
  const start = text.indexOf(signature);
  if (start < 0) return null;
  const open = text.indexOf("{", start + signature.length);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }
  return null;
}

function textHasAll(text, markers) {
  return Boolean(text && markers.every((marker) => text.includes(marker)));
}

function terraformCodeMask(text) {
  const mask = [...text];
  let index = 0;
  const blank = (start, end) => {
    for (let cursor = start; cursor < end; cursor += 1) {
      if (mask[cursor] !== "\n" && mask[cursor] !== "\r") mask[cursor] = " ";
    }
  };

  while (index < text.length) {
    if (text[index] === "#" || text.startsWith("//", index)) {
      const end = text.indexOf("\n", index);
      const limit = end < 0 ? text.length : end;
      blank(index, limit);
      index = limit;
      continue;
    }
    if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      const limit = end < 0 ? text.length : end + 2;
      blank(index, limit);
      index = limit;
      continue;
    }
    if (text[index] === '"') {
      const start = index;
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\" && index + 1 < text.length) index += 2;
        else if (text[index] === '"') {
          index += 1;
          break;
        } else index += 1;
      }
      blank(start, index);
      continue;
    }
    index += 1;
  }
  return mask.join("");
}

function terraformListAttributeReferences(block, attribute) {
  if (!block) return null;
  const code = terraformCodeMask(block);
  const matches = [
    ...code.matchAll(new RegExp(`\\b${attribute}\\s*=\\s*\\[`, "gu")),
  ];
  if (matches.length !== 1) return null;
  const open = code.indexOf("[", matches[0].index);
  let depth = 0;
  let close = -1;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === "[") depth += 1;
    else if (code[index] === "]") depth -= 1;
    if (depth === 0) {
      close = index;
      break;
    }
  }
  if (open < 0 || close < 0) return null;
  return new Set(
    [
      ...code
        .slice(open + 1, close)
        .matchAll(/\b[A-Za-z_]\w*\.[A-Za-z_]\w*\b/gu),
    ].map((match) => match[0]),
  );
}

const PROJECT_ASSET_SCHEDULER_DEPENDENCIES = [
  "aws_s3_bucket_notification.beaver_data_eventbridge",
  "terraform_data.beaver_writer_operational_tuple",
];

function projectAssetSchedulerDependencyIssues(terraformText) {
  const issues = new Set();
  const scheduler = terraformResourceBlock(
    terraformText,
    "aws_scheduler_schedule",
    "beaver_project_asset_deletions",
  );
  const dependencies = terraformListAttributeReferences(
    scheduler,
    "depends_on",
  );
  if (
    !dependencies ||
    PROJECT_ASSET_SCHEDULER_DEPENDENCIES.some(
      (dependency) => !dependencies.has(dependency),
    )
  ) {
    issues.add("scheduler-eventbridge-and-writer-tuple-dependencies");
  }
  return issues;
}

function retiredHardeningTombstoneIssues(source) {
  const issues = new Set();
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const commands = [];
  let inMessage = false;
  let messageCount = 0;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (inMessage) {
      if (line === "MESSAGE") inMessage = false;
      continue;
    }
    if (!line || line.startsWith("#")) continue;
    commands.push(line);
    if (line === "cat >&2 <<'MESSAGE'") {
      inMessage = true;
      messageCount += 1;
    }
  }
  const expectedCommands = [
    "set -euo pipefail",
    "cat >&2 <<'MESSAGE'",
    "exit 64",
  ];
  if (
    lines[0] !== "#!/usr/bin/env bash" ||
    inMessage ||
    messageCount !== 1 ||
    commands.length !== expectedCommands.length ||
    commands.some((command, index) => command !== expectedCommands[index]) ||
    !textHasAll(source, [
      "RETIRED SECURITY BOUNDARY",
      "deliberately side-effect-free",
      "No AWS command has been run",
      "owner may apply Terraform or make AWS changes",
    ])
  ) {
    issues.add("exact-side-effect-free-exit-64-tombstone");
  }
  return issues;
}

function delimitedTextBlock(text, signature, terminator) {
  const start = text.indexOf(signature);
  if (start < 0) return null;
  const end = text.indexOf(terminator, start + signature.length);
  return end < 0 ? null : text.slice(start, end + terminator.length);
}

async function parsed(file) {
  if (sourceCache.has(file)) return sourceCache.get(file);
  const text = await readFile(path.join(ROOT, file), "utf8");
  const value = parseText(file, text);
  sourceCache.set(file, value);
  return value;
}

function parseText(file, text) {
  const kind = file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : file.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : /\.(?:cjs|mjs|js)$/u.test(file)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const functions = new Map();

  function visit(node) {
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name
    ) {
      functions.set(node.name.getText(source), node);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = unwrapExpression(node.initializer);
      if (
        initializer &&
        (ts.isArrowFunction(initializer) ||
          ts.isFunctionExpression(initializer))
      ) {
        functions.set(node.name.text, initializer);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { text, source, functions };
}

function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function descendants(node, predicate) {
  const found = [];
  function visit(child) {
    if (predicate(child)) found.push(child);
    ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}

function propertyName(node) {
  const value = unwrapExpression(node);
  if (!value) return null;
  if (ts.isIdentifier(value)) return value.text;
  if (ts.isPropertyAccessExpression(value)) return value.name.text;
  if (ts.isElementAccessExpression(value)) {
    const arg = unwrapExpression(value.argumentExpression);
    return arg && (ts.isStringLiteral(arg) || ts.isNumericLiteral(arg))
      ? arg.text
      : null;
  }
  return null;
}

function exactPropertyPath(node, parts) {
  let current = unwrapExpression(node);
  const names = [];
  while (current && ts.isPropertyAccessExpression(current)) {
    names.unshift(current.name.text);
    current = unwrapExpression(current.expression);
  }
  if (!current || !ts.isIdentifier(current)) return false;
  names.unshift(current.text);
  return JSON.stringify(names) === JSON.stringify(parts);
}

function hasEqPropertyPaths(node, leftParts, rightParts) {
  return descendants(node, ts.isCallExpression).some(
    (call) =>
      callName(call) === "eq" &&
      call.arguments.length === 2 &&
      ((exactPropertyPath(call.arguments[0], leftParts) &&
        exactPropertyPath(call.arguments[1], rightParts)) ||
        (exactPropertyPath(call.arguments[0], rightParts) &&
          exactPropertyPath(call.arguments[1], leftParts))),
  );
}

function hasEqPropertyLiteral(node, propertyParts, expected) {
  return descendants(node, ts.isCallExpression).some((call) => {
    if (callName(call) !== "eq" || call.arguments.length !== 2) return false;
    return (
      (exactPropertyPath(call.arguments[0], propertyParts) &&
        literalValue(call.arguments[1]) === expected) ||
      (exactPropertyPath(call.arguments[1], propertyParts) &&
        literalValue(call.arguments[0]) === expected)
    );
  });
}

function callName(node) {
  return ts.isCallExpression(node) ? propertyName(node.expression) : null;
}

function hasIdentifier(node, names) {
  const wanted = new Set(names);
  return (
    descendants(
      node,
      (child) => ts.isIdentifier(child) && wanted.has(child.text),
    ).length > 0
  );
}

function hasAllIdentifiers(node, names) {
  return names.every((name) => hasIdentifier(node, [name]));
}

function hasStringLiteral(node, values) {
  const wanted = new Set(values);
  return (
    descendants(
      node,
      (child) => ts.isStringLiteralLike(child) && wanted.has(child.text),
    ).length > 0
  );
}

function hasAllStringLiterals(node, values) {
  return values.every((value) => hasStringLiteral(node, [value]));
}

function hasTextStarting(node, prefix) {
  return descendants(
    node,
    (child) => ts.isStringLiteralLike(child) || ts.isTemplateExpression(child),
  ).some((literal) => templateStartsWith(literal, prefix));
}

function hasPropertyAccess(node, objectName, property) {
  return (
    descendants(node, (child) => {
      if (!ts.isPropertyAccessExpression(child) || child.name.text !== property)
        return false;
      const expression = unwrapExpression(child.expression);
      return (
        !!expression &&
        ts.isIdentifier(expression) &&
        expression.text === objectName
      );
    }).length > 0
  );
}

function directCalls(node) {
  return descendants(node, ts.isCallExpression).map((call) => ({
    call,
    name: callName(call),
  }));
}

function sourceFileForModule(currentFile, moduleName) {
  let candidate;
  if (moduleName.startsWith("@/")) {
    candidate = `src/${moduleName.slice(2)}`;
  } else if (moduleName.startsWith(".")) {
    candidate = path.posix.normalize(
      path.posix.join(path.posix.dirname(currentFile), moduleName),
    );
  } else {
    return null;
  }
  return /\.[cm]?[jt]sx?$/u.test(candidate) ? candidate : `${candidate}.ts`;
}

function importedBindings(parsedFile) {
  const bindings = new Map();
  for (const declaration of descendants(
    parsedFile.source,
    ts.isImportDeclaration,
  )) {
    if (!ts.isStringLiteralLike(declaration.moduleSpecifier)) continue;
    const sourceFile = sourceFileForModule(
      parsedFile.source.fileName,
      declaration.moduleSpecifier.text,
    );
    const namedBindings = declaration.importClause?.namedBindings;
    if (!sourceFile || !namedBindings || !ts.isNamedImports(namedBindings))
      continue;
    for (const specifier of namedBindings.elements) {
      bindings.set(specifier.name.text, {
        sourceFile,
        symbol: specifier.propertyName?.text ?? specifier.name.text,
      });
    }
  }
  return bindings;
}

function importedCallsTransitively(
  parsedFile,
  start,
  seenFunctions = new Set(),
) {
  const found = [];
  const bindings = importedBindings(parsedFile);
  for (const { name, call } of directCalls(start)) {
    if (!name) continue;
    const binding = bindings.get(name);
    if (binding) found.push({ ...binding, local: name, call });
    const local = parsedFile.functions.get(name);
    if (local && !seenFunctions.has(local)) {
      seenFunctions.add(local);
      found.push(
        ...importedCallsTransitively(parsedFile, local, seenFunctions),
      );
    }
  }
  return found;
}

function namedImportLocals(parsedFile, moduleName, importedName) {
  const locals = new Set();
  for (const declaration of descendants(
    parsedFile.source,
    ts.isImportDeclaration,
  )) {
    if (
      !ts.isStringLiteralLike(declaration.moduleSpecifier) ||
      declaration.moduleSpecifier.text !== moduleName
    )
      continue;
    const namedBindings = declaration.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
    for (const specifier of namedBindings.elements) {
      if (
        (specifier.propertyName?.text ?? specifier.name.text) === importedName
      ) {
        locals.add(specifier.name.text);
      }
    }
  }
  return locals;
}

function delegatesToReviewedInternalSink(
  parsedFile,
  target,
  policies = new Set(["atomic-project-storage-write", "atomic-project-write"]),
) {
  const bindings = importedBindings(parsedFile);
  const reviewed = new Set(
    INTERNAL_MUTATION_SINKS.filter(([, , sinkPolicy]) =>
      policies.has(sinkPolicy),
    ).map(([file, symbol]) => `${file}:${symbol}`),
  );
  return directCalls(target).some(({ name }) => {
    const binding = name ? bindings.get(name) : null;
    return binding && reviewed.has(`${binding.sourceFile}:${binding.symbol}`);
  });
}

function functionTransitivelyMatches(
  parsedFile,
  start,
  matcher,
  seen = new Set(),
) {
  if (!start || seen.has(start)) return false;
  seen.add(start);
  if (matcher(start)) return true;
  for (const { name } of directCalls(start)) {
    const local = name ? parsedFile.functions.get(name) : null;
    if (local && functionTransitivelyMatches(parsedFile, local, matcher, seen))
      return true;
  }
  return false;
}

function hasCall(node, names) {
  const wanted = new Set(names);
  return directCalls(node).some(({ name }) => name && wanted.has(name));
}

function hasAllCalls(node, names) {
  return names.every((name) => hasCall(node, [name]));
}

function nodeContains(container, child) {
  return (
    container.getStart() <= child.getStart() &&
    container.getEnd() >= child.getEnd()
  );
}

function nearestNamedFunction(parsedFile, node) {
  let current = node.parent;
  while (current && current !== parsedFile.source) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) {
      for (const [name, fn] of parsedFile.functions) {
        if (fn === current) return { name, node: current };
      }
      return { name: "<anonymous>", node: current };
    }
    current = current.parent;
  }
  return { name: "<module>", node: parsedFile.source };
}

function rootReceiverIdentifier(call) {
  if (!ts.isCallExpression(call)) return null;
  let expression = unwrapExpression(call.expression);
  if (!expression || !ts.isPropertyAccessExpression(expression)) return null;
  expression = unwrapExpression(expression.expression);
  while (
    expression &&
    (ts.isPropertyAccessExpression(expression) ||
      ts.isElementAccessExpression(expression))
  ) {
    expression = unwrapExpression(expression.expression);
  }
  return expression && ts.isIdentifier(expression) ? expression.text : null;
}

function callbackTransactionIdentifier(callback, parsedFile) {
  const value = unwrapExpression(callback);
  let fn = value;
  if (value && ts.isIdentifier(value))
    fn = parsedFile.functions.get(value.text);
  if (
    !fn ||
    !(
      ts.isFunctionDeclaration(fn) ||
      ts.isFunctionExpression(fn) ||
      ts.isArrowFunction(fn) ||
      ts.isMethodDeclaration(fn)
    )
  ) {
    return null;
  }
  const first = fn.parameters[0]?.name;
  return first && ts.isIdentifier(first) ? first.text : null;
}

function wrapperCallback(call) {
  const name = callName(call);
  if (name === "withProjectWrite") return call.arguments[2] ?? null;
  if (name === "withProjectWrites") return call.arguments[1] ?? null;
  if (name === "withProjectStorageWrite") return call.arguments[3] ?? null;
  if (name === "withProjectWritesInTransaction")
    return call.arguments[2] ?? null;
  if (name === "withProjectStorageWritesInTransaction")
    return call.arguments[3] ?? null;
  return null;
}

function mutationReceiver(sink) {
  if (ts.isCallExpression(sink.node)) return rootReceiverIdentifier(sink.node);
  let current = sink.node.parent;
  while (current) {
    if (ts.isCallExpression(current) && nodeContains(current, sink.node)) {
      const name = callName(current);
      if (name === "execute" || name === "query")
        return rootReceiverIdentifier(current);
    }
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    )
      break;
    current = current.parent;
  }
  return null;
}

/**
 * Prove that this concrete sink is inside an atomic callback and uses that callback's transaction
 * handle. A function merely calling withProjectWrite elsewhere is intentionally insufficient.
 */
function atomicBoundaryForSink(parsedFile, sink, seenHelpers = new Set()) {
  const sinkReceiver = sink.receiver ?? mutationReceiver(sink);
  let current = sink.node.parent;
  while (current && current !== parsedFile.source) {
    if (
      ts.isCallExpression(current) &&
      ATOMIC_WRITE_CALLS.has(callName(current))
    ) {
      const callback = wrapperCallback(current);
      if (
        callback &&
        nodeContains(unwrapExpression(callback) ?? callback, sink.node)
      ) {
        return {
          call: current,
          transaction: callbackTransactionIdentifier(callback, parsedFile),
          receiver: sinkReceiver,
        };
      }
    }
    current = current.parent;
  }

  // Named callbacks are commonly declared once and passed to withProjectWrites (bulk cleanup).
  const owner = nearestNamedFunction(parsedFile, sink.node);
  if (owner.name !== "<anonymous>" && owner.name !== "<module>") {
    for (const call of descendants(parsedFile.source, ts.isCallExpression)) {
      if (!ATOMIC_WRITE_CALLS.has(callName(call))) continue;
      const callback = unwrapExpression(wrapperCallback(call));
      if (
        !callback ||
        !ts.isIdentifier(callback) ||
        callback.text !== owner.name
      )
        continue;
      return {
        call,
        transaction: callbackTransactionIdentifier(callback, parsedFile),
        receiver: sinkReceiver,
      };
    }

    // A reviewed transaction helper may contain the concrete sinks and be called from an atomic
    // callback. Follow only an exact first-parameter/first-argument transaction handoff; merely
    // calling the helper somewhere beneath a boundary cannot bless a global-db sink.
    const helperTransaction = callbackTransactionIdentifier(
      owner.node,
      parsedFile,
    );
    if (
      helperTransaction &&
      sinkReceiver === helperTransaction &&
      !seenHelpers.has(owner.node)
    ) {
      const nextSeen = new Set(seenHelpers);
      nextSeen.add(owner.node);
      for (const call of descendants(parsedFile.source, ts.isCallExpression)) {
        if (callName(call) !== owner.name || call === sink.node) continue;
        const transactionArgument = unwrapExpression(call.arguments[0]);
        if (!transactionArgument || !ts.isIdentifier(transactionArgument))
          continue;
        const upstream = atomicBoundaryForSink(
          parsedFile,
          { node: call, receiver: transactionArgument.text },
          nextSeen,
        );
        if (
          upstream &&
          upstream.transaction === transactionArgument.text &&
          upstream.receiver === transactionArgument.text
        ) {
          return {
            call: upstream.call,
            transaction: helperTransaction,
            receiver: sinkReceiver,
          };
        }
      }
    }
  }
  return null;
}

function atomicSinkViolation(parsedFile, sink) {
  const boundary = atomicBoundaryForSink(parsedFile, sink);
  if (!boundary) return "PROJECT_WRITE_NOT_ATOMIC";
  if (!boundary.transaction || boundary.receiver !== boundary.transaction) {
    return "PROJECT_WRITE_BYPASSES_TRANSACTION";
  }
  return null;
}

function hasAtomicWriteBoundary(node) {
  return hasCall(node, [...ATOMIC_WRITE_CALLS]);
}

function binaryComparesIdentifierToNull(node, identifier) {
  return descendants(node, ts.isBinaryExpression).some((binary) => {
    if (
      binary.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
      binary.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken
    )
      return false;
    const left = unwrapExpression(binary.left);
    const right = unwrapExpression(binary.right);
    return (
      (ts.isIdentifier(left) &&
        left.text === identifier &&
        right.kind === ts.SyntaxKind.NullKeyword) ||
      (left.kind === ts.SyntaxKind.NullKeyword &&
        ts.isIdentifier(right) &&
        right.text === identifier)
    );
  });
}

/** chat_messages.project_id is nullable for the intentionally global chat stream. */
function isProvablyNullProjectChatInsert(sink) {
  if (sink.table !== "chatMessages" || sink.kind !== "insert") return false;
  let current = sink.node.parent;
  while (current) {
    if (
      ts.isIfStatement(current) &&
      nodeContains(current.thenStatement, sink.node)
    ) {
      if (binaryComparesIdentifierToNull(current.expression, "projectId"))
        return true;
    }
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    )
      break;
    current = current.parent;
  }
  return false;
}

function objectPropertyNames(expression) {
  const value = unwrapExpression(expression);
  if (!value) return [];
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.flatMap((property) => {
      if (
        !ts.isPropertyAssignment(property) &&
        !ts.isShorthandPropertyAssignment(property)
      )
        return ["*"];
      return [propertyName(property.name) ?? "*"];
    });
  }
  if (ts.isConditionalExpression(value)) {
    return [
      ...objectPropertyNames(value.whenTrue),
      ...objectPropertyNames(value.whenFalse),
    ];
  }
  return ["*"];
}

function setColumnsForUpdateSink(sink) {
  let current = sink.node.parent;
  while (current) {
    if (
      ts.isCallExpression(current) &&
      callName(current) === "set" &&
      current.arguments[0]
    ) {
      return objectPropertyNames(current.arguments[0]);
    }
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    )
      break;
    current = current.parent;
  }
  return [];
}

function hasDbClockAssignment(
  node,
  fieldName,
  { requireInterval = false } = {},
) {
  return descendants(node, ts.isPropertyAssignment).some((assignment) => {
    if (propertyName(assignment.name) !== fieldName) return false;
    const value = unwrapExpression(assignment.initializer);
    if (
      !value ||
      !ts.isTaggedTemplateExpression(value) ||
      propertyName(value.tag) !== "sql"
    )
      return false;
    const tokens = new Set(stringTokens(taggedSqlText(value) ?? ""));
    return (
      tokens.has("current_timestamp") &&
      (!requireInterval || tokens.has("interval"))
    );
  });
}

function hasAppClockAssignment(node, fieldName) {
  return descendants(node, ts.isPropertyAssignment).some((assignment) => {
    if (propertyName(assignment.name) !== fieldName) return false;
    return (
      descendants(
        assignment.initializer,
        (child) =>
          (ts.isNewExpression(child) &&
            propertyName(child.expression) === "Date") ||
          (ts.isCallExpression(child) &&
            callName(child) === "now" &&
            rootReceiverIdentifier(child) === "Date"),
      ).length > 0
    );
  });
}

function activeLeaseWhereCalls(node) {
  return descendants(node, ts.isCallExpression).filter(
    (call) =>
      callName(call) === "where" &&
      call.arguments[0] &&
      hasAllIdentifiers(call.arguments[0], [
        "projectMutationLeases",
        "status",
      ]) &&
      hasStringLiteral(call.arguments[0], ["active"]),
  );
}

function hasFailClosedActiveLeasePredicate(node) {
  const predicates = activeLeaseWhereCalls(node);
  return (
    predicates.length > 0 &&
    predicates.every(
      (call) =>
        !hasIdentifier(call.arguments[0], ["expiresAt"]) &&
        !hasCall(call.arguments[0], ["gt", "gte", "lt", "lte"]),
    )
  );
}

function usesExpiryBasedLeaseRetirement(node) {
  return activeLeaseWhereCalls(node).some(
    (call) =>
      hasIdentifier(call.arguments[0], ["expiresAt"]) ||
      hasCall(call.arguments[0], ["gt", "gte", "lt", "lte"]),
  );
}

function hasSafeLeaseReleaseFinally(node) {
  return descendants(node, ts.isTryStatement).some((outerTry) => {
    if (!outerTry.finallyBlock) return false;
    const releaseTry = descendants(
      outerTry.finallyBlock,
      ts.isTryStatement,
    ).find((candidate) =>
      hasCall(candidate.tryBlock, ["releaseProjectMutationLease"]),
    );
    const catchBlock = releaseTry?.catchClause?.block;
    if (!catchBlock) return false;
    const throwsReleaseFailure = descendants(
      catchBlock,
      ts.isThrowStatement,
    ).some((statement) => {
      const expression = unwrapExpression(statement.expression);
      return (
        expression &&
        ts.isIdentifier(expression) &&
        expression.text === "releaseError"
      );
    });
    const logsReleaseFailure = descendants(
      catchBlock,
      ts.isCallExpression,
    ).some(
      (call) =>
        callName(call) === "error" &&
        rootReceiverIdentifier(call) === "logger" &&
        hasStringLiteral(call, ["Project mutation lease release failed:"]),
    );
    return (
      throwsReleaseFailure &&
      logsReleaseFailure &&
      hasAllIdentifiers(catchBlock, [
        "releaseError",
        "operationError",
        "removedByProjectDelete",
        "remainingProject",
        "projects",
      ]) &&
      hasStringLiteral(catchBlock, ["project-delete"]) &&
      hasCall(catchBlock, ["select"])
    );
  });
}

function hasRetryingObservableHeartbeat(node) {
  const logsHeartbeatFailure = descendants(node, ts.isCallExpression).some(
    (call) =>
      callName(call) === "error" &&
      rootReceiverIdentifier(call) === "logger" &&
      hasStringLiteral(call, ["Project mutation lease heartbeat failed:"]),
  );
  const retryFinally = descendants(node, ts.isCallExpression).some(
    (call) =>
      callName(call) === "finally" &&
      hasAllIdentifiers(call, ["stopped", "scheduleHeartbeat"]) &&
      hasCall(call, ["scheduleHeartbeat"]),
  );
  return logsHeartbeatFailure && retryFinally;
}

function publicationFenceSqlNodes(node) {
  return descendants(node, ts.isTaggedTemplateExpression).filter((tagged) => {
    if (propertyName(tagged.tag) !== "sql") return false;
    const tokens = new Set(stringTokens(taggedSqlText(tagged) ?? ""));
    const createdAtReferences = descendants(
      tagged,
      (child) => ts.isIdentifier(child) && child.text === "createdAt",
    ).length;
    return (
      hasAllIdentifiers(tagged, [
        "projects",
        "createdAt",
        "PROJECT_UPLOAD_PUBLICATION_FENCE_SECONDS",
      ]) &&
      createdAtReferences >= 2 &&
      tokens.has("is") &&
      tokens.has("null") &&
      tokens.has("or") &&
      tokens.has("current_timestamp") &&
      tokens.has("interval")
    );
  });
}

function anyLabelingSessionWhereCalls(node) {
  return descendants(node, ts.isCallExpression).filter((call) => {
    if (callName(call) !== "where" || !call.arguments[0]) return false;
    const predicate = unwrapExpression(call.arguments[0]);
    return (
      predicate &&
      ts.isCallExpression(predicate) &&
      callName(predicate) === "eq" &&
      predicate.arguments.length === 2 &&
      hasPropertyAccess(
        predicate.arguments[0],
        "labelingSessions",
        "projectId",
      ) &&
      hasAllIdentifiers(predicate.arguments[1], ["project", "id"])
    );
  });
}

function labelingBlockerBefore(
  node,
  boundary,
  recordName = "linkedLabelingSession",
) {
  const query = anyLabelingSessionWhereCalls(node)[0];
  const guard = conflictGuard(node, "Project has linked labeling sessions", [
    recordName,
  ]);
  return Boolean(
    query &&
    guard &&
    query.getStart() < boundary &&
    guard.getStart() < boundary,
  );
}

function labelStudioIntentBlockerBefore(
  node,
  boundary,
  recordName = "pendingLabelStudioProject",
) {
  const query = descendants(node, ts.isCallExpression).find((call) => {
    if (callName(call) !== "where" || !call.arguments[0]) return false;
    const predicate = unwrapExpression(call.arguments[0]);
    return Boolean(
      predicate &&
      ts.isCallExpression(predicate) &&
      callName(predicate) === "eq" &&
      exactPropertyPath(predicate.arguments[0], [
        "labelStudioProjectIntents",
        "projectId",
      ]) &&
      exactPropertyPath(predicate.arguments[1], ["project", "id"]),
    );
  });
  const guard = conflictGuard(
    node,
    "Project has pending Label Studio provisioning",
    [recordName],
  );
  return Boolean(
    query &&
    guard &&
    query.getStart() < boundary &&
    guard.getStart() < boundary,
  );
}

function conflictGuard(node, message, conditionNames = []) {
  return (
    descendants(node, ts.isIfStatement).find(
      (statement) =>
        hasAllIdentifiers(statement.expression, conditionNames) &&
        hasStringLiteral(statement.thenStatement, [message]),
    ) ?? null
  );
}

function chainedCall(node, name) {
  let current = node.parent;
  while (current) {
    if (ts.isCallExpression(current) && callName(current) === name)
      return current;
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    )
      break;
    current = current.parent;
  }
  return null;
}

function inlineCallbackForCall(call, parsedFile) {
  const callback = unwrapExpression(wrapperCallback(call));
  if (
    callback &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
  )
    return callback;
  if (callback && ts.isIdentifier(callback))
    return parsedFile.functions.get(callback.text) ?? null;
  return null;
}

function callbackArgumentForCall(call, index, parsedFile) {
  const callback = unwrapExpression(call.arguments[index]);
  if (
    callback &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
  )
    return callback;
  if (callback && ts.isIdentifier(callback))
    return parsedFile.functions.get(callback.text) ?? null;
  return null;
}

function directAwaitContains(node) {
  let current = node;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent))
  ) {
    current = current.parent;
  }
  return Boolean(current.parent && ts.isAwaitExpression(current.parent));
}

function catchRethrowsBinding(catchClause) {
  const binding = catchClause.variableDeclaration?.name;
  if (!binding || !ts.isIdentifier(binding)) return false;
  return descendants(catchClause.block, ts.isThrowStatement).some(
    (statement) => {
      const expression = unwrapExpression(statement.expression);
      return (
        expression &&
        ts.isIdentifier(expression) &&
        expression.text === binding.text
      );
    },
  );
}

function callFailurePropagates(target, call) {
  if (!directAwaitContains(call) || chainedCall(call, "catch")) return false;
  return descendants(target, ts.isTryStatement)
    .filter(
      (statement) =>
        statement.catchClause && nodeContains(statement.tryBlock, call),
    )
    .every((statement) => catchRethrowsBinding(statement.catchClause));
}

function booleanAssignment(node, identifier, value) {
  return descendants(node, ts.isBinaryExpression).some((expression) => {
    if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
      return false;
    const left = unwrapExpression(expression.left);
    return (
      ts.isIdentifier(left) &&
      left.text === identifier &&
      literalValue(expression.right) === value
    );
  });
}

function projectMutationLease(target, kind) {
  return (
    descendants(target, ts.isCallExpression).find((call) => {
      if (callName(call) !== "withProjectMutationLease") return false;
      const options = objectArgumentForCall(call, 1);
      const kindValue = options ? propertyInitializer(options, "kind") : null;
      return kindValue && literalValue(kindValue) === kind;
    }) ?? null
  );
}

function hasProjectIdempotencyKey(leaseCall, projectBinding) {
  const options = leaseCall ? objectArgumentForCall(leaseCall, 1) : null;
  const key = options
    ? unwrapExpression(propertyInitializer(options, "idempotencyKey"))
    : null;
  return Boolean(
    key &&
    ts.isCallExpression(key) &&
    callName(key) === "String" &&
    key.arguments[0] &&
    hasPropertyAccess(key.arguments[0], projectBinding, "id"),
  );
}

function isExportedDeclaration(source, name) {
  for (const statement of source.statements) {
    const modifiers = ts.canHaveModifiers(statement)
      ? (ts.getModifiers(statement) ?? [])
      : [];
    const exported = modifiers.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!exported) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name)
      return true;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name)
          return true;
      }
    }
  }
  return false;
}

function literalValue(node) {
  const value = unwrapExpression(node);
  if (!value) return undefined;
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (value.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value))
    return value.text;
  return undefined;
}

function numericConstantValue(node) {
  const value = unwrapExpression(node);
  if (!value) return null;
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (!ts.isBinaryExpression(value)) return null;
  const left = numericConstantValue(value.left);
  const right = numericConstantValue(value.right);
  if (left === null || right === null) return null;
  switch (value.operatorToken.kind) {
    case ts.SyntaxKind.PlusToken:
      return left + right;
    case ts.SyntaxKind.MinusToken:
      return left - right;
    case ts.SyntaxKind.AsteriskToken:
      return left * right;
    case ts.SyntaxKind.SlashToken:
      return right === 0 ? null : left / right;
    default:
      return null;
  }
}

function objectProperty(object, name) {
  const value = unwrapExpression(object);
  if (!value || !ts.isObjectLiteralExpression(value)) return null;
  for (const prop of value.properties) {
    if (
      !ts.isPropertyAssignment(prop) &&
      !ts.isShorthandPropertyAssignment(prop)
    )
      continue;
    const propName = propertyName(prop.name);
    if (propName === name) return prop;
  }
  return null;
}

function taggedSqlText(node) {
  if (!ts.isTaggedTemplateExpression(node) || propertyName(node.tag) !== "sql")
    return null;
  const template = node.template;
  if (ts.isNoSubstitutionTemplateLiteral(template))
    return template.text.toLowerCase();
  let text = template.head.text;
  for (const span of template.templateSpans)
    text += " ${expression} " + span.literal.text;
  return text.toLowerCase();
}

function stringTokens(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .filter(Boolean);
}

function sqlHasAll(node, required) {
  const sqlText = taggedSqlText(node);
  if (sqlText === null) return false;
  const tokens = new Set(stringTokens(sqlText));
  return required.every((token) => tokens.has(token));
}

function expressionSqlHasAll(node, required) {
  const value = unwrapExpression(node);
  if (
    value &&
    ts.isTaggedTemplateExpression(value) &&
    sqlHasAll(value, required)
  )
    return true;
  return Boolean(
    value &&
    descendants(value, ts.isTaggedTemplateExpression).some((sqlNode) =>
      sqlHasAll(sqlNode, required),
    ),
  );
}

function hasEqBoolean(node, objectName, fieldName, expected) {
  return directCalls(node).some(({ call, name }) => {
    if (name !== "eq" || call.arguments.length < 2) return false;
    const left = unwrapExpression(call.arguments[0]);
    const right = literalValue(call.arguments[1]);
    return (
      ts.isPropertyAccessExpression(left) &&
      propertyName(left.expression) === objectName &&
      left.name.text === fieldName &&
      right === expected
    );
  });
}

function hasStrictPropertyLiteralComparison(
  node,
  objectName,
  fieldName,
  expected,
) {
  return descendants(node, ts.isBinaryExpression).some((binary) => {
    if (binary.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken)
      return false;
    const pairs = [
      [unwrapExpression(binary.left), unwrapExpression(binary.right)],
      [unwrapExpression(binary.right), unwrapExpression(binary.left)],
    ];
    return pairs.some(
      ([access, literal]) =>
        access &&
        ts.isPropertyAccessExpression(access) &&
        propertyName(access.expression) === objectName &&
        access.name.text === fieldName &&
        literalValue(literal) === expected,
    );
  });
}

function objectArgumentForCall(call, index) {
  const argument = unwrapExpression(call.arguments[index]);
  return argument && ts.isObjectLiteralExpression(argument) ? argument : null;
}

function propertyInitializer(object, name) {
  const property = objectProperty(object, name);
  return property && ts.isPropertyAssignment(property)
    ? property.initializer
    : null;
}

function templateStartsWith(node, prefix) {
  const value = unwrapExpression(node);
  if (ts.isStringLiteralLike(value)) return value.text.startsWith(prefix);
  if (ts.isTemplateExpression(value)) return value.head.text.startsWith(prefix);
  if (ts.isNoSubstitutionTemplateLiteral(value))
    return value.text.startsWith(prefix);
  return false;
}

function interpolationTemplateMatches(node, prefix, spans) {
  const value = unwrapExpression(node);
  if (
    !value ||
    !ts.isTemplateExpression(value) ||
    value.templateSpans.length !== spans.length
  )
    return false;
  if (value.head.text !== prefix) return false;
  return spans.every(({ identifier, suffix }, index) => {
    const span = value.templateSpans[index];
    const expression = unwrapExpression(span.expression);
    return (
      expression &&
      ts.isIdentifier(expression) &&
      expression.text === identifier &&
      span.literal.text === suffix
    );
  });
}

function singleInterpolationTemplate(node, prefix, identifier, suffix) {
  return interpolationTemplateMatches(node, prefix, [{ identifier, suffix }]);
}

function exactProjectStagingKeyTemplate(node) {
  const value = unwrapExpression(node);
  if (!value || !ts.isTemplateExpression(value) || value.head.text !== "")
    return false;
  if (value.templateSpans.length !== 3) return false;
  const [prefixSpan, indexSpan, filenameSpan] = value.templateSpans;
  const prefixCall = unwrapExpression(prefixSpan.expression);
  const index = unwrapExpression(indexSpan.expression);
  const filenameCall = unwrapExpression(filenameSpan.expression);
  return Boolean(
    prefixCall &&
    ts.isCallExpression(prefixCall) &&
    callName(prefixCall) === "projectUploadStagingPrefix" &&
    prefixCall.arguments.length === 1 &&
    ts.isIdentifier(unwrapExpression(prefixCall.arguments[0])) &&
    unwrapExpression(prefixCall.arguments[0]).text === "projectPath" &&
    prefixSpan.literal.text === "" &&
    ts.isIdentifier(index) &&
    index.text === "idx3" &&
    indexSpan.literal.text === "_" &&
    filenameCall &&
    ts.isCallExpression(filenameCall) &&
    callName(filenameCall) === "sanitizeProjectUploadFilename" &&
    filenameCall.arguments.length === 1 &&
    ts.isIdentifier(unwrapExpression(filenameCall.arguments[0])) &&
    unwrapExpression(filenameCall.arguments[0]).text === "filename" &&
    filenameSpan.literal.text === "",
  );
}

function exactIdentifierCall(node, name, argumentsList) {
  const value = unwrapExpression(node);
  if (!value || !ts.isCallExpression(value) || callName(value) !== name)
    return false;
  if (value.arguments.length !== argumentsList.length) return false;
  return argumentsList.every((expected, index) => {
    const argument = unwrapExpression(value.arguments[index]);
    return argument && ts.isIdentifier(argument) && argument.text === expected;
  });
}

function exactModelStorageTemplate(node, slugExpression) {
  const value = unwrapExpression(node);
  if (!value || !ts.isTemplateExpression(value) || value.head.text !== "")
    return false;
  if (value.templateSpans.length !== 2) return false;
  const [rootSpan, slugSpan] = value.templateSpans;
  const root = unwrapExpression(rootSpan.expression);
  return Boolean(
    root &&
    ts.isIdentifier(root) &&
    root.text === "MODEL_STORAGE_ROOT" &&
    rootSpan.literal.text === "/" &&
    slugExpression(unwrapExpression(slugSpan.expression)) &&
    slugSpan.literal.text === "",
  );
}

function templateStartsInProjectPrefix(node, projectBinding) {
  const value = unwrapExpression(node);
  if (!value || !ts.isTemplateExpression(value) || value.head.text !== "")
    return false;
  const first = value.templateSpans[0];
  const expression = first ? unwrapExpression(first.expression) : null;
  return Boolean(
    expression &&
    ts.isIdentifier(expression) &&
    expression.text === projectBinding &&
    first.literal.text.startsWith("/"),
  );
}

function templateStartsWithPropertyPath(node, propertyPath) {
  const value = unwrapExpression(node);
  if (!value || !ts.isTemplateExpression(value) || value.head.text !== "")
    return false;
  const first = value.templateSpans[0];
  return Boolean(
    first &&
    exactPropertyPath(first.expression, propertyPath) &&
    first.literal.text.startsWith("/"),
  );
}

function modelStorageGuardBefore(
  parsedFile,
  target,
  argumentPaths,
  message,
  boundary,
) {
  if (!target) return false;
  const binding = importedBindings(parsedFile).get(
    "isCanonicalModelStoragePath",
  );
  if (
    binding?.sourceFile !== "src/lib/model-storage-authority.ts" ||
    binding.symbol !== "isCanonicalModelStoragePath"
  )
    return false;
  return descendants(target, ts.isIfStatement).some(
    (statement) =>
      statement.getStart() < boundary &&
      hasStringLiteral(statement.thenStatement, [message]) &&
      descendants(statement.expression, ts.isPrefixUnaryExpression).some(
        (expression) => {
          if (expression.operator !== ts.SyntaxKind.ExclamationToken)
            return false;
          const call = unwrapExpression(expression.operand);
          return Boolean(
            call &&
            ts.isCallExpression(call) &&
            callName(call) === "isCanonicalModelStoragePath" &&
            call.arguments.length === argumentPaths.length &&
            argumentPaths.every((pathParts, index) =>
              exactPropertyPath(call.arguments[index], pathParts),
            ),
          );
        },
      ),
  );
}

function hasCanonicalProjectPathGuard(
  parsedFile,
  target,
  boundary = Number.POSITIVE_INFINITY,
) {
  if (!target) return false;
  const callerCompanyLookup = descendants(
    target,
    ts.isVariableDeclaration,
  ).find((declaration) => {
    if (
      declaration.getStart() >= boundary ||
      !ts.isArrayBindingPattern(declaration.name) ||
      !declaration.name.elements.some(
        (element) =>
          ts.isBindingElement(element) &&
          ts.isIdentifier(element.name) &&
          element.name.text === "callerCompany",
      ) ||
      !declaration.initializer ||
      !hasCall(declaration.initializer, ["from"])
    )
      return false;
    const readsCompanies = descendants(
      declaration.initializer,
      ts.isCallExpression,
    ).some(
      (call) =>
        callName(call) === "from" &&
        call.arguments[0] &&
        ts.isIdentifier(unwrapExpression(call.arguments[0])) &&
        unwrapExpression(call.arguments[0]).text === "companies",
    );
    const sessionScoped = descendants(
      declaration.initializer,
      ts.isCallExpression,
    ).some(
      (call) =>
        callName(call) === "eq" &&
        call.arguments.length === 2 &&
        exactPropertyPath(call.arguments[0], ["companies", "id"]) &&
        exactPropertyPath(call.arguments[1], ["session", "user", "companyId"]),
    );
    return readsCompanies && sessionScoped;
  });
  const canonicalBinding = importedBindings(parsedFile).get(
    "isCanonicalProjectPath",
  );
  const guard = descendants(target, ts.isIfStatement).find((statement) => {
    if (
      statement.getStart() >= boundary ||
      !hasStringLiteral(statement.thenStatement, [
        "Invalid dataUrl — must be inside your company prefix (use /api/s3/staging-credentials to obtain one)",
      ])
    )
      return false;
    const checksString =
      descendants(statement.expression, ts.isTypeOfExpression).some(
        (expression) => {
          const operand = unwrapExpression(expression.expression);
          return (
            operand && ts.isIdentifier(operand) && operand.text === "dataUrl"
          );
        },
      ) && hasStringLiteral(statement.expression, ["string"]);
    const rejectsNoncanonical = descendants(
      statement.expression,
      ts.isPrefixUnaryExpression,
    ).some((expression) => {
      if (expression.operator !== ts.SyntaxKind.ExclamationToken) return false;
      const call = unwrapExpression(expression.operand);
      return Boolean(
        call &&
        ts.isCallExpression(call) &&
        callName(call) === "isCanonicalProjectPath" &&
        call.arguments.length === 2 &&
        exactPropertyPath(call.arguments[0], ["callerCompany", "dataKey"]) &&
        ts.isIdentifier(unwrapExpression(call.arguments[1])) &&
        unwrapExpression(call.arguments[1]).text === "dataUrl",
      );
    });
    return checksString && rejectsNoncanonical;
  });
  return Boolean(
    callerCompanyLookup &&
    canonicalBinding?.sourceFile === "src/lib/project-upload-authority.ts" &&
    canonicalBinding.symbol === "isCanonicalProjectPath" &&
    guard,
  );
}

function hasCanonicalDemoDenial(node) {
  return descendants(node, ts.isIfStatement).some((statement) => {
    if (!hasIdentifier(statement.expression, ["isDemo"])) return false;
    const consequent = statement.thenStatement;
    const throwsForbidden = descendants(consequent, ts.isThrowStatement).some(
      (throwStatement) => {
        const expression = unwrapExpression(throwStatement.expression);
        if (
          !expression ||
          !ts.isNewExpression(expression) ||
          propertyName(expression.expression) !== "ApiError"
        ) {
          return false;
        }
        const args = expression.arguments ?? [];
        return (
          literalValue(args[0]) === "FORBIDDEN" &&
          literalValue(args[1]) === "Demo projects are read-only"
        );
      },
    );
    const returns403 = descendants(consequent, ts.isReturnStatement).some(
      (returnStatement) => {
        const calls = returnStatement.expression
          ? descendants(returnStatement.expression, ts.isCallExpression)
          : [];
        return calls.some((call) => {
          const options = call.arguments.find((arg) =>
            objectProperty(arg, "status"),
          );
          const status = options ? objectProperty(options, "status") : null;
          return (
            status &&
            ts.isPropertyAssignment(status) &&
            literalValue(status.initializer) === "403"
          );
        });
      },
    );
    return throwsForbidden || returns403;
  });
}

function functionFor(parsedFile, symbol) {
  if (!symbol) return parsedFile.source;
  return parsedFile.functions.get(symbol) ?? null;
}

function exportedRouteConfig(parsedFile, method) {
  for (const statement of parsedFile.source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const modifiers = ts.canHaveModifiers(statement)
      ? (ts.getModifiers(statement) ?? [])
      : [];
    if (
      !modifiers.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    )
      continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== method
      )
        continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (
        !initializer ||
        !ts.isCallExpression(initializer) ||
        callName(initializer) !== "defineRoute"
      )
        continue;
      const config = initializer.arguments[0];
      const value = unwrapExpression(config);
      if (value && ts.isObjectLiteralExpression(value)) return value;
    }
  }
  return null;
}

function exportedRouteHandler(parsedFile, method) {
  const config = exportedRouteConfig(parsedFile, method);
  const handler = config ? objectProperty(config, "handler") : null;
  if (handler && ts.isPropertyAssignment(handler)) {
    const expression = unwrapExpression(handler.initializer);
    if (
      expression &&
      (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))
    )
      return expression;
  }
  return functionFor(parsedFile, method);
}

function routeAuthLiteral(parsedFile, method) {
  const config = exportedRouteConfig(parsedFile, method);
  const auth = config ? objectProperty(config, "auth") : null;
  return auth && ts.isPropertyAssignment(auth)
    ? literalValue(auth.initializer)
    : undefined;
}

function directReturnExpressions(fn) {
  const expressions = [];
  const root = fn.body ?? fn;
  function visit(node) {
    if (
      node !== root &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node))
    )
      return;
    if (ts.isReturnStatement(node)) {
      if (node.expression) expressions.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  }
  if (ts.isBlock(root)) visit(root);
  else expressions.push(root);
  return expressions;
}

function variableInitializer(scope, name) {
  const declarations = descendants(scope, ts.isVariableDeclaration);
  const declaration = declarations.find(
    (item) => ts.isIdentifier(item.name) && item.name.text === name,
  );
  return declaration?.initializer ?? null;
}

function enclosingPropertyAssignment(node, boundary) {
  let current = node.parent;
  while (current && current !== boundary) {
    if (ts.isPropertyAssignment(current)) return current;
    current = current.parent;
  }
  return null;
}

function projectReferenceFromCall(call, tableInitializer) {
  if (callName(call) !== "references" || !call.arguments[0]) return null;
  const target = descendants(
    call.arguments[0],
    ts.isPropertyAccessExpression,
  ).find((access) => {
    const object = unwrapExpression(access.expression);
    return access.name.text === "id" && object && ts.isIdentifier(object);
  });
  if (!target) return null;
  const object = unwrapExpression(target.expression);
  const field = enclosingPropertyAssignment(call, tableInitializer);
  const options = objectArgumentForCall(call, 1);
  const onDelete = options ? propertyInitializer(options, "onDelete") : null;
  return {
    field: field ? propertyName(field.name) : null,
    target: object.text,
    nullable: field ? !hasCall(field.initializer, ["notNull"]) : null,
    onDelete: onDelete ? literalValue(onDelete) : undefined,
    node: call,
  };
}

function schemaTableGraph(parsedSchema) {
  const tables = new Map();
  for (const declaration of descendants(
    parsedSchema.source,
    ts.isVariableDeclaration,
  )) {
    if (!ts.isIdentifier(declaration.name)) continue;
    const initializer = unwrapExpression(declaration.initializer);
    if (
      !initializer ||
      !ts.isCallExpression(initializer) ||
      callName(initializer) !== "pgTable"
    )
      continue;
    const sqlName = literalValue(initializer.arguments[0]);
    if (typeof sqlName !== "string") continue;
    const references = descendants(initializer, ts.isCallExpression)
      .map((call) => projectReferenceFromCall(call, initializer))
      .filter(Boolean);
    tables.set(declaration.name.text, {
      symbol: declaration.name.text,
      sqlName,
      references,
      node: declaration,
    });
  }
  return tables;
}

function transitiveProjectOwnedTables(tableGraph, root = "projects") {
  const owned = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [symbol, table] of tableGraph) {
      if (owned.has(symbol)) continue;
      if (table.references.some((reference) => owned.has(reference.target))) {
        owned.add(symbol);
        changed = true;
      }
    }
  }
  return owned;
}

function projectOwnershipDrift(derived, exemptions, declaredProtected) {
  const protectedTables = new Set(
    [...derived].filter((table) => !exemptions.has(table)),
  );
  return {
    protectedTables,
    missingFromManifest: [...protectedTables]
      .filter((table) => !declaredProtected.has(table))
      .sort(),
    notSchemaOwned: [...declaredProtected]
      .filter((table) => !protectedTables.has(table))
      .sort(),
  };
}

function projectionPathsFromExpression(
  expression,
  scope,
  prefix = "",
  seen = new Set(),
) {
  const value = unwrapExpression(expression);
  if (!value || seen.has(value)) return [];
  seen.add(value);

  if (ts.isObjectLiteralExpression(value)) {
    const paths = [];
    for (const prop of value.properties) {
      if (ts.isSpreadAssignment(prop)) {
        paths.push(`${prefix}*`);
        continue;
      }
      if (
        !ts.isPropertyAssignment(prop) &&
        !ts.isShorthandPropertyAssignment(prop)
      ) {
        paths.push(`${prefix}*`);
        continue;
      }
      const name = propertyName(prop.name);
      if (!name) {
        paths.push(`${prefix}*`);
        continue;
      }
      const field = prefix ? `${prefix}.${name}` : name;
      const initializer = ts.isPropertyAssignment(prop)
        ? prop.initializer
        : variableInitializer(scope, prop.name.text);
      const nested = initializer
        ? projectionPathsFromExpression(
            initializer,
            scope,
            field,
            new Set(seen),
          )
        : [];
      if (nested.length > 0) paths.push(...nested);
      else paths.push(field);
    }
    return paths;
  }

  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.flatMap((element) =>
      projectionPathsFromExpression(
        element,
        scope,
        `${prefix}[]`,
        new Set(seen),
      ),
    );
  }

  if (ts.isCallExpression(value)) {
    const name = callName(value);
    if (name === "json" && value.arguments[0]) {
      return projectionPathsFromExpression(
        value.arguments[0],
        scope,
        prefix,
        new Set(seen),
      );
    }
    if (name === "map") {
      const callback = unwrapExpression(value.arguments[0]);
      if (
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
      ) {
        return directReturnExpressions(callback).flatMap((returned) =>
          projectionPathsFromExpression(
            returned,
            scope,
            `${prefix}[]`,
            new Set(seen),
          ),
        );
      }
    }
    return [];
  }

  if (ts.isIdentifier(value)) {
    const initializer = variableInitializer(scope, value.text);
    return initializer
      ? projectionPathsFromExpression(initializer, scope, prefix, new Set(seen))
      : [];
  }

  if (ts.isConditionalExpression(value)) {
    return [value.whenTrue, value.whenFalse].flatMap((branch) =>
      projectionPathsFromExpression(branch, scope, prefix, new Set(seen)),
    );
  }

  return [];
}

function projectionPathsForFunction(target) {
  return [
    ...new Set(
      directReturnExpressions(target).flatMap((expression) =>
        projectionPathsFromExpression(expression, target),
      ),
    ),
  ].sort();
}

function hasNoPersistContract(node) {
  return hasIdentifier(node, ["noPersist"]) && hasIdentifier(node, ["isDemo"]);
}

function hasReadOnlyToolsContract(node) {
  return (
    hasIdentifier(node, ["readOnlyTools"]) ||
    hasIdentifier(node, ["allowMutatingTools"])
  );
}

async function validateManifestShape() {
  const canonicalKeys = Object.keys(CANONICAL_DEMO_WRITE_ERROR)
    .sort()
    .join(",");
  if (canonicalKeys !== "code,constraint,databaseCode,message,status") {
    report(
      "CANONICAL_DEMO_ERROR_SHAPE",
      "canonical demo-write error fields must remain exact",
    );
  }
  if (
    CANONICAL_DEMO_WRITE_ERROR.status !== 403 ||
    CANONICAL_DEMO_WRITE_ERROR.code !== "FORBIDDEN" ||
    CANONICAL_DEMO_WRITE_ERROR.message !== "Demo projects are read-only" ||
    CANONICAL_DEMO_WRITE_ERROR.databaseCode !== "P0001" ||
    CANONICAL_DEMO_WRITE_ERROR.constraint !== "demo_project_read_only"
  ) {
    report(
      "CANONICAL_DEMO_ERROR_DRIFT",
      "canonical application/database demo-write denial drifted",
    );
  }

  const tombstoneKeys = TOMBSTONED_HTTP_SURFACES.map(
    (surface) => `${surface.method} ${surface.route}`,
  );
  if (
    TOMBSTONED_HTTP_SURFACES.length !== 1 ||
    new Set(tombstoneKeys).size !== tombstoneKeys.length ||
    TOMBSTONED_HTTP_SURFACES[0]?.id !== "label-studio-browser-credentials" ||
    TOMBSTONED_HTTP_SURFACES[0]?.status !== 410
  ) {
    report(
      "TOMBSTONE_MANIFEST_DRIFT",
      "the Label Studio browser-credential endpoint must remain the sole explicit HTTP tombstone at 410",
    );
  }

  const providerTaskIds = LABEL_STUDIO_PROVIDER_TASKS.map((task) => task.id);
  if (
    JSON.stringify(LABEL_STUDIO_PROVIDER_PATHS) !==
    JSON.stringify({
      create: "/api/projects/",
      search:
        "/api/projects/?search=${encodeURIComponent(marker)}&page_size=100",
      project: "/api/projects/${projectId}/",
      import: "/api/projects/${projectId}/import",
    })
  ) {
    report(
      "LABEL_STUDIO_PROVIDER_PATH_MANIFEST_DRIFT",
      "the manifest must retain the exact redirect-free Label Studio project API paths",
    );
  }
  if (
    LABEL_STUDIO_PROVIDER_TASKS.length !== 2 ||
    new Set(providerTaskIds).size !== providerTaskIds.length ||
    !providerTaskIds.includes("application") ||
    !providerTaskIds.includes("cleanup-worker") ||
    LABEL_STUDIO_PROVIDER_TASKS.some(
      (task) =>
        !task.terraformFile ||
        !task.resource ||
        !task.requiredEnvironment?.includes("LABEL_STUDIO_URL") ||
        !task.requiredEnvironment?.includes("LABEL_STUDIO_INSTANCE_ID") ||
        !task.requiredSecrets?.includes("LABEL_STUDIO_API_KEY") ||
        task.instanceIdentity !==
          "${aws_efs_file_system.label_studio.id}:${var.label_studio_instance_generation}" ||
        (task.id === "application" &&
          task.rootAdminIdentity !== "var.root_admin_email") ||
        !task.forbiddenAuthority?.includes("LABEL_STUDIO_USERNAME") ||
        !task.forbiddenAuthority?.includes("LABEL_STUDIO_PASSWORD") ||
        !task.forbiddenAuthority?.includes("label_studio_admin_email") ||
        !task.forbiddenAuthority?.includes("label_studio_admin_password"),
    )
  ) {
    report(
      "LABEL_STUDIO_PROVIDER_TASK_MANIFEST_DRIFT",
      "application and cleanup-worker tasks must declare stable provider identity, API authority, and bootstrap-secret isolation",
    );
  }

  if (new Set(PROJECT_OWNED_TABLES).size !== PROJECT_OWNED_TABLES.length) {
    report("PROJECT_TABLE_DUPLICATE", "PROJECT_OWNED_TABLES must be unique");
  }

  const exemptionTables = PROJECT_FK_TABLE_EXEMPTIONS.map((item) => item.table);
  if (
    new Set(exemptionTables).size !== exemptionTables.length ||
    exemptionTables.some((table) => PROJECT_OWNED_TABLES.includes(table))
  ) {
    report(
      "PROJECT_FK_EXEMPTION_SET",
      "project-FK exemptions must be unique and disjoint from protected project-owned tables",
    );
  }
  for (const exemption of PROJECT_FK_TABLE_EXEMPTIONS) {
    if (
      !exemption.table ||
      !exemption.sqlTable ||
      exemption.policy !== "billing-attribution-ledger" ||
      exemption.projectReference?.nullable !== true ||
      exemption.projectReference?.onDelete !== "set null" ||
      typeof exemption.reason !== "string" ||
      exemption.reason.trim() === ""
    ) {
      report(
        "PROJECT_FK_EXEMPTION_INVALID",
        `${exemption.table ?? "<unknown>"} has an invalid exemption contract`,
      );
    }
    const writerKeys =
      exemption.writers?.map((writer) => writer.join(":")) ?? [];
    if (
      writerKeys.length === 0 ||
      new Set(writerKeys).size !== writerKeys.length ||
      writerKeys.some(
        (key, index) =>
          index > 0 && writerKeys[index - 1].localeCompare(key) > 0,
      ) ||
      exemption.writers.some(
        ([, , kind]) => !new Set(["insert", "update", "delete"]).has(kind),
      )
    ) {
      report(
        "PROJECT_FK_EXEMPTION_WRITERS",
        `${exemption.table} needs unique, sorted, explicit writers`,
      );
    }
    for (const [file, symbol] of exemption.writers ?? []) {
      try {
        const parsedFile = await parsed(file);
        if (!functionFor(parsedFile, symbol)) {
          report(
            "PROJECT_FK_EXEMPTION_WRITER_SYMBOL",
            `${exemption.table} points to missing ${symbol}`,
            file,
          );
        }
      } catch {
        report(
          "PROJECT_FK_EXEMPTION_WRITER_SOURCE",
          `${exemption.table} points to missing ${file}`,
          file,
        );
      }
    }
  }

  const inventoryTables = DEMO_WRITE_TRIGGER_INVENTORY.map(
    (item) => item.table,
  );
  const expectedTables = [...PROJECT_OWNED_TABLES].sort();
  if (
    new Set(inventoryTables).size !== inventoryTables.length ||
    JSON.stringify([...inventoryTables].sort()) !==
      JSON.stringify(expectedTables)
  ) {
    report(
      "TRIGGER_INVENTORY_TABLE_COVERAGE",
      "demo-write trigger inventory must cover every project-owned table exactly once",
    );
  }
  const inventoryTriggers = DEMO_WRITE_TRIGGER_INVENTORY.map(
    (item) => item.trigger,
  );
  if (new Set(inventoryTriggers).size !== inventoryTriggers.length) {
    report(
      "TRIGGER_INVENTORY_DUPLICATE",
      "demo-write trigger names must be unique",
    );
  }
  for (const item of DEMO_WRITE_TRIGGER_INVENTORY) {
    if (!item.sqlTable || !item.trigger || !item.function) {
      report(
        "TRIGGER_INVENTORY_INVALID",
        `${item.table ?? "<unknown>"} has an incomplete trigger entry`,
      );
    }
    if (
      item.table !== "projects" &&
      item.table !== "annotationGroupMembers" &&
      (item.function !== "bp_guard_direct_project_child" ||
        item.argument !== "project_id")
    ) {
      report(
        "TRIGGER_INVENTORY_DIRECT_GUARD",
        `${item.table} must use the direct project child guard`,
      );
    }
  }

  const durableIds = new Set();
  const durableSymbols = new Set();
  for (const domain of DURABLE_MUTATION_DOMAINS) {
    const symbolKey = `${domain.sourceFile}:${domain.symbol}`;
    if (durableIds.has(domain.id) || durableSymbols.has(symbolKey)) {
      report(
        "DURABLE_DOMAIN_DUPLICATE",
        `duplicate durable mutation domain ${domain.id}`,
      );
    }
    durableIds.add(domain.id);
    durableSymbols.add(symbolKey);
    if (!domain.kind || typeof domain.kind !== "string") {
      report("DURABLE_DOMAIN_KIND", `${domain.id} needs a stable lease kind`);
    }
    try {
      const file = await parsed(domain.sourceFile);
      if (!functionFor(file, domain.symbol)) {
        report(
          "DURABLE_DOMAIN_SYMBOL",
          `${domain.id} points to missing ${domain.symbol}`,
          domain.sourceFile,
        );
      }
    } catch {
      report(
        "DURABLE_DOMAIN_SOURCE",
        `${domain.id} points to missing ${domain.sourceFile}`,
        domain.sourceFile,
      );
    }
  }

  const seenMutation = new Set();
  for (const surface of MUTATION_SURFACES) {
    const key = `${surface.method} ${surface.route}`;
    if (seenMutation.has(key))
      report(
        "MANIFEST_DUPLICATE_MUTATION",
        `duplicate mutation surface ${key}`,
      );
    seenMutation.add(key);
    if (!MUTATION_POLICIES.has(surface.policy)) {
      report(
        "UNKNOWN_MUTATION_POLICY",
        `${surface.id} uses unknown mutation policy ${surface.policy}`,
      );
    }

    let route;
    try {
      route = await parsed(surface.routeFile);
    } catch {
      report(
        "MANIFEST_ROUTE_MISSING",
        `${surface.id} points to missing ${surface.routeFile}`,
        surface.routeFile,
      );
      continue;
    }
    if (!isExportedDeclaration(route.source, surface.method)) {
      report(
        "MANIFEST_METHOD_MISSING",
        `${surface.id} expects exported ${surface.method}`,
        surface.routeFile,
        route.source,
      );
    }

    for (const [file, symbol] of surface.checks) {
      let targetFile;
      try {
        targetFile = await parsed(file);
      } catch {
        report(
          "MANIFEST_SOURCE_MISSING",
          `${surface.id} points to missing ${file}`,
          file,
        );
        continue;
      }
      if (symbol && !functionFor(targetFile, symbol)) {
        report(
          "MANIFEST_SYMBOL_MISSING",
          `${surface.id} points to missing symbol ${symbol}`,
          file,
          targetFile.source,
        );
      }
    }
  }

  for (const [file, symbol, policy] of INTERNAL_MUTATION_SINKS) {
    if (!INTERNAL_SINK_POLICIES.has(policy)) {
      report(
        "UNKNOWN_INTERNAL_SINK_POLICY",
        `${file}:${symbol} uses unknown internal policy ${policy}`,
      );
    }
  }

  const seenPublic = new Set();
  for (const surface of PUBLIC_DEMO_SURFACES) {
    const key = `${surface.method} ${surface.route}`;
    if (seenPublic.has(key))
      report("MANIFEST_DUPLICATE_PUBLIC", `duplicate public surface ${key}`);
    seenPublic.add(key);
    if (!PUBLIC_POLICIES.has(surface.policy)) {
      report(
        "UNKNOWN_PUBLIC_POLICY",
        `${surface.id} uses unknown public policy ${surface.policy}`,
      );
    }
    const contract = surface.contract;
    if (
      !contract ||
      (contract.kind !== "projection" && contract.kind !== "debt")
    ) {
      report(
        "PUBLIC_CONTRACT_MISSING",
        `${surface.id} needs an explicit projection or debt contract`,
      );
      continue;
    }
    if (
      surface.policy === "strict-public-shape" &&
      contract.kind !== "projection"
    ) {
      report(
        "STRICT_PUBLIC_SHAPE_REQUIRES_PROJECTION",
        `${surface.id} cannot claim a strict public shape through a debt-only contract`,
      );
    }
    if (contract.kind === "projection") {
      const fields = contract.fields;
      const sorted = Array.isArray(fields) ? [...fields].sort() : [];
      if (!contract.symbol || !Array.isArray(fields) || fields.length === 0) {
        report(
          "PUBLIC_PROJECTION_INVALID",
          `${surface.id} projection requires a symbol and fields`,
        );
      } else if (
        new Set(fields).size !== fields.length ||
        JSON.stringify(fields) !== JSON.stringify(sorted)
      ) {
        report(
          "PUBLIC_PROJECTION_UNSORTED",
          `${surface.id} projection fields must be unique and sorted`,
        );
      } else if (
        fields.some(
          (field) =>
            typeof field !== "string" ||
            field.includes("*") ||
            !/^(?:\[\]\.)?[A-Za-z_$][\w$]*(?:\[\])?(?:\.[A-Za-z_$][\w$]*(?:\[\])?)*$/u.test(
              field,
            ),
        )
      ) {
        report(
          "PUBLIC_PROJECTION_PATH_INVALID",
          `${surface.id} has an invalid/wildcard recursive field path`,
        );
      }
      const owningFiles = [];
      for (const file of surface.sources) {
        const source = await parsed(file);
        if (functionFor(source, contract.symbol)) owningFiles.push(file);
      }
      if (owningFiles.length !== 1) {
        report(
          "PUBLIC_PROJECTION_SYMBOL",
          `${surface.id} projection symbol ${contract.symbol} must exist in exactly one source`,
        );
      }
    } else if (
      typeof contract.tracking !== "string" ||
      contract.tracking.trim() === "" ||
      typeof contract.reason !== "string" ||
      contract.reason.trim() === ""
    ) {
      report(
        "PUBLIC_DEBT_INVALID",
        `${surface.id} debt classification requires tracking and reason`,
      );
    }
  }

  const exceptionNames = LIFECYCLE_EXCEPTIONS.map((item) => item.symbol);
  if (exceptionNames.length !== 1 || exceptionNames[0] !== "manageDemo") {
    report(
      "LIFECYCLE_EXCEPTION_SET",
      "manageDemo must be the sole lifecycle exception",
    );
  }
  for (const exception of LIFECYCLE_EXCEPTIONS) {
    const allowed = [...exception.allowedColumns].sort().join(",");
    if (allowed !== "isDemo,lifecycleEpoch,updatedAt") {
      report(
        "LIFECYCLE_EXCEPTION_COLUMNS",
        `${exception.symbol} may only write isDemo, lifecycleEpoch, and updatedAt`,
      );
    }
    const file = await parsed(exception.sourceFile);
    if (!functionFor(file, exception.symbol)) {
      report(
        "LIFECYCLE_EXCEPTION_SYMBOL",
        `missing lifecycle exception symbol ${exception.symbol}`,
        exception.sourceFile,
      );
    }
  }
}

async function validateMutationPolicies() {
  for (const surface of MUTATION_SURFACES) {
    for (const [file, symbol] of surface.checks) {
      const parsedFile = await parsed(file);
      const target = functionFor(parsedFile, symbol);
      if (!target) continue;

      if (surface.policy === "shared-guard") {
        const guarded = functionTransitivelyMatches(parsedFile, target, (fn) =>
          hasAtomicWriteBoundary(fn),
        );
        const durableSymbols = new Set(
          DURABLE_MUTATION_DOMAINS.map((domain) => domain.symbol),
        );
        const delegatesToDurableDomain = directCalls(target).some(
          ({ name }) => name && durableSymbols.has(name),
        );
        const delegatesToReviewedSink = delegatesToReviewedInternalSink(
          parsedFile,
          target,
        );
        if (!guarded && !delegatesToDurableDomain && !delegatesToReviewedSink) {
          report(
            "MISSING_ATOMIC_PROJECT_WRITE",
            `${surface.method} ${surface.route} (${symbol}) does not transitively use withProjectWrite(s)`,
            file,
            target,
          );
        }
      } else if (surface.policy === "inline-demo-denial") {
        if (
          !functionTransitivelyMatches(
            parsedFile,
            target,
            hasCanonicalDemoDenial,
          )
        ) {
          report(
            "MISSING_INLINE_DEMO_DENIAL",
            `${surface.method} ${surface.route} lacks the canonical all-role demo denial`,
            file,
            target,
          );
        }
      } else if (surface.policy === "batch-non-demo") {
        const excludesDemo = functionTransitivelyMatches(
          parsedFile,
          target,
          (fn) => {
            if (hasEqBoolean(fn, "projects", "isDemo", false)) return true;
            return descendants(fn, ts.isTaggedTemplateExpression).some(
              (sqlNode) => sqlHasAll(sqlNode, ["is_demo", "false"]),
            );
          },
        );
        if (!excludesDemo) {
          report(
            "BATCH_INCLUDES_DEMO",
            `${surface.method} ${surface.route} batch mutation does not semantically exclude demo projects`,
            file,
            target,
          );
        }
      } else if (surface.policy === "batch-tenant-non-demo") {
        const updateTemplates = descendants(
          target,
          ts.isTaggedTemplateExpression,
        ).filter((node) => {
          const tokens = new Set(stringTokens(taggedSqlText(node) ?? ""));
          return (
            tokens.has("update") || tokens.has("delete") || tokens.has("insert")
          );
        });
        const allScoped =
          updateTemplates.length > 0 &&
          updateTemplates.every((sqlNode) => {
            const tokens = new Set(stringTokens(taggedSqlText(sqlNode) ?? ""));
            return (
              tokens.has("projects") &&
              tokens.has("company_id") &&
              tokens.has("is_demo") &&
              tokens.has("false")
            );
          });
        const capabilitiesPerTarget =
          hasAtomicWriteBoundary(target) &&
          hasEqBoolean(target, "projects", "isDemo", false) &&
          hasAllIdentifiers(target, [
            "projects",
            "companyId",
            "annotations",
            "projectId",
          ]);
        if (!allScoped && !capabilitiesPerTarget) {
          report(
            "BATCH_MISSING_TENANT_DEMO_SCOPE",
            `${surface.method} ${surface.route} raw mutation is not joined to tenant-owned, non-demo projects`,
            file,
            target,
          );
        }
      } else if (surface.policy === "indirect-session-guard") {
        const route = await parsed(surface.routeFile);
        const routeHandler = exportedRouteHandler(route, surface.method);
        const routeThreadsSession = routeHandler
          ? hasIdentifier(routeHandler, ["session"]) &&
            directCalls(routeHandler).some(
              ({ call, name }) =>
                name === symbol &&
                call.arguments.some((argument) =>
                  hasIdentifier(argument, ["session"]),
                ),
            )
          : false;
        const serviceScopes =
          hasIdentifier(target, ["session", "companyId", "isDemo"]) &&
          (hasCall(target, [
            "resolveProjectOrThrow",
            "resolveWritableProjectOrThrow",
          ]) ||
            descendants(target, ts.isTaggedTemplateExpression).some((node) =>
              sqlHasAll(node, ["projects", "company_id", "is_demo"]),
            ));
        if (!routeThreadsSession || !serviceScopes) {
          report(
            "INDIRECT_MUTATION_UNSCOPED",
            `${surface.method} ${surface.route} must thread the admin session and scope the job through a non-demo tenant project`,
            file,
            target,
          );
        }
      } else if (surface.policy === "new-private-project") {
        if (hasIdentifier(target, ["isDemo"])) {
          report(
            "PROJECT_CREATE_ACCEPTS_DEMO",
            `${surface.method} ${surface.route} project creation must not accept an isDemo input`,
            file,
            target,
          );
        }
      } else if (surface.policy === "demo-read-only") {
        const needsTools = file.endsWith("scoped.ts");
        if (
          !hasNoPersistContract(target) ||
          (needsTools && !hasReadOnlyToolsContract(target))
        ) {
          report(
            "DEMO_CHAT_CAN_MUTATE",
            `${surface.method} ${surface.route} (${symbol}) lacks explicit noPersist${needsTools ? "/readOnlyTools" : ""} semantics`,
            file,
            target,
          );
        }
        if (
          file.endsWith("ai-chat.ts") &&
          !hasPropertyAccess(target, "project", "isDemo")
        ) {
          report(
            "DEMO_CHAT_CARVEOUT",
            `${surface.method} ${surface.route} must derive demo policy from project.isDemo, not caller scope`,
            file,
            target,
          );
        }
      } else if (surface.policy === "demo-aware-lifecycle") {
        const ownsNoDemo = hasCall(target, [
          "assertProjectWritable",
          "assertNoDemoProjects",
          "deleteUserPrivateProjectsOnly",
        ]);
        const referenceCalls = directCalls(target).filter(
          ({ name }) =>
            name &&
            new Set([
              "assertNoDemoProjectReferences",
              "assertUserHasNoDemoProjectReferences",
              "findReferencedProjects",
            ]).has(name),
        );
        const referenceCall = referenceCalls[0];
        const referenceHelper = referenceCall?.name
          ? parsedFile.functions.get(referenceCall.name)
          : null;
        const referenceProjection = variableInitializer(
          parsedFile.source,
          "projectWriteIdentitySelection",
        );
        const helperCoversProjectReferences =
          referenceHelper &&
          (hasAllIdentifiers(referenceHelper, [
            "projects",
            "annotations",
            "chatMessages",
            "annotationGroups",
            "isDemo",
          ]) ||
            (hasAllIdentifiers(referenceHelper, [
              "annotations",
              "chatMessages",
              "annotationGroups",
              "projectWriteIdentitySelection",
            ]) &&
              referenceProjection &&
              hasAllIdentifiers(referenceProjection, [
                "projects",
                "isDemo",
                "lifecycleEpoch",
              ])) ||
            descendants(referenceHelper, ts.isTaggedTemplateExpression).some(
              (sqlNode) =>
                sqlHasAll(sqlNode, [
                  "projects",
                  "annotations",
                  "chat_messages",
                  "annotation_groups",
                  "is_demo",
                ]),
            ));
        const firstLifecycleSideEffect = directCalls(target)
          .filter(
            ({ name }) =>
              name &&
              new Set(["deleteProjectFully", "update", "delete"]).has(name),
          )
          .map(({ call }) => call.getStart(parsedFile.source))
          .sort((a, b) => a - b)[0];
        const censusDominates =
          referenceCall &&
          (firstLifecycleSideEffect === undefined ||
            referenceCall.call.getStart(parsedFile.source) <
              firstLifecycleSideEffect);
        if (!ownsNoDemo || !helperCoversProjectReferences || !censusDominates) {
          report(
            "LIFECYCLE_MUTATION_MISSES_DEMO_REFERENCES",
            `${surface.method} ${surface.route} must reject owned and referenced demo data before lifecycle side effects`,
            file,
            target,
          );
        }
      } else if (surface.policy === "lifecycle-exception") {
        const validatesPublishableState = functionTransitivelyMatches(
          parsedFile,
          target,
          (fn) =>
            hasAllIdentifiers(fn, ["processingJobs", "isDemo"]) &&
            hasAllStringLiterals(fn, ["completed", "running", "CONFLICT"]),
        );
        const serializesLifecycle =
          hasAllCalls(target, ["transaction", "for"]) &&
          hasAllIdentifiers(target, [
            "lifecycleEpoch",
            "projectMutationLeases",
            "status",
          ]);
        const checksLiveLease = hasAllStringLiterals(target, [
          "active",
          "Project has an active mutation lease",
        ]);
        const leasePolicyFailsClosed =
          hasFailClosedActiveLeasePredicate(target) &&
          !usesExpiryBasedLeaseRetirement(target);
        const publication = descendants(target, ts.isCallExpression).find(
          (call) =>
            callName(call) === "update" &&
            exactPropertyPath(call.arguments[0], ["projects"]) &&
            objectPropertyHasLiteral(
              objectArgumentForCall(chainedCall(call, "set"), 0),
              "isDemo",
              true,
            ),
        );
        const blocksLabelStudioIntent =
          publication &&
          labelStudioIntentBlockerBefore(target, publication.getStart());
        if (
          !validatesPublishableState ||
          !serializesLifecycle ||
          !checksLiveLease ||
          !leasePolicyFailsClosed ||
          !blocksLabelStudioIntent
        ) {
          report(
            "DEMO_PUBLICATION_NOT_QUIESCENT",
            `${surface.method} ${surface.route} must lock the lifecycle row, increment lifecycleEpoch, and reject every active lease or Label Studio provider intent`,
            file,
            target,
          );
        }
      } else {
        report(
          "UNKNOWN_MUTATION_POLICY",
          `${surface.id} has no checker branch for mutation policy ${surface.policy}`,
          file,
          target,
        );
      }
    }
  }
}

async function validateInternalSinks() {
  for (const [file, symbol, policy] of INTERNAL_MUTATION_SINKS) {
    const parsedFile = await parsed(file);
    const target = functionFor(parsedFile, symbol);
    if (!target) {
      report(
        "MANIFEST_SYMBOL_MISSING",
        `internal sink ${symbol} is missing`,
        file,
        parsedFile.source,
      );
      continue;
    }
    if (policy === "atomic-project-write") {
      const atomic = functionTransitivelyMatches(
        parsedFile,
        target,
        hasAtomicWriteBoundary,
      );
      if (!atomic) {
        report(
          "UNGUARDED_INTERNAL_SINK",
          `${symbol} does not transitively publish through withProjectWrite(s)`,
          file,
          target,
        );
      }
    } else if (policy === "atomic-project-storage-write") {
      const storageBoundaries = descendants(target, ts.isCallExpression).filter(
        (call) => callName(call) === "withProjectStorageWrite",
      );
      if (storageBoundaries.length !== 1) {
        report(
          "UNGUARDED_STORAGE_DELETE_SINK",
          `${symbol} must publish through exactly one withProjectStorageWrite boundary`,
          file,
          target,
        );
      }
    } else if (policy === "parent-locked-project-intent") {
      if (
        !hasAllCalls(target, [
          "claimIntent",
          "deleteClaimedIntent",
          "rescheduleClaimedIntent",
        ])
      ) {
        report(
          "UNGUARDED_PARENT_LOCKED_INTENT_SINK",
          `${symbol} must claim and finalize its project-owned intent through reviewed parent-first helpers`,
          file,
          target,
        );
      }
    } else if (policy === "project-write-transaction-helper") {
      const transactionParameter = target.parameters[0];
      const transactionName = transactionParameter?.name;
      const transactionType = transactionParameter?.type?.getText(
        parsedFile.source,
      );
      const sinks = discoverProjectWriteSinks(parsedFile, [
        "labelStudioAssetGrants",
      ]).filter(
        (sink) => nearestNamedFunction(parsedFile, sink.node).name === symbol,
      );
      if (
        file !== "src/lib/label-studio-asset-grant.ts" ||
        !LABEL_STUDIO_GRANT_TRANSACTION_HELPERS.has(symbol) ||
        !isExportedDeclaration(parsedFile.source, symbol) ||
        !transactionName ||
        !ts.isIdentifier(transactionName) ||
        transactionName.text !== "tx" ||
        transactionType !== "ProjectWriteTransaction" ||
        sinks.length !== 1 ||
        mutationReceiver(sinks[0]) !== "tx"
      ) {
        report(
          "UNGUARDED_PROJECT_TRANSACTION_HELPER",
          `${symbol} must be an exported, single-sink ProjectWriteTransaction helper using only tx`,
          file,
          target,
        );
      }
    } else if (policy === "leased-reclaimable-session-retirement") {
      const issues = labelStudioSessionRetirementIssues(parsedFile);
      if (issues.size > 0) {
        report(
          "UNGUARDED_LABEL_STUDIO_RETIREMENT_SINK",
          `${symbol} violates: ${[...issues].sort().join(", ")}`,
          file,
          target,
        );
      }
    } else if (policy === "atomic-or-no-persist") {
      if (!hasNoPersistContract(target) || !hasAtomicWriteBoundary(target)) {
        report(
          "CHAT_SINK_PERSISTS_DEMO",
          `${symbol} needs an explicit noPersist contract and atomic private-project persistence`,
          file,
          target,
        );
      }
    } else if (policy === "atomic-tool-write") {
      const executorEnforcesAuthority =
        hasAllIdentifiers(target, [
          "ProjectWriteCapability",
          "writeCapability",
          "MUTATING_TOOLS",
        ]) &&
        hasCall(target, ["assertProjectWriteCapability"]) &&
        functionTransitivelyMatches(parsedFile, target, hasAtomicWriteBoundary);
      if (!executorEnforcesAuthority) {
        report(
          "CHAT_TOOL_EXECUTOR_TRUSTS_CALLER_FLAG",
          `${symbol} mutation branches require branded authority and withProjectWrite(s)`,
          file,
          target,
        );
      }
    } else {
      report(
        "UNKNOWN_INTERNAL_SINK_POLICY",
        `${symbol} has no checker branch for ${policy}`,
        file,
        target,
      );
    }
  }
}

function hasDemoEmptyBranch(node) {
  return descendants(node, ts.isIfStatement).some((statement) => {
    if (!hasIdentifier(statement.expression, ["isDemo"])) return false;
    return descendants(statement.thenStatement, ts.isReturnStatement).some(
      (returnNode) => {
        const expression = unwrapExpression(returnNode.expression);
        return (
          expression &&
          ts.isArrayLiteralExpression(expression) &&
          expression.elements.length === 0
        );
      },
    );
  });
}

async function validateDeclaredProjection(surface) {
  if (surface.contract?.kind !== "projection") return;
  let owner = null;
  let target = null;
  for (const file of surface.sources) {
    const candidate = await parsed(file);
    const fn = functionFor(candidate, surface.contract.symbol);
    if (fn) {
      owner = file;
      target = fn;
      break;
    }
  }
  if (!owner || !target) return;
  const actual = projectionPathsForFunction(target);
  const expected = surface.contract.fields;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    report(
      "PUBLIC_PROJECTION_DRIFT",
      `${surface.id} projection is ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`,
      owner,
      target,
    );
  }
}

async function validatePublicPolicies() {
  for (const surface of PUBLIC_DEMO_SURFACES) {
    let route;
    try {
      route = await parsed(surface.routeFile);
    } catch {
      report(
        "PUBLIC_ROUTE_MISSING",
        `${surface.id} points to missing ${surface.routeFile}`,
        surface.routeFile,
      );
      continue;
    }
    if (!isExportedDeclaration(route.source, surface.method)) {
      report(
        "PUBLIC_METHOD_MISSING",
        `${surface.id} expects exported ${surface.method}`,
        surface.routeFile,
        route.source,
      );
    }
    const sources = await Promise.all(
      surface.sources.map((file) => parsed(file)),
    );
    const sourceNodes = sources.map((item) => item.source);

    if (surface.policy === "strict-public-shape") {
      await validateDeclaredProjection(surface);
    } else if (surface.policy === "requires-redaction") {
      if (surface.contract?.kind === "projection")
        await validateDeclaredProjection(surface);
      else if (surface.contract?.kind !== "debt") {
        report(
          "PUBLIC_REDACTION_UNCLASSIFIED",
          `${surface.method} ${surface.route} needs a recursive projection or explicit debt`,
          surface.sources[0],
          sourceNodes[0],
        );
      }
    } else if (surface.policy === "anonymous-bearer-asset") {
      if (
        surface.contract?.kind !== "debt" ||
        !textHasAll(route.text, [
          'auth: "none"',
          'kind: "raw"',
          "serveLabelStudioAsset",
          'searchParams.get("token")',
          "withLabelStudioAssetResponsePolicy",
          "export const HEAD",
          "export async function OPTIONS",
        ]) ||
        !sourceNodes.some((node) =>
          hasAllCalls(node, [
            "hashLabelStudioAssetToken",
            "getS3ObjectVersionStream",
          ]),
        )
      ) {
        report(
          "ANONYMOUS_BEARER_ASSET_UNCLASSIFIED",
          `${surface.method} ${surface.route} must remain a raw anonymous hashed-bearer route with GET/HEAD/OPTIONS response policy`,
          surface.routeFile,
          route.source,
        );
      }
    } else if (surface.policy === "public-asset") {
      if (surface.contract?.kind !== "debt") {
        report(
          "PUBLIC_ASSET_UNCLASSIFIED",
          `${surface.method} ${surface.route} needs an explicit asset debt contract`,
          surface.routeFile,
          route.source,
        );
      }
    } else if (surface.policy === "owner-threat-model-debt") {
      if (surface.contract?.kind !== "debt") {
        report(
          "PUBLIC_THREAT_DEBT_MISSING",
          `${surface.method} ${surface.route} must remain explicitly debt-classified`,
          surface.routeFile,
          route.source,
        );
      }
    } else if (surface.policy === "requires-auth") {
      const authenticated =
        routeAuthLiteral(route, surface.method) === "session";
      const anonymousProjection = sourceNodes.some((node) =>
        hasIdentifier(node, [
          "PublicDemoExport",
          "redactPublicDemoExport",
          "publicDemoRedaction",
        ]),
      );
      if (!authenticated || anonymousProjection) {
        report(
          "PUBLIC_EXPORT_REQUIRES_AUTH",
          `${surface.method} ${surface.route} must use session auth and expose no anonymous demo projection`,
          surface.routeFile,
          route.source,
        );
      }
    } else if (surface.policy === "requires-empty-or-redaction") {
      const protectedSurface = sourceNodes.some(
        (node) =>
          hasDemoEmptyBranch(node) ||
          hasIdentifier(node, ["redactPublicDemoGroups", "PublicDemoGroup"]),
      );
      if (!protectedSurface) {
        report(
          "PUBLIC_GROUPS_EXPOSED",
          `${surface.method} ${surface.route} lacks a demo-empty/redacted response branch`,
          surface.sources[0],
          sourceNodes[0],
        );
      }
    } else if (surface.policy === "requires-public-input-filter") {
      const protectedSurface = sourceNodes.some(
        (node) =>
          hasCall(node, [
            "filterPublicDemoInput",
            "assertPublicDemoInput",
            "loadPublicDemoAnnotations",
          ]) || hasIdentifier(node, ["PublicDemoInput", "publicDemoSafe"]),
      );
      if (!protectedSurface) {
        report(
          "PUBLIC_COMPUTE_INPUT_UNFILTERED",
          `${surface.method} ${surface.route} lacks an explicit public-demo input projection/filter`,
          surface.sources[0],
          sourceNodes[0],
        );
      }
    } else if (surface.policy === "requires-private-canary-exclusion") {
      const protectedSurface =
        sourceNodes.every((node) => hasNoPersistContract(node)) &&
        sourceNodes.some((node) => hasReadOnlyToolsContract(node));
      if (!protectedSurface) {
        report(
          "PUBLIC_CHAT_PRIVATE_CONTEXT_OR_WRITE",
          `${surface.method} ${surface.route} lacks explicit private-canary exclusion, noPersist, and read-only tools`,
          surface.sources[0],
          sourceNodes[0],
        );
      }
    } else if (surface.policy === "requires-zero-persistence") {
      const protectedSurface = sourceNodes.every((node) =>
        hasNoPersistContract(node),
      );
      if (!protectedSurface) {
        report(
          "PUBLIC_DEMO_CHAT_PERSISTS",
          `${surface.method} ${surface.route} lacks an end-to-end noPersist contract`,
          surface.sources[0],
          sourceNodes[0],
        );
      }
    } else {
      report(
        "UNKNOWN_PUBLIC_POLICY",
        `${surface.id} has no checker branch for public policy ${surface.policy}`,
        surface.routeFile,
        route.source,
      );
    }
  }
}

const MUTATING_HTTP_METHODS = ["DELETE", "PATCH", "POST", "PUT"];

async function importedCallReachesChecks(call, checks) {
  const relevant = checks.filter(
    ([file, symbol]) => file === call.sourceFile && symbol,
  );
  if (relevant.length === 0) return false;
  let target;
  try {
    target = await parsed(call.sourceFile);
  } catch {
    return false;
  }
  const reachable = reachableFunctions(target, call.symbol);
  return relevant.some(([, symbol]) => reachable.has(symbol));
}

/**
 * Prove that every declared project mutation method actually reaches its reviewed
 * implementation, then invert that mapping so a second route cannot expose the
 * same writer without its own manifest entry. This closes the former
 * "exported method + unrelated symbol exists" proof gap.
 */
async function validateMutationRouteBindings() {
  const classified = new Set(
    MUTATION_SURFACES.map(
      (surface) => `${surface.routeFile}:${surface.method}`,
    ),
  );
  const reviewedEntrypoints = new Set(
    INTERNAL_MUTATION_SINKS.map(([file, symbol]) => `${file}:${symbol}`),
  );

  for (const surface of MUTATION_SURFACES) {
    let route;
    try {
      route = await parsed(surface.routeFile);
    } catch {
      continue;
    }
    const handler = exportedRouteHandler(route, surface.method);
    if (!handler) continue;
    const calls = importedCallsTransitively(route, handler);
    let reachesReviewedImplementation = surface.checks.some(
      ([file]) => file === surface.routeFile,
    );
    for (const call of calls) {
      if (await importedCallReachesChecks(call, surface.checks)) {
        reviewedEntrypoints.add(`${call.sourceFile}:${call.symbol}`);
        reachesReviewedImplementation = true;
      }
    }
    if (!reachesReviewedImplementation) {
      report(
        "MUTATION_ROUTE_DELEGATION_DRIFT",
        `${surface.method} ${surface.route} no longer reaches any declared mutation implementation`,
        surface.routeFile,
        handler,
      );
    }
  }

  const routeFiles = (await walk("src/app/api")).filter((file) =>
    /\/route\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/u.test(file),
  );
  for (const file of routeFiles) {
    const route = await parsed(file);
    for (const method of MUTATING_HTTP_METHODS) {
      if (!isExportedDeclaration(route.source, method)) continue;
      const handler = exportedRouteHandler(route, method);
      if (!handler) continue;
      const exposesReviewedWriter = importedCallsTransitively(
        route,
        handler,
      ).find((call) =>
        reviewedEntrypoints.has(`${call.sourceFile}:${call.symbol}`),
      );
      if (exposesReviewedWriter && !classified.has(`${file}:${method}`)) {
        report(
          "UNCLASSIFIED_MUTATION_ROUTE_DELEGATION",
          `${method} ${file} reaches reviewed project writer ${exposesReviewedWriter.sourceFile}:${exposesReviewedWriter.symbol} without a mutation manifest entry`,
          file,
          exposesReviewedWriter.call,
        );
      }
    }
  }
}

function containsObjectPropertyLiteral(node, name, expected) {
  return descendants(node, ts.isObjectLiteralExpression).some((object) =>
    objectPropertyHasLiteral(object, name, expected),
  );
}

async function validateDemoClassificationContracts() {
  const publicIds = new Set(PUBLIC_DEMO_SURFACES.map((surface) => surface.id));
  const dependencyFiles = new Set();
  for (const dependency of PUBLIC_DEMO_SHARED_DEPENDENCIES) {
    const consumers = dependency.consumers ?? [];
    if (
      dependencyFiles.has(dependency.sourceFile) ||
      consumers.length === 0 ||
      new Set(consumers).size !== consumers.length ||
      consumers.some((consumer) => !publicIds.has(consumer))
    ) {
      report(
        "PUBLIC_DEMO_DEPENDENCY_CONSUMERS",
        `${dependency.sourceFile} must name unique existing public-surface consumers`,
      );
    }
    dependencyFiles.add(dependency.sourceFile);
  }

  for (const dependency of DEMO_RESOLVER_SHARED_DEPENDENCIES) {
    if (
      dependency.sourceFile !== "src/server/api/access.ts" ||
      JSON.stringify(dependency.consumers) !==
        JSON.stringify(["all-role-demo-write-guard"])
    ) {
      report(
        "DEMO_RESOLVER_DEPENDENCY_CONSUMERS",
        "the central demo resolver dependency must remain scoped to the all-role write guard",
      );
    }
    const access = await parsed(dependency.sourceFile);
    const writable = functionFor(access, "resolveWritableProjectOrThrow");
    if (
      !writable ||
      !containsObjectPropertyLiteral(writable, "allowDemo", true) ||
      !hasCall(writable, ["assertProjectWritable"])
    ) {
      report(
        "DEMO_RESOLVER_DEPENDENCY_POLICY",
        "the shared resolver must expose demo rows only to the canonical all-role write denial",
        dependency.sourceFile,
        writable ?? access.source,
      );
    }
  }

  const classifiedPublic = new Set(
    PUBLIC_DEMO_SURFACES.map((surface) => `${surface.route}:${surface.method}`),
  );
  const seen = new Set();
  for (const surface of EXPLICIT_NON_PUBLIC_DEMO_SURFACES) {
    const key = `${surface.route}:${surface.method}`;
    const routeFile = `src/app/api${surface.route.slice("/api".length)}/route.ts`;
    if (
      seen.has(key) ||
      classifiedPublic.has(key) ||
      surface.policy !== "deny-demo"
    ) {
      report(
        "NON_PUBLIC_DEMO_SURFACE_CLASSIFICATION",
        `${surface.method} ${surface.route} must be a unique deny-demo surface disjoint from public routes`,
      );
    }
    seen.add(key);
    let route;
    let source;
    try {
      [route, source] = await Promise.all([
        parsed(routeFile),
        parsed(surface.sourceFile),
      ]);
    } catch {
      report(
        "NON_PUBLIC_DEMO_SURFACE_SOURCE",
        `${surface.method} ${surface.route} points to a missing route or source`,
        routeFile,
      );
      continue;
    }
    const handler = exportedRouteHandler(route, surface.method);
    const target = functionFor(source, surface.symbol);
    const delegates = handler
      ? await Promise.all(
          importedCallsTransitively(route, handler).map((call) =>
            importedCallReachesChecks(call, [
              [surface.sourceFile, surface.symbol],
            ]),
          ),
        )
      : [];
    if (
      !handler ||
      !target ||
      routeAuthLiteral(route, surface.method) !== "none" ||
      !delegates.some(Boolean) ||
      (!containsObjectPropertyLiteral(handler, "allowDemo", false) &&
        !containsObjectPropertyLiteral(target, "allowDemo", false))
    ) {
      report(
        "NON_PUBLIC_DEMO_SURFACE_POLICY",
        `${surface.method} ${surface.route} must delegate only through an explicit allowDemo:false boundary`,
        routeFile,
        handler ?? route.source,
      );
    }
  }
}

async function validateDemoRouteCoverage() {
  const demoRoutes = (await walk("src/app/api/demo")).filter((file) =>
    file.endsWith("/route.ts"),
  );
  const classified = new Set(
    PUBLIC_DEMO_SURFACES.map((surface) => surface.routeFile),
  );
  for (const file of demoRoutes) {
    if (!classified.has(file)) {
      const source = await parsed(file);
      report(
        "UNCLASSIFIED_PUBLIC_DEMO_ROUTE",
        `${file} is absent from PUBLIC_DEMO_SURFACES`,
        file,
        source.source,
      );
    }
  }
}

function exactIdentifierArray(node, identifiers) {
  const value = unwrapExpression(node);
  return Boolean(
    value &&
    ts.isArrayLiteralExpression(value) &&
    value.elements.length === identifiers.length &&
    identifiers.every((identifier, index) => {
      const element = unwrapExpression(value.elements[index]);
      return element && ts.isIdentifier(element) && element.text === identifier;
    }),
  );
}

function projectStorageWriteBoundaryIssues(parsedFile) {
  const issues = new Set();
  const seed = unwrapExpression(
    variableInitializer(
      parsedFile.source,
      "PROJECT_STORAGE_ADVISORY_LOCK_SEED",
    ),
  );
  if (
    !seed ||
    numericConstantValue(seed) !== 2026071401 ||
    !isExportedDeclaration(
      parsedFile.source,
      "PROJECT_STORAGE_ADVISORY_LOCK_SEED",
    )
  ) {
    issues.add("shared-advisory-lock-seed");
  }

  const lockRoot = functionFor(parsedFile, "lockProjectStorageRoot");
  const lockExecute = lockRoot
    ? descendants(lockRoot, ts.isCallExpression).find(
        (call) =>
          callName(call) === "execute" && rootReceiverIdentifier(call) === "tx",
      )
    : null;
  const lockSql = lockExecute
    ? descendants(lockExecute, ts.isTaggedTemplateExpression).find((sqlNode) =>
        sqlHasAll(sqlNode, [
          "select",
          "pg_advisory_xact_lock",
          "hashtextextended",
        ]),
      )
    : null;
  if (
    !lockRoot ||
    !isExportedDeclaration(parsedFile.source, "lockProjectStorageRoot") ||
    !lockExecute ||
    !directAwaitContains(lockExecute) ||
    !lockSql ||
    !hasAllIdentifiers(lockSql, [
      "storageRoot",
      "PROJECT_STORAGE_ADVISORY_LOCK_SEED",
    ]) ||
    !hasStringLiteral(lockRoot, ["Project storage root is required"])
  ) {
    issues.add("transaction-scoped-storage-lock");
  }

  const storageBoundary = functionFor(parsedFile, "withProjectStorageWrite");
  const storageDelegate = storageBoundary
    ? descendants(storageBoundary, ts.isCallExpression).find(
        (call) => callName(call) === "withProjectWritesInternal",
      )
    : null;
  if (
    !storageBoundary ||
    !isExportedDeclaration(parsedFile.source, "withProjectStorageWrite") ||
    !hasCall(storageBoundary, ["assertCapabilityBinding"]) ||
    !storageDelegate ||
    storageDelegate.arguments.length !== 3 ||
    !exactIdentifierArray(storageDelegate.arguments[0], ["capability"]) ||
    !exactIdentifierArray(storageDelegate.arguments[1], ["storageRoot"]) ||
    !ts.isIdentifier(unwrapExpression(storageDelegate.arguments[2])) ||
    unwrapExpression(storageDelegate.arguments[2]).text !== "write"
  ) {
    issues.add("storage-boundary-delegation");
  }

  const ordinaryPluralBoundary = functionFor(parsedFile, "withProjectWrites");
  const ordinaryDelegate = ordinaryPluralBoundary
    ? descendants(ordinaryPluralBoundary, ts.isCallExpression).find(
        (call) => callName(call) === "withProjectWritesInternal",
      )
    : null;
  if (
    !ordinaryDelegate ||
    ordinaryDelegate.arguments.length !== 3 ||
    !ts.isIdentifier(unwrapExpression(ordinaryDelegate.arguments[0])) ||
    unwrapExpression(ordinaryDelegate.arguments[0]).text !== "capabilities" ||
    !exactIdentifierArray(ordinaryDelegate.arguments[1], [])
  ) {
    issues.add("ordinary-boundary-cannot-lock-storage");
  }

  const existingTransactionBoundary = functionFor(
    parsedFile,
    "withProjectWritesInTransaction",
  );
  const existingTransactionDelegate = existingTransactionBoundary
    ? descendants(existingTransactionBoundary, ts.isCallExpression).filter(
        (call) => callName(call) === "withProjectWritesOnTransaction",
      )
    : [];
  const existingStorageBoundary = functionFor(
    parsedFile,
    "withProjectStorageWritesInTransaction",
  );
  const existingStorageDelegates = existingStorageBoundary
    ? descendants(existingStorageBoundary, ts.isCallExpression).filter(
        (call) => callName(call) === "withProjectWritesOnTransaction",
      )
    : [];
  if (
    !existingTransactionBoundary ||
    !isExportedDeclaration(
      parsedFile.source,
      "withProjectWritesInTransaction",
    ) ||
    existingTransactionDelegate.length !== 1 ||
    compactNodeText(existingTransactionDelegate[0], parsedFile) !==
      "withProjectWritesOnTransaction(tx,capabilities,[],write)"
  ) {
    issues.add("existing-transaction-boundary-delegation");
  }
  const storageDelegateText = compactNodeText(
    existingStorageDelegates[0],
    parsedFile,
  );
  if (
    !existingStorageBoundary ||
    !isExportedDeclaration(
      parsedFile.source,
      "withProjectStorageWritesInTransaction",
    ) ||
    existingStorageDelegates.length !== 1 ||
    !storageDelegateText.startsWith(
      "withProjectWritesOnTransaction(tx,[...storageWrites.map((storageWrite)=>storageWrite.capability),...additionalCapabilities,],",
    ) ||
    !storageDelegateText.endsWith(
      "storageWrites.map((storageWrite)=>storageWrite.storageRoot),write,)",
    ) ||
    !hasCall(existingStorageBoundary, ["assertCapabilityBinding"]) ||
    !hasStringLiteral(existingStorageBoundary, [
      "Project storage root is required",
    ])
  ) {
    issues.add("existing-storage-transaction-boundary-delegation");
  }

  const internal = functionFor(parsedFile, "withProjectWritesInternal");
  const transactionCalls = internal
    ? descendants(internal, ts.isCallExpression).filter(
        (call) =>
          callName(call) === "transaction" &&
          rootReceiverIdentifier(call) === "db",
      )
    : [];
  const transactionCallback =
    transactionCalls.length === 1
      ? callbackArgumentForCall(transactionCalls[0], 0, parsedFile)
      : null;
  const transactionName = transactionCallback
    ? callbackTransactionIdentifier(transactionCallback, parsedFile)
    : null;
  const internalDelegate = transactionCallback
    ? descendants(transactionCallback, ts.isCallExpression).filter(
        (call) => callName(call) === "withProjectWritesOnTransaction",
      )
    : [];
  if (
    !internal ||
    transactionCalls.length !== 1 ||
    !transactionCallback ||
    transactionName !== "tx" ||
    internalDelegate.length !== 1 ||
    compactNodeText(internalDelegate[0], parsedFile) !==
      "withProjectWritesOnTransaction(tx,capabilities,storageRoots,write)"
  ) {
    issues.add("transaction-opener-delegation");
  }

  const onTransaction = functionFor(
    parsedFile,
    "withProjectWritesOnTransaction",
  );
  const byProjectId = onTransaction
    ? namedVariableDeclaration(onTransaction, "byProjectId")
    : null;
  const ordered = onTransaction
    ? namedVariableDeclaration(onTransaction, "ordered")
    : null;
  const storageLoop = onTransaction
    ? descendants(onTransaction, ts.isForOfStatement).find(
        (statement) =>
          compactNodeText(statement.expression, parsedFile) ===
          "[...newSet(storageRoots)].sort()",
      )
    : null;
  const projectLoop = onTransaction
    ? descendants(onTransaction, ts.isForOfStatement).find(
        (statement) =>
          compactNodeText(statement.expression, parsedFile) === "ordered",
      )
    : null;
  const storageLock = storageLoop
    ? descendants(storageLoop, ts.isCallExpression).find((call) => {
        if (
          callName(call) !== "lockProjectStorageRoot" ||
          call.arguments.length !== 2
        )
          return false;
        const txArgument = unwrapExpression(call.arguments[0]);
        const rootArgument = unwrapExpression(call.arguments[1]);
        return (
          txArgument &&
          ts.isIdentifier(txArgument) &&
          txArgument.text === "tx" &&
          rootArgument &&
          ts.isIdentifier(rootArgument) &&
          rootArgument.text === "storageRoot" &&
          directAwaitContains(call)
        );
      })
    : null;
  const parentLock = projectLoop
    ? descendants(projectLoop, ts.isCallExpression).find(
        (call) =>
          callName(call) === "for" &&
          literalValue(call.arguments[0]) === "update" &&
          hasAllIdentifiers(call, [
            "tx",
            "projects",
            "capability",
            "projectId",
            "lifecycleEpoch",
          ]),
      )
    : null;
  const lockedValidation = projectLoop
    ? descendants(projectLoop, ts.isCallExpression).find(
        (call) => callName(call) === "assertLockedProjectWritable",
      )
    : null;
  const tailWrite = onTransaction
    ? descendants(onTransaction, ts.isReturnStatement).find(
        (statement) =>
          compactNodeText(statement.expression, parsedFile) === "write(tx)",
      )
    : null;
  const conflictingCapabilityGuard = onTransaction
    ? descendants(onTransaction, ts.isIfStatement).find((statement) =>
        hasStringLiteral(statement.thenStatement, [
          "Conflicting project write capabilities",
        ]),
      )
    : null;
  if (
    !onTransaction ||
    descendants(onTransaction, ts.isCallExpression).some(
      (call) => callName(call) === "transaction",
    )
  ) {
    issues.add("existing-transaction-core-opens-no-nested-transaction");
  }
  if (
    compactNodeText(byProjectId?.initializer, parsedFile) !==
      "newMap<number,ProjectWriteCapability>()" ||
    compactNodeText(ordered?.initializer, parsedFile) !==
      "[...byProjectId.values()].sort((a,b)=>a.projectId-b.projectId,)" ||
    !conflictingCapabilityGuard ||
    !hasAllIdentifiers(conflictingCapabilityGuard.expression, [
      "publicId",
      "companyId",
      "lifecycleEpoch",
    ])
  ) {
    issues.add("deduplicated-conflict-checked-ascending-project-order");
  }
  if (
    !storageLoop ||
    !projectLoop ||
    !storageLock ||
    !parentLock ||
    !lockedValidation ||
    !tailWrite ||
    storageLock.getStart() >= parentLock.getStart() ||
    parentLock.getStart() >= lockedValidation.getStart() ||
    lockedValidation.getStart() >= tailWrite.getStart()
  ) {
    issues.add("storage-lock-before-parent-for-update");
  }
  return issues;
}

async function validateCrossTenantAndCapabilitySemantics() {
  const takeoffFile = await parsed("src/server/services/takeoff.ts");
  for (const symbol of ["createTakeoffItem", "updateTakeoffItem"]) {
    const target = functionFor(takeoffFile, symbol);
    if (!target) continue;
    const validatesGroupProject = functionTransitivelyMatches(
      takeoffFile,
      target,
      (fn) => hasAllIdentifiers(fn, ["takeoffGroups", "groupId", "projectId"]),
    );
    if (!validatesGroupProject) {
      report(
        "TAKEOFF_GROUP_NOT_PROJECT_SCOPED",
        `${symbol} accepts groupId without proving the group belongs to the item project`,
        "src/server/services/takeoff.ts",
        target,
      );
    }
  }

  for (const symbol of ["updateTakeoffItem", "deleteTakeoffItem"]) {
    const target = functionFor(takeoffFile, symbol);
    if (!target) continue;
    const annotationMutations = descendants(
      target,
      ts.isTaggedTemplateExpression,
    ).filter((sqlNode) => {
      const tokens = new Set(stringTokens(taggedSqlText(sqlNode) ?? ""));
      return (
        tokens.has("annotations") &&
        (tokens.has("update") || tokens.has("delete"))
      );
    });
    const projectScoped =
      annotationMutations.length > 0 &&
      annotationMutations.every((sqlNode) =>
        sqlHasAll(sqlNode, ["annotations", "project_id"]),
      );
    if (!projectScoped) {
      report(
        "TAKEOFF_ANNOTATION_MUTATION_NOT_PROJECT_SCOPED",
        `${symbol} must include project_id in every takeoff annotation mutation`,
        "src/server/services/takeoff.ts",
        target,
      );
    }
  }

  const deleteGroup = functionFor(takeoffFile, "deleteTakeoffGroup");
  if (deleteGroup) {
    const rejectsForeignReferences = functionTransitivelyMatches(
      takeoffFile,
      deleteGroup,
      (fn) =>
        hasAllIdentifiers(fn, ["takeoffItems", "groupId", "projectId"]) &&
        hasStringLiteral(fn, ["CONFLICT"]),
    );
    if (!rejectsForeignReferences) {
      report(
        "TAKEOFF_GROUP_DELETE_CROSSES_PROJECT_FK",
        "deleteTakeoffGroup must reject foreign-project item references before FK SET NULL",
        "src/server/services/takeoff.ts",
        deleteGroup,
      );
    }
  }

  const capabilityFile = await parsed(
    "src/server/api/project-write-capability.ts",
  );
  const assertCapability = functionFor(
    capabilityFile,
    "assertProjectWriteCapability",
  );
  if (assertCapability) {
    const revalidatesCurrentLifecycle = functionTransitivelyMatches(
      capabilityFile,
      assertCapability,
      (fn) =>
        hasAllIdentifiers(fn, ["projects", "isDemo", "lifecycleEpoch"]) &&
        hasCall(fn, [
          "select",
          "resolveProjectOrThrow",
          "resolveWritableProjectOrThrow",
        ]),
    );
    if (!revalidatesCurrentLifecycle) {
      report(
        "STALE_PROJECT_WRITE_CAPABILITY",
        "assertProjectWriteCapability must revalidate isDemo and lifecycleEpoch",
        "src/server/api/project-write-capability.ts",
        assertCapability,
      );
    }
  }

  const boundaryIssues = projectStorageWriteBoundaryIssues(capabilityFile);
  if (boundaryIssues.size > 0) {
    report(
      "PROJECT_WRITE_BOUNDARY_NOT_PARENT_FIRST",
      `project write/storage boundary violates: ${[...boundaryIssues].sort().join(", ")}`,
      "src/server/api/project-write-capability.ts",
      functionFor(capabilityFile, "withProjectWritesInternal") ??
        capabilityFile.source,
    );
  }
}

async function validateSchemaDerivedOwnership() {
  const schemaFileName = "src/lib/db/schema.ts";
  const schema = await parsed(schemaFileName);
  const tableGraph = schemaTableGraph(schema);
  const derived = transitiveProjectOwnedTables(tableGraph);
  const exemptions = new Set(
    PROJECT_FK_TABLE_EXEMPTIONS.map((item) => item.table),
  );
  const declaredProtected = new Set(PROJECT_OWNED_TABLES);
  const { protectedTables, missingFromManifest, notSchemaOwned } =
    projectOwnershipDrift(derived, exemptions, declaredProtected);
  if (missingFromManifest.length > 0 || notSchemaOwned.length > 0) {
    report(
      "PROJECT_OWNERSHIP_SCHEMA_DRIFT",
      `schema-derived ownership differs from manifest (missing: ${missingFromManifest.join(", ") || "none"}; extra: ${notSchemaOwned.join(", ") || "none"})`,
      schemaFileName,
      schema.source,
    );
  }

  for (const exemption of PROJECT_FK_TABLE_EXEMPTIONS) {
    const table = tableGraph.get(exemption.table);
    const projectReference = table?.references.find(
      (reference) =>
        reference.target === "projects" && reference.field === "projectId",
    );
    if (
      !table ||
      !derived.has(exemption.table) ||
      table.sqlName !== exemption.sqlTable ||
      !projectReference ||
      projectReference.nullable !== exemption.projectReference.nullable ||
      projectReference.onDelete !== exemption.projectReference.onDelete
    ) {
      report(
        "PROJECT_FK_EXEMPTION_SCHEMA_DRIFT",
        `${exemption.table} exemption requires a nullable projectId FK with ON DELETE ${exemption.projectReference.onDelete}`,
        schemaFileName,
        table?.node ?? schema.source,
      );
    }
  }

  for (const item of DEMO_WRITE_TRIGGER_INVENTORY) {
    const table = tableGraph.get(item.table);
    if (!table || table.sqlName !== item.sqlTable) {
      report(
        "TRIGGER_SCHEMA_TABLE_DRIFT",
        `${item.table} trigger inventory does not match its schema table name`,
        schemaFileName,
        table?.node ?? schema.source,
      );
    }
  }

  return { tableGraph, derived, protectedTables, exemptions };
}

function exactModelUploadSigner(parsedFile, target) {
  if (!target) return false;
  const modelPath = variableInitializer(target, "s3Path");
  const modelKey = variableInitializer(target, "key");
  const presignLocals = namedImportLocals(
    parsedFile,
    "@aws-sdk/s3-presigned-post",
    "createPresignedPost",
  );
  const presigns = descendants(target, ts.isCallExpression).filter((call) =>
    presignLocals.has(callName(call)),
  );
  const options = presigns[0] ? objectArgumentForCall(presigns[0], 1) : null;
  const signedKey = options
    ? unwrapExpression(propertyInitializer(options, "Key"))
    : null;
  const storageBinding = importedBindings(parsedFile).get(
    "canonicalModelStoragePath",
  );
  return Boolean(
    target.parameters[0]?.name &&
    ts.isIdentifier(target.parameters[0].name) &&
    target.parameters[0].name.text === "modelName" &&
    modelPath &&
    exactIdentifierCall(modelPath, "canonicalModelStoragePath", [
      "modelName",
    ]) &&
    storageBinding?.sourceFile === "src/lib/model-storage-authority.ts" &&
    storageBinding.symbol === "canonicalModelStoragePath" &&
    modelKey &&
    singleInterpolationTemplate(modelKey, "", "s3Path", "/model.pt") &&
    presigns.length === 1 &&
    signedKey &&
    ts.isIdentifier(signedKey) &&
    signedKey.text === "key" &&
    !hasStringLiteral(target, ["original.pdf"]),
  );
}

function exactCanonicalProjectPathAuthority(parsedFile) {
  const safeCompanyKey = functionFor(parsedFile, "isSafeCompanyDataKey");
  const canonicalPath = functionFor(parsedFile, "isCanonicalProjectPath");
  if (
    !safeCompanyKey ||
    !canonicalPath ||
    !isExportedDeclaration(parsedFile.source, "isSafeCompanyDataKey") ||
    !isExportedDeclaration(parsedFile.source, "isCanonicalProjectPath")
  )
    return false;

  const safeParameters = safeCompanyKey.parameters.map((parameter) =>
    ts.isIdentifier(parameter.name) ? parameter.name.text : "",
  );
  const safeRegexTest = descendants(safeCompanyKey, ts.isCallExpression).some(
    (call) => {
      if (callName(call) !== "test" || call.arguments.length !== 1)
        return false;
      const callee = unwrapExpression(call.expression);
      const regex =
        callee && ts.isPropertyAccessExpression(callee)
          ? unwrapExpression(callee.expression)
          : null;
      const argument = unwrapExpression(call.arguments[0]);
      return Boolean(
        regex &&
        ts.isRegularExpressionLiteral(regex) &&
        regex.getText() === "/^[a-z0-9-]+$/" &&
        argument &&
        ts.isIdentifier(argument) &&
        argument.text === "dataKey",
      );
    },
  );
  const reservedInitializer = unwrapExpression(
    variableInitializer(parsedFile.source, "RESERVED_STORAGE_ROOTS"),
  );
  const reservedValues =
    reservedInitializer &&
    ts.isNewExpression(reservedInitializer) &&
    propertyName(reservedInitializer.expression) === "Set" &&
    reservedInitializer.arguments?.[0] &&
    ts.isArrayLiteralExpression(
      unwrapExpression(reservedInitializer.arguments[0]),
    )
      ? unwrapExpression(reservedInitializer.arguments[0]).elements.map(
          (element) => {
            const value = unwrapExpression(element);
            if (value && ts.isIdentifier(value)) return value.text;
            return literalValue(value);
          },
        )
      : [];
  const exactReservedRoots =
    JSON.stringify(reservedValues) ===
    JSON.stringify([
      "PROJECT_UPLOAD_STAGING_ROOT",
      "_bp-public",
      "models",
      "tmp",
      "config",
      "csi-databases",
    ]);
  const rejectsReservedRoot = descendants(
    safeCompanyKey,
    ts.isPrefixUnaryExpression,
  ).some((expression) => {
    if (expression.operator !== ts.SyntaxKind.ExclamationToken) return false;
    const call = unwrapExpression(expression.operand);
    return Boolean(
      call &&
      ts.isCallExpression(call) &&
      callName(call) === "has" &&
      rootReceiverIdentifier(call) === "RESERVED_STORAGE_ROOTS" &&
      call.arguments.length === 1 &&
      exactPropertyPath(call.arguments[0], ["dataKey"]),
    );
  });

  const canonicalParameters = canonicalPath.parameters.map((parameter) =>
    ts.isIdentifier(parameter.name) ? parameter.name.text : "",
  );
  const safeKeyGuard = descendants(canonicalPath, ts.isIfStatement).some(
    (statement) => {
      const rejectsUnsafe = descendants(
        statement.expression,
        ts.isPrefixUnaryExpression,
      ).some(
        (expression) =>
          expression.operator === ts.SyntaxKind.ExclamationToken &&
          exactIdentifierCall(expression.operand, "isSafeCompanyDataKey", [
            "dataKey",
          ]),
      );
      return (
        rejectsUnsafe &&
        descendants(statement.thenStatement, ts.isReturnStatement).some(
          (returnStatement) =>
            literalValue(returnStatement.expression) === false,
        )
      );
    },
  );
  const prefix = variableInitializer(canonicalPath, "prefix");
  const finalReturn = directReturnExpressions(canonicalPath)
    .map(unwrapExpression)
    .find(
      (expression) =>
        expression &&
        ts.isBinaryExpression(expression) &&
        expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken,
    );
  const startsWithPrefix =
    finalReturn &&
    ts.isBinaryExpression(finalReturn) &&
    unwrapExpression(finalReturn.left) &&
    ts.isCallExpression(unwrapExpression(finalReturn.left)) &&
    callName(unwrapExpression(finalReturn.left)) === "startsWith" &&
    rootReceiverIdentifier(unwrapExpression(finalReturn.left)) ===
      "projectPath" &&
    unwrapExpression(finalReturn.left).arguments[0] &&
    ts.isIdentifier(
      unwrapExpression(unwrapExpression(finalReturn.left).arguments[0]),
    ) &&
    unwrapExpression(unwrapExpression(finalReturn.left).arguments[0]).text ===
      "prefix";
  const exactSuffixTest =
    finalReturn &&
    ts.isBinaryExpression(finalReturn) &&
    (() => {
      const testCall = unwrapExpression(finalReturn.right);
      if (
        !testCall ||
        !ts.isCallExpression(testCall) ||
        callName(testCall) !== "test"
      )
        return false;
      const callee = unwrapExpression(testCall.expression);
      const regex =
        callee && ts.isPropertyAccessExpression(callee)
          ? unwrapExpression(callee.expression)
          : null;
      const slice = testCall.arguments[0]
        ? unwrapExpression(testCall.arguments[0])
        : null;
      return Boolean(
        regex &&
        ts.isRegularExpressionLiteral(regex) &&
        regex.getText() === "/^[a-f0-9]{20}$/" &&
        slice &&
        ts.isCallExpression(slice) &&
        callName(slice) === "slice" &&
        rootReceiverIdentifier(slice) === "projectPath" &&
        slice.arguments[0] &&
        exactPropertyPath(slice.arguments[0], ["prefix", "length"]),
      );
    })();

  return (
    JSON.stringify(safeParameters) === JSON.stringify(["dataKey"]) &&
    safeRegexTest &&
    exactReservedRoots &&
    rejectsReservedRoot &&
    JSON.stringify(canonicalParameters) ===
      JSON.stringify(["dataKey", "projectPath"]) &&
    safeKeyGuard &&
    prefix &&
    singleInterpolationTemplate(prefix, "", "dataKey", "/") &&
    startsWithPrefix &&
    exactSuffixTest
  );
}

function exactModelStorageAuthority(parsedFile) {
  const root = unwrapExpression(
    variableInitializer(parsedFile.source, "MODEL_STORAGE_ROOT"),
  );
  const slugFunction = functionFor(parsedFile, "canonicalModelSlug");
  const pathFunction = functionFor(parsedFile, "canonicalModelStoragePath");
  const predicateFunction = functionFor(
    parsedFile,
    "isCanonicalModelStoragePath",
  );
  if (
    literalValue(root) !== "models" ||
    !isExportedDeclaration(parsedFile.source, "MODEL_STORAGE_ROOT") ||
    !slugFunction ||
    !pathFunction ||
    !predicateFunction ||
    !isExportedDeclaration(parsedFile.source, "canonicalModelSlug") ||
    !isExportedDeclaration(parsedFile.source, "canonicalModelStoragePath") ||
    !isExportedDeclaration(parsedFile.source, "isCanonicalModelStoragePath")
  )
    return false;

  const slugParameters = slugFunction.parameters.map((parameter) =>
    ts.isIdentifier(parameter.name) ? parameter.name.text : "",
  );
  const slugReturn =
    directReturnExpressions(slugFunction).map(unwrapExpression)[0];
  const slugReplace =
    slugReturn &&
    ts.isCallExpression(slugReturn) &&
    callName(slugReturn) === "replace"
      ? slugReturn
      : null;
  const slugRegex = slugReplace?.arguments[0]
    ? unwrapExpression(slugReplace.arguments[0])
    : null;
  const lowerCall = slugReplace
    ? descendants(slugReplace.expression, ts.isCallExpression).find(
        (call) => callName(call) === "toLowerCase",
      )
    : null;
  const slugIsExact = Boolean(
    JSON.stringify(slugParameters) === JSON.stringify(["name"]) &&
    slugReplace &&
    slugRegex &&
    ts.isRegularExpressionLiteral(slugRegex) &&
    slugRegex.getText() === "/[^a-z0-9-]/g" &&
    literalValue(slugReplace.arguments[1]) === "-" &&
    lowerCall &&
    rootReceiverIdentifier(lowerCall) === "name",
  );

  const pathParameters = pathFunction.parameters.map((parameter) =>
    ts.isIdentifier(parameter.name) ? parameter.name.text : "",
  );
  const pathReturn =
    directReturnExpressions(pathFunction).map(unwrapExpression)[0];
  const pathIsExact =
    JSON.stringify(pathParameters) === JSON.stringify(["name"]) &&
    exactModelStorageTemplate(
      pathReturn,
      (expression) =>
        expression &&
        ts.isCallExpression(expression) &&
        exactIdentifierCall(expression, "canonicalModelSlug", ["name"]),
    );

  const predicateParameters = predicateFunction.parameters.map((parameter) =>
    ts.isIdentifier(parameter.name) ? parameter.name.text : "",
  );
  const slugInitializer = variableInitializer(predicateFunction, "slug");
  const predicateReturn = directReturnExpressions(predicateFunction)
    .map(unwrapExpression)
    .find(
      (expression) =>
        expression &&
        ts.isBinaryExpression(expression) &&
        expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken,
    );
  const nonemptySlug =
    predicateReturn &&
    ts.isBinaryExpression(predicateReturn) &&
    descendants(predicateReturn.left, ts.isBinaryExpression).some(
      (binary) =>
        binary.operatorToken.kind === ts.SyntaxKind.GreaterThanToken &&
        exactPropertyPath(binary.left, ["slug", "length"]) &&
        literalValue(binary.right) === "0",
    );
  const exactPath =
    predicateReturn &&
    ts.isBinaryExpression(predicateReturn) &&
    descendants(predicateReturn.right, ts.isBinaryExpression).some(
      (binary) =>
        binary.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        exactPropertyPath(binary.left, ["s3Path"]) &&
        exactModelStorageTemplate(
          binary.right,
          (expression) =>
            expression &&
            ts.isIdentifier(expression) &&
            expression.text === "slug",
        ),
    );
  const predicateIsExact =
    JSON.stringify(predicateParameters) ===
      JSON.stringify(["name", "s3Path"]) &&
    slugInitializer &&
    exactIdentifierCall(slugInitializer, "canonicalModelSlug", ["name"]) &&
    nonemptySlug &&
    exactPath;
  return Boolean(slugIsExact && pathIsExact && predicateIsExact);
}

function stagingS3VersionIssues(parsedFile) {
  const issues = new Set();
  const head = functionFor(parsedFile, "headS3Object");
  const download = functionFor(parsedFile, "downloadFromS3");
  const headVersion =
    head &&
    descendants(head, ts.isPropertyAssignment).some(
      (assignment) =>
        propertyName(assignment.name) === "versionId" &&
        exactPropertyPath(assignment.initializer, ["res", "VersionId"]),
    );
  if (!head || !headVersion) issues.add("head-returns-version-id");

  const downloadParameters =
    download?.parameters.map((parameter) =>
      ts.isIdentifier(parameter.name) ? parameter.name.text : "",
    ) ?? [];
  const versionedGet =
    download &&
    descendants(download, ts.isNewExpression).some((expression) => {
      if (
        propertyName(expression.expression) !== "GetObjectCommand" ||
        !expression.arguments?.[0]
      )
        return false;
      const options = unwrapExpression(expression.arguments[0]);
      if (!options || !ts.isObjectLiteralExpression(options)) return false;
      const key = unwrapExpression(propertyInitializer(options, "Key"));
      const versionId = unwrapExpression(
        propertyInitializer(options, "VersionId"),
      );
      return Boolean(
        key &&
        ts.isIdentifier(key) &&
        key.text === "key" &&
        versionId &&
        ts.isIdentifier(versionId) &&
        versionId.text === "versionId",
      );
    });
  if (
    !download ||
    JSON.stringify(downloadParameters) !==
      JSON.stringify(["key", "versionId"]) ||
    !versionedGet
  ) {
    issues.add("get-uses-version-id");
  }
  return issues;
}

function projectManifestVersionIssues(parsedFile, target) {
  const issues = new Set();
  if (!target) return new Set(["missing-symbol"]);
  const projectInsert = descendants(target, ts.isCallExpression).find(
    (call) =>
      callName(call) === "insert" &&
      propertyName(call.arguments[0]) === "projects",
  );
  const boundary = projectInsert?.getStart() ?? Number.POSITIVE_INFINITY;
  const versionGuard = descendants(target, ts.isIfStatement).find(
    (statement) => {
      if (statement.getStart() >= boundary) return false;
      const rejectsMissing = descendants(
        statement.expression,
        ts.isPrefixUnaryExpression,
      ).some(
        (expression) =>
          expression.operator === ts.SyntaxKind.ExclamationToken &&
          exactPropertyPath(expression.operand, ["h", "head", "versionId"]),
      );
      const rejectsNullVersion = descendants(
        statement.expression,
        ts.isBinaryExpression,
      ).some((binary) => {
        if (binary.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken)
          return false;
        return (
          (exactPropertyPath(binary.left, ["h", "head", "versionId"]) &&
            literalValue(binary.right) === "null") ||
          (exactPropertyPath(binary.right, ["h", "head", "versionId"]) &&
            literalValue(binary.left) === "null")
        );
      });
      return (
        rejectsMissing &&
        rejectsNullVersion &&
        hasTextStarting(
          statement.thenStatement,
          "Staged file is not version-pinned: ",
        )
      );
    },
  );
  if (!versionGuard) issues.add("reject-unversioned-head");

  const manifestInitializer = variableInitializer(target, "stagingManifest");
  const mapCall = unwrapExpression(manifestInitializer);
  const mapCallback =
    mapCall && ts.isCallExpression(mapCall) && callName(mapCall) === "map"
      ? callbackArgumentForCall(mapCall, 0, parsedFile)
      : null;
  const manifestObject = mapCallback
    ? directReturnExpressions(mapCallback)
        .map(unwrapExpression)
        .find(ts.isObjectLiteralExpression)
    : null;
  const manifestVersion = manifestObject
    ? unwrapExpression(propertyInitializer(manifestObject, "versionId"))
    : null;
  const manifestSize = manifestObject
    ? unwrapExpression(propertyInitializer(manifestObject, "size"))
    : null;
  if (
    !manifestObject ||
    !manifestVersion ||
    !exactPropertyPath(manifestVersion, ["h", "head", "versionId"]) ||
    !manifestSize ||
    !hasAllIdentifiers(manifestSize, ["h", "head", "size"])
  ) {
    issues.add("manifest-persists-version-and-size");
  }
  const insertValues = projectInsert
    ? chainedCall(projectInsert, "values")
    : null;
  if (
    !projectInsert ||
    !insertValues ||
    !hasIdentifier(insertValues, ["stagingManifest"])
  ) {
    issues.add("versioned-manifest-before-project-insert");
  }
  return issues;
}

function processingVersionReadIssues(parsedFile, target) {
  const issues = new Set();
  if (!target) return new Set(["missing-symbol"]);
  const downloads = descendants(target, ts.isCallExpression).filter(
    (call) => callName(call) === "downloadFromS3",
  );
  const download = downloads[0];
  const versionGuard =
    download &&
    descendants(target, ts.isIfStatement).find(
      (statement) =>
        statement.getStart() < download.getStart() &&
        descendants(statement.expression, ts.isPrefixUnaryExpression).some(
          (expression) =>
            expression.operator === ts.SyntaxKind.ExclamationToken &&
            exactPropertyPath(expression.operand, ["sf", "versionId"]),
        ) &&
        hasTextStarting(
          statement.thenStatement,
          "Staged file is missing its immutable S3 version: ",
        ),
    );
  if (
    downloads.length !== 1 ||
    !download ||
    download.arguments.length !== 2 ||
    !exactPropertyPath(download.arguments[0], ["sf", "stagingKey"]) ||
    !exactPropertyPath(download.arguments[1], ["sf", "versionId"]) ||
    !versionGuard
  ) {
    issues.add("versioned-download-before-use");
  }

  const sizeGuard =
    download &&
    descendants(target, ts.isIfStatement).find(
      (statement) =>
        statement.getStart() > download.getStart() &&
        descendants(statement.expression, ts.isBinaryExpression).some(
          (binary) => {
            if (
              binary.operatorToken.kind !==
              ts.SyntaxKind.ExclamationEqualsEqualsToken
            )
              return false;
            return (
              (exactPropertyPath(binary.left, ["buf", "byteLength"]) &&
                exactPropertyPath(binary.right, ["sf", "size"])) ||
              (exactPropertyPath(binary.right, ["buf", "byteLength"]) &&
                exactPropertyPath(binary.left, ["sf", "size"]))
            );
          },
        ) &&
        hasTextStarting(
          statement.thenStatement,
          "Staged file size changed after validation: ",
        ),
    );
  if (!sizeGuard) issues.add("download-size-revalidated");
  return issues;
}

function projectCreateStorageRootIssues(parsedFile, target) {
  const issues = new Set();
  if (!target) return new Set(["missing-symbol"]);
  const lockBinding = importedBindings(parsedFile).get(
    "lockProjectStorageRoot",
  );
  if (
    lockBinding?.sourceFile !== "src/server/api/project-write-capability.ts" ||
    lockBinding.symbol !== "lockProjectStorageRoot"
  ) {
    issues.add("shared-storage-lock-import");
  }

  const transactions = descendants(target, ts.isCallExpression).filter(
    (call) =>
      callName(call) === "transaction" && rootReceiverIdentifier(call) === "db",
  );
  const transaction = transactions.find((call) => {
    const callback = callbackArgumentForCall(call, 0, parsedFile);
    return (
      callback &&
      descendants(callback, ts.isCallExpression).some(
        (candidate) =>
          callName(candidate) === "insert" &&
          exactPropertyPath(candidate.arguments[0], ["projects"]),
      )
    );
  });
  const callback = transaction
    ? callbackArgumentForCall(transaction, 0, parsedFile)
    : null;
  const transactionName = callback
    ? callbackTransactionIdentifier(callback, parsedFile)
    : null;
  if (!transaction || !callback || transactionName !== "tx") {
    return new Set([...issues, "single-create-transaction"]);
  }

  const lock = descendants(callback, ts.isCallExpression).find((call) => {
    if (
      callName(call) !== "lockProjectStorageRoot" ||
      call.arguments.length !== 2
    )
      return false;
    const tx = unwrapExpression(call.arguments[0]);
    const root = unwrapExpression(call.arguments[1]);
    return (
      tx &&
      ts.isIdentifier(tx) &&
      tx.text === transactionName &&
      root &&
      ts.isIdentifier(root) &&
      root.text === "dataUrl" &&
      directAwaitContains(call)
    );
  });
  const retiredWhere = descendants(callback, ts.isCallExpression).find(
    (call) => {
      if (callName(call) !== "where" || !call.arguments[0]) return false;
      return (
        descendants(call.arguments[0], ts.isCallExpression).some(
          (predicate) =>
            callName(predicate) === "eq" &&
            predicate.arguments.length === 2 &&
            exactPropertyPath(predicate.arguments[0], [
              "projectAssetDeletions",
              "storageRoot",
            ]) &&
            ts.isIdentifier(unwrapExpression(predicate.arguments[1])) &&
            unwrapExpression(predicate.arguments[1]).text === "dataUrl",
        ) && hasIdentifier(call, ["projectAssetDeletions"])
      );
    },
  );
  const retiredGuard = conflictGuard(
    callback,
    "Project storage root has been retired",
    ["retiredRoot"],
  );
  const projectInsert = descendants(callback, ts.isCallExpression).find(
    (call) =>
      callName(call) === "insert" &&
      exactPropertyPath(call.arguments[0], ["projects"]) &&
      rootReceiverIdentifier(call) === transactionName,
  );
  if (
    !lock ||
    !retiredWhere ||
    !retiredGuard ||
    !projectInsert ||
    lock.getStart() >= retiredWhere.getStart() ||
    retiredWhere.getStart() >= retiredGuard.getStart() ||
    retiredGuard.getStart() >= projectInsert.getStart()
  ) {
    issues.add("lock-tombstone-check-insert-order");
  }
  return issues;
}

async function validateProjectUploadAuthority(files) {
  const authorityFileName = "src/lib/project-upload-authority.ts";
  const authority = await parsed(authorityFileName);
  if (!exactCanonicalProjectPathAuthority(authority)) {
    report(
      "PROJECT_PATH_AUTHORITY_DRIFT",
      "project paths must use a slash-free nonreserved company key and one exact lowercase 20-hex segment",
      authorityFileName,
      functionFor(authority, "isCanonicalProjectPath") ?? authority.source,
    );
  }
  const stagingRoot = unwrapExpression(
    variableInitializer(authority.source, "PROJECT_UPLOAD_STAGING_ROOT"),
  );
  const stagingPrefix = functionFor(authority, "projectUploadStagingPrefix");
  const stagingPrefixReturns = stagingPrefix
    ? directReturnExpressions(stagingPrefix)
    : [];
  const stagingPrefixParameter = stagingPrefix?.parameters[0]?.name;
  if (
    literalValue(stagingRoot) !== "_bp-staging" ||
    !isExportedDeclaration(authority.source, "PROJECT_UPLOAD_STAGING_ROOT") ||
    !stagingPrefix ||
    !isExportedDeclaration(authority.source, "projectUploadStagingPrefix") ||
    !stagingPrefixParameter ||
    !ts.isIdentifier(stagingPrefixParameter) ||
    stagingPrefixParameter.text !== "projectPath" ||
    stagingPrefixReturns.length !== 1 ||
    !interpolationTemplateMatches(stagingPrefixReturns[0], "", [
      { identifier: "PROJECT_UPLOAD_STAGING_ROOT", suffix: "/" },
      { identifier: "projectPath", suffix: "/" },
    ])
  ) {
    report(
      "PROJECT_UPLOAD_STAGING_PREFIX",
      "browser uploads must use the exact isolated _bp-staging shared-prefix helper",
      authorityFileName,
      stagingPrefix ?? authority.source,
    );
  }
  const stagingKeyFunction = functionFor(authority, "projectUploadStagingKey");
  const stagingKeyReturns = stagingKeyFunction
    ? directReturnExpressions(stagingKeyFunction)
    : [];
  const stagingKeyParameters =
    stagingKeyFunction?.parameters.map((parameter) =>
      ts.isIdentifier(parameter.name) ? parameter.name.text : "",
    ) ?? [];
  const uploadFilenameSanitizer = functionFor(
    authority,
    "sanitizeProjectUploadFilename",
  );
  const sanitizerRegexes = uploadFilenameSanitizer
    ? descendants(uploadFilenameSanitizer, ts.isRegularExpressionLiteral).map(
        (literal) => literal.getText(),
      )
    : [];
  if (
    !stagingKeyFunction ||
    !isExportedDeclaration(authority.source, "projectUploadStagingKey") ||
    JSON.stringify(stagingKeyParameters) !==
      JSON.stringify(["projectPath", "filename", "index"]) ||
    stagingKeyReturns.length !== 1 ||
    !exactProjectStagingKeyTemplate(stagingKeyReturns[0]) ||
    !hasAllCalls(stagingKeyFunction, [
      "isSafeInteger",
      "toString",
      "padStart",
    ]) ||
    !hasStringLiteral(stagingKeyFunction, [
      "Invalid project upload staging index",
    ]) ||
    !uploadFilenameSanitizer ||
    !isExportedDeclaration(authority.source, "sanitizeProjectUploadFilename") ||
    !hasAllCalls(uploadFilenameSanitizer, [
      "split",
      "pop",
      "replace",
      "slice",
    ]) ||
    !sanitizerRegexes.some((regex) => regex.includes("[\\\\/]")) ||
    !sanitizerRegexes.some((regex) => regex.includes("[^A-Za-z0-9._-]"))
  ) {
    report(
      "PROJECT_UPLOAD_STAGING_KEY",
      "the shared staging-key helper must isolate, index, and path-sanitize every browser upload",
      authorityFileName,
      stagingKeyFunction ?? authority.source,
    );
  }
  const presignTtl = unwrapExpression(
    variableInitializer(authority.source, "PROJECT_UPLOAD_PRESIGN_TTL_SECONDS"),
  );
  const clockSkew = unwrapExpression(
    variableInitializer(authority.source, "PROJECT_UPLOAD_CLOCK_SKEW_SECONDS"),
  );
  const publicationFence = unwrapExpression(
    variableInitializer(
      authority.source,
      "PROJECT_UPLOAD_PUBLICATION_FENCE_SECONDS",
    ),
  );
  const fenceOperands =
    publicationFence &&
    ts.isBinaryExpression(publicationFence) &&
    publicationFence.operatorToken.kind === ts.SyntaxKind.PlusToken
      ? [
          unwrapExpression(publicationFence.left),
          unwrapExpression(publicationFence.right),
        ]
      : [];
  const exactFenceSum =
    fenceOperands.length === 2 &&
    new Set(
      fenceOperands.map((operand) =>
        ts.isIdentifier(operand) ? operand.text : "",
      ),
    ).size === 2 &&
    fenceOperands.some(
      (operand) =>
        ts.isIdentifier(operand) &&
        operand.text === "PROJECT_UPLOAD_PRESIGN_TTL_SECONDS",
    ) &&
    fenceOperands.some(
      (operand) =>
        ts.isIdentifier(operand) &&
        operand.text === "PROJECT_UPLOAD_CLOCK_SKEW_SECONDS",
    );
  if (
    !presignTtl ||
    (numericConstantValue(presignTtl) ?? 0) <= 0 ||
    !clockSkew ||
    (numericConstantValue(clockSkew) ?? 0) <= 0 ||
    !publicationFence ||
    !exactFenceSum
  ) {
    report(
      "PROJECT_UPLOAD_AUTHORITY_CONSTANTS",
      "upload presign TTL and DB-clock publication fence must share one positive authority contract",
      authorityFileName,
      authority.source,
    );
  }

  const s3FileName = "src/lib/s3.ts";
  const s3 = await parsed(s3FileName);
  const generateProjectPath = functionFor(s3, "generateProjectPath");
  const safeDataKeyBinding = importedBindings(s3).get("isSafeCompanyDataKey");
  const safeDataKeyGuard =
    generateProjectPath &&
    descendants(generateProjectPath, ts.isIfStatement).some(
      (statement) =>
        descendants(statement.expression, ts.isPrefixUnaryExpression).some(
          (expression) =>
            expression.operator === ts.SyntaxKind.ExclamationToken &&
            exactIdentifierCall(expression.operand, "isSafeCompanyDataKey", [
              "companyDataKey",
            ]),
        ) &&
        hasStringLiteral(statement.thenStatement, [
          "Company data key is not safe for project storage",
        ]),
    );
  const generatedProjectId = generateProjectPath
    ? variableInitializer(generateProjectPath, "projectId")
    : null;
  const generatedPathReturn = generateProjectPath
    ? directReturnExpressions(generateProjectPath)[0]
    : null;
  if (
    !generateProjectPath ||
    safeDataKeyBinding?.sourceFile !== authorityFileName ||
    safeDataKeyBinding.symbol !== "isSafeCompanyDataKey" ||
    !safeDataKeyGuard ||
    !generatedProjectId ||
    !hasAllCalls(generatedProjectId, ["randomBytes", "toString"]) ||
    !hasStringLiteral(generatedProjectId, ["hex"]) ||
    !descendants(generatedProjectId, ts.isNumericLiteral).some(
      (literal) => literal.text === "10",
    ) ||
    !generatedPathReturn ||
    !interpolationTemplateMatches(generatedPathReturn, "", [
      { identifier: "companyDataKey", suffix: "/" },
      { identifier: "projectId", suffix: "" },
    ])
  ) {
    report(
      "PROJECT_PATH_ISSUER_DRIFT",
      "generateProjectPath must reject unsafe company roots and mint exactly one 20-hex child segment",
      s3FileName,
      generateProjectPath ?? s3.source,
    );
  }
  const s3VersionIssues = stagingS3VersionIssues(s3);
  if (s3VersionIssues.size > 0) {
    report(
      "PROJECT_STAGING_S3_VERSION_DRIFT",
      `S3 staging helpers violate: ${[...s3VersionIssues].sort().join(", ")}`,
      s3FileName,
      functionFor(s3, "downloadFromS3") ?? s3.source,
    );
  }
  const versionPurge = functionFor(s3, "deleteS3PrefixAllVersions");
  const finalPrefixDelete = functionFor(s3, "deleteProjectFiles");
  const stagingPrefixDelete = functionFor(s3, "deleteProjectStagingFiles");
  const finalPurgeCall =
    finalPrefixDelete &&
    descendants(finalPrefixDelete, ts.isCallExpression).find(
      (call) => callName(call) === "deleteS3PrefixAllVersions",
    );
  const stagingPurgeCall =
    stagingPrefixDelete &&
    descendants(stagingPrefixDelete, ts.isCallExpression).find(
      (call) => callName(call) === "deleteS3PrefixAllVersions",
    );
  const stagingPurgePrefix = stagingPurgeCall?.arguments[0]
    ? unwrapExpression(stagingPurgeCall.arguments[0])
    : null;
  if (
    !versionPurge ||
    !hasAllIdentifiers(versionPurge, [
      "ListObjectVersionsCommand",
      "DeleteObjectsCommand",
      "Versions",
      "DeleteMarkers",
      "VersionId",
      "Errors",
    ]) ||
    !finalPrefixDelete ||
    !isExportedDeclaration(s3.source, "deleteProjectFiles") ||
    !finalPurgeCall ||
    !finalPurgeCall.arguments[0] ||
    !singleInterpolationTemplate(
      finalPurgeCall.arguments[0],
      "",
      "projectPath",
      "/",
    ) ||
    !stagingPrefixDelete ||
    !isExportedDeclaration(s3.source, "deleteProjectStagingFiles") ||
    !stagingPurgePrefix ||
    !ts.isCallExpression(stagingPurgePrefix) ||
    !exactIdentifierCall(stagingPurgePrefix, "projectUploadStagingPrefix", [
      "projectPath",
    ])
  ) {
    report(
      "PROJECT_STORAGE_VERSION_PURGE_DRIFT",
      "project deletion must purge every final/staging object version through the exact isolated prefixes",
      s3FileName,
      versionPurge ?? s3.source,
    );
  }
  const stagingTypeFileName = "src/types/index.ts";
  const stagingTypes = await parsed(stagingTypeFileName);
  const stagingFileInterface = descendants(
    stagingTypes.source,
    ts.isInterfaceDeclaration,
  ).find((declaration) => declaration.name.text === "StagingFile");
  const versionIdProperty = stagingFileInterface?.members.find(
    (member) =>
      ts.isPropertySignature(member) &&
      propertyName(member.name) === "versionId",
  );
  if (
    !versionIdProperty ||
    !ts.isPropertySignature(versionIdProperty) ||
    versionIdProperty.questionToken ||
    versionIdProperty.type?.kind !== ts.SyntaxKind.StringKeyword
  ) {
    report(
      "PROJECT_STAGING_VERSION_TYPE",
      "StagingFile.versionId must remain a required string",
      stagingTypeFileName,
      stagingFileInterface ?? stagingTypes.source,
    );
  }
  const stagingSigner = functionFor(s3, "createStagingUploadPresignedPost");
  const presignLocals = namedImportLocals(
    s3,
    "@aws-sdk/s3-presigned-post",
    "createPresignedPost",
  );
  const stagingPresigns = stagingSigner
    ? descendants(stagingSigner, ts.isCallExpression).filter((call) =>
        presignLocals.has(callName(call)),
      )
    : [];
  const stagingPresign = stagingPresigns[0] ?? null;
  const stagingOptions = stagingPresign
    ? objectArgumentForCall(stagingPresign, 1)
    : null;
  const expires = stagingOptions
    ? propertyInitializer(stagingOptions, "Expires")
    : null;
  const signedStagingKey = stagingOptions
    ? unwrapExpression(propertyInitializer(stagingOptions, "Key"))
    : null;
  const stagingKey = stagingSigner
    ? variableInitializer(stagingSigner, "stagingKey")
    : null;
  const authorityBinding = importedBindings(s3).get("projectUploadStagingKey");
  const signsFinalProjectPrefix =
    stagingSigner &&
    descendants(stagingSigner, ts.isTemplateExpression).some((template) =>
      templateStartsInProjectPrefix(template, "projectPath"),
    );
  if (
    !stagingSigner ||
    stagingPresigns.length !== 1 ||
    !stagingPresign ||
    !expires ||
    !ts.isIdentifier(unwrapExpression(expires)) ||
    unwrapExpression(expires).text !== "PROJECT_UPLOAD_PRESIGN_TTL_SECONDS" ||
    !stagingKey ||
    !exactIdentifierCall(stagingKey, "projectUploadStagingKey", [
      "projectPath",
      "filename",
      "index",
    ]) ||
    !signedStagingKey ||
    !ts.isIdentifier(signedStagingKey) ||
    signedStagingKey.text !== "stagingKey" ||
    authorityBinding?.sourceFile !== authorityFileName ||
    authorityBinding.symbol !== "projectUploadStagingKey" ||
    signsFinalProjectPrefix ||
    hasStringLiteral(stagingSigner, ["original.pdf"])
  ) {
    report(
      "STAGING_UPLOAD_TTL_DRIFT",
      "staging presigned POSTs must use the shared TTL and exact isolated staging-key helper",
      s3FileName,
      stagingSigner ?? s3.source,
    );
  }
  if (functionFor(s3, "createUploadPresignedPost")) {
    report(
      "LEGACY_FINAL_UPLOAD_SIGNER_PRESENT",
      "legacy createUploadPresignedPost must remain absent",
      s3FileName,
      functionFor(s3, "createUploadPresignedPost"),
    );
  }

  const modelSigner = functionFor(s3, "createModelUploadPresignedPost");
  const modelSignerIsNonProject = exactModelUploadSigner(s3, modelSigner);

  for (const file of files) {
    const parsedFile = await parsed(file);
    const filePresignLocals = namedImportLocals(
      parsedFile,
      "@aws-sdk/s3-presigned-post",
      "createPresignedPost",
    );
    const signedUrlLocals = namedImportLocals(
      parsedFile,
      "@aws-sdk/s3-request-presigner",
      "getSignedUrl",
    );
    const getObjectCommandLocals = namedImportLocals(
      parsedFile,
      "@aws-sdk/client-s3",
      "GetObjectCommand",
    );
    for (const call of descendants(parsedFile.source, ts.isCallExpression)) {
      if (filePresignLocals.has(callName(call))) {
        const owner = enclosingFunction(parsedFile, call);
        const stagingOnly =
          file === s3FileName &&
          owner.name === "createStagingUploadPresignedPost" &&
          owner.node === stagingSigner;
        const reviewedModelOnly =
          file === s3FileName &&
          owner.name === "createModelUploadPresignedPost" &&
          owner.node === modelSigner &&
          modelSignerIsNonProject;
        if (!stagingOnly && !reviewedModelOnly) {
          report(
            "UNCLASSIFIED_PROJECT_UPLOAD_SIGNER",
            `createPresignedPost in ${owner.name} is not an exact staging/model signer`,
            file,
            call,
          );
        }
      }
      if (signedUrlLocals.has(callName(call))) {
        const command = call.arguments[1]
          ? unwrapExpression(call.arguments[1])
          : null;
        const commandName =
          command && ts.isNewExpression(command)
            ? propertyName(command.expression)
            : null;
        if (!commandName || !getObjectCommandLocals.has(commandName)) {
          report(
            "UNCLASSIFIED_BROWSER_WRITE_SIGNER",
            "getSignedUrl may only issue read-only GetObject credentials",
            file,
            call,
          );
        }
      }
    }
  }

  const serviceFileName = "src/server/services/s3.ts";
  const service = await parsed(serviceFileName);
  const uploadCredentials = functionFor(service, "uploadCredentials");
  const disabled =
    uploadCredentials &&
    descendants(uploadCredentials, ts.isThrowStatement).some((statement) => {
      const expression = unwrapExpression(statement.expression);
      if (
        !expression ||
        !ts.isNewExpression(expression) ||
        propertyName(expression.expression) !== "ApiError"
      ) {
        return false;
      }
      const args = expression.arguments ?? [];
      return (
        literalValue(args[0]) === "NOT_FOUND" &&
        literalValue(args[1]) ===
          "Legacy direct upload credentials are disabled" &&
        literalValue(args[2]) === "410"
      );
    });
  if (
    !disabled ||
    hasCall(uploadCredentials ?? service.source, [
      "createPresignedPost",
      "createUploadPresignedPost",
      "getSignedUrl",
    ])
  ) {
    report(
      "LEGACY_UPLOAD_CREDENTIALS_ENABLED",
      "uploadCredentials must remain a terminal 410 and issue no signer",
      serviceFileName,
      uploadCredentials ?? service.source,
    );
  }

  const projectsFileName = "src/server/services/projects.ts";
  const projectsService = await parsed(projectsFileName);
  const createProject = functionFor(projectsService, "createProject");
  const projectKeyBinding = importedBindings(projectsService).get(
    "projectUploadStagingKey",
  );
  const stagingKeyCalls = createProject
    ? descendants(createProject, ts.isCallExpression).filter(
        (call) => callName(call) === "projectUploadStagingKey",
      )
    : [];
  const stagingKeyCall = stagingKeyCalls[0];
  const keyCallArgumentsMatch =
    stagingKeyCall &&
    stagingKeyCall.arguments.length === 3 &&
    ts.isIdentifier(unwrapExpression(stagingKeyCall.arguments[0])) &&
    unwrapExpression(stagingKeyCall.arguments[0]).text === "dataUrl" &&
    hasPropertyAccess(stagingKeyCall.arguments[1], "sf", "filename") &&
    ts.isIdentifier(unwrapExpression(stagingKeyCall.arguments[2])) &&
    unwrapExpression(stagingKeyCall.arguments[2]).text === "index";
  const exactKeyComparison =
    createProject &&
    stagingKeyCall &&
    descendants(createProject, ts.isBinaryExpression).some(
      (binary) =>
        binary.operatorToken.kind ===
          ts.SyntaxKind.ExclamationEqualsEqualsToken &&
        nodeContains(binary, stagingKeyCall) &&
        hasPropertyAccess(binary, "sf", "stagingKey"),
    );
  const nonemptyManifestGuard =
    createProject &&
    descendants(createProject, ts.isIfStatement).some(
      (statement) =>
        hasCall(statement.expression, ["isArray"]) &&
        hasAllIdentifiers(statement.expression, ["stagingFiles", "length"]) &&
        hasStringLiteral(statement.thenStatement, [
          "stagingFiles must be a non-empty array",
        ]),
    );
  const legacyPrefixValidation =
    createProject &&
    descendants(createProject, ts.isCallExpression).some(
      (call) =>
        callName(call) === "startsWith" &&
        hasPropertyAccess(call, "sf", "stagingKey"),
    );
  const firstHead =
    createProject &&
    descendants(createProject, ts.isCallExpression).find(
      (call) => callName(call) === "headS3Object",
    );
  const projectInsert =
    createProject &&
    descendants(createProject, ts.isCallExpression).find(
      (call) =>
        callName(call) === "insert" &&
        propertyName(call.arguments[0]) === "projects",
    );
  if (
    !createProject ||
    projectKeyBinding?.sourceFile !== authorityFileName ||
    projectKeyBinding.symbol !== "projectUploadStagingKey" ||
    stagingKeyCalls.length !== 1 ||
    !stagingKeyCall ||
    !keyCallArgumentsMatch ||
    !exactKeyComparison ||
    !nonemptyManifestGuard ||
    !hasCanonicalProjectPathGuard(
      projectsService,
      createProject,
      stagingKeyCall.getStart(),
    ) ||
    legacyPrefixValidation ||
    !firstHead ||
    stagingKeyCall.getStart() > firstHead.getStart() ||
    !projectInsert ||
    stagingKeyCall.getStart() > projectInsert.getStart()
  ) {
    report(
      "PROJECT_STAGING_MANIFEST_VALIDATION",
      "createProject must require a canonical non-nesting project root and exact non-empty isolated staging manifest",
      projectsFileName,
      createProject ?? projectsService.source,
    );
  }
  const manifestVersionIssues = projectManifestVersionIssues(
    projectsService,
    createProject,
  );
  if (manifestVersionIssues.size > 0) {
    report(
      "PROJECT_STAGING_MANIFEST_VERSION_DRIFT",
      `createProject violates: ${[...manifestVersionIssues].sort().join(", ")}`,
      projectsFileName,
      createProject ?? projectsService.source,
    );
  }
  const storageRootIssues = projectCreateStorageRootIssues(
    projectsService,
    createProject,
  );
  if (storageRootIssues.size > 0) {
    report(
      "PROJECT_CREATE_STORAGE_ROOT_PROTOCOL_DRIFT",
      `createProject storage-root retirement protocol violates: ${[...storageRootIssues].sort().join(", ")}`,
      projectsFileName,
      createProject ?? projectsService.source,
    );
  }

  const processingFileName = "src/lib/processing.ts";
  const processing = await parsed(processingFileName);
  const buildProjectPdf = functionFor(processing, "buildProjectPdf");
  const finalPdfUploads = buildProjectPdf
    ? descendants(buildProjectPdf, ts.isCallExpression).filter(
        (call) =>
          callName(call) === "uploadToS3" &&
          call.arguments[0] &&
          singleInterpolationTemplate(
            call.arguments[0],
            "",
            "projectPath",
            "/original.pdf",
          ),
      )
    : [];
  if (!buildProjectPdf || finalPdfUploads.length !== 1) {
    report(
      "PROJECT_FINAL_UPLOAD_NOT_SERVER_ONLY",
      "processing must remain the server-side writer of projectPath/original.pdf",
      processingFileName,
      buildProjectPdf ?? processing.source,
    );
  }
  const processingVersionIssues = processingVersionReadIssues(
    processing,
    buildProjectPdf,
  );
  if (processingVersionIssues.size > 0) {
    report(
      "PROJECT_STAGING_PROCESSING_VERSION_DRIFT",
      `buildProjectPdf violates: ${[...processingVersionIssues].sort().join(", ")}`,
      processingFileName,
      buildProjectPdf ?? processing.source,
    );
  }

  const lifecycleFileName = "infrastructure/terraform/s3.tf";
  const lifecycleText = await readFile(
    path.join(ROOT, lifecycleFileName),
    "utf8",
  );
  const stagingLifecycleRules = braceBlocks(lifecycleText, "rule").filter(
    (block) => /\bid\s*=\s*"expire-project-upload-staging"/u.test(block),
  );
  const stagingLifecycle = stagingLifecycleRules[0] ?? "";
  const currentExpiryDays = Number(
    /\bexpiration\s*\{\s*days\s*=\s*(\d+)\s*\}/u.exec(stagingLifecycle)?.[1],
  );
  const noncurrentExpiryDays = Number(
    /\bnoncurrent_version_expiration\s*\{\s*noncurrent_days\s*=\s*(\d+)\s*\}/u.exec(
      stagingLifecycle,
    )?.[1],
  );
  const multipartAbortDays = Number(
    /\babort_incomplete_multipart_upload\s*\{\s*days_after_initiation\s*=\s*(\d+)\s*\}/u.exec(
      stagingLifecycle,
    )?.[1],
  );
  const stagingCdnDeny =
    /\bSid\s*=\s*"DenyCloudFrontServingProjectUploadStaging"[\s\S]{0,600}?\bEffect\s*=\s*"Deny"[\s\S]{0,600}?\bPrincipal\s*=\s*\{[\s\S]{0,200}?\bService\s*=\s*"cloudfront\.amazonaws\.com"[\s\S]{0,200}?\}[\s\S]{0,600}?\bAction\s*=\s*"s3:GetObject"[\s\S]{0,600}?\bResource\s*=\s*"\$\{aws_s3_bucket\.beaver_data\.arn\}\/_bp-staging\/\*"/u.test(
      lifecycleText,
    );
  const publicAccessBlock =
    /\bresource\s+"aws_s3_bucket_public_access_block"\s+"beaver_data"\s*\{([\s\S]*?)\}/u.exec(
      lifecycleText,
    )?.[1] ?? "";
  const blocksPublicBucketAccess = [
    "block_public_acls",
    "block_public_policy",
    "ignore_public_acls",
    "restrict_public_buckets",
  ].every((field) =>
    new RegExp(`\\b${field}\\s*=\\s*true`, "u").test(publicAccessBlock),
  );
  const bucketVersioningEnabled =
    /\bresource\s+"aws_s3_bucket_versioning"\s+"beaver_data"[\s\S]{0,600}?\bversioning_configuration\s*\{[\s\S]{0,200}?\bstatus\s*=\s*"Enabled"/u.test(
      lifecycleText,
    );
  if (
    stagingLifecycleRules.length !== 1 ||
    !/\bstatus\s*=\s*"Enabled"/u.test(stagingLifecycle) ||
    !/\bfilter\s*\{\s*prefix\s*=\s*"_bp-staging\/"\s*\}/u.test(
      stagingLifecycle,
    ) ||
    !Number.isSafeInteger(currentExpiryDays) ||
    currentExpiryDays <= 0 ||
    !Number.isSafeInteger(noncurrentExpiryDays) ||
    noncurrentExpiryDays <= 0 ||
    !Number.isSafeInteger(multipartAbortDays) ||
    multipartAbortDays <= 0 ||
    !stagingCdnDeny ||
    !blocksPublicBucketAccess ||
    !bucketVersioningEnabled
  ) {
    report(
      "PROJECT_STAGING_LIFECYCLE_DRIFT",
      "the S3 lifecycle/CDN policy must isolate, privately retain, and eventually expire only _bp-staging/ data",
      lifecycleFileName,
    );
  }

  const iamFileName = "infrastructure/terraform/iam.tf";
  const iamText = await readFile(path.join(ROOT, iamFileName), "utf8");
  const taskPolicyStart = iamText.indexOf(
    'resource "aws_iam_role_policy" "beaver_ecs_task_s3"',
  );
  const nextPolicyStart =
    taskPolicyStart >= 0
      ? iamText.indexOf('\nresource "', taskPolicyStart + 1)
      : -1;
  const taskS3Policy =
    taskPolicyStart >= 0
      ? iamText.slice(
          taskPolicyStart,
          nextPolicyStart >= 0 ? nextPolicyStart : undefined,
        )
      : "";
  const versionActions = [
    "s3:GetObjectVersion",
    "s3:DeleteObjectVersion",
    "s3:ListBucketVersions",
  ];
  if (
    !versionActions.every((action) => taskS3Policy.includes(`"${action}"`)) ||
    !taskS3Policy.includes("aws_s3_bucket.beaver_data.arn") ||
    !taskS3Policy.includes('"${aws_s3_bucket.beaver_data.arn}/*"')
  ) {
    report(
      "PROJECT_STAGING_VERSION_IAM_DRIFT",
      "the app task role must read and purge exact S3 object versions in the data bucket",
      iamFileName,
    );
  }

  const demoFileName = "src/server/services/demo.ts";
  const demo = await parsed(demoFileName);
  const manageDemo = functionFor(demo, "manageDemo");
  const publishBranch =
    manageDemo &&
    descendants(manageDemo, ts.isIfStatement).find(
      (statement) =>
        hasIdentifier(statement.expression, ["isDemo"]) &&
        descendants(statement.thenStatement, ts.isCallExpression).some(
          (call) =>
            callName(call) === "update" &&
            propertyName(call.arguments[0]) === "projects",
        ),
    );
  const publishUpdate = publishBranch
    ? descendants(publishBranch.thenStatement, ts.isCallExpression).find(
        (call) =>
          callName(call) === "update" &&
          propertyName(call.arguments[0]) === "projects",
      )
    : null;
  const fenceSql = publishBranch
    ? publicationFenceSqlNodes(publishBranch.thenStatement)[0]
    : null;
  const fenceGuard = publishBranch
    ? conflictGuard(
        publishBranch.thenStatement,
        "Project upload credentials are still active",
        ["project", "uploadAuthorityActive"],
      )
    : null;
  const publishSet = publishUpdate ? chainedCall(publishUpdate, "set") : null;
  const labelingBlocked =
    publishBranch && publishUpdate
      ? labelingBlockerBefore(
          publishBranch.thenStatement,
          publishUpdate.getStart(),
        )
      : false;
  if (
    !publishBranch ||
    !publishUpdate ||
    !fenceSql ||
    !fenceGuard ||
    fenceSql.getStart() > publishUpdate.getStart() ||
    fenceGuard.getStart() > publishUpdate.getStart() ||
    !labelingBlocked ||
    !publishSet ||
    !hasDbClockAssignment(publishSet, "updatedAt")
  ) {
    report(
      "DEMO_UPLOAD_PUBLICATION_FENCE",
      "manageDemo must apply the labeling blocker and shared DB-clock upload fence before publishing",
      demoFileName,
      manageDemo ?? demo.source,
    );
  }
}

async function validateModelStorageAuthority(files) {
  const authorityFileName = "src/lib/model-storage-authority.ts";
  const authority = await parsed(authorityFileName);
  if (!exactModelStorageAuthority(authority)) {
    report(
      "MODEL_STORAGE_AUTHORITY_DRIFT",
      "model storage must derive one nonempty canonical slug below the exact models root",
      authorityFileName,
      functionFor(authority, "isCanonicalModelStoragePath") ?? authority.source,
    );
  }

  const modelsFileName = "src/server/services/models.ts";
  const modelsService = await parsed(modelsFileName);
  const listModels = functionFor(modelsService, "listModels");
  const modelPresigns = listModels
    ? descendants(listModels, ts.isCallExpression).filter(
        (call) => callName(call) === "createModelUploadPresignedPost",
      )
    : [];
  const rawNamePresign =
    modelPresigns[0] &&
    modelPresigns[0].arguments.length === 1 &&
    exactPropertyPath(modelPresigns[0].arguments[0], ["name"]);
  if (modelPresigns.length !== 1 || !rawNamePresign) {
    report(
      "MODEL_PRESIGN_AUTHORITY_DRIFT",
      "listModels must pass the raw model name to the shared canonical model signer",
      modelsFileName,
      listModels ?? modelsService.source,
    );
  }

  const registerModel = functionFor(modelsService, "registerModel");
  const registerUploads = registerModel
    ? descendants(registerModel, ts.isCallExpression).filter(
        (call) =>
          callName(call) === "uploadToS3" &&
          call.arguments[0] &&
          templateStartsWithPropertyPath(call.arguments[0], ["s3Path"]),
      )
    : [];
  const registerInsert = registerModel
    ? descendants(registerModel, ts.isCallExpression).find(
        (call) =>
          callName(call) === "insert" &&
          propertyName(call.arguments[0]) === "models",
      )
    : null;
  const registerBoundary = Math.min(
    registerUploads[0]?.getStart() ?? Number.POSITIVE_INFINITY,
    registerInsert?.getStart() ?? Number.POSITIVE_INFINITY,
  );
  const registerRootGuard =
    registerModel &&
    descendants(registerModel, ts.isIfStatement).find(
      (statement) =>
        statement.getStart() < registerBoundary &&
        descendants(statement.expression, ts.isPrefixUnaryExpression).some(
          (expression) =>
            expression.operator === ts.SyntaxKind.ExclamationToken &&
            exactPropertyPath(expression.operand, [
              "session",
              "user",
              "isRootAdmin",
            ]),
        ) &&
        hasAllStringLiterals(statement.thenStatement, [
          "FORBIDDEN",
          "Not authorized",
        ]),
    );
  const uploadKillSwitch =
    registerModel &&
    descendants(registerModel, ts.isIfStatement).find(
      (statement) =>
        hasAllIdentifiers(statement.expression, [
          "process",
          "env",
          "ALLOW_MODEL_UPLOAD",
        ]) &&
        hasStringLiteral(statement.expression, ["true"]) &&
        hasTextStarting(
          statement.thenStatement,
          "Model uploads are disabled on this deployment.",
        ),
    );
  if (
    registerUploads.length !== 2 ||
    !registerInsert ||
    !registerRootGuard ||
    !uploadKillSwitch ||
    uploadKillSwitch.getStart() > registerRootGuard.getStart() ||
    !modelStorageGuardBefore(
      modelsService,
      registerModel,
      [["name"], ["s3Path"]],
      "Invalid model storage path",
      registerBoundary,
    )
  ) {
    report(
      "MODEL_REGISTER_STORAGE_UNSAFE",
      "registerModel must remain root-only and reject noncanonical paths before every S3/DB write",
      modelsFileName,
      registerModel ?? modelsService.source,
    );
  }

  const yoloFileName = "src/server/services/yolo.ts";
  const yolo = await parsed(yoloFileName);
  const yoloRun = functionFor(yolo, "yoloRun");
  const yoloUploads = yoloRun
    ? descendants(yoloRun, ts.isCallExpression).filter(
        (call) =>
          callName(call) === "uploadToS3" &&
          call.arguments[0] &&
          templateStartsWithPropertyPath(call.arguments[0], [
            "model",
            "s3Path",
          ]),
      )
    : [];
  const startsYolo = yoloRun
    ? descendants(yoloRun, ts.isCallExpression).find(
        (call) =>
          callName(call) === "startYoloJob" &&
          call.arguments[1] &&
          exactPropertyPath(call.arguments[1], ["model", "s3Path"]),
      )
    : null;
  const yoloBoundary = Math.min(
    yoloUploads[0]?.getStart() ?? Number.POSITIVE_INFINITY,
    startsYolo?.getStart() ?? Number.POSITIVE_INFINITY,
  );
  if (
    yoloUploads.length !== 1 ||
    !startsYolo ||
    !modelStorageGuardBefore(
      yolo,
      yoloRun,
      [
        ["model", "name"],
        ["model", "s3Path"],
      ],
      "Model storage path requires reconciliation",
      yoloBoundary,
    )
  ) {
    report(
      "YOLO_MODEL_STORAGE_UNSAFE",
      "yoloRun must reject noncanonical stored model paths before S3/SageMaker side effects",
      yoloFileName,
      yoloRun ?? yolo.source,
    );
  }

  const classifiedModelSinks = new Set([
    `${modelsFileName}:registerModel`,
    `${yoloFileName}:yoloRun`,
  ]);
  for (const file of files) {
    const parsedFile = await parsed(file);
    for (const call of descendants(parsedFile.source, ts.isCallExpression)) {
      if (callName(call) !== "uploadToS3" || !call.arguments[0]) continue;
      const touchesModelPath = descendants(
        call.arguments[0],
        ts.isIdentifier,
      ).some((identifier) => identifier.text === "s3Path");
      if (!touchesModelPath) continue;
      const owner = enclosingFunction(parsedFile, call);
      if (!classifiedModelSinks.has(`${file}:${owner.name}`)) {
        report(
          "UNCLASSIFIED_MODEL_STORAGE_WRITE",
          `uploadToS3 in ${owner.name} derives from s3Path outside the reviewed model sinks`,
          file,
          call,
        );
      }
    }
  }
}

function storageOwnershipBeforeDelete(parsedFile, callback, boundary) {
  const binding = importedBindings(parsedFile).get("isCanonicalProjectPath");
  if (
    binding?.sourceFile !== "src/lib/project-upload-authority.ts" ||
    binding.symbol !== "isCanonicalProjectPath"
  )
    return false;
  const lookup = descendants(callback, ts.isVariableDeclaration).find(
    (declaration) => {
      if (
        declaration.getStart() >= boundary ||
        !ts.isArrayBindingPattern(declaration.name) ||
        !declaration.name.elements.some(
          (element) =>
            ts.isBindingElement(element) &&
            ts.isIdentifier(element.name) &&
            element.name.text === "storageOwner",
        ) ||
        !declaration.initializer
      )
        return false;
      const joinsCompany = descendants(
        declaration.initializer,
        ts.isCallExpression,
      ).some(
        (call) =>
          callName(call) === "innerJoin" &&
          call.arguments.length === 2 &&
          exactPropertyPath(call.arguments[0], ["companies"]) &&
          descendants(call.arguments[1], ts.isCallExpression).some(
            (predicate) =>
              callName(predicate) === "eq" &&
              exactPropertyPath(predicate.arguments[0], ["companies", "id"]) &&
              exactPropertyPath(predicate.arguments[1], [
                "projects",
                "companyId",
              ]),
          ),
      );
      const selectsProject = descendants(
        declaration.initializer,
        ts.isCallExpression,
      ).some(
        (call) =>
          callName(call) === "where" &&
          call.arguments[0] &&
          descendants(call.arguments[0], ts.isCallExpression).some(
            (predicate) =>
              callName(predicate) === "eq" &&
              exactPropertyPath(predicate.arguments[0], ["projects", "id"]) &&
              exactPropertyPath(predicate.arguments[1], ["project", "id"]),
          ),
      );
      return (
        joinsCompany &&
        selectsProject &&
        hasAllIdentifiers(declaration.initializer, [
          "dataUrl",
          "companyDataKey",
        ])
      );
    },
  );
  const guard = descendants(callback, ts.isIfStatement).find((statement) => {
    if (
      statement.getStart() >= boundary ||
      !hasStringLiteral(statement.thenStatement, [
        "Project storage root requires reconciliation",
      ])
    )
      return false;
    const rejectsMissing = descendants(
      statement.expression,
      ts.isPrefixUnaryExpression,
    ).some(
      (expression) =>
        expression.operator === ts.SyntaxKind.ExclamationToken &&
        exactPropertyPath(expression.operand, ["storageOwner"]),
    );
    const rejectsArgumentMismatch = descendants(
      statement.expression,
      ts.isBinaryExpression,
    ).some(
      (binary) =>
        binary.operatorToken.kind ===
          ts.SyntaxKind.ExclamationEqualsEqualsToken &&
        exactPropertyPath(binary.left, ["storageOwner", "dataUrl"]) &&
        exactPropertyPath(binary.right, ["project", "dataUrl"]),
    );
    const rejectsNoncanonical = descendants(
      statement.expression,
      ts.isPrefixUnaryExpression,
    ).some((expression) => {
      if (expression.operator !== ts.SyntaxKind.ExclamationToken) return false;
      const call = unwrapExpression(expression.operand);
      return Boolean(
        call &&
        ts.isCallExpression(call) &&
        callName(call) === "isCanonicalProjectPath" &&
        call.arguments.length === 2 &&
        exactPropertyPath(call.arguments[0], [
          "storageOwner",
          "companyDataKey",
        ]) &&
        exactPropertyPath(call.arguments[1], ["storageOwner", "dataUrl"]),
      );
    });
    return rejectsMissing && rejectsArgumentMismatch && rejectsNoncanonical;
  });
  return Boolean(lookup && guard);
}

function quiescentDeleteIssues(parsedFile, target) {
  const issues = new Set();
  const stagedDelete = functionFor(parsedFile, "stageLockedProjectDeletion");
  const bulkStage = functionFor(
    parsedFile,
    "stageProjectDeletionsInTransaction",
  );
  const reconcileCommitted = functionFor(
    parsedFile,
    "reconcileCommittedProjectDeletions",
  );
  if (!target || !stagedDelete || !bulkStage || !reconcileCommitted) {
    return new Set(["missing-symbol"]);
  }
  if (
    isExportedDeclaration(parsedFile.source, "stageLockedProjectDeletion") ||
    !isExportedDeclaration(
      parsedFile.source,
      "stageProjectDeletionsInTransaction",
    ) ||
    !isExportedDeclaration(
      parsedFile.source,
      "reconcileCommittedProjectDeletions",
    ) ||
    callbackTransactionIdentifier(stagedDelete, parsedFile) !== "tx"
  ) {
    issues.add("private-locked-stage-and-exported-bulk-boundary");
  }

  const writeCalls = descendants(target, ts.isCallExpression).filter(
    (call) => callName(call) === "withProjectStorageWrite",
  );
  if (writeCalls.length !== 1) issues.add("single-atomic-callback");
  const callback =
    writeCalls.length === 1
      ? inlineCallbackForCall(writeCalls[0], parsedFile)
      : null;
  if (!callback) return new Set([...issues, "inline-atomic-callback"]);
  const storageBoundaryBinding = importedBindings(parsedFile).get(
    "withProjectStorageWrite",
  );
  const writeCall = writeCalls[0];
  if (
    storageBoundaryBinding?.sourceFile !==
      "src/server/api/project-write-capability.ts" ||
    storageBoundaryBinding.symbol !== "withProjectStorageWrite" ||
    writeCall.arguments.length !== 4 ||
    !ts.isIdentifier(unwrapExpression(writeCall.arguments[0])) ||
    unwrapExpression(writeCall.arguments[0]).text !== "writeCapability" ||
    !exactPropertyPath(writeCall.arguments[1], ["project", "id"]) ||
    !exactPropertyPath(writeCall.arguments[2], ["project", "dataUrl"])
  ) {
    issues.add("exact-storage-delete-boundary");
  }

  const stagedCalls = callback
    ? descendants(callback, ts.isCallExpression).filter(
        (call) => callName(call) === "stageLockedProjectDeletion",
      )
    : [];
  if (
    stagedCalls.length !== 1 ||
    compactNodeText(stagedCalls[0], parsedFile) !==
      "stageLockedProjectDeletion(tx,project)"
  ) {
    issues.add("singleton-delegates-to-locked-stage");
  }

  const deletes = descendants(stagedDelete, ts.isCallExpression)
    .filter((call) => callName(call) === "delete")
    .sort((a, b) => a.getStart() - b.getStart());
  const firstDelete = deletes[0];
  if (!firstDelete) issues.add("missing-delete");
  const boundary = firstDelete?.getStart() ?? Number.POSITIVE_INFINITY;

  if (!storageOwnershipBeforeDelete(parsedFile, stagedDelete, boundary)) {
    issues.add("canonical-storage-owner-before-delete");
  }

  const runningWhere = descendants(stagedDelete, ts.isCallExpression).find(
    (call) =>
      callName(call) === "where" &&
      call.arguments[0] &&
      hasAllIdentifiers(call.arguments[0], [
        "processingJobs",
        "projectId",
        "status",
      ]) &&
      hasStringLiteral(call.arguments[0], ["running"]),
  );
  const runningGuard = conflictGuard(
    stagedDelete,
    "Project has an active processing job",
    ["runningJob"],
  );
  if (
    !runningWhere ||
    !runningGuard ||
    runningWhere.getStart() > boundary ||
    runningGuard.getStart() > boundary
  ) {
    issues.add("running-job-before-delete");
  }

  const leaseWheres = activeLeaseWhereCalls(stagedDelete);
  const leaseGuard = conflictGuard(
    stagedDelete,
    "Project has an active mutation lease",
    ["activeLease"],
  );
  if (
    leaseWheres.length === 0 ||
    leaseWheres.some((call) => call.getStart() > boundary) ||
    !hasFailClosedActiveLeasePredicate(stagedDelete) ||
    usesExpiryBasedLeaseRetirement(stagedDelete) ||
    !leaseGuard ||
    leaseGuard.getStart() > boundary
  ) {
    issues.add("active-lease-before-delete");
  }

  const fenceSql = publicationFenceSqlNodes(stagedDelete)[0];
  const fenceGuard = conflictGuard(
    stagedDelete,
    "Project upload credentials are still active",
    ["uploadAuthority", "active"],
  );
  if (
    !fenceSql ||
    !fenceGuard ||
    fenceSql.getStart() > boundary ||
    fenceGuard.getStart() > boundary
  ) {
    issues.add("upload-fence-before-delete");
  }

  if (!labelingBlockerBefore(stagedDelete, boundary)) {
    issues.add("labeling-blocker-before-delete");
  }
  if (!labelStudioIntentBlockerBefore(stagedDelete, boundary)) {
    issues.add("label-studio-intent-blocker-before-delete");
  }

  const outboxInsert = descendants(stagedDelete, ts.isCallExpression).find(
    (call) =>
      callName(call) === "insert" &&
      exactPropertyPath(call.arguments[0], ["projectAssetDeletions"]) &&
      rootReceiverIdentifier(call) === "tx",
  );
  const outboxValuesCall = outboxInsert
    ? chainedCall(outboxInsert, "values")
    : null;
  const outboxValues = outboxValuesCall
    ? objectArgumentForCall(outboxValuesCall, 0)
    : null;
  const projectDelete = deletes.find(
    (call) =>
      exactPropertyPath(call.arguments[0], ["projects"]) &&
      rootReceiverIdentifier(call) === "tx",
  );
  const durableFields = [
    ["projectPublicId", ["storageOwner", "publicId"]],
    ["companyId", ["storageOwner", "companyId"]],
    ["storageRoot", ["storageOwner", "dataUrl"]],
    ["lifecycleEpoch", ["storageOwner", "lifecycleEpoch"]],
  ];
  if (
    !outboxInsert ||
    !outboxValues ||
    !projectDelete ||
    outboxInsert.getStart() >= projectDelete.getStart() ||
    !durableFields.every(([field, valuePath]) => {
      const initializer = propertyInitializer(outboxValues, field);
      return initializer && exactPropertyPath(initializer, valuePath);
    })
  ) {
    issues.add("durable-outbox-before-project-delete");
  }

  if (
    hasCall(stagedDelete, [
      "withProjectMutationLease",
      "reconcileProjectAssetDeletion",
      "deleteProjectFiles",
      "deleteProjectStagingFiles",
    ]) ||
    hasIdentifier(stagedDelete, ["StopExecutionCommand", "SFNClient"]) ||
    hasCall(stagedDelete, ["stopExecution"])
  ) {
    issues.add("external-stop-or-durable-lease");
  }

  const cleanupBindings = importedBindings(parsedFile);
  const reconcileBinding = cleanupBindings.get("reconcileProjectAssetDeletion");
  const reconcileCalls = descendants(
    reconcileCommitted,
    ts.isCallExpression,
  ).filter((call) => callName(call) === "reconcileProjectAssetDeletion");
  const reconcileCall = reconcileCalls[0] ?? null;
  const reconcileLoops = descendants(
    reconcileCommitted,
    ts.isForOfStatement,
  ).filter(
    (statement) =>
      compactNodeText(statement.expression, parsedFile) === "deletions",
  );
  const reconcileCatches = descendants(reconcileCommitted, ts.isCatchClause);
  const reconcileCatch = reconcileCatches[0];
  const singletonReconcileCalls = descendants(
    target,
    ts.isCallExpression,
  ).filter((call) => callName(call) === "reconcileCommittedProjectDeletions");
  const singletonReconcile = singletonReconcileCalls[0] ?? null;
  if (
    reconcileBinding?.sourceFile !== "src/lib/project-asset-deletion.ts" ||
    reconcileBinding.symbol !== "reconcileProjectAssetDeletion" ||
    reconcileCalls.length !== 1 ||
    reconcileLoops.length !== 1 ||
    reconcileCatches.length !== 1 ||
    !reconcileCall ||
    reconcileCall.arguments.length !== 1 ||
    !exactPropertyPath(reconcileCall.arguments[0], ["deletion", "id"]) ||
    !directAwaitContains(reconcileCall) ||
    !reconcileCatch ||
    !hasCall(reconcileCatch.block, ["error"]) ||
    descendants(
      reconcileCatch.block,
      (node) =>
        ts.isThrowStatement(node) ||
        ts.isReturnStatement(node) ||
        ts.isBreakStatement(node),
    ).length !== 0 ||
    singletonReconcileCalls.length !== 1 ||
    !singletonReconcile ||
    compactNodeText(singletonReconcile.arguments[0], parsedFile) !==
      "[deletion]" ||
    !directAwaitContains(singletonReconcile) ||
    singletonReconcile.getStart() < writeCall.getEnd() ||
    hasCall(target, ["deleteProjectFiles", "deleteProjectStagingFiles"])
  ) {
    issues.add("durable-asset-reconcile-after-commit");
  }

  const bulkStorageCalls = descendants(bulkStage, ts.isCallExpression).filter(
    (call) => callName(call) === "withProjectStorageWritesInTransaction",
  );
  const bulkOrdinaryCalls = descendants(bulkStage, ts.isCallExpression).filter(
    (call) => callName(call) === "withProjectWritesInTransaction",
  );
  const stageDeclaration = namedVariableDeclaration(bulkStage, "stage");
  const stageFunction = unwrapExpression(stageDeclaration?.initializer);
  const sortedEntryLoops =
    stageFunction &&
    (ts.isArrowFunction(stageFunction) ||
      ts.isFunctionExpression(stageFunction))
      ? descendants(stageFunction, ts.isForOfStatement).filter(
          (statement) =>
            compactNodeText(statement.expression, parsedFile) ===
            "[...entries].sort((left,right)=>left.project.id-right.project.id,)",
        )
      : [];
  const bulkStageCalls = stageFunction
    ? descendants(stageFunction, ts.isCallExpression).filter(
        (call) => callName(call) === "stageLockedProjectDeletion",
      )
    : [];
  const bulkWriteCalls = stageFunction
    ? descendants(stageFunction, ts.isCallExpression).filter(
        (call) => compactNodeText(call, parsedFile) === "write(lockedTx)",
      )
    : [];
  const duplicateGuard = descendants(bulkStage, ts.isIfStatement).find(
    (statement) =>
      hasStringLiteral(statement.thenStatement, [
        "Duplicate project deletion entry",
      ]) && hasAllIdentifiers(statement.expression, ["projectIds", "entry"]),
  );
  const bulkStorageBoundaryBinding = cleanupBindings.get(
    "withProjectStorageWritesInTransaction",
  );
  const ordinaryBoundaryBinding = cleanupBindings.get(
    "withProjectWritesInTransaction",
  );
  if (
    bulkStorageBoundaryBinding?.sourceFile !==
      "src/server/api/project-write-capability.ts" ||
    bulkStorageBoundaryBinding.symbol !==
      "withProjectStorageWritesInTransaction" ||
    ordinaryBoundaryBinding?.sourceFile !==
      "src/server/api/project-write-capability.ts" ||
    ordinaryBoundaryBinding.symbol !== "withProjectWritesInTransaction" ||
    !duplicateGuard ||
    sortedEntryLoops.length !== 1 ||
    bulkStageCalls.length !== 1 ||
    compactNodeText(bulkStageCalls[0], parsedFile) !==
      "stageLockedProjectDeletion(lockedTx,entry.project)" ||
    !directAwaitContains(bulkStageCalls[0]) ||
    bulkWriteCalls.length !== 1 ||
    !directAwaitContains(bulkWriteCalls[0]) ||
    bulkStorageCalls.length !== 1 ||
    bulkStorageCalls[0].arguments.length !== 4 ||
    compactNodeText(bulkStorageCalls[0].arguments[0], parsedFile) !== "tx" ||
    compactNodeText(bulkStorageCalls[0].arguments[1], parsedFile) !==
      "entries.map((entry)=>({capability:entry.writeCapability,projectId:entry.project.id,storageRoot:entry.project.dataUrl,}))" ||
    compactNodeText(bulkStorageCalls[0].arguments[2], parsedFile) !==
      "additionalCapabilities" ||
    compactNodeText(bulkStorageCalls[0].arguments[3], parsedFile) !== "stage" ||
    bulkOrdinaryCalls.length !== 1 ||
    compactNodeText(bulkOrdinaryCalls[0], parsedFile) !==
      "withProjectWritesInTransaction(tx,additionalCapabilities,stage)"
  ) {
    issues.add("bulk-stage-locks-all-roots-and-projects-before-delete");
  }
  return issues;
}

async function validateQuiescentProjectDelete() {
  const fileName = "src/lib/project-delete.ts";
  const parsedFile = await parsed(fileName);
  const target = functionFor(parsedFile, "deleteProjectFully");
  const issues = quiescentDeleteIssues(parsedFile, target);
  if (issues.size > 0) {
    report(
      "PROJECT_DELETE_NOT_QUIESCENT",
      `deleteProjectFully violates: ${[...issues].sort().join(", ")}`,
      fileName,
      target ?? parsedFile.source,
    );
  }
}

function compactNodeText(node, parsedFile) {
  return node?.getText(parsedFile.source).replace(/\s+/gu, "") ?? "";
}

function bindingContainsName(name, expected) {
  if (ts.isIdentifier(name)) return name.text === expected;
  return descendants(name, ts.isIdentifier).some(
    (identifier) => identifier.text === expected,
  );
}

function namedVariableDeclaration(scope, expected) {
  return descendants(scope, ts.isVariableDeclaration).find((declaration) =>
    bindingContainsName(declaration.name, expected),
  );
}

function exactApiErrorThrow(node, code, message) {
  return descendants(node, ts.isThrowStatement).some((statement) => {
    const expression = unwrapExpression(statement.expression);
    return Boolean(
      expression &&
      ts.isNewExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "ApiError" &&
      expression.arguments?.length === 2 &&
      literalValue(expression.arguments[0]) === code &&
      literalValue(expression.arguments[1]) === message,
    );
  });
}

function exactReturnLiteral(node, expected) {
  return descendants(node, ts.isReturnStatement).some(
    (statement) => literalValue(statement.expression) === expected,
  );
}

function namedDbTransactionCallback(scope, parsedFile, parameterName) {
  const callbacks = descendants(scope, ts.isCallExpression)
    .filter(
      (call) =>
        callName(call) === "transaction" &&
        exactPropertyPath(call.expression, ["db", "transaction"]),
    )
    .map((call) => unwrapExpression(call.arguments[0]))
    .filter(
      (callback) =>
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        callback.parameters.length === 1 &&
        ts.isIdentifier(callback.parameters[0].name) &&
        callback.parameters[0].name.text === parameterName,
    );
  return callbacks.length === 1 ? callbacks[0] : null;
}

function checkedTryAdvisoryLock(
  parsedFile,
  scope,
  transactionName,
  busyPolicy,
) {
  const issues = new Set();
  const lockResult = namedVariableDeclaration(scope, "lockResult");
  const lockCalls = lockResult?.initializer
    ? descendants(lockResult.initializer, ts.isCallExpression).filter(
        (call) =>
          exactPropertyPath(call.expression, [transactionName, "execute"]) &&
          call.arguments.length === 1 &&
          expressionSqlHasAll(call.arguments[0], [
            "select",
            "pg_catalog",
            "pg_try_advisory_xact_lock",
            "as",
            "acquired",
          ]),
      )
    : [];
  const allAdvisoryCalls = descendants(scope, ts.isCallExpression).filter(
    (call) => {
      if (callName(call) !== "execute" || call.arguments.length !== 1)
        return false;
      const sqlNodes = descendants(
        call.arguments[0],
        ts.isTaggedTemplateExpression,
      );
      if (ts.isTaggedTemplateExpression(unwrapExpression(call.arguments[0]))) {
        sqlNodes.push(unwrapExpression(call.arguments[0]));
      }
      return sqlNodes.some((sqlNode) => {
        const text = taggedSqlText(sqlNode);
        return Boolean(text && /pg_(?:try_)?advisory_xact_lock/u.test(text));
      });
    },
  );
  if (lockCalls.length !== 1 || allAdvisoryCalls.length !== 1) {
    issues.add("single-checked-try-advisory-lock");
  }

  const acquired = namedVariableDeclaration(scope, "acquired");
  if (
    compactNodeText(acquired?.initializer, parsedFile) !==
    "(lockResult.rows[0]as{acquired?:boolean}|undefined)?.acquired===true"
  ) {
    issues.add("exact-boolean-lock-result");
  }
  const busyChecks = descendants(scope, ts.isIfStatement).filter(
    (statement) =>
      compactNodeText(statement.expression, parsedFile) === "!acquired" &&
      (busyPolicy === "conflict"
        ? exactApiErrorThrow(
            statement.thenStatement,
            "CONFLICT",
            "User authority change in progress",
          )
        : exactReturnLiteral(statement.thenStatement, "busy")),
  );
  if (busyChecks.length !== 1) issues.add("fail-fast-on-lock-contention");

  const lockPosition = lockResult?.getStart(parsedFile.source) ?? -1;
  const acquiredPosition = acquired?.getStart(parsedFile.source) ?? -1;
  const guardPosition = busyChecks[0]?.getStart(parsedFile.source) ?? -1;
  if (
    lockPosition < 0 ||
    acquiredPosition <= lockPosition ||
    guardPosition <= acquiredPosition
  ) {
    issues.add("lock-result-checked-in-order");
  }
  return {
    issues,
    lockPosition,
    guardPosition,
  };
}

function adminUserUpdateAuthorityIssues(parsedFile) {
  const issues = new Set();
  const updateUser = functionFor(parsedFile, "updateUser");
  if (!updateUser) return new Set(["update-user-structure"]);
  if (
    numericConstantValue(
      variableInitializer(
        parsedFile.source,
        "ROOT_ADMIN_MUTATION_ADVISORY_LOCK",
      ),
    ) !== 737375864
  ) {
    issues.add("shared-root-advisory-lock-id");
  }
  const transaction = namedDbTransactionCallback(updateUser, parsedFile, "tx");
  if (!transaction) return new Set([...issues, "update-authority-transaction"]);
  const lock = checkedTryAdvisoryLock(
    parsedFile,
    transaction,
    "tx",
    "conflict",
  );
  for (const issue of lock.issues) issues.add(issue);

  const candidateTarget = namedVariableDeclaration(
    transaction,
    "candidateTarget",
  );
  const authorityIds = namedVariableDeclaration(transaction, "authorityIds");
  const currentUsers = namedVariableDeclaration(transaction, "currentUsers");
  const actor = namedVariableDeclaration(transaction, "actor");
  const target = namedVariableDeclaration(transaction, "target");
  if (
    compactNodeText(candidateTarget?.initializer, parsedFile) !==
      "awaittx.select({id:users.id}).from(users).where(eq(users.publicId,id)).limit(1)" ||
    compactNodeText(authorityIds?.initializer, parsedFile) !==
      "[...newSet([session.user.dbId,candidateTarget.id]),].sort((left,right)=>left-right)" ||
    compactNodeText(currentUsers?.initializer, parsedFile) !==
      'awaittx.select({id:users.id,publicId:users.publicId,companyId:users.companyId,role:users.role,isRootAdmin:users.isRootAdmin,}).from(users).where(inArray(users.id,authorityIds)).orderBy(users.id).for("update")' ||
    compactNodeText(actor?.initializer, parsedFile) !==
      "currentUsers.find((current)=>current.id===session.user.dbId,)" ||
    compactNodeText(target?.initializer, parsedFile) !==
      "currentUsers.find((current)=>current.id===candidateTarget.id,)"
  ) {
    issues.add("locked-ordered-actor-target-reread");
  }

  const actorChecks = descendants(transaction, ts.isIfStatement).filter(
    (statement) =>
      compactNodeText(statement.expression, parsedFile) ===
        '!actor||(actor.role!=="admin"&&!actor.isRootAdmin)' &&
      exactApiErrorThrow(statement.thenStatement, "FORBIDDEN", "Admin only"),
  );
  const tenantChecks = descendants(transaction, ts.isIfStatement).filter(
    (statement) =>
      compactNodeText(statement.expression, parsedFile) ===
      "!actor.isRootAdmin&&target.companyId!==actor.companyId",
  );
  const rootUpdateGuards = descendants(transaction, ts.isIfStatement).filter(
    (statement) =>
      ["role&&actor.isRootAdmin", "companyId&&actor.isRootAdmin"].includes(
        compactNodeText(statement.expression, parsedFile),
      ),
  );
  if (
    actorChecks.length !== 1 ||
    tenantChecks.length !== 1 ||
    rootUpdateGuards.length !== 2 ||
    descendants(transaction, ts.isPropertyAccessExpression).some((node) =>
      exactPropertyPath(node, ["session", "user", "isRootAdmin"]),
    )
  ) {
    issues.add("database-backed-update-authority");
  }

  const updated = namedVariableDeclaration(transaction, "updated");
  const exactOne = descendants(transaction, ts.isIfStatement).filter(
    (statement) =>
      compactNodeText(statement.expression, parsedFile) ===
        "updated.length!==1" &&
      exactApiErrorThrow(
        statement.thenStatement,
        "NOT_FOUND",
        "User not found",
      ),
  );
  if (
    compactNodeText(updated?.initializer, parsedFile) !==
      "awaittx.update(users).set(updates).where(eq(users.id,target.id)).returning({id:users.id})" ||
    exactOne.length !== 1
  ) {
    issues.add("update-target-exact-one-returning");
  }
  const authorityPosition = currentUsers?.getStart(parsedFile.source) ?? -1;
  const actorCheckPosition = actorChecks[0]?.getStart(parsedFile.source) ?? -1;
  const updatePosition = updated?.getStart(parsedFile.source) ?? -1;
  if (
    authorityPosition <= lock.guardPosition ||
    actorCheckPosition <= authorityPosition ||
    updatePosition <= actorCheckPosition
  ) {
    issues.add("lock-authority-before-update-order");
  }
  return issues;
}

function adminUserDeletionAuthorityIssues(parsedFile) {
  const issues = new Set();
  const deleteUser = functionFor(parsedFile, "deleteUser");
  const runCleanup = functionFor(parsedFile, "runCleanup");
  if (!deleteUser || !runCleanup) {
    issues.add("delete-user-structure");
    return issues;
  }
  if (
    numericConstantValue(
      variableInitializer(
        parsedFile.source,
        "ROOT_ADMIN_MUTATION_ADVISORY_LOCK",
      ),
    ) !== 737375864
  ) {
    issues.add("shared-root-advisory-lock-id");
  }

  const deleted = namedVariableDeclaration(runCleanup, "deleted");
  if (
    compactNodeText(deleted?.initializer, parsedFile) !==
    "awaittx.delete(users).where(and(eq(users.publicId,id),eq(users.isRootAdmin,false))).returning({id:users.id})"
  ) {
    issues.add("final-delete-root-predicate-returning");
  }
  const exactOneChecks = descendants(runCleanup, ts.isIfStatement).filter(
    (statement) =>
      compactNodeText(statement.expression, parsedFile) ===
        "deleted.length!==1" &&
      exactApiErrorThrow(
        statement.thenStatement,
        "VALIDATION",
        "Cannot delete root admin",
      ),
  );
  if (exactOneChecks.length !== 1) {
    issues.add("final-delete-exact-one");
  }

  const rootTransaction = namedDbTransactionCallback(
    deleteUser,
    parsedFile,
    "rootMutationTx",
  );
  if (!rootTransaction) {
    issues.add("outer-root-mutation-transaction");
    return issues;
  }
  const lock = checkedTryAdvisoryLock(
    parsedFile,
    rootTransaction,
    "rootMutationTx",
    "conflict",
  );
  for (const issue of lock.issues) issues.add(issue);

  const guardedUsers = namedVariableDeclaration(
    rootTransaction,
    "guardedUsers",
  );
  const guardedActor = namedVariableDeclaration(
    rootTransaction,
    "guardedActor",
  );
  const guardedTarget = namedVariableDeclaration(
    rootTransaction,
    "guardedTarget",
  );
  if (
    compactNodeText(guardedUsers?.initializer, parsedFile) !==
      "awaitrootMutationTx.select({id:users.id,publicId:users.publicId,companyId:users.companyId,role:users.role,isRootAdmin:users.isRootAdmin,}).from(users).where(or(eq(users.id,session.user.dbId),inArray(users.publicId,requestedPublicIds),),).orderBy(users.id)" ||
    compactNodeText(guardedActor?.initializer, parsedFile) !==
      "guardedUsers.find((current)=>current.id===session.user.dbId,)" ||
    compactNodeText(guardedTarget?.initializer, parsedFile) !==
      "guardedUsers.find((current)=>current.publicId===id,)" ||
    descendants(rootTransaction, ts.isCallExpression).some(
      (call) => callName(call) === "for",
    )
  ) {
    issues.add("locked-ordered-actor-target-scope");
  }
  const guardedActorChecks = descendants(
    rootTransaction,
    ts.isIfStatement,
  ).filter(
    (statement) =>
      compactNodeText(statement.expression, parsedFile) ===
        '!guardedActor||(guardedActor.role!=="admin"&&!guardedActor.isRootAdmin)' &&
      exactApiErrorThrow(statement.thenStatement, "FORBIDDEN", "Admin only"),
  );
  const guardedRootChecks = descendants(
    rootTransaction,
    ts.isIfStatement,
  ).filter(
    (statement) =>
      compactNodeText(statement.expression, parsedFile) ===
        "guardedTarget.isRootAdmin" &&
      exactApiErrorThrow(
        statement.thenStatement,
        "VALIDATION",
        "Cannot delete root admin",
      ),
  );
  const tenantChecks = descendants(rootTransaction, ts.isIfStatement).filter(
    (statement) =>
      compactNodeText(statement.expression, parsedFile) ===
      "!guardedActor.isRootAdmin&&guardedTarget.companyId!==guardedActor.companyId",
  );
  const selfChecks = descendants(rootTransaction, ts.isIfStatement).filter(
    (statement) =>
      compactNodeText(statement.expression, parsedFile) ===
      "guardedTarget.id===guardedActor.id",
  );
  const referencedProjects = namedVariableDeclaration(
    rootTransaction,
    "referencedProjects",
  );
  const ownedProjects = namedVariableDeclaration(
    rootTransaction,
    "ownedProjects",
  );
  const referencedDemoChecks = descendants(
    rootTransaction,
    ts.isCallExpression,
  ).filter(
    (call) =>
      compactNodeText(call, parsedFile) ===
      "assertNoDemoProjects(referencedProjects)",
  );
  const ownedDemoChecks = descendants(
    rootTransaction,
    ts.isCallExpression,
  ).filter(
    (call) =>
      compactNodeText(call, parsedFile) ===
      "assertNoDemoProjects(ownedProjects)",
  );
  if (
    guardedActorChecks.length !== 1 ||
    guardedRootChecks.length !== 1 ||
    tenantChecks.length !== 1 ||
    selfChecks.length !== 1 ||
    compactNodeText(referencedProjects?.initializer, parsedFile) !==
      "awaitfindReferencedProjects(rootMutationTx,guardedTarget.id,)" ||
    !compactNodeText(ownedProjects?.initializer, parsedFile).includes(
      "guardedActor.isRootAdmin?eq(projects.authorId,guardedTarget.id):and(eq(projects.authorId,guardedTarget.id),eq(projects.companyId,guardedActor.companyId),)",
    ) ||
    referencedDemoChecks.length !== 1 ||
    ownedDemoChecks.length !== 1 ||
    descendants(rootTransaction, ts.isPropertyAccessExpression).some((node) =>
      exactPropertyPath(node, ["session", "user", "isRootAdmin"]),
    )
  ) {
    issues.add("database-backed-delete-authority-and-project-scope");
  }
  const imports = importedBindings(parsedFile);
  const stageBinding = imports.get("stageProjectDeletionsInTransaction");
  const reconcileBinding = imports.get("reconcileCommittedProjectDeletions");
  const existingWritesBinding = imports.get("withProjectWritesInTransaction");
  const stageCalls = descendants(deleteUser, ts.isCallExpression).filter(
    (call) => callName(call) === "stageProjectDeletionsInTransaction",
  );
  const stageCall = stageCalls[0] ?? null;
  const ordinaryCleanupCalls = descendants(
    rootTransaction,
    ts.isCallExpression,
  ).filter((call) => callName(call) === "withProjectWritesInTransaction");
  const directCleanupCalls = descendants(
    rootTransaction,
    ts.isCallExpression,
  ).filter((call) => callName(call) === "runCleanup");
  const committedAssignments = descendants(
    rootTransaction,
    ts.isBinaryExpression,
  ).filter(
    (binary) =>
      compactNodeText(binary, parsedFile) ===
      "committedProjectDeletions=staged.deletions",
  );
  const reconcileCalls = descendants(deleteUser, ts.isCallExpression).filter(
    (call) => callName(call) === "reconcileCommittedProjectDeletions",
  );
  const reconcileCall = reconcileCalls[0] ?? null;
  const rootTransactionCalls = descendants(
    deleteUser,
    ts.isCallExpression,
  ).filter(
    (call) =>
      callName(call) === "transaction" &&
      rootReceiverIdentifier(call) === "db" &&
      callbackArgumentForCall(call, 0, parsedFile) === rootTransaction,
  );
  const rootTransactionCall = rootTransactionCalls[0] ?? null;
  const forbiddenTransactionWork = descendants(
    rootTransaction,
    ts.isCallExpression,
  ).filter((call) =>
    new Set([
      "deleteProjectFully",
      "reconcileCommittedProjectDeletions",
      "transaction",
    ]).has(callName(call)),
  );
  const targetPosition = guardedUsers?.getStart(parsedFile.source) ?? -1;
  const authorityPosition =
    guardedActorChecks[0]?.getStart(parsedFile.source) ?? -1;
  const referencePosition =
    referencedProjects?.getStart(parsedFile.source) ?? -1;
  const ownedPosition = ownedProjects?.getStart(parsedFile.source) ?? -1;
  const demoPosition = Math.max(
    referencedDemoChecks[0]?.getStart(parsedFile.source) ?? -1,
    ownedDemoChecks[0]?.getStart(parsedFile.source) ?? -1,
  );
  const stagePosition = stageCall?.getStart(parsedFile.source) ?? -1;
  const transactionEnd = rootTransactionCall?.getEnd() ?? -1;
  const reconcilePosition = reconcileCall?.getStart(parsedFile.source) ?? -1;
  if (
    stageBinding?.sourceFile !== "src/lib/project-delete.ts" ||
    stageBinding.symbol !== "stageProjectDeletionsInTransaction" ||
    reconcileBinding?.sourceFile !== "src/lib/project-delete.ts" ||
    reconcileBinding.symbol !== "reconcileCommittedProjectDeletions" ||
    existingWritesBinding?.sourceFile !==
      "src/server/api/project-write-capability.ts" ||
    existingWritesBinding.symbol !== "withProjectWritesInTransaction" ||
    stageCalls.length !== 1 ||
    !stageCall ||
    stageCall.arguments.length !== 4 ||
    compactNodeText(stageCall.arguments[0], parsedFile) !== "rootMutationTx" ||
    compactNodeText(stageCall.arguments[1], parsedFile) !==
      "ownedProjects.map((project)=>({project,writeCapability:assertProjectWritable(project),}))" ||
    compactNodeText(stageCall.arguments[2], parsedFile) !==
      "cleanupCapabilities" ||
    compactNodeText(stageCall.arguments[3], parsedFile) !== "runCleanup" ||
    ordinaryCleanupCalls.length !== 1 ||
    compactNodeText(ordinaryCleanupCalls[0], parsedFile) !==
      "withProjectWritesInTransaction(rootMutationTx,cleanupCapabilities,runCleanup,)" ||
    directCleanupCalls.length !== 1 ||
    compactNodeText(directCleanupCalls[0], parsedFile) !==
      "runCleanup(rootMutationTx)" ||
    committedAssignments.length !== 1 ||
    rootTransactionCalls.length !== 1 ||
    reconcileCalls.length !== 1 ||
    !reconcileCall ||
    compactNodeText(reconcileCall.arguments[0], parsedFile) !==
      "committedProjectDeletions" ||
    !directAwaitContains(reconcileCall) ||
    forbiddenTransactionWork.length !== 0 ||
    descendants(deleteUser, ts.isCallExpression).some(
      (call) => callName(call) === "deleteProjectFully",
    ) ||
    targetPosition <= lock.guardPosition ||
    authorityPosition <= targetPosition ||
    referencePosition <= authorityPosition ||
    ownedPosition <= referencePosition ||
    demoPosition <= ownedPosition ||
    stagePosition <= demoPosition ||
    reconcilePosition <= transactionEnd
  ) {
    issues.add("try-lock-authority-atomic-stage-before-post-commit-reconcile");
  }
  return issues;
}

function jwtAuthorityIssues(authority, auth) {
  const issues = new Set();
  const refresh = functionFor(authority, "refreshJwtUserAuthority");
  const expectedRefreshStatements = [
    "if(!Number.isSafeInteger(token.dbId)||Number(token.dbId)<=0)returnnull;",
    "const[fresh]=awaitdb.select({companyId:users.companyId,role:users.role,canRunModels:users.canRunModels,isRootAdmin:users.isRootAdmin,}).from(users).where(eq(users.id,token.dbId!)).limit(1);",
    "if(!fresh)returnnull;",
    "token.companyId=fresh.companyId;",
    "token.role=fresh.role;",
    "token.canRunModels=fresh.canRunModels;",
    "token.isRootAdmin=fresh.isRootAdmin;",
    "returntoken;",
  ];
  if (
    !refresh?.body ||
    refresh.body.statements.length !== expectedRefreshStatements.length ||
    refresh.body.statements.some(
      (statement, index) =>
        compactNodeText(statement, authority) !==
        expectedRefreshStatements[index],
    ) ||
    descendants(refresh, ts.isTryStatement).length > 0 ||
    descendants(refresh, ts.isCatchClause).length > 0
  ) {
    issues.add("jwt-helper-exact-fail-closed");
  }

  const jwtMethods = descendants(auth.source, ts.isMethodDeclaration).filter(
    (method) => propertyName(method.name) === "jwt",
  );
  const jwt = jwtMethods.length === 1 ? jwtMethods[0] : null;
  const refreshCalls = jwt
    ? descendants(jwt, ts.isCallExpression).filter(
        (call) => callName(call) === "refreshJwtUserAuthority",
      )
    : [];
  const refreshBranches = jwt
    ? descendants(jwt, ts.isIfStatement).filter(
        (statement) =>
          compactNodeText(statement, auth) ===
          'if(trigger!=="signIn"){returnrefreshJwtUserAuthority(token);}',
      )
    : [];
  if (refreshCalls.length !== 1 || refreshBranches.length !== 1) {
    issues.add("jwt-refresh-unconditional-delegation");
  }
  const importedRefresh = descendants(auth.source, ts.isImportSpecifier).filter(
    (specifier) =>
      (specifier.propertyName ?? specifier.name).text ===
      "refreshJwtUserAuthority",
  );
  if (importedRefresh.length !== 1) {
    issues.add("jwt-refresh-exact-import");
  }
  return issues;
}

function rootBootstrapPromotionIssues(auth) {
  const issues = new Set();
  if (
    numericConstantValue(
      variableInitializer(auth.source, "ROOT_ADMIN_MUTATION_ADVISORY_LOCK"),
    ) !== 737375864
  ) {
    issues.add("bootstrap-shared-root-advisory-lock-id");
  }
  const authorize = functionFor(auth, "authorize");
  if (!authorize)
    return new Set([...issues, "credentials-authorize-structure"]);
  const found = namedVariableDeclaration(authorize, "found");
  if (
    compactNodeText(found?.initializer, auth) !==
    "awaitdb.select({id:users.id,email:users.email,username:users.username,passwordHash:users.passwordHash,companyId:users.companyId,role:users.role,canRunModels:users.canRunModels,isRootAdmin:users.isRootAdmin,}).from(users).where(eq(users.email,email)).limit(1)"
  ) {
    issues.add("credentials-full-authority-query");
  }
  const credentialQueryTry = descendants(authorize, ts.isTryStatement).filter(
    (statement) => found && nodeContains(statement.tryBlock, found),
  );
  if (
    credentialQueryTry.length !== 1 ||
    !credentialQueryTry[0].catchClause ||
    !exactReturnLiteral(credentialQueryTry[0].catchClause.block, null)
  ) {
    issues.add("credentials-query-fails-closed");
  }

  const promotion = namedVariableDeclaration(authorize, "promotion");
  const promotionTransaction = namedDbTransactionCallback(
    authorize,
    auth,
    "tx",
  );
  if (
    !promotion ||
    !promotionTransaction ||
    !nodeContains(promotion, promotionTransaction)
  ) {
    issues.add("bootstrap-promotion-transaction");
    return issues;
  }
  const lock = checkedTryAdvisoryLock(auth, promotionTransaction, "tx", "busy");
  for (const issue of lock.issues) issues.add(`bootstrap-${issue}`);

  const promoted = namedVariableDeclaration(promotionTransaction, "promoted");
  const current = namedVariableDeclaration(promotionTransaction, "current");
  const promotedChecks = descendants(
    promotionTransaction,
    ts.isIfStatement,
  ).filter(
    (statement) =>
      compactNodeText(statement, auth) ===
      'if(promoted)return"promoted"asconst;',
  );
  const currentReturns = descendants(
    promotionTransaction,
    ts.isReturnStatement,
  ).filter(
    (statement) =>
      compactNodeText(statement.expression, auth) ===
      'current?.isRootAdmin?("already-root"asconst):("missing"asconst)',
  );
  if (
    compactNodeText(promoted?.initializer, auth) !==
      "awaittx.update(users).set({isRootAdmin:true}).where(and(eq(users.id,user.id),eq(users.isRootAdmin,false))).returning({id:users.id})" ||
    promotedChecks.length !== 1 ||
    compactNodeText(current?.initializer, auth) !==
      "awaittx.select({isRootAdmin:users.isRootAdmin}).from(users).where(eq(users.id,user.id)).limit(1)" ||
    currentReturns.length !== 1
  ) {
    issues.add("bootstrap-conditional-update-and-live-recheck");
  }
  const promotionFailureChecks = descendants(
    authorize,
    ts.isIfStatement,
  ).filter(
    (statement) =>
      compactNodeText(statement, auth) ===
      'if(promotion==="busy"||promotion==="missing")returnnull;',
  );
  const promotionTry = descendants(authorize, ts.isTryStatement).filter(
    (statement) => promotion && nodeContains(statement.tryBlock, promotion),
  );
  if (
    promotionFailureChecks.length !== 1 ||
    promotionTry.length !== 1 ||
    !promotionTry[0].catchClause ||
    !exactReturnLiteral(promotionTry[0].catchClause.block, null)
  ) {
    issues.add("bootstrap-contention-missing-and-error-fail-closed");
  }
  const promotedPosition = promoted?.getStart(auth.source) ?? -1;
  const currentPosition = current?.getStart(auth.source) ?? -1;
  if (
    promotedPosition <= lock.guardPosition ||
    currentPosition <= promotedPosition
  ) {
    issues.add("bootstrap-lock-update-recheck-order");
  }
  return issues;
}

async function validateRootAndJwtAuthority() {
  const files = {
    admin: "src/server/services/admin-users.ts",
    auth: "src/lib/auth.ts",
    jwt: "src/server/services/auth-jwt-authority.ts",
  };
  const [admin, auth, jwt] = await Promise.all([
    parsed(files.admin),
    parsed(files.auth),
    parsed(files.jwt),
  ]);
  const updateIssues = adminUserUpdateAuthorityIssues(admin);
  if (updateIssues.size > 0) {
    report(
      "ADMIN_USER_UPDATE_AUTHORITY_RACE",
      `admin user update violates: ${[...updateIssues].sort().join(", ")}`,
      files.admin,
      functionFor(admin, "updateUser") ?? admin.source,
    );
  }
  const deletionIssues = adminUserDeletionAuthorityIssues(admin);
  if (deletionIssues.size > 0) {
    report(
      "ROOT_ADMIN_DELETE_RACE",
      `admin user deletion violates: ${[...deletionIssues].sort().join(", ")}`,
      files.admin,
      functionFor(admin, "deleteUser") ?? admin.source,
    );
  }
  const jwtIssues = jwtAuthorityIssues(jwt, auth);
  if (jwtIssues.size > 0) {
    report(
      "JWT_AUTHORITY_FAIL_OPEN",
      `JWT authority violates: ${[...jwtIssues].sort().join(", ")}`,
      files.jwt,
      functionFor(jwt, "refreshJwtUserAuthority") ?? jwt.source,
    );
  }
  const promotionIssues = rootBootstrapPromotionIssues(auth);
  if (promotionIssues.size > 0) {
    report(
      "ROOT_BOOTSTRAP_RACE",
      `root bootstrap promotion violates: ${[...promotionIssues].sort().join(", ")}`,
      files.auth,
      auth.source,
    );
  }
}

function objectPropertyHasLiteral(object, name, expected) {
  const initializer = object ? propertyInitializer(object, name) : null;
  return (
    initializer !== null &&
    initializer !== undefined &&
    literalValue(initializer) === expected
  );
}

function deterministicDeletionCallerReference(node) {
  const value = unwrapExpression(node);
  if (
    !value ||
    !ts.isTemplateExpression(value) ||
    value.head.text !== "bp-project-delete:"
  ) {
    return false;
  }
  if (value.templateSpans.length !== 2) return false;
  return (
    exactPropertyPath(value.templateSpans[0].expression, ["row", "id"]) &&
    value.templateSpans[0].literal.text === ":" &&
    exactPropertyPath(value.templateSpans[1].expression, [
      "row",
      "invalidationGeneration",
    ]) &&
    value.templateSpans[1].literal.text === ""
  );
}

function projectAssetDeletionFoundationIssues(
  schema,
  migrationText,
  eventMigrationText,
  productionFiles,
) {
  const issues = new Set();
  const tableCall = unwrapExpression(
    variableInitializer(schema.source, "projectAssetDeletions"),
  );
  const columns =
    tableCall && ts.isCallExpression(tableCall)
      ? objectArgumentForCall(tableCall, 1)
      : null;
  const storageRoot = columns
    ? propertyInitializer(columns, "storageRoot")
    : null;
  const expectedColumns = [
    "id",
    "projectPublicId",
    "companyId",
    "storageRoot",
    "lifecycleEpoch",
    "status",
    "phase",
    "nextAttemptAt",
    "leaseToken",
    "leaseExpiresAt",
    "invalidationGeneration",
    "objectEventGeneration",
    "lastReconciledEventGeneration",
    "cloudfrontInvalidationId",
    "lastVerifiedAt",
    "completedAt",
  ];
  if (
    !tableCall ||
    !ts.isCallExpression(tableCall) ||
    callName(tableCall) !== "pgTable" ||
    literalValue(tableCall.arguments[0]) !== "project_asset_deletions" ||
    !columns ||
    !expectedColumns.every((name) => objectProperty(columns, name)) ||
    !storageRoot ||
    !hasAllCalls(storageRoot, ["unique", "notNull"]) ||
    hasCall(tableCall, ["references"])
  ) {
    issues.add("permanent-unique-no-fk-schema");
  }

  const normalized = migrationText.toLowerCase().replace(/\s+/gu, " ").trim();
  const createMatch = normalized.match(
    /create table "project_asset_deletions" \(([\s\S]*?)\); --> statement-breakpoint/u,
  );
  const createBody = createMatch?.[1] ?? "";
  const lockText =
    "perform pg_advisory_xact_lock(hashtextextended(new.data_url, 2026071401))";
  const lockPosition = normalized.indexOf(lockText);
  const tombstoneCheckPosition = normalized.indexOf(
    "from project_asset_deletions where storage_root = new.data_url",
  );
  const reservedRoots =
    "'_bp-staging', '_bp-public', 'models', 'tmp', 'config', 'csi-databases'";
  if (
    !createBody.includes(
      'constraint "project_asset_deletions_storage_root_unique" unique("storage_root")',
    ) ||
    createBody.includes("references") ||
    createBody.includes("foreign key") ||
    !normalized.includes(
      "check (\"status\" in ('pending', 'watching', 'completed'))",
    ) ||
    !normalized.includes(
      "check (\"phase\" in ('purge', 'invalidate', 'verify', 'watch', 'complete'))",
    ) ||
    !normalized.includes(
      "check ((\"phase\" = 'complete') = (\"status\" = 'completed'))",
    ) ||
    !normalized.includes("\"storage_root\" ~ '^[a-z0-9-]+/[a-f0-9]{20}$'") ||
    !normalized.includes("split_part(\"storage_root\", '/', 1)") ||
    !normalized.includes(`not in (${reservedRoots})`) ||
    !normalized.includes(
      "create trigger bp_guard_retired_project_storage before insert on projects",
    ) ||
    lockPosition < 0 ||
    tombstoneCheckPosition < 0 ||
    lockPosition >= tombstoneCheckPosition
  ) {
    issues.add("permanent-tombstone-migration-backstop");
  }
  const normalizedEvents = eventMigrationText
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
  if (
    !normalizedEvents.includes(
      'alter table "project_asset_deletions" add column "object_event_generation" bigint default 0 not null',
    ) ||
    !normalizedEvents.includes(
      'alter table "project_asset_deletions" add column "last_reconciled_event_generation" bigint default 0 not null',
    ) ||
    !normalizedEvents.includes('"object_event_generation" >= 0') ||
    !normalizedEvents.includes('"last_reconciled_event_generation" >= 0') ||
    !normalizedEvents.includes(
      '"last_reconciled_event_generation" <= "object_event_generation"',
    )
  ) {
    issues.add("durable-object-event-generations");
  }

  for (const parsedFile of productionFiles) {
    const deletesTombstone =
      descendants(parsedFile.source, ts.isCallExpression).some(
        (call) =>
          callName(call) === "delete" &&
          exactPropertyPath(call.arguments[0], ["projectAssetDeletions"]),
      ) ||
      descendants(parsedFile.source, ts.isTaggedTemplateExpression).some(
        (sqlNode) => sqlHasAll(sqlNode, ["delete", "project_asset_deletions"]),
      );
    if (deletesTombstone) {
      issues.add(`permanent-tombstone-delete:${parsedFile.source.fileName}`);
    }
  }
  const storageBoundaryCallsites = productionFiles.flatMap((parsedFile) =>
    descendants(parsedFile.source, ts.isCallExpression)
      .filter((call) => callName(call) === "withProjectStorageWrite")
      .map((call) => ({
        file: parsedFile.source.fileName,
        owner: enclosingFunction(parsedFile, call).name,
      })),
  );
  if (
    storageBoundaryCallsites.length !== 1 ||
    storageBoundaryCallsites[0].file !== "src/lib/project-delete.ts" ||
    storageBoundaryCallsites[0].owner !== "deleteProjectFully"
  ) {
    issues.add("storage-boundary-callsite-inventory");
  }
  const existingTransactionCallsites = productionFiles.flatMap((parsedFile) =>
    descendants(parsedFile.source, ts.isCallExpression)
      .filter((call) =>
        new Set([
          "withProjectWritesInTransaction",
          "withProjectStorageWritesInTransaction",
        ]).has(callName(call)),
      )
      .map((call) => ({
        file: parsedFile.source.fileName,
        owner: enclosingFunction(parsedFile, call).name,
        symbol: callName(call),
      })),
  );
  const expectedExistingTransactionCallsites = [
    "src/lib/project-delete.ts:stageProjectDeletionsInTransaction:withProjectStorageWritesInTransaction",
    "src/lib/project-delete.ts:stageProjectDeletionsInTransaction:withProjectWritesInTransaction",
    "src/server/services/admin-users.ts:deleteUser:withProjectWritesInTransaction",
  ];
  if (
    JSON.stringify(
      existingTransactionCallsites
        .map(({ file, owner, symbol }) => `${file}:${owner}:${symbol}`)
        .sort(),
    ) !== JSON.stringify(expectedExistingTransactionCallsites)
  ) {
    issues.add("existing-transaction-boundary-callsite-inventory");
  }
  return issues;
}

function cloudFrontDeletionIssues(parsedFile) {
  const issues = new Set();
  const target = functionFor(parsedFile, "ensureProjectCloudFrontInvalidation");
  if (
    !target ||
    !isExportedDeclaration(
      parsedFile.source,
      "ensureProjectCloudFrontInvalidation",
    )
  ) {
    return new Set(["missing-cloudfront-authority"]);
  }
  const getCommand = descendants(target, ts.isNewExpression).find(
    (expression) =>
      propertyName(expression.expression) === "GetInvalidationCommand",
  );
  const createCommand = descendants(target, ts.isNewExpression).find(
    (expression) =>
      propertyName(expression.expression) === "CreateInvalidationCommand",
  );
  const getOptions = getCommand?.arguments?.[0]
    ? unwrapExpression(getCommand.arguments[0])
    : null;
  const createOptions = createCommand?.arguments?.[0]
    ? unwrapExpression(createCommand.arguments[0])
    : null;
  const invalidationBatch =
    createOptions && ts.isObjectLiteralExpression(createOptions)
      ? unwrapExpression(
          propertyInitializer(createOptions, "InvalidationBatch"),
        )
      : null;
  const paths =
    invalidationBatch && ts.isObjectLiteralExpression(invalidationBatch)
      ? unwrapExpression(propertyInitializer(invalidationBatch, "Paths"))
      : null;
  const items =
    paths && ts.isObjectLiteralExpression(paths)
      ? unwrapExpression(propertyInitializer(paths, "Items"))
      : null;
  const exactPath =
    items &&
    ts.isArrayLiteralExpression(items) &&
    items.elements.length === 1 &&
    interpolationTemplateMatches(items.elements[0], "/", [
      { identifier: "storageRoot", suffix: "/*" },
    ]);
  const callerReference =
    invalidationBatch && ts.isObjectLiteralExpression(invalidationBatch)
      ? unwrapExpression(
          propertyInitializer(invalidationBatch, "CallerReference"),
        )
      : null;
  const pollsStoredIdentity =
    getOptions &&
    ts.isObjectLiteralExpression(getOptions) &&
    exactPropertyPath(propertyInitializer(getOptions, "Id"), [
      "invalidationId",
    ]);
  const completionCheck = descendants(target, ts.isBinaryExpression).some(
    (binary) =>
      binary.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      exactPropertyPath(binary.left, ["response", "Invalidation", "Status"]) &&
      literalValue(binary.right) === "Completed",
  );
  if (
    !getCommand ||
    !createCommand ||
    !pollsStoredIdentity ||
    !callerReference ||
    !ts.isIdentifier(callerReference) ||
    callerReference.text !== "callerReference" ||
    !exactPath ||
    !completionCheck
  ) {
    issues.add("deterministic-create-and-poll");
  }
  if (
    !hasAllIdentifiers(target, [
      "CLOUDFRONT_DISTRIBUTION_ID",
      "CLOUDFRONT_DOMAIN",
    ]) ||
    !hasStringLiteral(target, [
      "CLOUDFRONT_DISTRIBUTION_ID is required when CLOUDFRONT_DOMAIN is configured",
      "CloudFront invalidation lookup returned no identity",
      "CloudFront invalidation creation returned no identity",
    ])
  ) {
    issues.add("cloudfront-fail-closed-identity");
  }
  return issues;
}

function updateUsesObjectEventGenerationCas(call) {
  return Boolean(
    call &&
    call.arguments.length === 4 &&
    exactPropertyPath(call.arguments[3], ["row", "objectEventGeneration"]),
  );
}

function recordsReconciledObjectEventGeneration(values) {
  return Boolean(
    values &&
    exactPropertyPath(
      propertyInitializer(values, "lastReconciledEventGeneration"),
      ["row", "objectEventGeneration"],
    ),
  );
}

function projectAssetDeletionReconcilerIssues(parsedFile, s3File) {
  const issues = new Set();
  const purgeHelper = functionFor(parsedFile, "purgeBothPrefixes");
  const bindings = importedBindings(parsedFile);
  const finalBinding = bindings.get("deleteProjectFiles");
  const stagingBinding = bindings.get("deleteProjectStagingFiles");
  const finalPurge = purgeHelper
    ? descendants(purgeHelper, ts.isCallExpression).find(
        (call) => callName(call) === "deleteProjectFiles",
      )
    : null;
  const stagingPurge = purgeHelper
    ? descendants(purgeHelper, ts.isCallExpression).find(
        (call) => callName(call) === "deleteProjectStagingFiles",
      )
    : null;
  const finalOptions = finalPurge ? objectArgumentForCall(finalPurge, 1) : null;
  const finalHook = finalOptions
    ? unwrapExpression(propertyInitializer(finalOptions, "onObjectsFound"))
    : null;
  if (
    !purgeHelper ||
    finalBinding?.sourceFile !== "src/lib/s3.ts" ||
    finalBinding.symbol !== "deleteProjectFiles" ||
    stagingBinding?.sourceFile !== "src/lib/s3.ts" ||
    stagingBinding.symbol !== "deleteProjectStagingFiles" ||
    !hasCall(purgeHelper, ["allSettled"]) ||
    !hasIdentifier(purgeHelper, ["AggregateError"]) ||
    !finalPurge ||
    !stagingPurge ||
    !exactPropertyPath(finalPurge.arguments[0], ["storageRoot"]) ||
    !finalHook ||
    !ts.isIdentifier(finalHook) ||
    finalHook.text !== "onFinalObjectsFound" ||
    stagingPurge.arguments.length !== 1 ||
    !exactPropertyPath(stagingPurge.arguments[0], ["storageRoot"])
  ) {
    issues.add("final-and-staging-all-version-purge");
  }

  const allVersionPurge = functionFor(s3File, "deleteS3PrefixAllVersions");
  const intentHooks = allVersionPurge
    ? descendants(allVersionPurge, ts.isCallExpression).filter(
        (call) =>
          callName(call) === "onObjectsFound" &&
          rootReceiverIdentifier(call) === "options",
      )
    : [];
  const firstDeleteObjects = allVersionPurge
    ? descendants(allVersionPurge, ts.isNewExpression).find(
        (expression) =>
          propertyName(expression.expression) === "DeleteObjectsCommand",
      )
    : null;
  const deleteProjectFiles = functionFor(s3File, "deleteProjectFiles");
  const delegatedFinalPurge = deleteProjectFiles
    ? descendants(deleteProjectFiles, ts.isCallExpression).find(
        (call) => callName(call) === "deleteS3PrefixAllVersions",
      )
    : null;
  let intentHookGuard = intentHooks[0]?.parent ?? null;
  while (intentHookGuard && !ts.isIfStatement(intentHookGuard)) {
    intentHookGuard = intentHookGuard.parent;
  }
  if (
    !allVersionPurge ||
    intentHooks.length !== 1 ||
    !directAwaitContains(intentHooks[0]) ||
    !firstDeleteObjects ||
    intentHooks[0].getStart() >= firstDeleteObjects.getStart() ||
    !intentHookGuard ||
    !hasAllIdentifiers(intentHookGuard.expression, [
      "objects",
      "objectsAnnounced",
    ]) ||
    !delegatedFinalPurge ||
    delegatedFinalPurge.arguments.length !== 2 ||
    !ts.isIdentifier(unwrapExpression(delegatedFinalPurge.arguments[1])) ||
    unwrapExpression(delegatedFinalPurge.arguments[1]).text !== "options"
  ) {
    issues.add("durable-intent-before-first-final-delete");
  }

  const target = functionFor(parsedFile, "reconcileProjectAssetDeletion");
  if (
    !target ||
    !isExportedDeclaration(parsedFile.source, "reconcileProjectAssetDeletion")
  ) {
    return new Set([...issues, "missing-reconciler"]);
  }
  const phaseBranches = descendants(target, ts.isIfStatement);
  const purgeBranch = phaseBranches.find((statement) =>
    hasStrictPropertyLiteralComparison(
      statement.expression,
      "row",
      "phase",
      "purge",
    ),
  );
  const invalidateBranch = phaseBranches.find((statement) =>
    hasStrictPropertyLiteralComparison(
      statement.expression,
      "row",
      "phase",
      "invalidate",
    ),
  );
  const verifyBranch = phaseBranches.find(
    (statement) =>
      hasStrictPropertyLiteralComparison(
        statement.expression,
        "row",
        "phase",
        "verify",
      ) &&
      hasStrictPropertyLiteralComparison(
        statement.expression,
        "row",
        "phase",
        "watch",
      ),
  );

  const initialPurge = purgeBranch
    ? descendants(purgeBranch.thenStatement, ts.isCallExpression).find(
        (call) => callName(call) === "purgeBothPrefixes",
      )
    : null;
  const initialAdvance = purgeBranch
    ? descendants(purgeBranch.thenStatement, ts.isCallExpression).find(
        (call) => {
          if (callName(call) !== "updateClaimedDeletion") return false;
          const values = objectArgumentForCall(call, 2);
          return (
            objectPropertyHasLiteral(values, "phase", "invalidate") &&
            Boolean(objectProperty(values, "s3PurgedAt"))
          );
        },
      )
    : null;
  if (
    !purgeBranch ||
    !initialPurge ||
    initialPurge.arguments.length !== 1 ||
    !exactPropertyPath(initialPurge.arguments[0], ["row", "storageRoot"]) ||
    !initialAdvance ||
    initialPurge.getStart() >= initialAdvance.getStart()
  ) {
    issues.add("purge-before-invalidation-phase");
  }

  const invalidationCall = invalidateBranch
    ? descendants(invalidateBranch.thenStatement, ts.isCallExpression).find(
        (call) => callName(call) === "ensureProjectCloudFrontInvalidation",
      )
    : null;
  const incompleteBranch = invalidateBranch
    ? descendants(invalidateBranch.thenStatement, ts.isIfStatement).find(
        (statement) =>
          descendants(statement.expression, ts.isPrefixUnaryExpression).some(
            (expression) =>
              expression.operator === ts.SyntaxKind.ExclamationToken &&
              exactPropertyPath(expression.operand, [
                "invalidation",
                "complete",
              ]),
          ),
      )
    : null;
  const pollUpdate = incompleteBranch
    ? descendants(incompleteBranch.thenStatement, ts.isCallExpression).find(
        (call) => {
          if (callName(call) !== "updateClaimedDeletion") return false;
          const values = objectArgumentForCall(call, 2);
          return (
            values &&
            exactPropertyPath(
              propertyInitializer(values, "cloudfrontInvalidationId"),
              ["invalidation", "id"],
            ) &&
            objectPropertyHasLiteral(values, "leaseToken", null) &&
            objectPropertyHasLiteral(values, "leaseExpiresAt", null) &&
            Boolean(objectProperty(values, "nextAttemptAt"))
          );
        },
      )
    : null;
  const verificationAdvance = invalidateBranch
    ? descendants(invalidateBranch.thenStatement, ts.isCallExpression).find(
        (call) => {
          if (callName(call) !== "updateClaimedDeletion") return false;
          const values = objectArgumentForCall(call, 2);
          return objectPropertyHasLiteral(values, "phase", "verify");
        },
      )
    : null;
  if (
    !invalidateBranch ||
    !invalidationCall ||
    invalidationCall.arguments.length !== 3 ||
    !exactPropertyPath(invalidationCall.arguments[0], ["row", "storageRoot"]) ||
    !deterministicDeletionCallerReference(invalidationCall.arguments[1]) ||
    !exactPropertyPath(invalidationCall.arguments[2], [
      "row",
      "cloudfrontInvalidationId",
    ]) ||
    !incompleteBranch ||
    !pollUpdate ||
    !updateUsesObjectEventGenerationCas(pollUpdate) ||
    !hasStringLiteral(incompleteBranch.thenStatement, ["pending"]) ||
    !verificationAdvance ||
    invalidationCall.getStart() >= verificationAdvance.getStart()
  ) {
    issues.add("deterministic-invalidation-create-poll");
  }

  const watchPurge = verifyBranch
    ? descendants(verifyBranch.thenStatement, ts.isCallExpression).find(
        (call) =>
          callName(call) === "purgeBothPrefixes" && call.arguments.length === 2,
      )
    : null;
  const lateIntent = watchPurge
    ? callbackArgumentForCall(watchPurge, 1, parsedFile)
    : null;
  const intentUpdate = lateIntent
    ? descendants(lateIntent, ts.isCallExpression).find((call) => {
        if (callName(call) !== "updateClaimedDeletion") return false;
        const values = objectArgumentForCall(call, 2);
        const generation = values
          ? unwrapExpression(
              propertyInitializer(values, "invalidationGeneration"),
            )
          : null;
        return (
          objectPropertyHasLiteral(values, "status", "pending") &&
          objectPropertyHasLiteral(values, "phase", "purge") &&
          objectPropertyHasLiteral(values, "cloudfrontInvalidationId", null) &&
          generation &&
          ts.isBinaryExpression(generation) &&
          generation.operatorToken.kind === ts.SyntaxKind.PlusToken &&
          exactPropertyPath(generation.left, [
            "row",
            "invalidationGeneration",
          ]) &&
          literalValue(generation.right) === "1"
        );
      })
    : null;
  const lateAdvance = verifyBranch
    ? descendants(verifyBranch.thenStatement, ts.isIfStatement).find(
        (statement) =>
          hasIdentifier(statement.expression, ["lateFinalRow"]) &&
          descendants(statement.thenStatement, ts.isCallExpression).some(
            (call) => {
              const values =
                callName(call) === "updateClaimedDeletion"
                  ? objectArgumentForCall(call, 2)
                  : null;
              return objectPropertyHasLiteral(values, "phase", "invalidate");
            },
          ),
      )
    : null;
  const watchUpdate = verifyBranch
    ? descendants(verifyBranch.thenStatement, ts.isCallExpression).find(
        (call) => {
          if (callName(call) !== "updateClaimedDeletion") return false;
          const values = objectArgumentForCall(call, 2);
          return (
            objectPropertyHasLiteral(values, "status", "watching") &&
            objectPropertyHasLiteral(values, "phase", "watch") &&
            objectPropertyHasLiteral(values, "leaseToken", null) &&
            objectPropertyHasLiteral(values, "leaseExpiresAt", null) &&
            Boolean(objectProperty(values, "completedAt")) &&
            Boolean(objectProperty(values, "lastVerifiedAt")) &&
            recordsReconciledObjectEventGeneration(values) &&
            Boolean(objectProperty(values, "nextAttemptAt"))
          );
        },
      )
    : null;
  const completedUpdate = verifyBranch
    ? descendants(verifyBranch.thenStatement, ts.isCallExpression).find(
        (call) => {
          if (callName(call) !== "updateClaimedDeletion") return false;
          const values = objectArgumentForCall(call, 2);
          return (
            objectPropertyHasLiteral(values, "status", "completed") &&
            objectPropertyHasLiteral(values, "phase", "complete") &&
            objectPropertyHasLiteral(values, "leaseToken", null) &&
            objectPropertyHasLiteral(values, "leaseExpiresAt", null) &&
            recordsReconciledObjectEventGeneration(values)
          );
        },
      )
    : null;
  const watchDelay = functionFor(parsedFile, "watchDelaySeconds");
  const hotWatchSeconds = numericConstantValue(
    variableInitializer(parsedFile.source, "HOT_WATCH_SECONDS"),
  );
  const coldWatchSeconds = numericConstantValue(
    variableInitializer(parsedFile.source, "COLD_WATCH_SECONDS"),
  );
  const hotWatchDays = numericConstantValue(
    variableInitializer(parsedFile.source, "HOT_WATCH_DAYS"),
  );
  if (
    !verifyBranch ||
    !watchPurge ||
    !exactPropertyPath(watchPurge.arguments[0], ["row", "storageRoot"]) ||
    !lateIntent ||
    !intentUpdate ||
    !lateAdvance ||
    !watchUpdate ||
    !updateUsesObjectEventGenerationCas(watchUpdate) ||
    !completedUpdate ||
    !updateUsesObjectEventGenerationCas(completedUpdate) ||
    !watchDelay ||
    !hasAllIdentifiers(watchDelay, [
      "HOT_WATCH_DAYS",
      "HOT_WATCH_SECONDS",
      "COLD_WATCH_SECONDS",
      "PROJECT_ASSET_EVENT_QUEUE_URL",
    ]) ||
    hotWatchSeconds !== 60 * 60 ||
    coldWatchSeconds !== 24 * 60 * 60 ||
    hotWatchDays !== 7 ||
    hasIdentifier(target, ["deletedObjects"])
  ) {
    issues.add("pre-delete-late-object-intent-and-permanent-watch");
  }

  const retryCatch = descendants(target, ts.isTryStatement).find(
    (statement) => {
      const catchClause = statement.catchClause;
      if (!catchClause) return false;
      return (
        descendants(catchClause.block, ts.isCallExpression).some((call) => {
          if (callName(call) !== "updateClaimedDeletion") return false;
          const values = objectArgumentForCall(call, 2);
          const status = values ? propertyInitializer(values, "status") : null;
          const phase = values ? propertyInitializer(values, "phase") : null;
          return (
            objectPropertyHasLiteral(values, "leaseToken", null) &&
            objectPropertyHasLiteral(values, "leaseExpiresAt", null) &&
            Boolean(objectProperty(values, "nextAttemptAt")) &&
            Boolean(objectProperty(values, "consecutiveFailures")) &&
            Boolean(objectProperty(values, "lastError")) &&
            status &&
            phase &&
            hasAllIdentifiers(status, [
              "projectAssetDeletions",
              "objectEventGeneration",
              "row",
            ]) &&
            expressionSqlHasAll(status, ["case", "when", "then", "pending"]) &&
            hasAllIdentifiers(phase, [
              "projectAssetDeletions",
              "objectEventGeneration",
              "row",
            ]) &&
            expressionSqlHasAll(phase, ["case", "when", "then", "purge"])
          );
        }) && catchRethrowsBinding(catchClause)
      );
    },
  );
  if (!retryCatch) issues.add("durable-retry-state");

  const claimedUpdate = functionFor(parsedFile, "updateClaimedDeletion");
  const generationPredicate = claimedUpdate
    ? descendants(claimedUpdate, ts.isCallExpression).find(
        (call) =>
          callName(call) === "eq" &&
          exactPropertyPath(call.arguments[0], [
            "projectAssetDeletions",
            "objectEventGeneration",
          ]) &&
          ts.isIdentifier(unwrapExpression(call.arguments[1])) &&
          unwrapExpression(call.arguments[1]).text ===
            "expectedObjectEventGeneration",
      )
    : null;
  if (
    !claimedUpdate ||
    !hasIdentifier(claimedUpdate, ["expectedObjectEventGeneration"]) ||
    !generationPredicate
  ) {
    issues.add("object-event-generation-cas");
  }

  const claim = functionFor(parsedFile, "claimProjectAssetDeletion");
  const claimForUpdate = claim
    ? descendants(claim, ts.isCallExpression).find((call) => {
        if (
          callName(call) !== "for" ||
          literalValue(call.arguments[0]) !== "update"
        )
          return false;
        const options = objectArgumentForCall(call, 1);
        return objectPropertyHasLiteral(options, "skipLocked", true);
      })
    : null;
  if (
    !claim ||
    !hasCall(claim, ["transaction"]) ||
    !claimForUpdate ||
    !hasAllStringLiterals(claim, ["pending", "watching"]) ||
    !hasAllIdentifiers(claim, [
      "leaseToken",
      "leaseExpiresAt",
      "nextAttemptAt",
      "attemptCount",
    ]) ||
    !descendants(claim, ts.isTaggedTemplateExpression).some((sqlNode) =>
      sqlHasAll(sqlNode, ["current_timestamp"]),
    )
  ) {
    issues.add("leased-scheduled-claim");
  }
  return issues;
}

function projectAssetObjectEventIssues(
  eventFile,
  workerFile,
  terraformText,
  terraformSource = terraformText,
) {
  const issues = new Set();
  const eventBindings = importedBindings(eventFile);
  const canonicalBinding = eventBindings.get("isCanonicalProjectPath");
  const stagingRootBinding = eventBindings.get("PROJECT_UPLOAD_STAGING_ROOT");
  const pathParser = functionFor(
    eventFile,
    "retiredProjectPathFromObjectEvent",
  );
  const pathHelper = functionFor(
    eventFile,
    "canonicalProjectPathFromObjectKeyParts",
  );
  const canonicalCall = pathHelper
    ? descendants(pathHelper, ts.isCallExpression).find(
        (call) => callName(call) === "isCanonicalProjectPath",
      )
    : null;
  const projectPath = pathHelper
    ? unwrapExpression(variableInitializer(pathHelper, "projectPath"))
    : null;
  const projectSegment =
    projectPath && ts.isTemplateExpression(projectPath)
      ? unwrapExpression(projectPath.templateSpans[1]?.expression)
      : null;
  const exactProjectPath =
    projectPath &&
    ts.isTemplateExpression(projectPath) &&
    projectPath.head.text === "" &&
    projectPath.templateSpans.length === 2 &&
    exactPropertyPath(projectPath.templateSpans[0].expression, [
      "companyDataKey",
    ]) &&
    projectPath.templateSpans[0].literal.text === "/" &&
    projectSegment &&
    exactPropertyPath(projectSegment, ["projectIdentity"]) &&
    projectPath.templateSpans[1].literal.text === "";
  const companyPart = pathHelper
    ? unwrapExpression(variableInitializer(pathHelper, "companyDataKey"))
    : null;
  const projectPart = pathHelper
    ? unwrapExpression(variableInitializer(pathHelper, "projectIdentity"))
    : null;
  const objectSegments = pathHelper
    ? unwrapExpression(variableInitializer(pathHelper, "objectSegments"))
    : null;
  const exactIndexedPart = (expression, indexName) =>
    expression &&
    ts.isElementAccessExpression(expression) &&
    exactPropertyPath(expression.expression, ["parts"]) &&
    exactPropertyPath(expression.argumentExpression, [indexName]);
  const helperCalls = pathParser
    ? descendants(pathParser, ts.isCallExpression).filter(
        (call) => callName(call) === "canonicalProjectPathFromObjectKeyParts",
      )
    : [];
  const exactHelperCall = (
    call,
    companyIndex,
    projectIndex,
    objectStartIndex,
  ) =>
    call &&
    call.arguments.length === 4 &&
    exactPropertyPath(call.arguments[0], ["parts"]) &&
    literalValue(call.arguments[1]) === String(companyIndex) &&
    literalValue(call.arguments[2]) === String(projectIndex) &&
    literalValue(call.arguments[3]) === String(objectStartIndex);
  const stagingPathCall = helperCalls.find((call) =>
    exactHelperCall(call, 1, 2, 3),
  );
  const finalPathCall = helperCalls.find((call) =>
    exactHelperCall(call, 0, 1, 2),
  );
  const stagingBranch = pathParser
    ? descendants(pathParser, ts.isIfStatement).find((statement) => {
        const expression = unwrapExpression(statement.expression);
        if (
          !expression ||
          !ts.isBinaryExpression(expression) ||
          expression.operatorToken.kind !==
            ts.SyntaxKind.EqualsEqualsEqualsToken
        )
          return false;
        const left = unwrapExpression(expression.left);
        const right = unwrapExpression(expression.right);
        const isPartsZero = (value) =>
          value &&
          ts.isElementAccessExpression(value) &&
          exactPropertyPath(value.expression, ["parts"]) &&
          literalValue(value.argumentExpression) === "0";
        return (
          (isPartsZero(left) &&
            exactPropertyPath(right, ["PROJECT_UPLOAD_STAGING_ROOT"])) ||
          (isPartsZero(right) &&
            exactPropertyPath(left, ["PROJECT_UPLOAD_STAGING_ROOT"]))
        );
      })
    : null;
  if (
    canonicalBinding?.sourceFile !== "src/lib/project-upload-authority.ts" ||
    canonicalBinding.symbol !== "isCanonicalProjectPath" ||
    stagingRootBinding?.sourceFile !== "src/lib/project-upload-authority.ts" ||
    stagingRootBinding.symbol !== "PROJECT_UPLOAD_STAGING_ROOT" ||
    !pathParser ||
    !isExportedDeclaration(
      eventFile.source,
      "retiredProjectPathFromObjectEvent",
    ) ||
    !pathHelper ||
    !hasAllCalls(pathParser, ["decodeURIComponent", "replaceAll", "split"]) ||
    !hasAllIdentifiers(pathParser, ["PROJECT_UPLOAD_STAGING_ROOT", "parts"]) ||
    !stagingBranch ||
    !stagingPathCall ||
    !nodeContains(stagingBranch.thenStatement, stagingPathCall) ||
    !finalPathCall ||
    nodeContains(stagingBranch.thenStatement, finalPathCall) ||
    helperCalls.length !== 2 ||
    !exactIndexedPart(companyPart, "companyIndex") ||
    !exactIndexedPart(projectPart, "projectIndex") ||
    !objectSegments ||
    !ts.isCallExpression(objectSegments) ||
    callName(objectSegments) !== "slice" ||
    rootReceiverIdentifier(objectSegments) !== "parts" ||
    !exactPropertyPath(objectSegments.arguments[0], ["objectStartIndex"]) ||
    !hasAllIdentifiers(pathHelper, [
      "companyDataKey",
      "projectIdentity",
      "objectSegments",
      "INVALID_OBJECT_KEY_SEGMENT",
    ]) ||
    !hasAllStringLiterals(pathHelper, [".", ".."]) ||
    !hasAllCalls(pathHelper, ["some", "test"]) ||
    !exactProjectPath ||
    !canonicalCall ||
    canonicalCall.arguments.length !== 2 ||
    !exactPropertyPath(canonicalCall.arguments[0], ["companyDataKey"]) ||
    !exactPropertyPath(canonicalCall.arguments[1], ["projectPath"])
  ) {
    issues.add("canonical-final-and-staging-event-path");
  }

  const wake = functionFor(eventFile, "wakeRetiredProjectPath");
  const wakeTransactions = wake
    ? descendants(wake, ts.isCallExpression).filter(
        (call) =>
          callName(call) === "transaction" &&
          rootReceiverIdentifier(call) === "db",
      )
    : [];
  const wakeCallback =
    wakeTransactions.length === 1
      ? callbackArgumentForCall(wakeTransactions[0], 0, eventFile)
      : null;
  const rowLock = wakeCallback
    ? descendants(wakeCallback, ts.isCallExpression).find(
        (call) =>
          callName(call) === "for" &&
          literalValue(call.arguments[0]) === "update" &&
          hasIdentifier(call, ["projectAssetDeletions"]),
      )
    : null;
  const wakeUpdate = wakeCallback
    ? descendants(wakeCallback, ts.isCallExpression).find(
        (call) =>
          callName(call) === "update" &&
          exactPropertyPath(call.arguments[0], ["projectAssetDeletions"]) &&
          rootReceiverIdentifier(call) === "tx",
      )
    : null;
  const wakeSetCall = wakeUpdate ? chainedCall(wakeUpdate, "set") : null;
  const wakeValues = wakeSetCall ? objectArgumentForCall(wakeSetCall, 0) : null;
  const statusWake = wakeValues
    ? propertyInitializer(wakeValues, "status")
    : null;
  const phaseWake = wakeValues
    ? propertyInitializer(wakeValues, "phase")
    : null;
  const generationWake = wakeValues
    ? propertyInitializer(wakeValues, "objectEventGeneration")
    : null;
  if (
    !wake ||
    wakeTransactions.length !== 1 ||
    !wakeCallback ||
    !rowLock ||
    !wakeUpdate ||
    rowLock.getStart() >= wakeUpdate.getStart() ||
    !statusWake ||
    !phaseWake ||
    !generationWake ||
    !hasAllIdentifiers(statusWake, ["projectAssetDeletions", "status"]) ||
    !expressionSqlHasAll(statusWake, ["case", "completed", "watching"]) ||
    !hasAllIdentifiers(phaseWake, ["projectAssetDeletions", "phase"]) ||
    !expressionSqlHasAll(phaseWake, ["case", "complete", "watch"]) ||
    !hasIdentifier(generationWake, ["objectEventGeneration"]) ||
    !expressionSqlHasAll(generationWake, ["1"]) ||
    objectProperty(wakeValues, "leaseToken") ||
    objectProperty(wakeValues, "leaseExpiresAt") ||
    !objectProperty(wakeValues, "nextAttemptAt")
  ) {
    issues.add("row-locked-generation-wake");
  }

  const drain = functionFor(eventFile, "drainProjectAssetObjectEvents");
  const wakeOnce = functionFor(eventFile, "wakeOnce");
  const durableWakeCall = wakeOnce
    ? descendants(wakeOnce, ts.isCallExpression).find(
        (call) => callName(call) === "wakeRetiredProjectPath",
      )
    : null;
  const wakeOnceCall = drain
    ? descendants(drain, ts.isCallExpression).find(
        (call) => callName(call) === "wakeOnce",
      )
    : null;
  const pathParserCall = drain
    ? descendants(drain, ts.isCallExpression).find(
        (call) => callName(call) === "retiredProjectPathFromObjectEvent",
      )
    : null;
  const deleteMessage = drain
    ? descendants(drain, ts.isNewExpression).find(
        (expression) =>
          propertyName(expression.expression) === "DeleteMessageCommand",
      )
    : null;
  const deleteSend =
    drain && deleteMessage
      ? descendants(drain, ts.isCallExpression).find(
          (call) =>
            callName(call) === "send" && nodeContains(call, deleteMessage),
        )
      : null;
  const durableBeforeAck =
    drain &&
    wakeOnceCall &&
    deleteSend &&
    descendants(drain, ts.isTryStatement).some(
      (statement) =>
        nodeContains(statement.tryBlock, wakeOnceCall) &&
        nodeContains(statement.tryBlock, deleteSend) &&
        wakeOnceCall.getStart() < deleteSend.getStart(),
    );
  const receiptGuard = drain
    ? descendants(drain, ts.isIfStatement).find(
        (statement) =>
          hasIdentifier(statement.expression, ["ReceiptHandle", "message"]) &&
          descendants(statement.thenStatement, ts.isThrowStatement).length > 0,
      )
    : null;
  const dedupeDeclaration = drain
    ? descendants(drain, ts.isVariableDeclaration).find(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === "wakeByProjectPath",
      )
    : null;
  const dedupeMap = dedupeDeclaration?.initializer
    ? unwrapExpression(dedupeDeclaration.initializer)
    : null;
  const receiveMessage = drain
    ? descendants(drain, ts.isNewExpression).find(
        (expression) =>
          propertyName(expression.expression) === "ReceiveMessageCommand",
      )
    : null;
  const receiveInput = receiveMessage?.arguments?.[0];
  const parallelBatch = drain
    ? descendants(drain, ts.isCallExpression).find(
        (call) =>
          callName(call) === "all" &&
          rootReceiverIdentifier(call) === "Promise" &&
          hasIdentifier(call, ["messages"]),
      )
    : null;
  const batchLoop =
    drain && receiveMessage && dedupeDeclaration && parallelBatch
      ? descendants(drain, ts.isForStatement).find(
          (statement) =>
            nodeContains(statement, receiveMessage) &&
            nodeContains(statement, dedupeDeclaration) &&
            nodeContains(statement, parallelBatch),
        )
      : null;
  const maxBatchesParameter = drain?.parameters.find(
    (parameter) =>
      ts.isIdentifier(parameter.name) && parameter.name.text === "maxBatches",
  );
  if (
    !drain ||
    !isExportedDeclaration(eventFile.source, "drainProjectAssetObjectEvents") ||
    !hasIdentifier(drain, [
      "PROJECT_ASSET_EVENT_QUEUE_URL",
      "ReceiveMessageCommand",
    ]) ||
    !maxBatchesParameter?.initializer ||
    !exactPropertyPath(maxBatchesParameter.initializer, [
      "DEFAULT_MAX_BATCHES",
    ]) ||
    numericConstantValue(
      variableInitializer(eventFile.source, "DEFAULT_MAX_BATCHES"),
    ) < 100 ||
    !receiveMessage ||
    !objectPropertyHasLiteral(receiveInput, "MaxNumberOfMessages", "10") ||
    !parallelBatch ||
    !directAwaitContains(parallelBatch) ||
    !dedupeMap ||
    !ts.isNewExpression(dedupeMap) ||
    propertyName(dedupeMap.expression) !== "Map" ||
    !batchLoop ||
    receiveMessage.getStart() >= dedupeDeclaration.getStart() ||
    dedupeDeclaration.getStart() >= parallelBatch.getStart() ||
    !wakeOnce ||
    !durableWakeCall ||
    !chainedCall(durableWakeCall, "then") ||
    !hasAllCalls(wakeOnce, ["get", "set", "delete"]) ||
    !hasAllIdentifiers(wakeOnce, [
      "wakeByProjectPath",
      "didWake",
      "awakened",
    ]) ||
    !pathParserCall ||
    !wakeOnceCall ||
    !directAwaitContains(wakeOnceCall) ||
    !receiptGuard ||
    receiptGuard.getStart() >= wakeOnceCall.getStart() ||
    !deleteSend ||
    !directAwaitContains(deleteSend) ||
    !durableBeforeAck ||
    !hasAllIdentifiers(deleteMessage, ["QueueUrl", "ReceiptHandle", "message"])
  ) {
    issues.add("durable-wake-before-sqs-ack");
  }

  const workerBindings = importedBindings(workerFile);
  const workerMain = functionFor(workerFile, "main");
  const eventDrain = workerMain
    ? descendants(workerMain, ts.isCallExpression).find(
        (call) => callName(call) === "drainProjectAssetObjectEvents",
      )
    : null;
  const assetDrain = workerMain
    ? descendants(workerMain, ts.isCallExpression).find(
        (call) => callName(call) === "drainProjectAssetDeletionQueue",
      )
    : null;
  if (
    workerBindings.get("drainProjectAssetObjectEvents")?.sourceFile !==
      "src/lib/project-asset-object-events.ts" ||
    workerBindings.get("drainProjectAssetObjectEvents")?.symbol !==
      "drainProjectAssetObjectEvents" ||
    !eventDrain ||
    !assetDrain ||
    !directAwaitContains(eventDrain) ||
    eventDrain.getStart() >= assetDrain.getStart()
  ) {
    issues.add("event-drain-before-due-row-drain");
  }

  const requiredInfra = [
    'resource "aws_sqs_queue" "beaver_project_asset_events"',
    'resource "aws_s3_bucket_notification" "beaver_data_eventbridge"',
    "eventbridge = true",
    'resource "aws_cloudwatch_event_rule" "beaver_project_staging_object_created"',
    'resource "aws_cloudwatch_event_target" "beaver_project_staging_object_created"',
    'resource "aws_sqs_queue_policy" "beaver_project_asset_events"',
    'Principal = { Service = "events.amazonaws.com" }',
    '"sqs:ReceiveMessage"',
    '"sqs:DeleteMessage"',
    'name = "PROJECT_ASSET_EVENT_QUEUE_URL"',
  ];
  const eventRule = terraformResourceBlock(
    terraformText,
    "aws_cloudwatch_event_rule",
    "beaver_project_staging_object_created",
  );
  const eventQueuePolicy = terraformResourceBlock(
    terraformText,
    "aws_sqs_queue_policy",
    "beaver_project_asset_events",
  );
  if (
    !requiredInfra.every((marker) => terraformText.includes(marker)) ||
    !textHasAll(eventRule, [
      'source = ["aws.s3"]',
      'detail-type = ["Object Created"]',
      "bucket = { name = [aws_s3_bucket.beaver_data.id] }",
    ]) ||
    eventRule.includes("object =") ||
    !textHasAll(eventQueuePolicy, [
      "queue_url = aws_sqs_queue.beaver_project_asset_events.id",
      'Principal = { Service = "events.amazonaws.com" }',
      'Action = "sqs:SendMessage"',
      "Resource = aws_sqs_queue.beaver_project_asset_events.arn",
      '"aws:SourceAccount" = data.aws_caller_identity.current.account_id',
      '"aws:SourceArn" = aws_cloudwatch_event_rule.beaver_project_staging_object_created.arn',
    ])
  ) {
    issues.add("durable-s3-object-created-delivery");
  }

  const deliveryDlq = terraformResourceBlock(
    terraformText,
    "aws_sqs_queue",
    "beaver_project_asset_event_delivery_dlq",
  );
  const eventTarget = terraformResourceBlock(
    terraformText,
    "aws_cloudwatch_event_target",
    "beaver_project_staging_object_created",
  );
  const deliveryDlqPolicy = terraformResourceBlock(
    terraformText,
    "aws_sqs_queue_policy",
    "beaver_project_asset_event_delivery_dlq",
  );
  const bucketNotification = terraformResourceBlock(
    terraformText,
    "aws_s3_bucket_notification",
    "beaver_data_eventbridge",
  );
  if (
    !textHasAll(deliveryDlq, [
      'name = "beaver-project-asset-event-delivery-dlq"',
      "message_retention_seconds = 1209600",
    ]) ||
    !textHasAll(eventTarget, [
      "dead_letter_config { arn = aws_sqs_queue.beaver_project_asset_event_delivery_dlq.arn }",
      "retry_policy { maximum_event_age_in_seconds = 86400 maximum_retry_attempts = 185 }",
      "aws_sqs_queue_policy.beaver_project_asset_events",
      "aws_sqs_queue_policy.beaver_project_asset_event_delivery_dlq",
    ]) ||
    !textHasAll(deliveryDlqPolicy, [
      "queue_url = aws_sqs_queue.beaver_project_asset_event_delivery_dlq.id",
      'Principal = { Service = "events.amazonaws.com" }',
      'Action = "sqs:SendMessage"',
      "Resource = aws_sqs_queue.beaver_project_asset_event_delivery_dlq.arn",
      '"aws:SourceAccount" = data.aws_caller_identity.current.account_id',
      '"aws:SourceArn" = aws_cloudwatch_event_rule.beaver_project_staging_object_created.arn',
    ]) ||
    !textHasAll(bucketNotification, [
      "eventbridge = true",
      "aws_cloudwatch_event_target.beaver_project_staging_object_created",
      "aws_sqs_queue_policy.beaver_project_asset_events",
      "aws_sqs_queue_policy.beaver_project_asset_event_delivery_dlq",
    ])
  ) {
    issues.add("eventbridge-delivery-dlq-and-exact-retry");
  }

  const scheduler = terraformResourceBlock(
    terraformText,
    "aws_scheduler_schedule",
    "beaver_project_asset_deletions",
  );
  if (
    projectAssetSchedulerDependencyIssues(terraformSource).size > 0 ||
    !textHasAll(scheduler, [
      'schedule_expression = "rate(5 minutes)"',
      "dead_letter_config { arn = aws_sqs_queue.beaver_project_asset_deletion_scheduler_dlq.arn }",
      "retry_policy { maximum_event_age_in_seconds = 600 maximum_retry_attempts = 2 }",
    ])
  ) {
    issues.add("scheduler-must-wait-for-eventbridge-delivery");
  }

  const deliveryDlqAlarm = terraformResourceBlock(
    terraformText,
    "aws_cloudwatch_metric_alarm",
    "beaver_project_asset_event_delivery_dlq",
  );
  const deliveryFailureAlarm = terraformResourceBlock(
    terraformText,
    "aws_cloudwatch_metric_alarm",
    "beaver_project_asset_event_delivery_failures",
  );
  const deliveryDlqFailureAlarm = terraformResourceBlock(
    terraformText,
    "aws_cloudwatch_metric_alarm",
    "beaver_project_asset_event_delivery_dlq_failures",
  );
  if (
    !textHasAll(deliveryDlqAlarm, [
      'metric_name = "ApproximateNumberOfMessagesVisible"',
      'namespace = "AWS/SQS"',
      "threshold = 0",
      "QueueName = aws_sqs_queue.beaver_project_asset_event_delivery_dlq.name",
      "alarm_actions = [aws_sns_topic.beaver_alerts.arn]",
    ]) ||
    !textHasAll(deliveryFailureAlarm, [
      'metric_name = "FailedInvocations"',
      'namespace = "AWS/Events"',
      "threshold = 0",
      "RuleName = aws_cloudwatch_event_rule.beaver_project_staging_object_created.name",
      "alarm_actions = [aws_sns_topic.beaver_alerts.arn]",
    ]) ||
    !textHasAll(deliveryDlqFailureAlarm, [
      'metric_name = "InvocationsFailedToBeSentToDlq"',
      'namespace = "AWS/Events"',
      "threshold = 0",
      "RuleName = aws_cloudwatch_event_rule.beaver_project_staging_object_created.name",
      "alarm_actions = [aws_sns_topic.beaver_alerts.arn]",
    ])
  ) {
    issues.add("eventbridge-delivery-failure-monitoring");
  }

  const heartbeatFilter = terraformResourceBlock(
    terraformText,
    "aws_cloudwatch_log_metric_filter",
    "beaver_project_asset_worker_heartbeat",
  );
  const heartbeatAlarm = terraformResourceBlock(
    terraformText,
    "aws_cloudwatch_metric_alarm",
    "beaver_project_asset_worker_heartbeat",
  );
  const fatalFilter = terraformResourceBlock(
    terraformText,
    "aws_cloudwatch_log_metric_filter",
    "beaver_project_asset_worker_fatal",
  );
  const nonzeroExitRule = terraformResourceBlock(
    terraformText,
    "aws_cloudwatch_event_rule",
    "beaver_project_asset_worker_nonzero_exit",
  );
  const failedStartRule = terraformResourceBlock(
    terraformText,
    "aws_cloudwatch_event_rule",
    "beaver_project_asset_worker_failed_to_start",
  );
  const nonzeroExitTarget = terraformResourceBlock(
    terraformText,
    "aws_cloudwatch_event_target",
    "beaver_project_asset_worker_nonzero_exit",
  );
  const failedStartTarget = terraformResourceBlock(
    terraformText,
    "aws_cloudwatch_event_target",
    "beaver_project_asset_worker_failed_to_start",
  );
  if (
    !textHasAll(heartbeatFilter, [
      'pattern = "\\"project-asset-deletion-worker] complete\\""',
      'name = "ProjectAssetDeletionWorkerHeartbeats"',
      'namespace = "BlueprintParser/Security"',
    ]) ||
    !textHasAll(heartbeatAlarm, [
      'comparison_operator = "LessThanThreshold"',
      "evaluation_periods = 2",
      "datapoints_to_alarm = 2",
      'metric_name = "ProjectAssetDeletionWorkerHeartbeats"',
      "period = 900",
      "threshold = 1",
      'treat_missing_data = "breaching"',
      "alarm_actions = [aws_sns_topic.beaver_alerts.arn]",
    ]) ||
    !textHasAll(fatalFilter, [
      'pattern = "\\"project-asset-deletion-worker] fatal\\""',
      'name = "ProjectAssetDeletionFailures"',
    ]) ||
    !textHasAll(nonzeroExitRule, [
      'detail-type = ["ECS Task State Change"]',
      "clusterArn = [aws_ecs_cluster.beaver.arn]",
      'group = ["family:${aws_ecs_task_definition.beaver_project_asset_deletions.family}"]',
      'lastStatus = ["STOPPED"]',
      'exitCode = [{ "anything-but" = 0 }]',
    ]) ||
    !textHasAll(failedStartRule, [
      'detail-type = ["ECS Task State Change"]',
      "clusterArn = [aws_ecs_cluster.beaver.arn]",
      'group = ["family:${aws_ecs_task_definition.beaver_project_asset_deletions.family}"]',
      'lastStatus = ["STOPPED"]',
      'stopCode = ["TaskFailedToStart"]',
    ]) ||
    !textHasAll(nonzeroExitTarget, [
      "arn = aws_sns_topic.beaver_alerts.arn",
      "depends_on = [aws_sns_topic_policy.beaver_alerts]",
    ]) ||
    !textHasAll(failedStartTarget, [
      "arn = aws_sns_topic.beaver_alerts.arn",
      "depends_on = [aws_sns_topic_policy.beaver_alerts]",
    ])
  ) {
    issues.add("worker-heartbeat-and-ecs-failure-monitoring");
  }
  return issues;
}

async function validateProjectAssetDeletionProtocol(productionFiles) {
  const schemaFileName = "src/lib/db/schema.ts";
  const migrationFileName = "drizzle/0034_project_asset_deletion_outbox.sql";
  const eventMigrationFileName =
    "drizzle/0036_project_asset_object_event_generation.sql";
  const assetFileName = "src/lib/project-asset-deletion.ts";
  const s3FileName = "src/lib/s3.ts";
  const cloudFrontFileName = "src/lib/cloudfront.ts";
  const schema = await parsed(schemaFileName);
  const migrationText = await readFile(
    path.join(ROOT, migrationFileName),
    "utf8",
  );
  const eventMigrationText = await readFile(
    path.join(ROOT, eventMigrationFileName),
    "utf8",
  );
  const parsedProductionFiles = [];
  for (const file of productionFiles)
    parsedProductionFiles.push(await parsed(file));
  const foundationIssues = projectAssetDeletionFoundationIssues(
    schema,
    migrationText,
    eventMigrationText,
    parsedProductionFiles,
  );
  if (foundationIssues.size > 0) {
    report(
      "PROJECT_ASSET_DELETION_FOUNDATION_DRIFT",
      `asset tombstone foundation violates: ${[...foundationIssues].sort().join(", ")}`,
      migrationFileName,
    );
  }

  const assetFile = await parsed(assetFileName);
  const s3File = await parsed(s3FileName);
  const reconcilerIssues = projectAssetDeletionReconcilerIssues(
    assetFile,
    s3File,
  );
  if (reconcilerIssues.size > 0) {
    report(
      "PROJECT_ASSET_DELETION_RECONCILER_DRIFT",
      `asset reconciler violates: ${[...reconcilerIssues].sort().join(", ")}`,
      assetFileName,
      functionFor(assetFile, "reconcileProjectAssetDeletion") ??
        assetFile.source,
    );
  }

  const cloudFrontFile = await parsed(cloudFrontFileName);
  const cloudFrontIssues = cloudFrontDeletionIssues(cloudFrontFile);
  if (cloudFrontIssues.size > 0) {
    report(
      "PROJECT_ASSET_DELETION_CLOUDFRONT_DRIFT",
      `CloudFront deletion authority violates: ${[...cloudFrontIssues].sort().join(", ")}`,
      cloudFrontFileName,
      functionFor(cloudFrontFile, "ensureProjectCloudFrontInvalidation") ??
        cloudFrontFile.source,
    );
  }

  const workerFileName = "scripts/project-asset-deletion-worker.ts";
  const workerFile = await parsed(workerFileName);
  const workerMain = functionFor(workerFile, "main");
  const workerBinding = importedBindings(workerFile).get(
    "drainProjectAssetDeletionQueue",
  );
  const workerDrain = workerMain
    ? descendants(workerMain, ts.isCallExpression).find(
        (call) => callName(call) === "drainProjectAssetDeletionQueue",
      )
    : null;
  const workerBatch =
    workerMain && workerDrain
      ? descendants(workerMain, ts.isCallExpression).find(
          (call) => callName(call) === "all" && nodeContains(call, workerDrain),
        )
      : null;
  const queueDrain = functionFor(assetFile, "drainProjectAssetDeletionQueue");
  const terraformFileName =
    "infrastructure/terraform/project-asset-deletions.tf";
  const terraformSource = await readFile(
    path.join(ROOT, terraformFileName),
    "utf8",
  );
  const terraformText = terraformSource.replace(/\s+/gu, " ");
  const dockerText = (
    await readFile(path.join(ROOT, "Dockerfile"), "utf8")
  ).replace(/\s+/gu, " ");
  const eventFileName = "src/lib/project-asset-object-events.ts";
  const eventFile = await parsed(eventFileName);
  const eventIssues = projectAssetObjectEventIssues(
    eventFile,
    workerFile,
    terraformText,
    terraformSource,
  );
  if (eventIssues.size > 0) {
    report(
      "PROJECT_ASSET_OBJECT_EVENT_DRIFT",
      `late project-object event protocol violates: ${[...eventIssues].sort().join(", ")}`,
      eventFileName,
      functionFor(eventFile, "drainProjectAssetObjectEvents") ??
        eventFile.source,
    );
  }
  if (
    workerBinding?.sourceFile !== assetFileName ||
    workerBinding.symbol !== "drainProjectAssetDeletionQueue" ||
    !workerMain ||
    !workerDrain ||
    (!directAwaitContains(workerDrain) &&
      (!workerBatch || !directAwaitContains(workerBatch))) ||
    !hasAllIdentifiers(workerMain, ["failed", "exitCode"]) ||
    !queueDrain ||
    !isExportedDeclaration(
      assetFile.source,
      "drainProjectAssetDeletionQueue",
    ) ||
    !hasCall(queueDrain, ["reconcileProjectAssetDeletion"]) ||
    !hasIdentifier(queueDrain, ["maxAttempts", "attempted", "failed"]) ||
    !terraformText.includes(
      'resource "aws_scheduler_schedule" "beaver_project_asset_deletions"',
    ) ||
    !terraformText.includes('schedule_expression = "rate(5 minutes)"') ||
    !terraformText.includes(
      'command = ["./entrypoint.sh", "worker", "node", "scripts/project-asset-deletion-worker.js"]',
    ) ||
    !terraformText.includes("image = local.beaver_app_image") ||
    !terraformText.includes(
      'state = var.maintenance_worker_schedule_enabled ? "ENABLED" : "DISABLED"',
    ) ||
    !terraformText.includes('Action = ["s3:ListBucketVersions"]') ||
    !terraformText.includes(
      'Action = ["s3:DeleteObject", "s3:DeleteObjectVersion"]',
    ) ||
    !terraformText.includes(
      'Action = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]',
    ) ||
    !terraformText.includes("maximum_retry_attempts = 2") ||
    !dockerText.includes("scripts/project-asset-deletion-worker.ts") ||
    !dockerText.includes("scripts/project-asset-deletion-worker.js")
  ) {
    report(
      "PROJECT_ASSET_DELETION_SCHEDULER_DRIFT",
      "durable asset cleanup requires a built, bounded, scheduled worker with version-purge and CloudFront permissions",
      terraformFileName,
    );
  }
}

function processingStartIntentIssues(parsedFile, target) {
  const issues = new Set();
  if (!target) return new Set(["missing-symbol"]);
  const sends = descendants(target, ts.isCallExpression).filter(
    (call) =>
      callName(call) === "send" &&
      hasIdentifier(call, ["StartExecutionCommand"]),
  );
  if (sends.length !== 1) return new Set(["single-start-execution-send"]);
  const send = sends[0];

  const identityDeclaration = descendants(
    target,
    ts.isVariableDeclaration,
  ).find(
    (declaration) =>
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === "expectedExecutionArn" &&
      declaration.initializer &&
      hasAllIdentifiers(declaration.initializer, [
        "STEP_FUNCTION_ARN",
        "executionName",
      ]),
  );
  if (
    !identityDeclaration ||
    identityDeclaration.getStart() > send.getStart()
  ) {
    issues.add("provider-identity-before-send");
  }

  const intentValues = descendants(target, ts.isCallExpression).find((call) => {
    if (callName(call) !== "values" || !call.arguments[0]) return false;
    const insertsJob = descendants(call.expression, ts.isCallExpression).some(
      (candidate) =>
        callName(candidate) === "insert" &&
        propertyName(candidate.arguments[0]) === "processingJobs",
    );
    return (
      insertsJob &&
      hasAllIdentifiers(call.arguments[0], [
        "projectId",
        "executionId",
        "expectedExecutionArn",
        "status",
      ]) &&
      hasStringLiteral(call.arguments[0], ["running"])
    );
  });
  const intentInsert = intentValues
    ? descendants(intentValues.expression, ts.isCallExpression).find(
        (candidate) =>
          callName(candidate) === "insert" &&
          propertyName(candidate.arguments[0]) === "processingJobs",
      )
    : null;
  if (
    !intentValues ||
    !intentInsert ||
    intentValues.getStart() > send.getStart() ||
    atomicSinkViolation(parsedFile, {
      node: intentInsert,
      table: "processingJobs",
      kind: "insert",
    }) !== null
  ) {
    issues.add("running-intent-before-send");
  }

  const command = descendants(send, ts.isNewExpression).find(
    (expression) =>
      propertyName(expression.expression) === "StartExecutionCommand",
  );
  const commandOptions = command?.arguments?.[0]
    ? unwrapExpression(command.arguments[0])
    : null;
  const commandName =
    commandOptions && ts.isObjectLiteralExpression(commandOptions)
      ? propertyInitializer(commandOptions, "name")
      : null;
  if (
    !commandName ||
    !ts.isIdentifier(unwrapExpression(commandName)) ||
    unwrapExpression(commandName).text !== "executionName"
  ) {
    issues.add("provider-command-identity");
  }

  const sendTry = descendants(target, ts.isTryStatement)
    .filter((statement) => nodeContains(statement.tryBlock, send))
    .sort((a, b) => a.getEnd() - a.getStart() - (b.getEnd() - b.getStart()))[0];
  const catchBlock = sendTry?.catchClause?.block;
  const rethrowsStartError =
    catchBlock &&
    descendants(catchBlock, ts.isThrowStatement).some((statement) => {
      const expression = unwrapExpression(statement.expression);
      return (
        expression && ts.isIdentifier(expression) && expression.text === "error"
      );
    });
  const marksUnknown =
    catchBlock &&
    hasAllIdentifiers(catchBlock, ["processingJobs", "pendingJobId"]) &&
    hasStringLiteral(catchBlock, ["Step Functions start outcome unknown"]) &&
    hasCall(catchBlock, ["withProjectWrite", "update"]);
  const retiresIntent =
    catchBlock &&
    (hasCall(catchBlock, ["delete"]) ||
      hasStringLiteral(catchBlock, ["completed"]) ||
      hasStringLiteral(catchBlock, ["failed"]));
  if (!catchBlock || !rethrowsStartError || !marksUnknown || retiresIntent) {
    issues.add("ambiguous-start-fails-closed");
  }
  return issues;
}

async function validateProcessingStartIntent() {
  const fileName = "src/server/services/projects.ts";
  const parsedFile = await parsed(fileName);
  const target = functionFor(parsedFile, "createProject");
  const issues = processingStartIntentIssues(parsedFile, target);
  if (issues.size > 0) {
    report(
      "PROCESSING_START_INTENT_UNSAFE",
      `createProject violates: ${[...issues].sort().join(", ")}`,
      fileName,
      target ?? parsedFile.source,
    );
  }
}

async function validateLabelStudioCredentialTombstone() {
  for (const surface of TOMBSTONED_HTTP_SURFACES) {
    const parsedFile = await parsed(surface.routeFile);
    const handler = exportedRouteHandler(parsedFile, surface.method);
    const body = handler?.body;
    const statement = body && ts.isBlock(body) ? body.statements[0] : null;
    const thrown =
      statement && ts.isThrowStatement(statement)
        ? unwrapExpression(statement.expression)
        : null;
    const argumentsList =
      thrown && ts.isNewExpression(thrown) ? [...(thrown.arguments ?? [])] : [];
    if (
      !isExportedDeclaration(parsedFile.source, surface.method) ||
      routeAuthLiteral(parsedFile, surface.method) !== surface.auth ||
      !handler ||
      handler.parameters.length !== 0 ||
      !body ||
      !ts.isBlock(body) ||
      body.statements.length !== 1 ||
      !thrown ||
      !ts.isNewExpression(thrown) ||
      propertyName(thrown.expression) !== "ApiError" ||
      argumentsList.length !== 3 ||
      literalValue(argumentsList[0]) !== surface.code ||
      literalValue(argumentsList[1]) !== surface.message ||
      numericConstantValue(argumentsList[2]) !== surface.status
    ) {
      report(
        "LABEL_STUDIO_CREDENTIAL_TOMBSTONE_DRIFT",
        `${surface.method} ${surface.route} must unconditionally throw the manifest-pinned 410 without consulting authentication or provider configuration`,
        surface.routeFile,
        handler ?? parsedFile.source,
      );
    }

    const consumerFiles = [
      ...(await walk("src/app")),
      ...(await walk("src/components")),
      ...(await walk("src/server")),
      ...(await walk("src/stores")),
    ].filter((file) => file !== surface.routeFile);
    const forbiddenConsumerMarkers = [
      surface.route,
      "getLabelingCredentials",
      "LabelingCredentials",
      "labelingCredentials",
      "setLabelingCredentials",
      "LABEL_STUDIO_ADMIN_EMAIL",
      "LABEL_STUDIO_ADMIN_PASSWORD",
      "LABEL_STUDIO_USERNAME",
      "LABEL_STUDIO_PASSWORD",
    ];
    for (const file of consumerFiles) {
      const text = (await parsed(file)).text;
      const marker = forbiddenConsumerMarkers.find((value) =>
        text.includes(value),
      );
      if (marker) {
        report(
          "LABEL_STUDIO_BROWSER_CREDENTIAL_CONSUMER",
          `${file} still references retired Label Studio browser credential authority (${marker})`,
          file,
        );
      }
    }

    const wizardFile = "src/components/viewer/LabelingWizard.tsx";
    const wizard = await parsed(wizardFile);
    const createHandler = functionFor(wizard, "handleCreate");
    if (
      !createHandler ||
      !textHasAll(createHandler.getText(wizard.source), [
        'fetch("/api/labeling/create"',
        "setStoredSessions(data.sessions)",
      ]) ||
      [
        surface.route,
        "labelingCredentials",
        "setLabelingCredentials",
        "LABEL_STUDIO_ADMIN_EMAIL",
        "LABEL_STUDIO_ADMIN_PASSWORD",
      ].some((marker) => wizard.text.includes(marker))
    ) {
      report(
        "LABEL_STUDIO_BROWSER_CREDENTIAL_SERIALIZATION_DRIFT",
        "the labeling UI must retain only returned sessions and never request or store shared provider email/password authority",
        wizardFile,
        createHandler ?? wizard.source,
      );
    }

    const middlewareFile = "src/middleware.ts";
    const middleware = await parsed(middlewareFile);
    const deprecatedRoutes = variableInitializer(
      middleware.source,
      "DEPRECATED_ROUTES",
    );
    if (
      !deprecatedRoutes ||
      !hasStringLiteral(deprecatedRoutes, [surface.route])
    ) {
      report(
        "LABEL_STUDIO_CREDENTIAL_TOMBSTONE_TELEMETRY_DRIFT",
        `${surface.route} must remain classified as a deprecated-route signal while its 410 tombstone drains`,
        middlewareFile,
        deprecatedRoutes ?? middleware.source,
      );
    }
  }
}

function labelStudioProviderTaskAuthorityIssues(block, task) {
  const issues = new Set();
  if (!block) {
    issues.add("missing-task");
    return issues;
  }
  if (
    task.requiredEnvironment.some((name) => !block.includes(`name = "${name}"`))
  ) {
    issues.add("missing-environment");
  }
  if (
    task.requiredSecrets.some(
      (name) => !block.includes(`name      = "${name}"`),
    )
  ) {
    issues.add("missing-secret");
  }
  if (
    !block.includes(
      `{ name = "LABEL_STUDIO_INSTANCE_ID", value = "${task.instanceIdentity}" }`,
    )
  ) {
    issues.add("provider-generation");
  }
  if (
    task.rootAdminIdentity &&
    !block.includes(
      `{ name = "ROOT_ADMIN_EMAIL", value = ${task.rootAdminIdentity} }`,
    )
  ) {
    issues.add("root-admin-identity");
  }
  if (task.forbiddenAuthority.some((marker) => block.includes(marker))) {
    issues.add("provider-bootstrap-authority");
  }
  return issues;
}

async function validateLabelStudioProviderBindingPolicy() {
  const schemaFileName = "src/lib/db/schema.ts";
  const schema = await parsed(schemaFileName);
  const schemaTables = [
    [
      "labelStudioProjectIntents",
      "uq_ls_intents_provider_project",
      "providerProjectId",
    ],
    [
      "labelingSessions",
      "uq_labeling_sessions_provider_project",
      "labelStudioProjectId",
    ],
  ];
  for (const [tableName, indexName, providerProjectField] of schemaTables) {
    const table = variableInitializer(schema.source, tableName);
    const columns =
      table && ts.isCallExpression(table)
        ? objectArgumentForCall(table, 1)
        : null;
    const baseUrl = columns
      ? propertyInitializer(columns, "providerBaseUrl")
      : null;
    const instanceId = columns
      ? propertyInitializer(columns, "providerInstanceId")
      : null;
    if (
      !table ||
      !columns ||
      !baseUrl ||
      !instanceId ||
      !hasCall(baseUrl, ["text", "notNull"]) ||
      !hasStringLiteral(baseUrl, ["provider_base_url"]) ||
      !hasCall(instanceId, ["text", "notNull"]) ||
      !hasStringLiteral(instanceId, ["provider_instance_id"]) ||
      !hasStringLiteral(table, [indexName]) ||
      !hasAllIdentifiers(table, [
        "providerBaseUrl",
        "providerInstanceId",
        providerProjectField,
      ])
    ) {
      report(
        "LABEL_STUDIO_PROVIDER_BINDING_SCHEMA_DRIFT",
        `${tableName} must retain a non-null URL/instance binding and provider-identity unique index`,
        schemaFileName,
        table ?? schema.source,
      );
    }
  }

  const clientFileName = "src/lib/label-studio.ts";
  const client = await parsed(clientFileName);
  const configured = functionFor(client, "configuredLabelStudioProvider");
  const bindingConfig = functionFor(client, "configForBinding");
  if (
    !client.text.includes(
      "export type LabelStudioProviderBinding = Readonly<{",
    ) ||
    !configured ||
    !isExportedDeclaration(client.source, "configuredLabelStudioProvider") ||
    !textHasAll(configured.getText(client.source), [
      "process.env.LABEL_STUDIO_URL",
      "process.env.LABEL_STUDIO_INSTANCE_ID",
      "canonicalLabelStudioBaseUrl(rawUrl)",
      "instanceId",
    ]) ||
    !bindingConfig ||
    !textHasAll(bindingConfig.getText(client.source), [
      "configuredLabelStudioProvider()",
      "binding.baseUrl !== configured.baseUrl",
      "binding.instanceId !== configured.instanceId",
      "Label Studio provider binding differs from current configuration",
    ])
  ) {
    report(
      "LABEL_STUDIO_PROVIDER_CLIENT_BINDING_DRIFT",
      "the Label Studio client must expose and validate a canonical immutable URL/instance binding before using API authority",
      clientFileName,
      configured ?? client.source,
    );
  }

  for (const [symbol, transport, canonicalPath] of [
    ["createProject", "lsFetch", `"${LABEL_STUDIO_PROVIDER_PATHS.create}"`],
    [
      "findProjectsByExactDescription",
      "lsFetch",
      `\`${LABEL_STUDIO_PROVIDER_PATHS.search}\``,
    ],
    ["importTasks", "lsFetch", `\`${LABEL_STUDIO_PROVIDER_PATHS.import}\``],
    ["getProject", "lsFetch", `\`${LABEL_STUDIO_PROVIDER_PATHS.project}\``],
    [
      "deleteProject",
      "providerFetch",
      `\`${LABEL_STUDIO_PROVIDER_PATHS.project}\``,
    ],
  ]) {
    const target = functionFor(client, symbol);
    const firstParameter = target?.parameters[0];
    const transportCalls = target
      ? descendants(target, ts.isCallExpression).filter(
          (call) => callName(call) === transport,
        )
      : [];
    if (
      !target ||
      !isExportedDeclaration(client.source, symbol) ||
      !firstParameter ||
      !ts.isIdentifier(firstParameter.name) ||
      firstParameter.name.text !== "provider" ||
      firstParameter.type?.getText(client.source) !==
        "LabelStudioProviderBinding" ||
      transportCalls.length === 0 ||
      transportCalls.some(
        (call) =>
          call.arguments.length === 0 ||
          !exactPropertyPath(call.arguments[0], ["provider"]),
      ) ||
      !target.getText(client.source).includes(canonicalPath)
    ) {
      report(
        "LABEL_STUDIO_PROVIDER_OPERATION_BINDING_DRIFT",
        `${symbol} must accept the provider binding first and use its canonical redirect-free provider path`,
        clientFileName,
        target ?? client.source,
      );
    }
  }

  const nonCanonicalProjectPath = [
    /(["'`])\/api\/projects\1/u,
    /\/api\/projects\?/u,
    /`\/api\/projects\/\$\{projectId\}`/u,
  ].find((pattern) => pattern.test(client.text));
  if (nonCanonicalProjectPath) {
    report(
      "LABEL_STUDIO_PROVIDER_NONCANONICAL_PATH",
      `Label Studio project endpoint literals must retain their documented terminal slash (${nonCanonicalProjectPath})`,
      clientFileName,
    );
  }

  const variablesFileName = "infrastructure/terraform/variables.tf";
  const variables = await readFile(path.join(ROOT, variablesFileName), "utf8");
  const rootAdminVariable = terraformVariableBlock(
    variables,
    "root_admin_email",
  );
  const providerGenerationVariable = terraformVariableBlock(
    variables,
    "label_studio_instance_generation",
  );
  const maintenanceScheduleVariable = terraformVariableBlock(
    variables,
    "maintenance_worker_schedule_enabled",
  );
  const autoscalingVariable = terraformVariableBlock(
    variables,
    "ecs_autoscaling_enabled",
  );
  if (
    !rootAdminVariable ||
    !textHasAll(rootAdminVariable, [
      'default     = ""',
      'var.root_admin_email == ""',
      "can(regex(",
    ])
  ) {
    report(
      "ROOT_ADMIN_TERRAFORM_IDENTITY_DRIFT",
      "BlueprintParser root-admin promotion must use its own validated, empty-by-default Terraform variable",
      variablesFileName,
    );
  }
  if (
    !providerGenerationVariable ||
    !textHasAll(providerGenerationVariable, [
      'default     = "generation-1"',
      "var.label_studio_instance_generation",
      "can(regex(",
    ])
  ) {
    report(
      "LABEL_STUDIO_PROVIDER_GENERATION_VARIABLE_DRIFT",
      "the operator-controlled Label Studio database generation must remain non-empty and validated",
      variablesFileName,
    );
  }
  const maintenanceTerraformFileName =
    "infrastructure/terraform/project-asset-deletions.tf";
  const maintenanceTerraform = await readFile(
    path.join(ROOT, maintenanceTerraformFileName),
    "utf8",
  );
  const readmeFileName = "README.md";
  const readme = await readFile(path.join(ROOT, readmeFileName), "utf8");
  const outageEcsTerraform = await readFile(
    path.join(ROOT, "infrastructure/terraform/ecs.tf"),
    "utf8",
  );
  const autoscalingTarget = terraformResourceBlock(
    outageEcsTerraform,
    "aws_appautoscaling_target",
    "beaver_ecs",
  );
  const cutoverFileName = "scripts/p2-schema-cutover.sh";
  const cutover = await readFile(path.join(ROOT, cutoverFileName), "utf8");
  const ecsSchemaToolsFileName = "scripts/lib/ecs-schema-tools.sh";
  const ecsSchemaTools = await readFile(
    path.join(ROOT, ecsSchemaToolsFileName),
    "utf8",
  );
  if (
    !maintenanceScheduleVariable ||
    !textHasAll(maintenanceScheduleVariable, [
      "type        = bool",
      "default     = true",
    ]) ||
    !autoscalingVariable ||
    !textHasAll(autoscalingVariable, [
      "type        = bool",
      "default     = true",
    ]) ||
    !textHasAll(autoscalingTarget, [
      "dynamic_scaling_in_suspended  = !var.ecs_autoscaling_enabled",
      "dynamic_scaling_out_suspended = !var.ecs_autoscaling_enabled",
      "scheduled_scaling_suspended   = !var.ecs_autoscaling_enabled",
    ]) ||
    !maintenanceTerraform.includes(
      'state      = var.maintenance_worker_schedule_enabled ? "ENABLED" : "DISABLED"',
    ) ||
    !textHasAll(readme, [
      "writer-outage compatibility boundary",
      "maintenance_worker_schedule_enabled = false",
      "ecs_autoscaling_enabled = false",
      "ecs_desired_count = 0",
      "ecs_min_count = 0",
      "scripts/p2-schema-cutover.sh preflight",
      "scripts/p2-schema-cutover.sh run",
      "scripts/p2-schema-cutover.sh verify-restored",
      "Never use `deploy.sh activate` for the initial boundary",
    ]) ||
    !textHasAll(cutover, [
      'assert_eq "${schedule_state}" "DISABLED"',
      'assert_eq "${desired}" "0"',
      'assert_eq "${running}" "0"',
      'assert_eq "${pending}" "0"',
      'assert_eq "${min_capacity}" "0"',
      'assert_boolean "${scale_in_suspended}" true',
      'assert_boolean "${scale_out_suspended}" true',
      'assert_boolean "${scheduled_scaling_suspended}" true',
      'assert_eq "${running_executions}" "0"',
      "MAINTENANCE_MAX_EVENT_AGE_SECONDS=600",
      "ECS_CONSISTENCY_WINDOW_SECONDS=300",
      "QUIESCENCE_OBSERVATION_SECONDS=300",
      'sleep "${QUIESCENCE_OBSERVATION_SECONDS}"',
      "assert_no_writer_tasks",
      'bp_run_one_off_task "${MIGRATOR_TASK_DEFINITION}"',
      "retire_pre_boundary_task_definitions",
      "bp_assert_service_revision_stable",
      "--desired-count 0",
      "verify-restored",
    ]) ||
    (cutover.match(/assert_quiescent_preflight "\$\{expected_image\}"/gu) ?? [])
      .length < 2
  ) {
    report(
      "LABEL_STUDIO_PROVIDER_REPLACEMENT_OUTAGE_DRIFT",
      "logical provider replacement must retain a schedulable writer-off switch and an explicit zero-overlap generation runbook",
      maintenanceScheduleVariable &&
        autoscalingVariable &&
        maintenanceTerraform.includes("state")
        ? readmeFileName
        : maintenanceTerraformFileName,
    );
  }

  const rootAdminScriptFileName = "root_admin.sh";
  const rootAdminScript = await readFile(
    path.join(ROOT, rootAdminScriptFileName),
    "utf8",
  );
  if (
    !textHasAll(rootAdminScript, [
      "show_root_email_setup",
      "infrastructure/terraform/terraform.tfvars",
      "TF_VAR_root_admin_email",
      "Never place the bootstrap identity in tracked ecs.tf source",
    ]) ||
    [
      "update_root_email",
      "sed -i.bak",
      'ROOT_ADMIN_EMAIL\\\", value =',
      "Run custom SQL",
      "ALTER TABLE",
      "reset_password",
      "ensure_column",
    ].some((marker) => rootAdminScript.includes(marker))
  ) {
    report(
      "ROOT_ADMIN_HELPER_SOURCE_MUTATION_DRIFT",
      "the emergency admin helper must direct operators to the validated untracked Terraform input and never rewrite tracked ECS source",
      rootAdminScriptFileName,
    );
  }

  for (const task of LABEL_STUDIO_PROVIDER_TASKS) {
    const terraform = await readFile(
      path.join(ROOT, task.terraformFile),
      "utf8",
    );
    const block = terraformResourceBlock(
      terraform,
      "aws_ecs_task_definition",
      task.resource,
    );
    const taskIssues = labelStudioProviderTaskAuthorityIssues(block, task);
    if (taskIssues.size > 0) {
      report(
        "LABEL_STUDIO_PROVIDER_TASK_AUTHORITY_DRIFT",
        `${task.id} must carry URL/composite-instance/API-key authority without Label Studio bootstrap identity (${[...taskIssues].join(", ")})`,
        task.terraformFile,
      );
    }
  }

  const appTerraformFileName = "infrastructure/terraform/ecs.tf";
  const appTerraform = await readFile(
    path.join(ROOT, appTerraformFileName),
    "utf8",
  );
  const appService = terraformResourceBlock(
    appTerraform,
    "aws_ecs_service",
    "beaver_app",
  );
  const deployFileName = "deploy.sh";
  const deployScript = await readFile(path.join(ROOT, deployFileName), "utf8");
  if (
    !appService ||
    !textHasAll(appService, [
      "task_definition",
      "aws_ecs_task_definition.beaver_app.arn",
      "ignore_changes = [task_definition]",
    ]) ||
    !textHasAll(appTerraform, [
      "beaver_app_image",
      '"${aws_ecr_repository.beaver_app.repository_url}@${var.beaver_app_image_digest}"',
      'family                   = "beaver-app"',
      'family                   = "beaver-cpu-pipeline"',
      'family                   = "beaver-schema-migrator"',
    ]) ||
    !textHasAll(deployScript, [
      "activate_image()",
      'bp_assert_task_definition_image "${APP_FAMILY}"',
      'bp_assert_task_definition_image "${CPU_FAMILY}"',
      'bp_assert_task_definition_image "${MAINTENANCE_FAMILY}"',
      'bp_assert_task_definition_image "${MIGRATOR_FAMILY}"',
      "bp_task_definition_label_studio_identity",
      "bp_assert_maintenance_schedule_contract",
      'bp_run_one_off_task "${migrator_td}"',
      '--task-definition "${app_td}"',
      "--force-new-deployment",
    ]) ||
    !textHasAll(cutover, [
      "assert_task_definitions",
      "bp_task_definition_label_studio_identity",
      "bp_assert_maintenance_schedule_contract",
      'bp_run_one_off_task "${MIGRATOR_TASK_DEFINITION}"',
      '--task-definition "${APP_TASK_DEFINITION}"',
      "--desired-count 0",
    ]) ||
    !textHasAll(ecsSchemaTools, [
      "bp_assert_maintenance_schedule_contract",
      "Target.EcsParameters.TaskDefinitionArn",
      "Target.EcsParameters.PlatformVersion",
      "Target.Arn",
      "Target.Input",
      'exactKeys(definition, ["Comment", "StartAt", "States"])',
      'exactKeys(states, ["CPUProcessing", "ProcessingComplete", "ProcessingFailed", "ValidateInput"])',
      "LABEL_STUDIO_URL",
      "LABEL_STUDIO_INSTANCE_ID",
      "LABEL_STUDIO_API_KEY",
      "fs-(?:[0-9a-f]{8}|[0-9a-f]{17})",
    ])
  ) {
    report(
      "LABEL_STUDIO_PROVIDER_GENERATION_ROLLOUT_DRIFT",
      "the digest-pinned deploy/cutover workflows must bind one reviewed app/worker generation only after schema admission, using zero-count activation at the compatibility boundary",
      appService ? deployFileName : appTerraformFileName,
    );
  }
}

async function validateLabelStudioAccessLogSecretPolicy() {
  const s3FileName = "infrastructure/terraform/s3.tf";
  const s3Terraform = await readFile(path.join(ROOT, s3FileName), "utf8");
  const logBucket = terraformResourceBlock(
    s3Terraform,
    "aws_s3_bucket",
    "beaver_alb_access_logs",
  );
  const ownership = terraformResourceBlock(
    s3Terraform,
    "aws_s3_bucket_ownership_controls",
    "beaver_alb_access_logs",
  );
  const encryption = terraformResourceBlock(
    s3Terraform,
    "aws_s3_bucket_server_side_encryption_configuration",
    "beaver_alb_access_logs",
  );
  const publicAccess = terraformResourceBlock(
    s3Terraform,
    "aws_s3_bucket_public_access_block",
    "beaver_alb_access_logs",
  );
  const lifecycle = terraformResourceBlock(
    s3Terraform,
    "aws_s3_bucket_lifecycle_configuration",
    "beaver_alb_access_logs",
  );
  const bucketPolicy = terraformResourceBlock(
    s3Terraform,
    "aws_s3_bucket_policy",
    "beaver_alb_access_logs",
  );
  const bucketPolicyAllowCount =
    bucketPolicy?.match(/\bEffect\s*=\s*"Allow"/gu)?.length ?? 0;
  const bucketPolicyDenyCount =
    bucketPolicy?.match(/\bEffect\s*=\s*"Deny"/gu)?.length ?? 0;

  const ecsFileName = "infrastructure/terraform/ecs.tf";
  const ecsTerraform = await readFile(path.join(ROOT, ecsFileName), "utf8");
  const loadBalancer = terraformResourceBlock(ecsTerraform, "aws_lb", "beaver");

  const hardeningFileName = "hardening.sh";
  const hardening = await readFile(path.join(ROOT, hardeningFileName), "utf8");
  const hardeningTombstoneIssues = retiredHardeningTombstoneIssues(hardening);

  const schemaFileName = "src/lib/db/schema.ts";
  const schema = await readFile(path.join(ROOT, schemaFileName), "utf8");
  const readmeFileName = "README.md";
  const readme = await readFile(path.join(ROOT, readmeFileName), "utf8");

  if (
    !textHasAll(logBucket, [
      'bucket = "beaver-alb-access-logs-${data.aws_caller_identity.current.account_id}"',
      'DataClassification = "secret-bearing"',
    ]) ||
    !textHasAll(ownership, ['object_ownership = "BucketOwnerEnforced"']) ||
    !textHasAll(encryption, ['sse_algorithm = "AES256"']) ||
    encryption.includes("aws:kms") ||
    !textHasAll(publicAccess, [
      "block_public_acls       = true",
      "block_public_policy     = true",
      "ignore_public_acls      = true",
      "restrict_public_buckets = true",
    ]) ||
    !textHasAll(lifecycle, [
      'id     = "expire-secret-bearing-alb-access-logs"',
      'status = "Enabled"',
      'prefix = "alb-logs/"',
      "days = 1",
      "noncurrent_days = 1",
      "days_after_initiation = 1",
    ]) ||
    !textHasAll(bucketPolicy, [
      'Service = "logdelivery.elasticloadbalancing.amazonaws.com"',
      'Action   = "s3:PutObject"',
      "/alb-logs/AWSLogs/${data.aws_caller_identity.current.account_id}/*",
      // aws:SourceAccount is deliberately NOT pinned here: the ALB log-delivery service does not
      // satisfy it (the first real apply, 2026-10-02, got "Access Denied for bucket"), and the
      // account is already pinned twice below — in the resource path and in aws:SourceArn.
      '"aws:SourceArn" = "arn:aws:elasticloadbalancing:${var.aws_region}:${data.aws_caller_identity.current.account_id}:loadbalancer/app/beaver-alb/*"',
      // The documented legacy grant for us-east-1 (the Region's Elastic Load Balancing account),
      // scoped by the same account-id resource path; the service-principal form alone was
      // refused by the real ALB on 2026-10-02.
      'AWS = "arn:aws:iam::127311923021:root"',
      'Sid       = "DenyInsecureTransport"',
      '"aws:SecureTransport" = "false"',
    ]) ||
    bucketPolicyAllowCount !== 2 ||
    bucketPolicyDenyCount !== 1 ||
    /s3:(?:GetObject|ListBucket)/u.test(bucketPolicy) ||
    !textHasAll(loadBalancer, [
      "access_logs {",
      "bucket  = aws_s3_bucket.beaver_alb_access_logs.id",
      'prefix  = "alb-logs"',
      "enabled = true",
      "aws_s3_bucket_ownership_controls.beaver_alb_access_logs",
      "aws_s3_bucket_server_side_encryption_configuration.beaver_alb_access_logs",
      "aws_s3_bucket_public_access_block.beaver_alb_access_logs",
      "aws_s3_bucket_lifecycle_configuration.beaver_alb_access_logs",
      "aws_s3_bucket_policy.beaver_alb_access_logs",
    ]) ||
    hardeningTombstoneIssues.size > 0 ||
    !textHasAll(schema, [
      "also enters the shared ALB's",
      "private SSE-S3 bucket with one-day lifecycle expiry",
      "BP stores only its SHA-256 digest",
    ]) ||
    !textHasAll(readme, [
      "Treat ALB access logs as secrets",
      "beaver-alb-access-logs-*",
      "lifecycle deletion limits log persistence but is not",
      "revocation",
    ])
  ) {
    report(
      "LABEL_STUDIO_ALB_LOG_SECRET_POLICY_DRIFT",
      "Label Studio query bearers require fail-closed Terraform-owned ALB logging into an isolated, encrypted, non-public, account-scoped bucket with the shortest S3 lifecycle, while the retired imperative hardening entrypoint remains an exact side-effect-free exit-64 tombstone",
      s3FileName,
    );
  }
}

async function validateLabelStudioAssetRatePolicy() {
  const fileName = "src/lib/middleware-rate-limit.ts";
  const middlewareFileName = "src/middleware.ts";
  const middleware = await parsed(fileName);
  const middlewareRuntime = await parsed(middlewareFileName);
  const classifier = functionFor(middleware, "isLabelAssetTransportRatePath");
  const regex = variableInitializer(
    middleware.source,
    "LABEL_ASSET_TRANSPORT_RE",
  );
  const rule = unwrapExpression(
    variableInitializer(middleware.source, "LABEL_ASSET_TRANSPORT_RATE_RULE"),
  );
  const generalRules = variableInitializer(middleware.source, "RATE_RULES");
  const findRule = functionFor(middleware, "findRateRule");
  const labelRuleBranch = findRule
    ? descendants(findRule, ts.isIfStatement).find(
        (statement) =>
          descendants(statement.expression, ts.isCallExpression).some(
            (call) => callName(call) === "isLabelAssetTransportRatePath",
          ) &&
          descendants(statement.thenStatement, ts.isReturnStatement).some(
            (returnStatement) =>
              exactPropertyPath(returnStatement.expression, [
                "LABEL_ASSET_TRANSPORT_RATE_RULE",
              ]),
          ),
      )
    : null;
  const viewerRuleBranch = findRule
    ? descendants(findRule, ts.isIfStatement).find((statement) =>
        descendants(statement.expression, ts.isCallExpression).some(
          (call) => callName(call) === "isViewerTransportRatePath",
        ),
      )
    : null;
  const classifierMethods = classifier
    ? [
        ...new Set(
          descendants(classifier, ts.isStringLiteralLike)
            .map((literal) => literal.text)
            .filter((value) => ["GET", "HEAD", "OPTIONS"].includes(value)),
        ),
      ].sort()
    : [];
  const middlewareHandler = functionFor(middlewareRuntime, "middleware");
  if (
    !regex ||
    !textHasAll(regex.getText(middleware.source), [
      "^/api/label-assets/${UUID_PATH_SEGMENT}$",
      '"i"',
    ]) ||
    !classifier ||
    !isExportedDeclaration(
      middleware.source,
      "isLabelAssetTransportRatePath",
    ) ||
    JSON.stringify(classifierMethods) !==
      JSON.stringify(["GET", "HEAD", "OPTIONS"]) ||
    !hasIdentifier(classifier, ["LABEL_ASSET_TRANSPORT_RE"]) ||
    !hasCall(classifier, ["test"]) ||
    !rule ||
    !ts.isObjectLiteralExpression(rule) ||
    literalValue(propertyInitializer(rule, "pattern")) !==
      "label-asset-transport" ||
    literalValue(propertyInitializer(rule, "method")) !== "GET|HEAD|OPTIONS" ||
    numericConstantValue(propertyInitializer(rule, "limit")) !== 600 ||
    numericConstantValue(propertyInitializer(rule, "windowMs")) !== 60_000 ||
    literalValue(propertyInitializer(rule, "keyType")) !== "ip" ||
    literalValue(propertyInitializer(rule, "exact")) !== true ||
    (generalRules &&
      hasStringLiteral(generalRules, ["label-asset-transport"])) ||
    !findRule ||
    !isExportedDeclaration(middleware.source, "findRateRule") ||
    !viewerRuleBranch ||
    !labelRuleBranch ||
    viewerRuleBranch.getStart() >= labelRuleBranch.getStart() ||
    !middlewareHandler ||
    !hasCall(middlewareHandler, ["findRateRule", "isRateLimited"])
  ) {
    report(
      "LABEL_STUDIO_ASSET_RATE_POLICY_DRIFT",
      "anonymous label-asset GET/HEAD/OPTIONS traffic must use its own UUID-only, bounded 600/minute IP bucket",
      fileName,
      classifier ?? middleware.source,
    );
  }
}

async function validateMiddlewareRateLimitIdentityPolicy() {
  const fileName = "src/lib/middleware-rate-limit.ts";
  const middlewareFileName = "src/middleware.ts";
  const ratePolicy = await parsed(fileName);
  const middleware = await parsed(middlewareFileName);
  const handler = functionFor(middleware, "middleware");
  const limiter = functionFor(ratePolicy, "isRateLimited");
  const pruner = functionFor(ratePolicy, "pruneExpiredRateBuckets");
  const backstopPolicy = functionFor(ratePolicy, "apiIpBackstopForRule");
  const storeSize = functionFor(
    ratePolicy,
    "middlewareRateLimitStoreSizeForTest",
  );
  const storeCap = variableInitializer(
    ratePolicy.source,
    "RATE_LIMIT_STORE_MAX_ENTRIES",
  );
  const generalLimit = variableInitializer(
    ratePolicy.source,
    "GENERAL_API_BACKSTOP_LIMIT",
  );
  const generalWindow = variableInitializer(
    ratePolicy.source,
    "GENERAL_API_BACKSTOP_WINDOW_MS",
  );
  const handlerText = handler?.getText(middleware.source) ?? "";
  const limiterText = limiter?.getText(ratePolicy.source) ?? "";
  const routeRuleBranch = handler
    ? descendants(handler, ts.isIfStatement).find(
        (statement) =>
          exactPropertyPath(statement.expression, ["rule"]) &&
          hasIdentifier(statement.thenStatement, ["verifiedAuthToken"]),
      )
    : null;
  const ipBackstopBranch = handler
    ? descendants(handler, ts.isIfStatement).find(
        (statement) =>
          hasCall(statement.expression, ["isGeneralBucketExempt"]) &&
          hasIdentifier(statement.thenStatement, [
            "apiIpBackstopForRule",
            "backstop",
          ]),
      )
    : null;
  const routeRuleText = routeRuleBranch?.getText(middleware.source) ?? "";

  if (
    numericConstantValue(storeCap) !== 10_000 ||
    !limiter ||
    !pruner ||
    !textHasAll(limiterText, [
      "store.size >= RATE_LIMIT_STORE_MAX_ENTRIES",
      "pruneExpiredRateBuckets(now)",
      "return true",
      "store.set(key",
    ]) ||
    limiterText.indexOf("return true") > limiterText.indexOf("store.set(key") ||
    !storeSize ||
    !isExportedDeclaration(
      ratePolicy.source,
      "middlewareRateLimitStoreSizeForTest",
    ) ||
    !textHasAll(storeSize.getText(ratePolicy.source), ["return store.size"])
  ) {
    report(
      "MIDDLEWARE_RATE_STORE_BOUND_DRIFT",
      "middleware rate buckets must have a hard live-entry cap that prunes expired entries and fails closed without evicting active buckets",
      fileName,
      limiter ?? middleware.source,
    );
  }

  if (
    numericConstantValue(generalLimit) !== 120 ||
    numericConstantValue(generalWindow) !== 60_000 ||
    !backstopPolicy ||
    !textHasAll(backstopPolicy.getText(ratePolicy.source), [
      "VIEWER_TRANSPORT_RATE_RULE",
      "LABEL_ASSET_TRANSPORT_RATE_RULE",
      "keyScope: `transport:${rule.pattern}`",
      "limit: rule.limit",
      'keyScope: "api"',
      "GENERAL_API_BACKSTOP_LIMIT",
      "GENERAL_API_BACKSTOP_WINDOW_MS",
    ]) ||
    !ipBackstopBranch ||
    !textHasAll(ipBackstopBranch.getText(middleware.source), [
      "apiIpBackstopForRule(rule)",
      "`rl:backstop:${backstop.keyScope}:${ip}`",
      "backstop.limit",
      "backstop.windowMs",
      "isRateLimited",
    ]) ||
    !routeRuleBranch ||
    ipBackstopBranch.getStart() >= routeRuleBranch.getStart()
  ) {
    report(
      "MIDDLEWARE_IP_BACKSTOP_DRIFT",
      "every non-exempt API route must pass an independent 120/minute IP backstop, with only the two explicit high-fanout transports using bounded 600/minute backstops",
      fileName,
      ipBackstopBranch ?? handler ?? middleware.source,
    );
  }

  if (
    !handler ||
    !textHasAll(handlerText, [
      "const verifiedAuthToken = hasNextAuthSession",
      "getToken({",
      ".catch(() => null)",
    ]) ||
    !routeRuleBranch ||
    !textHasAll(routeRuleText, [
      "const token = await verifiedAuthToken",
      'typeof token?.dbId === "number"',
      "Number.isSafeInteger(token.dbId)",
      "token.dbId > 0",
      "`rl:route:${rule.pattern}:user:${verifiedUserId}`",
      "`rl:route:${rule.pattern}:ip:${ip}`",
    ]) ||
    routeRuleText.includes("request.cookies") ||
    routeRuleText.includes("session-token") ||
    routeRuleText.includes("sessionToken")
  ) {
    report(
      "MIDDLEWARE_RATE_IDENTITY_DRIFT",
      "user-keyed rate limits must use only a signature-verified stable dbId with trusted-IP fallback, never raw session-cookie bytes",
      fileName,
      routeRuleBranch ?? handler ?? middleware.source,
    );
  }
}

async function validateEdgeClientIpPolicy() {
  const policy = EDGE_CLIENT_IP_POLICY;
  const middleware = await parsed(policy.middlewareFile);
  const parser = await parsed(policy.parserFile);
  const terraformText = await readFile(
    path.join(ROOT, policy.terraformFile),
    "utf8",
  );
  const loadBalancer = terraformResourceBlock(
    terraformText,
    "aws_lb",
    policy.loadBalancerResource,
  );
  const trustedClientIp = functionFor(parser, "trustedClientIp");
  const canonicalIp = functionFor(parser, "canonicalIpLiteral");
  const deprecatedAdmission = functionFor(middleware, "admitDeprecatedRoute");
  const middlewareHandler = functionFor(middleware, "middleware");
  const ipInitializer = middlewareHandler
    ? variableInitializer(middlewareHandler, "ip")
    : null;
  const deprecatedBranch = middlewareHandler
    ? descendants(middlewareHandler, ts.isIfStatement).find(
        (statement) =>
          hasIdentifier(statement.expression, ["DEPRECATED_ROUTES"]) &&
          hasIdentifier(statement.expression, ["pathname"]),
      )
    : null;
  const admissionCall = deprecatedBranch
    ? descendants(deprecatedBranch.thenStatement, ts.isCallExpression).find(
        (call) => callName(call) === "admitDeprecatedRoute",
      )
    : null;
  const telemetryCall = deprecatedBranch
    ? descendants(deprecatedBranch.thenStatement, ts.isCallExpression).find(
        (call) => callName(call) === "recordAbuseEvent",
      )
    : null;
  const rateLimitedReturn = deprecatedBranch
    ? descendants(deprecatedBranch.thenStatement, ts.isIfStatement).find(
        (statement) =>
          hasPropertyAccess(statement.expression, "admission", "rateLimited") &&
          hasStringLiteral(statement.thenStatement, ["Retry-After"]),
      )
    : null;
  const tailLimit = variableInitializer(
    parser.source,
    "X_FORWARDED_FOR_TAIL_MAX_CHARS",
  );
  const suffixLimit = variableInitializer(
    parser.source,
    "X_FORWARDED_FOR_MAX_SUFFIX_SEGMENTS",
  );
  const deprecatedLimit = variableInitializer(
    middleware.source,
    "DEPRECATED_ROUTE_LIMIT",
  );
  const deprecatedWindow = variableInitializer(
    middleware.source,
    "DEPRECATED_ROUTE_WINDOW_MS",
  );

  if (
    policy.xffMode !== "append" ||
    policy.xffClientPort !== false ||
    policy.trustedHop !== "rightmost-nonempty" ||
    policy.invalidAddress !== "unknown" ||
    policy.deprecatedTelemetryPerWindow !== 1 ||
    !loadBalancer ||
    !/\bxff_header_processing_mode\s*=\s*"append"/u.test(loadBalancer) ||
    !/\benable_xff_client_port\s*=\s*false/u.test(loadBalancer) ||
    loadBalancer.includes('xff_header_processing_mode = "preserve"') ||
    loadBalancer.includes('xff_header_processing_mode = "remove"') ||
    numericConstantValue(tailLimit) !== policy.parseTailMaxChars ||
    numericConstantValue(suffixLimit) !== policy.parseSuffixMaxSegments ||
    numericConstantValue(deprecatedLimit) !== policy.deprecatedRouteLimit ||
    numericConstantValue(deprecatedWindow) !== policy.deprecatedRouteWindowMs ||
    !trustedClientIp ||
    !isExportedDeclaration(parser.source, "trustedClientIp") ||
    !textHasAll(trustedClientIp.getText(parser.source), [
      ".slice(-X_FORWARDED_FOR_TAIL_MAX_CHARS)",
      '.lastIndexOf(",", end - 1)',
      ".trim()",
      'canonicalIpLiteral(candidate) ?? "unknown"',
    ]) ||
    !canonicalIp ||
    !hasCall(canonicalIp, ["isIP"]) ||
    (!hasStringLiteral(canonicalIp, ["unknown"]) &&
      !hasStringLiteral(trustedClientIp, ["unknown"])) ||
    !ipInitializer ||
    !textHasAll(ipInitializer.getText(middleware.source), [
      "trustedClientIp",
      'request.headers.get("x-forwarded-for")',
    ]) ||
    middlewareHandler?.getText(middleware.source).includes('split(",")[0]') ||
    !deprecatedAdmission ||
    !hasAllIdentifiers(deprecatedAdmission, [
      "deprecatedRouteStore",
      "DEPRECATED_ROUTE_LIMIT",
      "DEPRECATED_ROUTE_WINDOW_MS",
      "telemetryRecorded",
      "rateLimited",
      "shouldRecordTelemetry",
      "ip",
      "pathname",
    ]) ||
    !deprecatedBranch ||
    !admissionCall ||
    !telemetryCall ||
    admissionCall.getStart() >= telemetryCall.getStart() ||
    !rateLimitedReturn
  ) {
    report(
      "EDGE_CLIENT_IP_POLICY_DRIFT",
      "ALB append mode, rightmost validated client-IP trust, and pre-telemetry tombstone admission must remain exact and bounded",
      policy.parserFile,
      trustedClientIp ?? parser.source,
    );
  }

  for (const consumer of policy.durableTelemetryConsumers) {
    const consumerFile = await parsed(consumer.file);
    const consumerFunction = functionFor(consumerFile, consumer.function);
    if (
      !consumerFunction ||
      !textHasAll(consumerFunction.getText(consumerFile.source), [
        "trustedClientIp",
        `headers.get("${consumer.header}")`,
      ]) ||
      consumerFunction.getText(consumerFile.source).includes('split(",")[0]')
    ) {
      report(
        "EDGE_CLIENT_IP_TELEMETRY_CONSUMER_DRIFT",
        "durable abuse telemetry must share the bounded rightmost-hop ALB client-IP parser",
        consumer.file,
        consumerFunction ?? consumerFile.source,
      );
    }
  }
}

async function validateProviderJobStatusAuthorities() {
  for (const authority of PROVIDER_JOB_STATUS_AUTHORITIES) {
    const route = await parsed(authority.routeFile);
    const routeHandler = exportedRouteHandler(route, authority.method);
    const service = await parsed(authority.serviceFile);
    const target = functionFor(service, authority.serviceFunction);
    const providerCalls = target
      ? descendants(target, ts.isCallExpression).filter(
          (call) => callName(call) === authority.providerCall,
        )
      : [];
    const providerCall = providerCalls[0];
    const witnessJoin = target
      ? descendants(target, ts.isCallExpression).find(
          (call) =>
            callName(call) === "innerJoin" &&
            hasAllIdentifiers(call, ["processingJobs", "projects"]),
        )
      : null;
    const tenantWhere = target
      ? descendants(target, ts.isCallExpression).find(
          (call) =>
            callName(call) === "where" &&
            hasAllIdentifiers(call, [
              "processingJobs",
              "executionId",
              "jobName",
              "modelConfig",
              "projects",
              "companyId",
              "session",
              "user",
            ]) &&
            hasAllCalls(call, ["and", "eq", "isNotNull"]),
        )
      : null;
    const missingWitness = target
      ? descendants(target, ts.isIfStatement).find(
          (statement) =>
            hasIdentifier(statement.expression, ["job"]) &&
            hasCall(statement.thenStatement, ["notFound"]),
        )
      : null;

    if (
      routeAuthLiteral(route, authority.method) !== authority.auth ||
      !routeHandler ||
      !textHasAll(routeHandler.getText(route.source), [
        authority.serviceFunction,
        "session",
      ]) ||
      !target ||
      providerCalls.length !== 1 ||
      !witnessJoin ||
      !tenantWhere ||
      !missingWitness ||
      witnessJoin.getEnd() >= tenantWhere.getEnd() ||
      tenantWhere.getEnd() >= missingWitness.getStart() ||
      missingWitness.getStart() >= providerCall.getStart() ||
      (authority.rootBypass
        ? !hasIdentifier(target, ["isRootAdmin"])
        : hasIdentifier(target, ["isRootAdmin"]))
    ) {
      report(
        "PROVIDER_JOB_STATUS_AUTHORITY_DRIFT",
        `${authority.id} must prove an own-company durable YOLO intent before its provider Describe call${authority.rootBypass ? " with only an explicit root bypass" : ", without a root bypass"}`,
        authority.serviceFile,
        target ?? service.source,
      );
    }
  }
}

function returnsNullForIdentifier(node, identifier) {
  return descendants(node, ts.isIfStatement).some(
    (statement) =>
      hasIdentifier(statement.expression, [identifier]) &&
      descendants(statement.thenStatement, ts.isReturnStatement).some(
        (returnStatement) => literalValue(returnStatement.expression) === null,
      ),
  );
}

function labelStudioProjectIntentReconcilerIssues(parsedFile) {
  const issues = new Set();
  const providerHelper = functionFor(parsedFile, "providerBinding");
  const providerShape = providerHelper
    ? descendants(providerHelper, ts.isObjectLiteralExpression).find(
        (object) =>
          exactPropertyPath(propertyInitializer(object, "baseUrl"), [
            "row",
            "providerBaseUrl",
          ]) &&
          exactPropertyPath(propertyInitializer(object, "instanceId"), [
            "row",
            "providerInstanceId",
          ]),
      )
    : null;
  if (
    !providerHelper ||
    providerHelper.parameters[0]?.type?.getText(parsedFile.source) !==
      "IntentRow" ||
    providerHelper.type?.getText(parsedFile.source) !==
      "LabelStudioProviderBinding" ||
    !providerShape
  ) {
    issues.add("immutable-provider-binding-from-intent");
  }

  const claimCandidate = functionFor(parsedFile, "claimCandidate");
  const claimTransactions = claimCandidate
    ? descendants(claimCandidate, ts.isCallExpression).filter(
        (call) =>
          callName(call) === "transaction" &&
          rootReceiverIdentifier(call) === "db",
      )
    : [];
  const claimCallback =
    claimTransactions.length === 1
      ? callbackArgumentForCall(claimTransactions[0], 0, parsedFile)
      : null;
  const parentLock = claimCallback
    ? descendants(claimCallback, ts.isCallExpression).find(
        (call) =>
          callName(call) === "for" &&
          literalValue(call.arguments[0]) === "update" &&
          hasIdentifier(call, ["projects"]) &&
          !hasIdentifier(call, ["labelStudioProjectIntents"]),
      )
    : null;
  const activeLeaseWhere = claimCallback
    ? descendants(claimCallback, ts.isCallExpression).find(
        (call) =>
          callName(call) === "where" &&
          call.arguments[0] &&
          hasAllIdentifiers(call.arguments[0], [
            "projectMutationLeases",
            "projectId",
            "status",
          ]) &&
          hasStringLiteral(call.arguments[0], ["active"]),
      )
    : null;
  const childLock = claimCallback
    ? descendants(claimCallback, ts.isCallExpression).find(
        (call) =>
          callName(call) === "for" &&
          literalValue(call.arguments[0]) === "update" &&
          hasIdentifier(call, ["labelStudioProjectIntents"]),
      )
    : null;
  const lifecycleGuard = claimCallback
    ? descendants(claimCallback, ts.isIfStatement).find(
        (statement) =>
          hasAllIdentifiers(statement.expression, [
            "project",
            "isDemo",
            "lifecycleEpoch",
            "current",
          ]) &&
          hasStringLiteral(statement.thenStatement, [
            "Label Studio cleanup intent project lifecycle changed",
          ]),
      )
    : null;
  const claimUpdate = claimCallback
    ? descendants(claimCallback, ts.isCallExpression).find(
        (call) =>
          callName(call) === "update" &&
          exactPropertyPath(call.arguments[0], ["labelStudioProjectIntents"]) &&
          rootReceiverIdentifier(call) === "tx",
      )
    : null;
  const claimIntentSinks = claimCandidate
    ? descendants(claimCandidate, ts.isCallExpression).filter(
        (call) =>
          new Set(["insert", "update", "delete"]).has(callName(call)) &&
          exactPropertyPath(call.arguments[0], ["labelStudioProjectIntents"]),
      )
    : [];
  const claimWhere = claimUpdate ? chainedCall(claimUpdate, "where") : null;
  const revokeClaimedGrants = claimCallback
    ? descendants(claimCallback, ts.isCallExpression).find(
        (call) =>
          callName(call) === "revokeIntentLabelStudioAssetGrants" &&
          call.arguments.length === 2 &&
          exactPropertyPath(call.arguments[0], ["tx"]) &&
          exactPropertyPath(call.arguments[1], ["claimed", "id"]),
      )
    : null;
  if (
    !claimCandidate ||
    claimTransactions.length !== 1 ||
    !claimCallback ||
    !parentLock ||
    !activeLeaseWhere ||
    !returnsNullForIdentifier(claimCallback, "activeMutation") ||
    !childLock ||
    !lifecycleGuard ||
    !claimUpdate ||
    claimIntentSinks.length !== 1 ||
    !claimWhere ||
    !revokeClaimedGrants ||
    !directAwaitContains(revokeClaimedGrants) ||
    importedBindings(parsedFile).get("revokeIntentLabelStudioAssetGrants")
      ?.sourceFile !== "src/lib/label-studio-asset-grant.ts" ||
    !hasAllIdentifiers(claimWhere, [
      "labelStudioProjectIntents",
      "id",
      "projectId",
      "lifecycleEpoch",
      "leaseExpiresAt",
    ]) ||
    !descendants(claimWhere, ts.isTaggedTemplateExpression).some((sqlNode) =>
      sqlHasAll(sqlNode, ["current_timestamp"]),
    ) ||
    parentLock.getStart() >= activeLeaseWhere.getStart() ||
    activeLeaseWhere.getStart() >= childLock.getStart() ||
    childLock.getStart() >= lifecycleGuard.getStart() ||
    lifecycleGuard.getStart() >= claimUpdate.getStart() ||
    claimUpdate.getStart() >= revokeClaimedGrants.getStart()
  ) {
    issues.add("parent-lock-lease-child-lock-claim-order");
  }

  const discovery = functionFor(parsedFile, "claimIntent");
  const discoveryWrites = discovery
    ? descendants(discovery, ts.isCallExpression).filter((call) =>
        new Set(["insert", "update", "delete"]).has(callName(call)),
      )
    : [];
  const discoveryClaim = discovery
    ? descendants(discovery, ts.isCallExpression).find(
        (call) => callName(call) === "claimCandidate",
      )
    : null;
  if (
    !discovery ||
    discoveryWrites.length !== 0 ||
    !discoveryClaim ||
    !directAwaitContains(discoveryClaim) ||
    !hasAllIdentifiers(discovery, [
      "labelStudioProjectIntents",
      "projectMutationLeases",
      "nextAttemptAt",
      "leaseExpiresAt",
    ]) ||
    !descendants(discovery, ts.isTaggedTemplateExpression).some((sqlNode) =>
      sqlHasAll(sqlNode, ["current_timestamp"]),
    )
  ) {
    issues.add("read-only-discovery-revalidated-by-claim");
  }

  const lockedProject = functionFor(parsedFile, "withLockedIntentProject");
  const lockedTransactions = lockedProject
    ? descendants(lockedProject, ts.isCallExpression).filter(
        (call) =>
          callName(call) === "transaction" &&
          rootReceiverIdentifier(call) === "db",
      )
    : [];
  const lockedCallback =
    lockedTransactions.length === 1
      ? callbackArgumentForCall(lockedTransactions[0], 0, parsedFile)
      : null;
  const lockedParent = lockedCallback
    ? descendants(lockedCallback, ts.isCallExpression).find(
        (call) =>
          callName(call) === "for" &&
          literalValue(call.arguments[0]) === "update" &&
          hasIdentifier(call, ["projects"]),
      )
    : null;
  const lockedGuard = lockedCallback
    ? descendants(lockedCallback, ts.isIfStatement).find(
        (statement) =>
          hasAllIdentifiers(statement.expression, [
            "project",
            "isDemo",
            "lifecycleEpoch",
            "row",
          ]) &&
          hasStringLiteral(statement.thenStatement, [
            "Label Studio cleanup intent project lifecycle changed",
          ]),
      )
    : null;
  const writeCall = lockedCallback
    ? descendants(lockedCallback, ts.isCallExpression).find(
        (call) =>
          callName(call) === "write" &&
          call.arguments.length === 1 &&
          exactPropertyPath(call.arguments[0], ["tx"]),
      )
    : null;
  if (
    !lockedProject ||
    lockedTransactions.length !== 1 ||
    !lockedCallback ||
    !lockedParent ||
    !lockedGuard ||
    !writeCall ||
    lockedParent.getStart() >= lockedGuard.getStart() ||
    lockedGuard.getStart() >= writeCall.getStart()
  ) {
    issues.add("parent-locked-lifecycle-fenced-finalizer");
  }

  for (const [symbol, kind] of [
    ["deleteClaimedIntent", "delete"],
    ["rescheduleClaimedIntent", "update"],
    ["persistDiscoveredProviderIdentity", "update"],
  ]) {
    const helper = functionFor(parsedFile, symbol);
    const wrappers = helper
      ? descendants(helper, ts.isCallExpression).filter(
          (call) => callName(call) === "withLockedIntentProject",
        )
      : [];
    const callback =
      wrappers.length === 1
        ? callbackArgumentForCall(wrappers[0], 1, parsedFile)
        : null;
    const sink = callback
      ? descendants(callback, ts.isCallExpression).find(
          (call) =>
            callName(call) === kind &&
            exactPropertyPath(call.arguments[0], [
              "labelStudioProjectIntents",
            ]) &&
            rootReceiverIdentifier(call) === "tx",
        )
      : null;
    const helperSinks = helper
      ? descendants(helper, ts.isCallExpression).filter(
          (call) =>
            new Set(["insert", "update", "delete"]).has(callName(call)) &&
            exactPropertyPath(call.arguments[0], ["labelStudioProjectIntents"]),
        )
      : [];
    const where = sink ? chainedCall(sink, "where") : null;
    if (
      !helper ||
      wrappers.length !== 1 ||
      !callback ||
      !sink ||
      helperSinks.length !== 1 ||
      !where ||
      !hasAllIdentifiers(where, [
        "labelStudioProjectIntents",
        "id",
        "projectId",
        "lifecycleEpoch",
        "leaseToken",
        "row",
      ]) ||
      (symbol === "persistDiscoveredProviderIdentity" &&
        (!hasAllIdentifiers(where, ["providerProjectId"]) ||
          !hasCall(where, ["isNull"])))
    ) {
      issues.add(`${symbol}-exact-lease-bound-sink`);
    }
  }

  const target = functionFor(parsedFile, "reconcileLabelStudioProjectIntent");
  const claim = target
    ? descendants(target, ts.isCallExpression).find(
        (call) => callName(call) === "claimIntent",
      )
    : null;
  const providerCalls = target
    ? descendants(target, ts.isCallExpression).filter((call) =>
        new Set(["deleteProject", "findProjectsByExactDescription"]).has(
          callName(call),
        ),
      )
    : [];
  const providerInitializer = target
    ? unwrapExpression(variableInitializer(target, "provider"))
    : null;
  const providerDeletes = providerCalls.filter(
    (call) => callName(call) === "deleteProject",
  );
  const providerSearches = providerCalls.filter(
    (call) => callName(call) === "findProjectsByExactDescription",
  );
  const knownProviderDelete = providerDeletes.find(
    (call) =>
      exactPropertyPath(call.arguments[0], ["provider"]) &&
      exactPropertyPath(call.arguments[1], ["durableRow", "providerProjectId"]),
  );
  const discoveredProviderDelete = providerDeletes.find(
    (call) =>
      exactPropertyPath(call.arguments[0], ["provider"]) &&
      textHasAll(call.arguments[1]?.getText(parsedFile.source) ?? "", [
        "matches[0]",
        ".id",
      ]),
  );
  const providerSearch = providerSearches.find(
    (call) =>
      exactPropertyPath(call.arguments[0], ["provider"]) &&
      exactPropertyPath(call.arguments[1], ["durableRow", "marker"]),
  );
  const persistDiscoveredIdentity = target
    ? descendants(target, ts.isCallExpression).find(
        (call) =>
          callName(call) === "persistDiscoveredProviderIdentity" &&
          exactPropertyPath(call.arguments[0], ["durableRow"]) &&
          exactPropertyPath(call.arguments[1], ["claim", "leaseToken"]) &&
          textHasAll(call.arguments[2]?.getText(parsedFile.source) ?? "", [
            "matches[0]",
            ".id",
          ]),
      )
    : null;
  const exactSingleMatchGuard = target
    ? descendants(target, ts.isIfStatement).find((statement) =>
        textHasAll(statement.expression.getText(parsedFile.source), [
          "matches.length",
          "!== 1",
        ]),
      )
    : null;
  if (
    !providerInitializer ||
    !ts.isCallExpression(providerInitializer) ||
    callName(providerInitializer) !== "providerBinding" ||
    providerInitializer.arguments.length !== 1 ||
    !exactPropertyPath(providerInitializer.arguments[0], ["durableRow"]) ||
    providerDeletes.length !== 2 ||
    providerSearches.length !== 1 ||
    !knownProviderDelete ||
    !discoveredProviderDelete ||
    !providerSearch ||
    !persistDiscoveredIdentity ||
    !directAwaitContains(persistDiscoveredIdentity) ||
    !exactSingleMatchGuard ||
    exactSingleMatchGuard.getStart() >= persistDiscoveredIdentity.getStart() ||
    persistDiscoveredIdentity.getStart() >=
      discoveredProviderDelete.getStart() ||
    providerCalls.some(
      (call) =>
        call.arguments.length < 2 ||
        !exactPropertyPath(call.arguments[0], ["provider"]),
    )
  ) {
    issues.add("binding-first-intent-provider-io");
  }
  if (
    !target ||
    !isExportedDeclaration(
      parsedFile.source,
      "reconcileLabelStudioProjectIntent",
    ) ||
    !claim ||
    providerCalls.length < 2 ||
    providerCalls.some((call) => call.getStart() < claim.getStart()) ||
    providerCalls.some((call) =>
      descendants(parsedFile.source, ts.isCallExpression).some(
        (transaction) =>
          callName(transaction) === "transaction" &&
          nodeContains(transaction, call),
      ),
    )
  ) {
    issues.add("provider-io-outside-parent-lock-transactions");
  }
  return issues;
}

function labelStudioAssetGrantModuleIssues(parsedFile) {
  const issues = new Set();
  const hashToken = functionFor(parsedFile, "hashLabelStudioAssetToken");
  const createSecret = functionFor(parsedFile, "createLabelStudioGrantSecret");
  const assetUrl = functionFor(parsedFile, "labelStudioAssetUrl");
  const snapshotLock = functionFor(parsedFile, "withLabelStudioSnapshotLock");
  const serve = functionFor(parsedFile, "serveLabelStudioAsset");
  const responsePolicy = functionFor(
    parsedFile,
    "withLabelStudioAssetResponsePolicy",
  );

  const randomBytesCall = createSecret
    ? descendants(createSecret, ts.isCallExpression).find(
        (call) => callName(call) === "randomBytes",
      )
    : null;
  if (
    !hashToken ||
    !isExportedDeclaration(parsedFile.source, "hashLabelStudioAssetToken") ||
    !textHasAll(hashToken.getText(parsedFile.source), [
      'createHash("sha256")',
      ".update(token)",
      '.digest("hex")',
    ]) ||
    !createSecret ||
    !isExportedDeclaration(parsedFile.source, "createLabelStudioGrantSecret") ||
    !hasAllCalls(createSecret, [
      "randomUUID",
      "randomBytes",
      "hashLabelStudioAssetToken",
    ]) ||
    !randomBytesCall ||
    numericConstantValue(randomBytesCall.arguments[0]) !== 32 ||
    !hasStringLiteral(createSecret, ["base64url"]) ||
    !hasTextStarting(createSecret, "label-studio-assets/") ||
    !hasAllIdentifiers(createSecret, ["id", "token", "tokenHash"])
  ) {
    issues.add("hashed-random-bearer-and-unique-snapshot-key");
  }

  if (
    !assetUrl ||
    !isExportedDeclaration(parsedFile.source, "labelStudioAssetUrl") ||
    !textHasAll(assetUrl.getText(parsedFile.source), [
      "NEXTAUTH_URL",
      "/api/label-assets/",
      'searchParams.set("token", token)',
      'url.protocol !== "https:"',
    ]) ||
    hasIdentifier(assetUrl, ["dataUrl", "getPresignedGetUrl", "getS3Url"])
  ) {
    issues.add("opaque-https-application-url");
  }

  const projectShareLock = snapshotLock
    ? descendants(snapshotLock, ts.isCallExpression).find(
        (call) =>
          callName(call) === "for" &&
          literalValue(call.arguments[0]) === "share" &&
          hasIdentifier(call, ["projects"]),
      )
    : null;
  if (
    !snapshotLock ||
    !isExportedDeclaration(parsedFile.source, "withLabelStudioSnapshotLock") ||
    !projectShareLock ||
    !hasAllCalls(snapshotLock, [
      "transaction",
      "isCanonicalProjectPath",
      "assertNoAssetWriter",
    ]) ||
    !hasAllIdentifiers(snapshotLock, [
      "companyDataKey",
      "dataUrl",
      "lifecycleEpoch",
      "isDemo",
    ]) ||
    !hasStringLiteral(snapshotLock, ["completed"]) ||
    !hasStringLiteral(snapshotLock, [
      "Project assets are not ready for labeling",
    ])
  ) {
    issues.add("canonical-parent-locked-snapshot-window");
  }

  const exactVersionGet = serve
    ? descendants(serve, ts.isCallExpression).find(
        (call) =>
          callName(call) === "getS3ObjectVersionStream" &&
          call.arguments.length === 3 &&
          exactPropertyPath(call.arguments[0], ["key"]) &&
          exactPropertyPath(call.arguments[1], [
            "grant",
            "snapshotVersionId",
          ]) &&
          exactPropertyPath(call.arguments[2], ["controller", "signal"]),
      )
    : null;
  const exactVersionHead = serve
    ? descendants(serve, ts.isCallExpression).find((call) => {
        if (
          callName(call) !== "headS3Object" ||
          !exactPropertyPath(call.arguments[0], ["key"])
        )
          return false;
        const options = objectArgumentForCall(call, 1);
        return Boolean(
          options &&
          exactPropertyPath(propertyInitializer(options, "versionId"), [
            "grant",
            "snapshotVersionId",
          ]),
        );
      })
    : null;
  const provisioningOwnerFrom = serve
    ? descendants(serve, ts.isCallExpression).find(
        (call) =>
          callName(call) === "from" &&
          exactPropertyPath(call.arguments[0], ["labelStudioProjectIntents"]),
      )
    : null;
  const provisioningOwnerWhere = provisioningOwnerFrom
    ? chainedCall(provisioningOwnerFrom, "where")
    : null;
  const provisioningOwnerLock = provisioningOwnerWhere
    ? chainedCall(provisioningOwnerWhere, "for")
    : null;
  const operationFrom = serve
    ? descendants(serve, ts.isCallExpression).find(
        (call) =>
          callName(call) === "from" &&
          exactPropertyPath(call.arguments[0], ["projectMutationLeases"]),
      )
    : null;
  const operationWhere = operationFrom
    ? chainedCall(operationFrom, "where")
    : null;
  const operationLock = operationWhere
    ? chainedCall(operationWhere, "for")
    : null;
  const provisioningBranch = serve
    ? descendants(serve, ts.isIfStatement).find(
        (statement) =>
          hasPropertyAccess(statement.expression, "grant", "state") &&
          hasStringLiteral(statement.expression, ["provisioning"]) &&
          Boolean(
            operationWhere &&
            nodeContains(statement.thenStatement, operationWhere),
          ),
      )
    : null;
  const operationGuard = provisioningBranch
    ? descendants(provisioningBranch.thenStatement, ts.isIfStatement).find(
        (statement) =>
          hasIdentifier(statement.expression, ["operation"]) &&
          hasCall(statement.thenStatement, ["notFound"]),
      )
    : null;
  const hasNotNullPredicate = (node, parts) =>
    Boolean(
      node &&
      descendants(node, ts.isCallExpression).some(
        (call) =>
          callName(call) === "isNotNull" &&
          call.arguments.length === 1 &&
          exactPropertyPath(call.arguments[0], parts),
      ),
    );
  if (
    !provisioningOwnerWhere ||
    !hasEqPropertyPaths(
      provisioningOwnerWhere,
      ["labelStudioProjectIntents", "id"],
      ["grant", "provisioningIntentId"],
    ) ||
    !hasEqPropertyPaths(
      provisioningOwnerWhere,
      ["labelStudioProjectIntents", "projectId"],
      ["grant", "projectId"],
    ) ||
    !hasEqPropertyPaths(
      provisioningOwnerWhere,
      ["labelStudioProjectIntents", "companyId"],
      ["grant", "companyId"],
    ) ||
    !hasEqPropertyPaths(
      provisioningOwnerWhere,
      ["labelStudioProjectIntents", "lifecycleEpoch"],
      ["grant", "lifecycleEpoch"],
    ) ||
    !hasEqPropertyLiteral(
      provisioningOwnerWhere,
      ["labelStudioProjectIntents", "state"],
      "cleanup_pending",
    ) ||
    !hasNotNullPredicate(provisioningOwnerWhere, [
      "labelStudioProjectIntents",
      "providerProjectId",
    ]) ||
    !hasNotNullPredicate(provisioningOwnerWhere, [
      "labelStudioProjectIntents",
      "leaseToken",
    ]) ||
    !hasIdentifier(provisioningOwnerWhere, ["leaseExpiresAt"]) ||
    !descendants(provisioningOwnerWhere, ts.isTaggedTemplateExpression).some(
      (sqlNode) => sqlHasAll(sqlNode, ["current_timestamp"]),
    ) ||
    !provisioningOwnerLock ||
    literalValue(provisioningOwnerLock.arguments[0]) !== "share" ||
    !operationWhere ||
    !hasEqPropertyPaths(
      operationWhere,
      ["projectMutationLeases", "token"],
      ["owner", "leaseToken"],
    ) ||
    !hasEqPropertyPaths(
      operationWhere,
      ["projectMutationLeases", "projectId"],
      ["grant", "projectId"],
    ) ||
    !hasEqPropertyPaths(
      operationWhere,
      ["projectMutationLeases", "lifecycleEpoch"],
      ["grant", "lifecycleEpoch"],
    ) ||
    !hasEqPropertyLiteral(
      operationWhere,
      ["projectMutationLeases", "kind"],
      "labeling-session-create",
    ) ||
    !hasEqPropertyLiteral(
      operationWhere,
      ["projectMutationLeases", "status"],
      "active",
    ) ||
    hasIdentifier(operationWhere, ["expiresAt"]) ||
    !operationLock ||
    literalValue(operationLock.arguments[0]) !== "share" ||
    !provisioningBranch ||
    !operationGuard ||
    (provisioningOwnerWhere &&
      operationWhere &&
      provisioningOwnerWhere.getStart() >= operationWhere.getStart()) ||
    (operationWhere &&
      operationGuard &&
      operationWhere.getStart() >= operationGuard.getStart())
  ) {
    issues.add("exact-active-provisioning-operation-lease");
  }
  if (
    !serve ||
    !isExportedDeclaration(parsedFile.source, "serveLabelStudioAsset") ||
    !hasAllCalls(serve, [
      "hashLabelStudioAssetToken",
      "discoverGrant",
      "transaction",
      "isCanonicalProjectPath",
    ]) ||
    !hasAllIdentifiers(serve, [
      "labelStudioAssetGrants",
      "tokenHash",
      "lifecycleEpoch",
      "labelingSessions",
      "snapshotVersionId",
    ]) ||
    !hasAllStringLiterals(serve, [
      "provisioning",
      "active",
      "cleanup_pending",
    ]) ||
    !hasAllStringLiterals(serve, ["private, no-store", "image/png"]) ||
    !serve
      .getText(parsedFile.source)
      .includes("/label-studio-assets/${grant.id}.png") ||
    !exactVersionGet ||
    !exactVersionHead ||
    hasIdentifier(serve, ["getPresignedGetUrl", "getS3Url"])
  ) {
    issues.add("exact-version-owner-locked-delivery");
  }

  if (
    !responsePolicy ||
    !isExportedDeclaration(
      parsedFile.source,
      "withLabelStudioAssetResponsePolicy",
    ) ||
    !hasAllIdentifiers(responsePolicy, [
      "configuredLabelStudioOrigin",
      "requestOrigin",
      "allowedOrigin",
    ]) ||
    !hasAllStringLiterals(responsePolicy, [
      "Access-Control-Allow-Origin",
      "GET, HEAD, OPTIONS",
      "private, no-store",
      "Origin",
      "no-referrer",
      "nosniff",
    ])
  ) {
    issues.add("narrow-label-studio-cors-and-no-store");
  }
  return issues;
}

function labelStudioSessionRetirementIssues(parsedFile) {
  const issues = new Set();
  const claimCandidate = functionFor(parsedFile, "claimCandidate");
  const claimedProviderShape = claimCandidate
    ? descendants(claimCandidate, ts.isObjectLiteralExpression).find(
        (object) =>
          exactPropertyPath(propertyInitializer(object, "baseUrl"), [
            "current",
            "providerBaseUrl",
          ]) &&
          exactPropertyPath(propertyInitializer(object, "instanceId"), [
            "current",
            "providerInstanceId",
          ]),
      )
    : null;
  const claimedProviderOwner = claimedProviderShape
    ? descendants(claimCandidate, ts.isObjectLiteralExpression).find(
        (object) =>
          propertyInitializer(object, "provider") === claimedProviderShape,
      )
    : null;
  if (!claimedProviderShape || !claimedProviderOwner) {
    issues.add("immutable-provider-binding-from-session");
  }
  const claimWrites = claimCandidate
    ? descendants(claimCandidate, ts.isCallExpression).filter(
        (call) => callName(call) === "withProjectWrite",
      )
    : [];
  const claimCallback =
    claimWrites.length === 1
      ? callbackArgumentForCall(claimWrites[0], 2, parsedFile)
      : null;
  const activeMutation = claimCallback
    ? descendants(claimCallback, ts.isCallExpression).find(
        (call) =>
          callName(call) === "where" &&
          hasAllIdentifiers(call, [
            "projectMutationLeases",
            "projectId",
            "status",
          ]) &&
          hasStringLiteral(call, ["active"]),
      )
    : null;
  const childLock = claimCallback
    ? descendants(claimCallback, ts.isCallExpression).find(
        (call) =>
          callName(call) === "for" &&
          literalValue(call.arguments[0]) === "update" &&
          hasIdentifier(call, ["labelingSessions"]),
      )
    : null;
  const revoke = claimCallback
    ? descendants(claimCallback, ts.isCallExpression).find(
        (call) =>
          callName(call) === "revokeSessionLabelStudioAssetGrants" &&
          exactPropertyPath(call.arguments[0], ["tx"]) &&
          exactPropertyPath(call.arguments[1], ["current", "id"]),
      )
    : null;
  const claimUpdate = claimCallback
    ? descendants(claimCallback, ts.isCallExpression).find((call) => {
        if (
          callName(call) !== "update" ||
          !exactPropertyPath(call.arguments[0], ["labelingSessions"])
        )
          return false;
        const values = objectArgumentForCall(chainedCall(call, "set"), 0);
        return Boolean(
          values &&
          objectProperty(values, "retirementLeaseToken") &&
          objectProperty(values, "retirementLeaseExpiresAt") &&
          objectProperty(values, "retirementAttemptCount"),
        );
      })
    : null;
  const claimWhere = claimUpdate ? chainedCall(claimUpdate, "where") : null;
  if (
    !claimCandidate ||
    claimWrites.length !== 1 ||
    !claimCallback ||
    !activeMutation ||
    !returnsNullForIdentifier(claimCallback, "activeMutation") ||
    !childLock ||
    !hasAllIdentifiers(childLock, [
      "status",
      "retirementNextAttemptAt",
      "retirementLeaseExpiresAt",
    ]) ||
    !hasStringLiteral(childLock, ["retiring"]) ||
    !revoke ||
    !directAwaitContains(revoke) ||
    !claimUpdate ||
    !claimWhere ||
    !hasAllIdentifiers(claimWhere, [
      "labelingSessions",
      "id",
      "projectId",
      "status",
      "retirementLeaseExpiresAt",
    ]) ||
    !hasStringLiteral(claimWhere, ["retiring"]) ||
    !descendants(claimWhere, ts.isTaggedTemplateExpression).some((sqlNode) =>
      sqlHasAll(sqlNode, ["current_timestamp"]),
    ) ||
    activeMutation.getStart() >= childLock.getStart() ||
    childLock.getStart() >= revoke.getStart() ||
    revoke.getStart() >= claimUpdate.getStart()
  ) {
    issues.add("due-expired-parent-locked-revoking-claim");
  }

  const discovery = functionFor(parsedFile, "claimRetirement");
  if (
    !discovery ||
    !hasAllIdentifiers(discovery, [
      "labelingSessions",
      "retirementNextAttemptAt",
      "retirementLeaseExpiresAt",
      "projectMutationLeases",
    ]) ||
    !hasStringLiteral(discovery, ["retiring"]) ||
    !hasCall(discovery, ["claimCandidate"]) ||
    descendants(discovery, ts.isCallExpression).some((call) =>
      new Set(["insert", "update", "delete"]).has(callName(call)),
    )
  ) {
    issues.add("read-only-retirement-discovery");
  }

  const finish = functionFor(parsedFile, "finishClaimedRetirement");
  const finishGrantDelete = finish
    ? descendants(finish, ts.isCallExpression).find(
        (call) => callName(call) === "deleteSessionLabelStudioAssetGrants",
      )
    : null;
  const finishSessionDelete = finish
    ? descendants(finish, ts.isCallExpression).find(
        (call) =>
          callName(call) === "delete" &&
          exactPropertyPath(call.arguments[0], ["labelingSessions"]),
      )
    : null;
  const finishWhere = finishSessionDelete
    ? chainedCall(finishSessionDelete, "where")
    : null;
  if (
    !finish ||
    !hasCall(finish, ["withProjectWrite"]) ||
    !finishGrantDelete ||
    !directAwaitContains(finishGrantDelete) ||
    !finishSessionDelete ||
    !finishWhere ||
    !hasAllIdentifiers(finishWhere, [
      "labelingSessions",
      "id",
      "projectId",
      "status",
      "retirementLeaseToken",
      "leaseToken",
    ]) ||
    !hasStringLiteral(finishWhere, ["retiring"]) ||
    finishGrantDelete.getStart() >= finishSessionDelete.getStart() ||
    atomicSinkViolation(parsedFile, {
      node: finishSessionDelete ?? finish,
      table: "labelingSessions",
      kind: "delete",
    }) !== null
  ) {
    issues.add("lease-bound-grants-before-session-finalize");
  }

  const reschedule = functionFor(parsedFile, "rescheduleClaimedRetirement");
  const retryUpdate = reschedule
    ? descendants(reschedule, ts.isCallExpression).find(
        (call) =>
          callName(call) === "update" &&
          exactPropertyPath(call.arguments[0], ["labelingSessions"]),
      )
    : null;
  const retryValues = retryUpdate
    ? objectArgumentForCall(chainedCall(retryUpdate, "set"), 0)
    : null;
  const retryWhere = retryUpdate ? chainedCall(retryUpdate, "where") : null;
  if (
    !reschedule ||
    !retryUpdate ||
    !retryValues ||
    !objectPropertyHasLiteral(retryValues, "retirementLeaseToken", null) ||
    !objectPropertyHasLiteral(retryValues, "retirementLeaseExpiresAt", null) ||
    !hasAllIdentifiers(retryValues, [
      "retirementConsecutiveFailures",
      "retirementNextAttemptAt",
      "retirementLastError",
      "delaySeconds",
    ]) ||
    !retryWhere ||
    !hasAllIdentifiers(retryWhere, [
      "id",
      "projectId",
      "retirementLeaseToken",
      "leaseToken",
    ]) ||
    !hasStringLiteral(retryWhere, ["retiring"]) ||
    atomicSinkViolation(parsedFile, {
      node: retryUpdate ?? reschedule,
      table: "labelingSessions",
      kind: "update",
    }) !== null
  ) {
    issues.add("lease-bound-reclaimable-backoff");
  }

  const reconcile = functionFor(
    parsedFile,
    "reconcileLabelStudioSessionRetirement",
  );
  const claim = reconcile
    ? descendants(reconcile, ts.isCallExpression).find(
        (call) => callName(call) === "claimRetirement",
      )
    : null;
  const providerDeletes = reconcile
    ? descendants(reconcile, ts.isCallExpression).filter(
        (call) => callName(call) === "deleteProject",
      )
    : [];
  const providerDelete = providerDeletes[0];
  const finishCall = reconcile
    ? descendants(reconcile, ts.isCallExpression).find(
        (call) => callName(call) === "finishClaimedRetirement",
      )
    : null;
  const rescheduleCall = reconcile
    ? descendants(reconcile, ts.isCallExpression).find(
        (call) => callName(call) === "rescheduleClaimedRetirement",
      )
    : null;
  if (
    !reconcile ||
    !isExportedDeclaration(
      parsedFile.source,
      "reconcileLabelStudioSessionRetirement",
    ) ||
    !claim ||
    !directAwaitContains(claim) ||
    providerDeletes.length !== 1 ||
    !providerDelete ||
    providerDelete.arguments.length !== 2 ||
    !exactPropertyPath(providerDelete.arguments[0], ["claim", "provider"]) ||
    !exactPropertyPath(providerDelete.arguments[1], [
      "claim",
      "providerProjectId",
    ]) ||
    !directAwaitContains(providerDelete) ||
    !finishCall ||
    !rescheduleCall ||
    claim.getStart() >= providerDelete.getStart() ||
    providerDelete.getStart() >= finishCall.getStart() ||
    providerDeletes.some((call) =>
      descendants(parsedFile.source, ts.isCallExpression).some(
        (transaction) =>
          new Set(["transaction", "withProjectWrite"]).has(
            callName(transaction),
          ) && nodeContains(transaction, call),
      ),
    )
  ) {
    issues.add("idempotent-provider-io-between-claim-and-finalize");
  }

  const drain = functionFor(
    parsedFile,
    "drainLabelStudioSessionRetirementQueue",
  );
  if (
    !drain ||
    !isExportedDeclaration(
      parsedFile.source,
      "drainLabelStudioSessionRetirementQueue",
    ) ||
    !hasCall(drain, ["reconcileLabelStudioSessionRetirement"]) ||
    !hasAllIdentifiers(drain, [
      "maxAttempts",
      "attempted",
      "cleaned",
      "failed",
    ]) ||
    !hasStringLiteral(drain, ["unavailable"])
  ) {
    issues.add("bounded-exported-retirement-drain");
  }

  const bindings = importedBindings(parsedFile);
  for (const helper of [
    "deleteSessionLabelStudioAssetGrants",
    "revokeSessionLabelStudioAssetGrants",
  ]) {
    if (
      bindings.get(helper)?.sourceFile !==
        "src/lib/label-studio-asset-grant.ts" ||
      bindings.get(helper)?.symbol !== helper
    ) {
      issues.add("reviewed-grant-transaction-helper-imports");
    }
  }
  return issues;
}

async function validateLabelStudioProjectIntentProtocol() {
  const fileName = "src/lib/label-studio-project-intent.ts";
  const parsedFile = await parsed(fileName);
  const issues = labelStudioProjectIntentReconcilerIssues(parsedFile);
  if (issues.size > 0) {
    report(
      "LABEL_STUDIO_PROJECT_INTENT_RECONCILER_DRIFT",
      `Label Studio intent reconciler violates: ${[...issues].sort().join(", ")}`,
      fileName,
      functionFor(parsedFile, "reconcileLabelStudioProjectIntent") ??
        parsedFile.source,
    );
  }

  const migrationFileName = "drizzle/0035_label_studio_project_intents.sql";
  const normalized = (
    await readFile(path.join(ROOT, migrationFileName), "utf8")
  )
    .toLowerCase()
    .replace(/\s+/gu, " ");
  const required = [
    'constraint "label_studio_project_intents_project_id_unique" unique("project_id")',
    'constraint "label_studio_project_intents_marker_unique" unique("marker")',
    'foreign key ("project_id") references "public"."projects"("id") on delete no action',
    "check (\"state\" in ('creating', 'create_uncertain', 'cleanup_pending'))",
    'check ("state" <> \'cleanup_pending\' or "provider_project_id" is not null)',
    "check (\"marker\" ~ '^bp-labeling-intent:[0-9a-f-]{36}$')",
    'constraint "labeling_sessions_provisioning_intent_id_unique" unique("provisioning_intent_id")',
  ];
  if (!required.every((marker) => normalized.includes(marker))) {
    report(
      "LABEL_STUDIO_PROJECT_INTENT_SCHEMA_DRIFT",
      "Label Studio provider intents must remain unique project-owned blockers with exact marker/provider state constraints",
      migrationFileName,
    );
  }
}

async function validateLabelStudioAssetGrantProtocol() {
  const grantFileName = "src/lib/label-studio-asset-grant.ts";
  const grantFile = await parsed(grantFileName);
  const grantIssues = labelStudioAssetGrantModuleIssues(grantFile);
  if (grantIssues.size > 0) {
    report(
      "LABEL_STUDIO_ASSET_GRANT_DRIFT",
      `Label Studio asset grant authority violates: ${[...grantIssues].sort().join(", ")}`,
      grantFileName,
      functionFor(grantFile, "serveLabelStudioAsset") ?? grantFile.source,
    );
  }

  const s3FileName = "src/lib/s3.ts";
  const s3File = await parsed(s3FileName);
  const copySnapshot = functionFor(s3File, "copyS3ObjectVersion");
  const uploadSnapshot = functionFor(s3File, "uploadS3VersionedSnapshot");
  const exactVersionStream = functionFor(s3File, "getS3ObjectVersionStream");
  if (
    !copySnapshot ||
    !uploadSnapshot ||
    !exactVersionStream ||
    !textHasAll(copySnapshot.getText(s3File.source), [
      "headS3Object(destinationKey)",
      "Label Studio snapshot key already exists",
      "CopySource: copySource(sourceKey, sourceVersionId)",
      'CacheControl: "private, no-store"',
      "result.VersionId",
      "return result.VersionId",
    ]) ||
    !textHasAll(uploadSnapshot.getText(s3File.source), [
      'IfNoneMatch: "*"',
      'CacheControl: "private, no-store"',
      "result.VersionId",
      "return result.VersionId",
    ]) ||
    !textHasAll(exactVersionStream.getText(s3File.source), [
      "VersionId: versionId",
      "abortSignal: signal",
    ])
  ) {
    report(
      "LABEL_STUDIO_S3_SNAPSHOT_DRIFT",
      "Label Studio snapshots must be never-overwritten private objects and every read must use the exact returned S3 VersionId",
      s3FileName,
      copySnapshot ?? s3File.source,
    );
  }

  const grantMigrationFileName = "drizzle/0037_label_studio_asset_grants.sql";
  const grantMigration = (
    await readFile(path.join(ROOT, grantMigrationFileName), "utf8")
  )
    .toLowerCase()
    .replace(/\s+/gu, " ");
  const grantMigrationRequired = [
    "lock table labeling_sessions, label_studio_project_intents in share row exclusive mode",
    "label studio sessions/intents must be retired before migration 0037",
    "alter table label_studio_project_intents add column provider_base_url text not null",
    "alter table label_studio_project_intents add column provider_instance_id text not null",
    "alter table labeling_sessions add column provider_base_url text not null",
    "alter table labeling_sessions add column provider_instance_id text not null",
    "alter table labeling_sessions alter column provisioning_intent_id set not null",
    "constraint label_studio_project_intents_provider_binding_check",
    "constraint labeling_sessions_provider_binding_check",
    "provider_base_url = btrim(provider_base_url)",
    "provider_instance_id = btrim(provider_instance_id)",
    "create unique index uq_ls_intents_provider_project on label_studio_project_intents ( provider_base_url, provider_instance_id, provider_project_id ) where provider_project_id is not null",
    "create unique index uq_labeling_sessions_provider_project on labeling_sessions ( provider_base_url, provider_instance_id, label_studio_project_id )",
    "check (marker = 'bp-labeling-intent:' || id::text)",
    "(state in ('creating', 'create_uncertain') and provider_project_id is null)",
    "(state = 'cleanup_pending' and provider_project_id > 0)",
    'create table "label_studio_asset_grants"',
    '"token_hash" varchar(64) not null',
    '"snapshot_version_id" text not null',
    'constraint "label_studio_asset_grants_token_hash_unique" unique("token_hash")',
    'foreign key ("project_id") references "public"."projects"("id") on delete no action',
    "token_hash ~ '^[a-f0-9]{64}$'",
    "state in ('provisioning', 'active', 'revoked')",
    "new.token_hash is distinct from old.token_hash",
    "new.snapshot_version_id is distinct from old.snapshot_version_id",
    "create trigger label_studio_asset_grants_owner_guard",
    "create trigger label_studio_asset_grants_transition_guard",
    "create trigger label_studio_asset_grants_demo_write_guard",
  ];
  const publicationGuard = delimitedTextBlock(
    grantMigration,
    "create or replace function bp_guard_project_label_studio_publication()",
    "$$;",
  );
  const publicationTrigger = delimitedTextBlock(
    grantMigration,
    "create trigger projects_label_studio_publication_guard",
    ";",
  );
  const intentGuard = delimitedTextBlock(
    grantMigration,
    "create or replace function bp_guard_label_studio_intent_authority()",
    "$$;",
  );
  const intentTrigger = delimitedTextBlock(
    grantMigration,
    "create trigger label_studio_project_intents_authority_guard",
    ";",
  );
  const sessionCreationGuard = delimitedTextBlock(
    grantMigration,
    "create or replace function bp_guard_labeling_session_creation()",
    "$$;",
  );
  const sessionCreationTrigger = delimitedTextBlock(
    grantMigration,
    "create trigger labeling_sessions_creation_guard",
    ";",
  );
  const grantOwnerGuard = delimitedTextBlock(
    grantMigration,
    "create or replace function bp_guard_label_studio_asset_grant_owner()",
    "$$;",
  );
  const grantOwnerTrigger = delimitedTextBlock(
    grantMigration,
    "create trigger label_studio_asset_grants_owner_guard",
    ";",
  );
  const grantTransitionGuard = delimitedTextBlock(
    grantMigration,
    "create or replace function bp_guard_label_studio_asset_grant()",
    "$$;",
  );
  const grantTransitionTrigger = delimitedTextBlock(
    grantMigration,
    "create trigger label_studio_asset_grants_transition_guard",
    ";",
  );
  if (
    !grantMigrationRequired.every((marker) =>
      grantMigration.includes(marker),
    ) ||
    !textHasAll(publicationGuard, [
      "if not old.is_demo and new.is_demo",
      "from labeling_sessions where project_id = old.id limit 1",
      "from label_studio_project_intents where project_id = old.id",
      "from label_studio_asset_grants where project_id = old.id limit 1",
      "constraint = 'label_studio_publication_guard'",
    ]) ||
    !textHasAll(publicationTrigger, [
      "before update on projects",
      "execute function bp_guard_project_label_studio_publication()",
    ]) ||
    !textHasAll(intentGuard, [
      "new.project_id is distinct from old.project_id",
      "new.company_id is distinct from old.company_id",
      "new.lifecycle_epoch is distinct from old.lifecycle_epoch",
      "new.marker is distinct from old.marker",
      "new.provider_base_url is distinct from old.provider_base_url",
      "new.provider_instance_id is distinct from old.provider_instance_id",
      "from projects where id = new.project_id for share",
      "or current_is_demo",
      "current_company_id is distinct from new.company_id",
      "current_lifecycle_epoch is distinct from new.lifecycle_epoch",
      "new.marker is distinct from 'bp-labeling-intent:' || new.id::text",
      "new.state in ('creating', 'create_uncertain') and new.provider_project_id is not null",
      "new.state = 'cleanup_pending' and (new.provider_project_id is null or new.provider_project_id <= 0)",
      "old.provider_project_id is not null and new.provider_project_id is distinct from old.provider_project_id",
      "old.state = 'creating' and new.state in ('create_uncertain', 'cleanup_pending')",
      "old.state = 'create_uncertain' and new.state = 'cleanup_pending'",
      "pg_advisory_xact_lock",
      "hashtextextended",
      "jsonb_build_array",
      "from labeling_sessions",
      "label_studio_project_id = new.provider_project_id",
      "constraint = 'label_studio_provider_identity_collision_guard'",
    ]) ||
    !textHasAll(intentTrigger, [
      "before insert or update on label_studio_project_intents",
      "execute function bp_guard_label_studio_intent_authority()",
    ]) ||
    !textHasAll(sessionCreationGuard, [
      "new.status <> 'active' or new.provisioning_intent_id is null",
      "from projects where id = new.project_id for share",
      "from label_studio_project_intents where id = new.provisioning_intent_id for key share",
      "owner_project_id is distinct from new.project_id",
      "owner_company_id is distinct from new.company_id",
      "owner_lifecycle_epoch is distinct from current_lifecycle_epoch",
      "owner_provider_project_id is distinct from new.label_studio_project_id",
      "owner_provider_base_url is distinct from new.provider_base_url",
      "owner_provider_instance_id is distinct from new.provider_instance_id",
      "owner_state is distinct from 'cleanup_pending'",
      "pg_advisory_xact_lock",
      "hashtextextended",
      "jsonb_build_array",
      "from label_studio_project_intents",
      "id <> new.provisioning_intent_id",
      "from labeling_sessions",
      "constraint = 'label_studio_provider_identity_collision_guard'",
    ]) ||
    !textHasAll(sessionCreationTrigger, [
      "before insert on labeling_sessions",
      "execute function bp_guard_labeling_session_creation()",
    ]) ||
    !textHasAll(grantOwnerGuard, [
      "from projects where id = new.project_id for share",
      "from label_studio_project_intents where id = new.provisioning_intent_id for key share",
      "from labeling_sessions where id = new.labeling_session_id for key share",
      "owner_project_id is distinct from new.project_id",
      "owner_company_id is distinct from new.company_id",
      "owner_lifecycle_epoch is distinct from new.lifecycle_epoch",
    ]) ||
    !textHasAll(grantOwnerTrigger, [
      "before insert or update on label_studio_asset_grants",
      "execute function bp_guard_label_studio_asset_grant_owner()",
    ]) ||
    !textHasAll(grantTransitionGuard, [
      "if tg_op = 'delete'",
      "if old.state <> 'revoked'",
      "new.id is distinct from old.id",
      "new.project_id is distinct from old.project_id",
      "new.company_id is distinct from old.company_id",
      "new.lifecycle_epoch is distinct from old.lifecycle_epoch",
      "new.token_hash is distinct from old.token_hash",
      "new.snapshot_version_id is distinct from old.snapshot_version_id",
      "activation_session.provider_base_url = provisioning_intent.provider_base_url",
      "activation_session.provider_instance_id = provisioning_intent.provider_instance_id",
      "old.state = 'active' and new.state = 'revoked'",
      "retiring_session.status = 'retiring'",
      "label studio asset grant revocation requires retirement",
      "for share",
    ]) ||
    !textHasAll(grantTransitionTrigger, [
      "before insert or update or delete on label_studio_asset_grants",
      "execute function bp_guard_label_studio_asset_grant()",
    ])
  ) {
    report(
      "LABEL_STUDIO_ASSET_GRANT_SCHEMA_DRIFT",
      "0037 must preserve immutable provider bindings, direct publication blockers, exact intent/session/grant authority guards, retirement-fenced revocation, and the demo-write trigger",
      grantMigrationFileName,
    );
  }

  const retirementMigrationFileName =
    "drizzle/0038_label_studio_session_retirements.sql";
  const retirementMigration = (
    await readFile(path.join(ROOT, retirementMigrationFileName), "utf8")
  )
    .toLowerCase()
    .replace(/\s+/gu, " ");
  const retirementRequired = [
    '"retirement_attempt_count" integer default 0 not null',
    '"retirement_consecutive_failures" integer default 0 not null',
    '"retirement_next_attempt_at" timestamp with time zone default now() not null',
    '"retirement_lease_token" uuid',
    '"retirement_lease_expires_at" timestamp with time zone',
    "constraint labeling_sessions_retirement_lease_check",
    "(retirement_lease_token is null) = (retirement_lease_expires_at is null)",
    "constraint labeling_sessions_active_retirement_shape_check",
  ];
  const retirementGuard = delimitedTextBlock(
    retirementMigration,
    "create or replace function bp_guard_labeling_session_retirement()",
    "$$;",
  );
  const retirementTrigger = delimitedTextBlock(
    retirementMigration,
    "create trigger labeling_sessions_retirement_guard",
    ";",
  );
  if (
    !retirementRequired.every((marker) =>
      retirementMigration.includes(marker),
    ) ||
    !textHasAll(retirementGuard, [
      "if tg_op = 'delete'",
      "old.status <> 'retiring'",
      "old.retirement_lease_token is null",
      "old.retirement_lease_expires_at is null",
      "only leased retiring label studio sessions may be deleted",
      "new.label_studio_project_id is distinct from old.label_studio_project_id",
      "new.provider_base_url is distinct from old.provider_base_url",
      "new.provider_instance_id is distinct from old.provider_instance_id",
      "new.label_studio_url is distinct from old.label_studio_url",
      "new.task_type is distinct from old.task_type",
      "new.labels is distinct from old.labels",
      "new.page_range is distinct from old.page_range",
      "new.tiling_enabled is distinct from old.tiling_enabled",
      "new.tile_grid is distinct from old.tile_grid",
      "new.provisioning_intent_id is distinct from old.provisioning_intent_id",
      "old.status = 'active' and new.status = 'retiring'",
      "new.retirement_lease_token is not null",
      "new.retirement_lease_expires_at is not null",
      "new.retirement_attempt_count <> 0",
      "new.retirement_consecutive_failures <> 0",
      "new.retirement_last_error is not null",
      "new.retirement_next_attempt_at > current_timestamp",
      "new.updated_at is distinct from current_timestamp",
      "old.status = 'retiring' and new.status = 'retiring'",
      "old.retirement_next_attempt_at <= current_timestamp",
      "old.retirement_lease_token is null and old.retirement_lease_expires_at is null",
      "old.retirement_lease_token is not null and old.retirement_lease_expires_at < current_timestamp",
      "new.retirement_lease_token is distinct from old.retirement_lease_token",
      "new.retirement_lease_expires_at > current_timestamp",
      "new.retirement_attempt_count = old.retirement_attempt_count + 1",
      "new.retirement_consecutive_failures = old.retirement_consecutive_failures",
      "new.retirement_next_attempt_at is not distinct from old.retirement_next_attempt_at",
      "new.retirement_last_error is not distinct from old.retirement_last_error",
      "new.updated_at is not distinct from current_timestamp",
      "old.retirement_attempt_count > 0",
      "new.retirement_lease_token is null",
      "new.retirement_lease_expires_at is null",
      "new.retirement_attempt_count = old.retirement_attempt_count",
      "new.retirement_consecutive_failures = old.retirement_consecutive_failures + 1",
      "btrim(coalesce(new.retirement_last_error, '')) <> ''",
      "new.retirement_next_attempt_at is not distinct from current_timestamp",
      "invalid label studio session retirement mutation",
      "invalid label studio session retirement transition",
    ]) ||
    !textHasAll(retirementTrigger, [
      "before update or delete on labeling_sessions",
      "execute function bp_guard_labeling_session_retirement()",
    ])
  ) {
    report(
      "LABEL_STUDIO_RETIREMENT_SCHEMA_DRIFT",
      "0038 must preserve paired leases, immutable session authority, exact claim/reclaim/failure transitions, and leased-retiring-only deletion",
      retirementMigrationFileName,
    );
  }

  const workerFileName = "scripts/project-asset-deletion-worker.ts";
  const workerFile = await parsed(workerFileName);
  const workerMain = functionFor(workerFile, "main");
  const workerBindings = importedBindings(workerFile);
  const workerAll = workerMain
    ? descendants(workerMain, ts.isCallExpression).find(
        (call) =>
          callName(call) === "all" &&
          rootReceiverIdentifier(call) === "Promise",
      )
    : null;
  const requiredWorkerDrains = [
    [
      "drainLabelStudioProjectIntentQueue",
      "src/lib/label-studio-project-intent.ts",
    ],
    [
      "drainLabelStudioSessionRetirementQueue",
      "src/lib/label-studio-session-retirement.ts",
    ],
  ];
  if (
    !workerMain ||
    !workerAll ||
    !directAwaitContains(workerAll) ||
    requiredWorkerDrains.some(([symbol, sourceFile]) => {
      const binding = workerBindings.get(symbol);
      const drain = descendants(workerAll, ts.isCallExpression).find(
        (call) => callName(call) === symbol,
      );
      return (
        binding?.sourceFile !== sourceFile ||
        binding.symbol !== symbol ||
        !drain
      );
    }) ||
    !hasAllIdentifiers(workerMain, [
      "labelStudio",
      "labelStudioRetirements",
      "failed",
      "exitCode",
    ])
  ) {
    report(
      "LABEL_STUDIO_WORKER_DRAIN_DRIFT",
      "the scheduled worker must import, await, report, and fail on both Label Studio intent and session-retirement drains",
      workerFileName,
      workerMain ?? workerFile.source,
    );
  }

  const terraformFileName = "infrastructure/terraform/s3.tf";
  const terraformText = await readFile(
    path.join(ROOT, terraformFileName),
    "utf8",
  );
  const s3Cors = terraformResourceBlock(
    terraformText,
    "aws_s3_bucket_cors_configuration",
    "beaver_data",
  );
  if (
    !s3Cors ||
    !s3Cors.includes('allowed_origins = ["https://app.${var.domain_name}"]') ||
    s3Cors.toLowerCase().includes("labelstudio") ||
    s3Cors.toLowerCase().includes("label_studio")
  ) {
    report(
      "LABEL_STUDIO_DIRECT_S3_CORS_DRIFT",
      "Label Studio must receive CORS only from the revocable application gateway, never direct S3 browser authority",
      terraformFileName,
    );
  }
}

function labelingDeleteIssues(parsedFile, target) {
  const issues = new Set();
  if (!target) return new Set(["missing-symbol"]);

  if (hasCall(target, ["withProjectMutationLease"])) {
    issues.add("obsolete-project-wide-delete-lease");
  }

  const retirementUpdate = descendants(target, ts.isCallExpression).find(
    (call) => {
      if (
        callName(call) !== "update" ||
        !exactPropertyPath(call.arguments[0], ["labelingSessions"])
      )
        return false;
      const values = objectArgumentForCall(chainedCall(call, "set"), 0);
      return (
        objectPropertyHasLiteral(values, "status", "retiring") &&
        Boolean(objectProperty(values, "retirementNextAttemptAt"))
      );
    },
  );
  const retirementWhere = retirementUpdate
    ? chainedCall(retirementUpdate, "where")
    : null;
  const retirementBoundary = retirementUpdate
    ? atomicBoundaryForSink(parsedFile, {
        node: retirementUpdate,
        table: "labelingSessions",
        kind: "update",
      })
    : null;
  const retirementCallback = retirementBoundary
    ? unwrapExpression(wrapperCallback(retirementBoundary.call))
    : null;
  const revoke = retirementCallback
    ? descendants(retirementCallback, ts.isCallExpression).find(
        (call) =>
          callName(call) === "revokeSessionLabelStudioAssetGrants" &&
          call.arguments.length === 2 &&
          exactPropertyPath(call.arguments[0], ["tx"]) &&
          exactPropertyPath(call.arguments[1], ["sessionId"]),
      )
    : null;
  const revokedWitness = retirementCallback
    ? descendants(retirementCallback, ts.isCallExpression).find(
        (call) =>
          callName(call) === "where" &&
          hasAllIdentifiers(call, [
            "labelStudioAssetGrants",
            "labelingSessionId",
            "sessionId",
            "state",
          ]) &&
          hasStringLiteral(call, ["revoked"]),
      )
    : null;
  if (
    !retirementUpdate ||
    !retirementWhere ||
    !retirementBoundary ||
    retirementBoundary.transaction !== "tx" ||
    retirementBoundary.receiver !== "tx" ||
    !hasAllIdentifiers(retirementWhere, [
      "labelingSessions",
      "id",
      "projectId",
      "companyId",
      "sessionId",
      "targetProject",
      "session",
    ]) ||
    !revoke ||
    !directAwaitContains(revoke) ||
    revoke.getStart() <= retirementUpdate.getStart() ||
    !revokedWitness ||
    revokedWitness.getStart() <= revoke.getStart()
  ) {
    issues.add("atomic-retirement-enqueue-and-revocation");
  }

  const providerDeletes = descendants(target, ts.isCallExpression).filter(
    (call) => callName(call) === "deleteProject",
  );
  if (providerDeletes.length > 0) issues.add("no-direct-provider-delete");

  const reconcileCalls = descendants(target, ts.isCallExpression).filter(
    (call) => callName(call) === "reconcileLabelStudioSessionRetirement",
  );
  const reconcile = reconcileCalls[0];
  const binding = importedBindings(parsedFile).get(
    "reconcileLabelStudioSessionRetirement",
  );
  if (
    reconcileCalls.length !== 1 ||
    !reconcile ||
    binding?.sourceFile !== "src/lib/label-studio-session-retirement.ts" ||
    binding.symbol !== "reconcileLabelStudioSessionRetirement" ||
    reconcile.arguments.length !== 1 ||
    !exactPropertyPath(reconcile.arguments[0], ["sessionId"]) ||
    !directAwaitContains(reconcile) ||
    (retirementBoundary &&
      reconcile.getStart() <= retirementBoundary.call.getStart()) ||
    !hasAllIdentifiers(target, ["retirement", "remaining"]) ||
    !hasStringLiteral(target, ["unavailable"]) ||
    !hasAllStringLiterals(target, [
      "Label Studio session retirement already in progress",
    ])
  ) {
    issues.add("delegates-to-reclaimable-retirement");
  }
  return issues;
}

function labelingCreateIssues(parsedFile, target) {
  const issues = new Set();
  if (!target) return new Set(["missing-symbol"]);

  const leaseCalls = descendants(target, ts.isCallExpression).filter(
    (call) => callName(call) === "withProjectMutationLease",
  );
  const lease = projectMutationLease(target, "labeling-session-create");
  const callback = lease ? callbackArgumentForCall(lease, 2, parsedFile) : null;
  if (leaseCalls.length !== 1 || !lease || !callback)
    issues.add("single-create-lease-callback");
  if (!hasProjectIdempotencyKey(lease, "project"))
    issues.add("shared-project-idempotency-key");
  if (!callback) return issues;

  const providerCreates = descendants(callback, ts.isCallExpression).filter(
    (call) => callName(call) === "createProject",
  );
  const imports = descendants(callback, ts.isCallExpression).filter(
    (call) => callName(call) === "importTasks",
  );
  const providerCreate = providerCreates[0];
  const importCall = imports[0];
  const configuredProviderCalls = descendants(
    callback,
    ts.isCallExpression,
  ).filter((call) => callName(call) === "configuredLabelStudioProvider");
  const configuredProviderCall = configuredProviderCalls[0];
  const configuredProviderAssignment = configuredProviderCall
    ? descendants(callback, ts.isBinaryExpression).find(
        (binary) =>
          binary.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          exactPropertyPath(binary.left, ["labelStudioProvider"]) &&
          nodeContains(binary.right, configuredProviderCall),
      )
    : null;
  const lsProjectAssignment = providerCreate
    ? descendants(callback, ts.isBinaryExpression).find(
        (binary) =>
          binary.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          exactPropertyPath(binary.left, ["lsProject"]) &&
          nodeContains(binary.right, providerCreate),
      )
    : null;
  if (
    configuredProviderCalls.length !== 1 ||
    !configuredProviderAssignment ||
    importedBindings(parsedFile).get("configuredLabelStudioProvider")
      ?.sourceFile !== "src/lib/label-studio.ts" ||
    providerCreates.length !== 1 ||
    !providerCreate ||
    providerCreate.arguments.length !== 4 ||
    !exactPropertyPath(providerCreate.arguments[0], ["labelStudioProvider"]) ||
    !exactPropertyPath(providerCreate.arguments[1], ["title"]) ||
    !exactPropertyPath(providerCreate.arguments[2], ["DEFAULT_LABEL_CONFIG"]) ||
    !exactPropertyPath(providerCreate.arguments[3], ["marker"]) ||
    !lsProjectAssignment
  ) {
    issues.add("provider-identity-captured");
  }

  const canonicalPage = functionFor(parsedFile, "canonicalPageAsset");
  const snapshotLockCalls = descendants(callback, ts.isCallExpression).filter(
    (call) => callName(call) === "withLabelStudioSnapshotLock",
  );
  const sourceVersionCalls = descendants(callback, ts.isCallExpression).filter(
    (call) => callName(call) === "requireVersionedSource",
  );
  const copyCalls = descendants(callback, ts.isCallExpression).filter(
    (call) => callName(call) === "copyS3ObjectVersion",
  );
  const tileSnapshotCalls = descendants(callback, ts.isCallExpression).filter(
    (call) => callName(call) === "uploadS3VersionedSnapshot",
  );
  const grantSecretCalls = descendants(callback, ts.isCallExpression).filter(
    (call) => callName(call) === "createLabelStudioGrantSecret",
  );
  const snapshotBindings = importedBindings(parsedFile);
  const sourceVersionCall = sourceVersionCalls[0];
  const copyCall = copyCalls[0];
  const tileSnapshotCall = tileSnapshotCalls[0];
  if (
    !canonicalPage ||
    !textHasAll(canonicalPage.getText(parsedFile.source), [
      "pages/page_",
      '.padStart(4, "0")',
      ".png",
    ]) ||
    snapshotLockCalls.length !== 1 ||
    sourceVersionCalls.length !== 1 ||
    copyCalls.length !== 1 ||
    tileSnapshotCalls.length !== 1 ||
    grantSecretCalls.length !== 2 ||
    snapshotBindings.get("withLabelStudioSnapshotLock")?.sourceFile !==
      "src/lib/label-studio-asset-grant.ts" ||
    snapshotBindings.get("requireVersionedSource")?.sourceFile !==
      "src/lib/label-studio-asset-grant.ts" ||
    snapshotBindings.get("createLabelStudioGrantSecret")?.sourceFile !==
      "src/lib/label-studio-asset-grant.ts" ||
    snapshotBindings.get("copyS3ObjectVersion")?.sourceFile !==
      "src/lib/s3.ts" ||
    snapshotBindings.get("uploadS3VersionedSnapshot")?.sourceFile !==
      "src/lib/s3.ts" ||
    !sourceVersionCall ||
    sourceVersionCall.arguments.length !== 1 ||
    !exactPropertyPath(sourceVersionCall.arguments[0], ["sourceKey"]) ||
    !directAwaitContains(sourceVersionCall) ||
    !copyCall ||
    copyCall.arguments.length !== 3 ||
    !exactPropertyPath(copyCall.arguments[0], ["sourceKey"]) ||
    !exactPropertyPath(copyCall.arguments[1], ["sourceVersion"]) ||
    !hasAllIdentifiers(copyCall.arguments[2], [
      "storageRoot",
      "grant",
      "snapshotAsset",
    ]) ||
    !directAwaitContains(copyCall) ||
    !tileSnapshotCall ||
    tileSnapshotCall.arguments.length !== 2 ||
    !hasAllIdentifiers(tileSnapshotCall.arguments[0], [
      "storageRoot",
      "grant",
      "snapshotAsset",
    ]) ||
    !directAwaitContains(tileSnapshotCall)
  ) {
    issues.add("canonical-versioned-immutable-snapshots");
  }

  const intentInserts = descendants(callback, ts.isCallExpression).filter(
    (call) =>
      callName(call) === "insert" &&
      exactPropertyPath(call.arguments[0], ["labelStudioProjectIntents"]),
  );
  const intentInsert = providerCreate
    ? intentInserts.find((call) => call.getStart() < providerCreate.getStart())
    : null;
  const intentValuesCall = intentInsert
    ? chainedCall(intentInsert, "values")
    : null;
  const intentValues = intentValuesCall
    ? objectArgumentForCall(intentValuesCall, 0)
    : null;
  const everyIntentStoresProviderBinding =
    intentInserts.length > 0 &&
    intentInserts.every((call) => {
      const valuesCall = chainedCall(call, "values");
      const values = valuesCall ? objectArgumentForCall(valuesCall, 0) : null;
      return Boolean(
        values &&
        exactPropertyPath(propertyInitializer(values, "providerBaseUrl"), [
          "labelStudioProvider",
          "baseUrl",
        ]) &&
        exactPropertyPath(propertyInitializer(values, "providerInstanceId"), [
          "labelStudioProvider",
          "instanceId",
        ]),
      );
    });
  if (
    imports.length !== 1 ||
    !importCall ||
    importCall.arguments.length !== 3 ||
    !exactPropertyPath(importCall.arguments[0], ["labelStudioProvider"]) ||
    !exactPropertyPath(importCall.arguments[1], ["lsProject", "id"]) ||
    !hasAllIdentifiers(importCall.arguments[2], ["preparedTasks"]) ||
    !intentInsert ||
    !intentValues ||
    !hasAllIdentifiers(intentValues, [
      "intentId",
      "projectId",
      "companyId",
      "lifecycleEpoch",
      "marker",
      "providerBaseUrl",
      "providerInstanceId",
      "requestLease",
      "leaseExpiresAt",
    ]) ||
    !exactPropertyPath(propertyInitializer(intentValues, "providerBaseUrl"), [
      "labelStudioProvider",
      "baseUrl",
    ]) ||
    !exactPropertyPath(
      propertyInitializer(intentValues, "providerInstanceId"),
      ["labelStudioProvider", "instanceId"],
    ) ||
    !everyIntentStoresProviderBinding ||
    !objectPropertyHasLiteral(intentValues, "state", "creating") ||
    intentInsert.getStart() >= providerCreate.getStart() ||
    atomicSinkViolation(parsedFile, {
      node: intentInsert ?? callback,
      table: "labelStudioProjectIntents",
      kind: "insert",
    }) !== null
  ) {
    issues.add("provisioning-intent-before-import");
  }

  const providerTry = providerCreate
    ? descendants(callback, ts.isTryStatement).find(
        (statement) =>
          statement.catchClause &&
          nodeContains(statement.tryBlock, providerCreate),
      )
    : null;
  const providerCatch = providerTry?.catchClause;
  const markCreateUncertain = functionFor(parsedFile, "markCreateUncertain");
  const markCreateUncertainCall = providerCatch
    ? descendants(providerCatch.block, ts.isCallExpression).find(
        (call) => callName(call) === "markCreateUncertain",
      )
    : null;
  const markCreateUncertainCatch = markCreateUncertainCall
    ? chainedCall(markCreateUncertainCall, "catch")
    : null;
  const uncertainUpdate = markCreateUncertain
    ? descendants(markCreateUncertain, ts.isCallExpression).find((call) => {
        if (
          callName(call) !== "update" ||
          !exactPropertyPath(call.arguments[0], ["labelStudioProjectIntents"])
        )
          return false;
        const setCall = chainedCall(call, "set");
        const values = setCall ? objectArgumentForCall(setCall, 0) : null;
        return (
          objectPropertyHasLiteral(values, "state", "create_uncertain") &&
          objectPropertyHasLiteral(values, "leaseToken", null) &&
          objectPropertyHasLiteral(values, "leaseExpiresAt", null)
        );
      })
    : null;
  if (
    !providerCatch ||
    !catchRethrowsBinding(providerCatch) ||
    !markCreateUncertain ||
    !markCreateUncertainCall ||
    !markCreateUncertainCatch ||
    !directAwaitContains(markCreateUncertainCatch) ||
    !uncertainUpdate ||
    atomicSinkViolation(parsedFile, {
      node: uncertainUpdate ?? callback,
      table: "labelStudioProjectIntents",
      kind: "update",
    }) !== null
  ) {
    issues.add("creation-failure-rethrown");
  }

  const providerIdentityUpdate = descendants(
    callback,
    ts.isCallExpression,
  ).find((call) => {
    if (
      callName(call) !== "update" ||
      !exactPropertyPath(call.arguments[0], ["labelStudioProjectIntents"])
    )
      return false;
    const setCall = chainedCall(call, "set");
    const values = setCall ? objectArgumentForCall(setCall, 0) : null;
    return (
      objectPropertyHasLiteral(values, "state", "cleanup_pending") &&
      Boolean(objectProperty(values, "providerProjectId"))
    );
  });
  const persistCalls = descendants(callback, ts.isCallExpression).filter(
    (call) => callName(call) === "persistKnownProvider",
  );
  const persistBeforeImport =
    importCall &&
    persistCalls.find(
      (call) =>
        call.getStart() < importCall.getStart() && directAwaitContains(call),
    );
  if (
    !providerIdentityUpdate ||
    !persistBeforeImport ||
    !directAwaitContains(persistBeforeImport) ||
    atomicSinkViolation(parsedFile, {
      node: providerIdentityUpdate ?? callback,
      table: "labelStudioProjectIntents",
      kind: "update",
    }) !== null ||
    !callFailurePropagates(callback, importCall)
  ) {
    issues.add("provider-identity-before-import");
  }

  const identityTry = persistBeforeImport
    ? descendants(callback, ts.isTryStatement).find(
        (statement) =>
          statement.catchClause &&
          nodeContains(statement.tryBlock, persistBeforeImport) &&
          nodeContains(statement.tryBlock, importCall),
      )
    : null;
  const persistedAssignment = identityTry
    ? descendants(identityTry.tryBlock, ts.isBinaryExpression).find(
        (binary) =>
          binary.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          exactPropertyPath(binary.left, ["providerIdentityPersisted"]) &&
          literalValue(binary.right) === true,
      )
    : null;
  const persistedCompensationGuard = identityTry?.catchClause
    ? descendants(identityTry.catchClause.block, ts.isIfStatement).find(
        (statement) =>
          exactPropertyPath(statement.expression, [
            "providerIdentityPersisted",
          ]) &&
          hasCall(statement.thenStatement, ["compensateKnownProvider"]) &&
          Boolean(statement.elseStatement) &&
          hasCall(statement.elseStatement, ["markCreateUncertain"]) &&
          !hasCall(statement.elseStatement, ["deleteProject"]),
      )
    : null;
  if (
    !identityTry ||
    !persistedAssignment ||
    persistedAssignment.getStart() <= persistBeforeImport.getStart() ||
    persistedAssignment.getStart() >= importCall.getStart() ||
    !persistedCompensationGuard ||
    !catchRethrowsBinding(identityTry.catchClause)
  ) {
    issues.add("unowned-provider-identity-never-compensated");
  }

  const grantInsert = descendants(callback, ts.isCallExpression).find(
    (call) =>
      callName(call) === "insert" &&
      exactPropertyPath(call.arguments[0], ["labelStudioAssetGrants"]),
  );
  const grantValues = grantInsert ? chainedCall(grantInsert, "values") : null;
  const persistOptions = persistBeforeImport
    ? objectArgumentForCall(persistBeforeImport, 0)
    : null;
  if (
    !grantInsert ||
    !grantValues ||
    !hasAllIdentifiers(grantValues, [
      "preparedTasks",
      "grant",
      "id",
      "projectId",
      "companyId",
      "lifecycleEpoch",
      "provisioningIntentId",
      "intentId",
      "tokenHash",
      "snapshotVersionId",
      "state",
    ]) ||
    !hasStringLiteral(grantValues, ["provisioning"]) ||
    hasIdentifier(grantValues, ["token"]) ||
    !persistOptions ||
    !objectPropertyHasLiteral(persistOptions, "insertGrants", true) ||
    !persistBeforeImport ||
    !importCall ||
    persistBeforeImport.getStart() >= importCall.getStart() ||
    !directAwaitContains(persistBeforeImport) ||
    atomicSinkViolation(parsedFile, {
      node: grantInsert ?? callback,
      table: "labelStudioAssetGrants",
      kind: "insert",
    }) !== null
  ) {
    issues.add("hashed-grants-committed-before-import");
  }

  const taskAssetUrls = importCall
    ? descendants(importCall, ts.isCallExpression).filter(
        (call) => callName(call) === "labelStudioAssetUrl",
      )
    : [];
  const taskAssetUrl = taskAssetUrls[0];
  if (
    taskAssetUrls.length !== 1 ||
    !taskAssetUrl ||
    taskAssetUrl.arguments.length !== 2 ||
    !exactPropertyPath(taskAssetUrl.arguments[0], ["grant", "id"]) ||
    !exactPropertyPath(taskAssetUrl.arguments[1], ["grant", "token"]) ||
    importedBindings(parsedFile).get("labelStudioAssetUrl")?.sourceFile !==
      "src/lib/label-studio-asset-grant.ts" ||
    hasIdentifier(importCall, [
      "dataUrl",
      "getPresignedGetUrl",
      "getS3Url",
      "snapshotAsset",
    ])
  ) {
    issues.add("opaque-grant-task-urls-only");
  }

  const sessionInserts = descendants(callback, ts.isCallExpression).filter(
    (call) =>
      callName(call) === "insert" &&
      exactPropertyPath(call.arguments[0], ["labelingSessions"]),
  );
  const activation = sessionInserts[0];
  const activationValuesCall = activation
    ? chainedCall(activation, "values")
    : null;
  const activationValues = activationValuesCall
    ? objectArgumentForCall(activationValuesCall, 0)
    : null;
  const activationBoundary = activation
    ? atomicBoundaryForSink(parsedFile, {
        node: activation,
        table: "labelingSessions",
        kind: "insert",
      })
    : null;
  const finalIntentDelete = descendants(callback, ts.isCallExpression).find(
    (call) => {
      if (
        callName(call) !== "delete" ||
        !exactPropertyPath(call.arguments[0], ["labelStudioProjectIntents"])
      )
        return false;
      const boundary = atomicBoundaryForSink(parsedFile, {
        node: call,
        table: "labelStudioProjectIntents",
        kind: "delete",
      });
      return (
        boundary &&
        activationBoundary &&
        boundary.call === activationBoundary.call
      );
    },
  );
  const grantActivation = activationBoundary
    ? descendants(
        unwrapExpression(wrapperCallback(activationBoundary.call)),
        ts.isCallExpression,
      ).find(
        (call) =>
          callName(call) === "activateLabelStudioAssetGrants" &&
          call.arguments.length === 4 &&
          exactPropertyPath(call.arguments[0], ["tx"]) &&
          exactPropertyPath(call.arguments[1], ["intentId"]) &&
          exactPropertyPath(call.arguments[2], ["inserted", "id"]) &&
          hasAllIdentifiers(call.arguments[3], [
            "preparedTasks",
            "grant",
            "id",
          ]),
      )
    : null;
  if (
    sessionInserts.length !== 1 ||
    !activation ||
    !activationValues ||
    !objectPropertyHasLiteral(activationValues, "status", "active") ||
    !exactPropertyPath(
      propertyInitializer(activationValues, "labelStudioProjectId"),
      ["lsProject", "id"],
    ) ||
    !exactPropertyPath(
      propertyInitializer(activationValues, "providerBaseUrl"),
      ["labelStudioProvider", "baseUrl"],
    ) ||
    !exactPropertyPath(
      propertyInitializer(activationValues, "providerInstanceId"),
      ["labelStudioProvider", "instanceId"],
    ) ||
    !exactPropertyPath(
      propertyInitializer(activationValues, "provisioningIntentId"),
      ["intentId"],
    ) ||
    !finalIntentDelete ||
    !grantActivation ||
    !directAwaitContains(grantActivation) ||
    (grantActivation && activation.getStart() >= grantActivation.getStart()) ||
    (grantActivation &&
      finalIntentDelete &&
      grantActivation.getStart() >= finalIntentDelete.getStart()) ||
    importedBindings(parsedFile).get("activateLabelStudioAssetGrants")
      ?.sourceFile !== "src/lib/label-studio-asset-grant.ts" ||
    (importCall && activation.getStart() < importCall.getStart()) ||
    atomicSinkViolation(parsedFile, {
      node: activation ?? callback,
      table: "labelingSessions",
      kind: "insert",
    }) !== null
  ) {
    issues.add("activate-after-import");
  }

  const compensation = functionFor(parsedFile, "compensateKnownProvider");
  const compensationDeletes = compensation
    ? descendants(compensation, ts.isCallExpression).filter(
        (call) =>
          callName(call) === "deleteProject" &&
          call.arguments.length === 2 &&
          exactPropertyPath(call.arguments[0], ["labelStudioProvider"]) &&
          exactPropertyPath(call.arguments[1], ["lsProject", "id"]),
      )
    : [];
  const compensationDelete = compensationDeletes[0];
  const compensationRevoke = compensation
    ? descendants(compensation, ts.isCallExpression).find(
        (call) =>
          callName(call) === "revokeIntentLabelStudioAssetGrants" &&
          call.arguments.length === 2 &&
          exactPropertyPath(call.arguments[0], ["tx"]) &&
          exactPropertyPath(call.arguments[1], ["intentId"]),
      )
    : null;
  const compensationRevokeBoundary =
    compensation && compensationRevoke
      ? descendants(compensation, ts.isCallExpression).find((call) => {
          if (callName(call) !== "withProjectWrite") return false;
          const callbackNode = unwrapExpression(wrapperCallback(call));
          return Boolean(
            callbackNode && nodeContains(callbackNode, compensationRevoke),
          );
        })
      : null;
  const compensationTry =
    compensationDelete && compensation
      ? descendants(compensation, ts.isTryStatement).find(
          (statement) =>
            statement.catchClause &&
            nodeContains(statement.tryBlock, compensationDelete),
        )
      : null;
  const cleanupFailure = compensationTry?.catchClause?.block;
  const retainKnownProvider =
    cleanupFailure &&
    descendants(cleanupFailure, ts.isCallExpression).some(
      (call) => callName(call) === "persistKnownProvider",
    );
  const removeCalls = compensation
    ? descendants(compensation, ts.isCallExpression).filter(
        (call) => callName(call) === "removeCompensatedIntent",
      )
    : [];
  const removeCall = removeCalls[0];
  if (
    !compensation ||
    compensationDeletes.length !== 1 ||
    !compensationDelete ||
    !compensationRevoke ||
    !compensationRevokeBoundary ||
    !directAwaitContains(compensationRevoke) ||
    !directAwaitContains(compensationRevokeBoundary) ||
    compensationRevokeBoundary.getStart() >= compensationDelete.getStart() ||
    importedBindings(parsedFile).get("revokeIntentLabelStudioAssetGrants")
      ?.sourceFile !== "src/lib/label-studio-asset-grant.ts" ||
    !compensationTry ||
    !cleanupFailure ||
    !retainKnownProvider ||
    !descendants(cleanupFailure, ts.isReturnStatement).length ||
    removeCalls.length !== 1 ||
    !removeCall ||
    compensationDelete.getStart() >= removeCall.getStart() ||
    nodeContains(cleanupFailure, removeCall)
  ) {
    issues.add("provider-compensation-observed");
  }

  if (
    !hasAllIdentifiers(callback, [
      "finalizationError",
      "activated",
      "pending",
      "provisioningIntentId",
    ]) ||
    !hasAllStringLiterals(callback, [
      "[LABELING] Contradictory Label Studio activation witnesses; preserving provider and blockers",
    ])
  ) {
    issues.add("retain-intent-until-provider-compensated");
  }
  return issues;
}

async function validateLabelingExternalAuthority() {
  const fileName = "src/server/services/labeling.ts";
  const parsedFile = await parsed(fileName);
  const deleteTarget = functionFor(parsedFile, "deleteLabelingSession");
  const deleteIssues = labelingDeleteIssues(parsedFile, deleteTarget);
  if (deleteIssues.size > 0) {
    report(
      "LABELING_DELETE_AUTHORITY_UNSAFE",
      `deleteLabelingSession violates: ${[...deleteIssues].sort().join(", ")}`,
      fileName,
      deleteTarget ?? parsedFile.source,
    );
  }

  const createTarget = functionFor(parsedFile, "createLabelingSessions");
  const createIssues = labelingCreateIssues(parsedFile, createTarget);
  if (createIssues.size > 0) {
    report(
      "LABELING_CREATE_AUTHORITY_UNSAFE",
      `createLabelingSessions violates: ${[...createIssues].sort().join(", ")}`,
      fileName,
      createTarget ?? parsedFile.source,
    );
  }
}

async function validateDurableMutationDomains(files) {
  const declared = new Set(
    DURABLE_MUTATION_DOMAINS.map(
      (domain) => `${domain.sourceFile}:${domain.symbol}`,
    ),
  );

  for (const domain of DURABLE_MUTATION_DOMAINS) {
    const parsedFile = await parsed(domain.sourceFile);
    const target = functionFor(parsedFile, domain.symbol);
    if (!target) continue;
    const leaseCalls = descendants(target, ts.isCallExpression).filter(
      (call) => callName(call) === "withProjectMutationLease",
    );
    const matching = leaseCalls.some((call) => {
      const options = objectArgumentForCall(call, 1);
      if (!options) return false;
      const kind = propertyInitializer(options, "kind");
      if (!kind || !templateStartsWith(kind, domain.kind)) return false;
      if (domain.kindPrefix !== true && literalValue(kind) !== domain.kind)
        return false;
      if (
        domain.requireIdempotencyKey &&
        !objectProperty(options, "idempotencyKey")
      )
        return false;
      const operation = unwrapExpression(call.arguments[2]);
      return (
        Boolean(operation) &&
        (ts.isArrowFunction(operation) ||
          ts.isFunctionExpression(operation) ||
          ts.isIdentifier(operation))
      );
    });
    if (!matching) {
      report(
        "DURABLE_MUTATION_LEASE_MISSING",
        `${domain.id} must run under a ${domain.kind}${domain.kindPrefix ? "*" : ""} durable lease${domain.requireIdempotencyKey ? " with an idempotency key" : ""}`,
        domain.sourceFile,
        target,
      );
    }
  }

  // A new lease call is a new lifecycle/publication coordination domain and must be reviewed here.
  for (const file of files) {
    const parsedFile = await parsed(file);
    for (const call of descendants(parsedFile.source, ts.isCallExpression)) {
      if (callName(call) !== "withProjectMutationLease") continue;
      const owner = enclosingFunction(parsedFile, call);
      if (!declared.has(`${file}:${owner.name}`)) {
        report(
          "UNCLASSIFIED_DURABLE_MUTATION",
          `${owner.name} acquires a project mutation lease but is absent from DURABLE_MUTATION_DOMAINS`,
          file,
          call,
        );
      }
    }
  }
}

async function validateLeaseFoundation() {
  const schema = await parsed("src/lib/db/schema.ts");
  const leaseSchema = variableInitializer(
    schema.source,
    "projectMutationLeases",
  );
  const requiredLeaseFields = [
    "token",
    "projectId",
    "lifecycleEpoch",
    "kind",
    "idempotencyKey",
    "status",
    "expiresAt",
    "heartbeatAt",
    "createdAt",
  ];
  if (
    !leaseSchema ||
    !hasAllIdentifiers(leaseSchema, requiredLeaseFields) ||
    !hasCall(leaseSchema, ["uniqueIndex"]) ||
    !hasAllStringLiterals(leaseSchema, [
      "uq_project_mutation_leases_idempotency",
      "cascade",
      "active",
    ])
  ) {
    report(
      "MUTATION_LEASE_SCHEMA_INCOMPLETE",
      `projectMutationLeases must contain ${requiredLeaseFields.join(", ")}`,
      "src/lib/db/schema.ts",
      leaseSchema ?? schema.source,
    );
  }

  const fileName = "src/server/api/project-write-capability.ts";
  const capability = await parsed(fileName);
  const acquire = functionFor(capability, "acquireProjectMutationLease");
  const heartbeat = functionFor(capability, "heartbeatProjectMutationLease");
  const release = functionFor(capability, "releaseProjectMutationLease");
  const wrapper = functionFor(capability, "withProjectMutationLease");
  const acquireLeaseSinks = acquire
    ? discoverProjectWriteSinks({ ...capability, source: acquire }, [
        "projectMutationLeases",
      ])
    : [];

  if (
    !acquire ||
    !hasAtomicWriteBoundary(acquire) ||
    !hasAllIdentifiers(acquire, [
      "projectMutationLeases",
      "lifecycleEpoch",
      "expiresAt",
      "status",
    ]) ||
    !hasCall(acquire, ["insert"]) ||
    acquireLeaseSinks.some((sink) => sink.kind !== "insert") ||
    !hasFailClosedActiveLeasePredicate(acquire) ||
    usesExpiryBasedLeaseRetirement(acquire) ||
    !hasDbClockAssignment(acquire, "expiresAt", { requireInterval: true }) ||
    !hasDbClockAssignment(acquire, "heartbeatAt") ||
    hasAppClockAssignment(acquire, "expiresAt") ||
    hasAppClockAssignment(acquire, "heartbeatAt")
  ) {
    report(
      "MUTATION_LEASE_ACQUIRE_NOT_ATOMIC",
      "lease acquisition must use DB-clock metadata, reject every active idempotency lease, never auto-reap, and insert atomically",
      fileName,
      acquire ?? capability.source,
    );
  }
  if (
    !heartbeat ||
    !hasAtomicWriteBoundary(heartbeat) ||
    !hasAllIdentifiers(heartbeat, [
      "projectMutationLeases",
      "lifecycleEpoch",
      "heartbeatAt",
      "expiresAt",
      "status",
    ]) ||
    !hasCall(heartbeat, ["update"]) ||
    !hasStringLiteral(heartbeat, ["active"]) ||
    !hasFailClosedActiveLeasePredicate(heartbeat) ||
    usesExpiryBasedLeaseRetirement(heartbeat) ||
    !hasDbClockAssignment(heartbeat, "expiresAt", { requireInterval: true }) ||
    !hasDbClockAssignment(heartbeat, "heartbeatAt") ||
    hasAppClockAssignment(heartbeat, "expiresAt") ||
    hasAppClockAssignment(heartbeat, "heartbeatAt")
  ) {
    report(
      "MUTATION_LEASE_HEARTBEAT_INCOMPLETE",
      "lease heartbeat must atomically bind token/project/generation/status and extend expiry",
      fileName,
      heartbeat ?? capability.source,
    );
  }
  if (
    !release ||
    !hasAtomicWriteBoundary(release) ||
    !hasCall(release, ["delete"])
  ) {
    report(
      "MUTATION_LEASE_RELEASE_NOT_ATOMIC",
      "lease release must run through withProjectWrite(s)",
      fileName,
      release ?? capability.source,
    );
  }
  if (
    !wrapper ||
    !hasAllCalls(wrapper, [
      "acquireProjectMutationLease",
      "heartbeatProjectMutationLease",
      "setTimeout",
      "operation",
    ]) ||
    hasCall(wrapper, ["transaction"]) ||
    !hasCall(wrapper, ["clearTimeout"]) ||
    !hasRetryingObservableHeartbeat(wrapper) ||
    !hasSafeLeaseReleaseFinally(wrapper)
  ) {
    report(
      "MUTATION_LEASE_WRAPPER_INCOMPLETE",
      "withProjectMutationLease must retry/log heartbeat loss and surface release failure except confirmed post-delete cascade",
      fileName,
      wrapper ?? capability.source,
    );
  }
}

async function validateTriggerInventory() {
  const migrationFiles = [
    ...new Set([
      DEMO_WRITE_TRIGGER_MIGRATION,
      ...DEMO_WRITE_TRIGGER_INVENTORY.map((item) => item.migration).filter(
        Boolean,
      ),
    ]),
  ];
  const normalizedByFile = new Map();
  for (const migrationFile of migrationFiles) {
    try {
      const text = await readFile(path.join(ROOT, migrationFile), "utf8");
      normalizedByFile.set(
        migrationFile,
        text
          .replace(/--[^\n]*/gu, " ")
          .replace(/\s+/gu, " ")
          .trim()
          .toLowerCase(),
      );
    } catch {
      report(
        "TRIGGER_MIGRATION_MISSING",
        `missing ${migrationFile}`,
        migrationFile,
      );
    }
  }
  const normalized = [...normalizedByFile.values()].join(" ");
  const primaryNormalized =
    normalizedByFile.get(DEMO_WRITE_TRIGGER_MIGRATION) ?? "";
  const discovered = new Map();
  const triggerPattern =
    /create\s+trigger\s+([a-z0-9_]+)\s+before\s+insert\s+or\s+update\s+or\s+delete\s+on\s+([a-z0-9_]+)\s+for\s+each\s+row\s+execute\s+function\s+([a-z0-9_]+)\s*\(([^)]*)\)/gu;
  for (const match of normalized.matchAll(triggerPattern)) {
    discovered.set(match[1], {
      table: match[2],
      function: match[3],
      argument: match[4].replace(/[\s']/gu, ""),
    });
  }
  for (const item of DEMO_WRITE_TRIGGER_INVENTORY) {
    const actual = discovered.get(item.trigger);
    const expectedArgument = item.argument ?? "";
    if (
      !actual ||
      actual.table !== item.sqlTable ||
      actual.function !== item.function ||
      actual.argument !== expectedArgument
    ) {
      report(
        "TRIGGER_INVENTORY_DRIFT",
        `${item.trigger} must guard ${item.sqlTable} with ${item.function}(${expectedArgument}) for INSERT/UPDATE/DELETE`,
        item.migration ?? DEMO_WRITE_TRIGGER_MIGRATION,
      );
    }
  }
  const expectedNames = new Set(
    DEMO_WRITE_TRIGGER_INVENTORY.map((item) => item.trigger),
  );
  const allTriggerNames = [
    ...normalized.matchAll(/create\s+trigger\s+([a-z0-9_]+)/gu),
  ].map((match) => match[1]);
  for (const name of allTriggerNames) {
    if (
      (name.endsWith("_demo_write_guard") ||
        name === "projects_lifecycle_guard") &&
      !expectedNames.has(name)
    ) {
      report(
        "UNCLASSIFIED_DEMO_WRITE_TRIGGER",
        `${name} exists in the migration but not the stable trigger inventory`,
        DEMO_WRITE_TRIGGER_MIGRATION,
      );
    }
  }
  if (
    !primaryNormalized.includes("for share") ||
    !primaryNormalized.includes(
      `errcode = '${CANONICAL_DEMO_WRITE_ERROR.databaseCode.toLowerCase()}'`,
    ) ||
    !primaryNormalized.includes(
      `message = '${CANONICAL_DEMO_WRITE_ERROR.message.toLowerCase()}'`,
    ) ||
    !primaryNormalized.includes(
      `constraint = '${CANONICAL_DEMO_WRITE_ERROR.constraint.toLowerCase()}'`,
    )
  ) {
    report(
      "TRIGGER_CANONICAL_DENIAL_DRIFT",
      "database guards must lock the parent and raise the canonical code/constraint/message",
      DEMO_WRITE_TRIGGER_MIGRATION,
    );
  }
  const storageRoots =
    "'_bp-staging', '_bp-public', 'models', 'tmp', 'config', 'csi-databases'";
  if (
    !primaryNormalized.includes(
      "constraint companies_data_key_storage_namespace_guard",
    ) ||
    !primaryNormalized.includes("data_key ~ '^[a-z0-9-]+$'") ||
    !primaryNormalized.includes(`data_key not in (${storageRoots})`) ||
    !primaryNormalized.includes(
      "companies_data_key_storage_namespace_guard check",
    ) ||
    primaryNormalized.includes("not valid") ||
    !primaryNormalized.includes("if tg_op = 'insert'") ||
    !primaryNormalized.includes(
      "select data_key into owning_company_data_key from companies where id = new.company_id",
    ) ||
    !primaryNormalized.includes(
      `owning_company_data_key in (${storageRoots})`,
    ) ||
    !primaryNormalized.includes(
      "new.data_url !~ ('^' || owning_company_data_key || '/[a-f0-9]{20}$')",
    ) ||
    !primaryNormalized.includes("new.data_url is distinct from old.data_url") ||
    !primaryNormalized.includes(
      "new.company_id is distinct from old.company_id",
    ) ||
    !primaryNormalized.includes("constraint = 'project_storage_root_guard'")
  ) {
    report(
      "STORAGE_ROOT_DB_GUARD_DRIFT",
      "database guards must reserve system roots, validate canonical project inserts, and freeze storage ownership",
      DEMO_WRITE_TRIGGER_MIGRATION,
    );
  }
}

async function validateCanonicalDbErrorMapping() {
  const envelopeFileName = "src/server/api/envelope.ts";
  const envelopeFile = await parsed(envelopeFileName);
  const statusMap = unwrapExpression(
    variableInitializer(envelopeFile.source, "STATUS_BY_CODE"),
  );
  const forbiddenStatus = statusMap
    ? objectProperty(statusMap, CANONICAL_DEMO_WRITE_ERROR.code)
    : null;
  if (
    !forbiddenStatus ||
    !ts.isPropertyAssignment(forbiddenStatus) ||
    literalValue(forbiddenStatus.initializer) !==
      String(CANONICAL_DEMO_WRITE_ERROR.status)
  ) {
    report(
      "CANONICAL_FORBIDDEN_STATUS_DRIFT",
      `${CANONICAL_DEMO_WRITE_ERROR.code} must map to HTTP ${CANONICAL_DEMO_WRITE_ERROR.status}`,
      envelopeFileName,
      statusMap ?? envelopeFile.source,
    );
  }

  const errorFileName = "src/server/api/project-write-errors.ts";
  const errorFile = await parsed(errorFileName);
  const detector = functionFor(errorFile, "isDemoWriteProtectionError");
  const exactDetector =
    detector &&
    hasStrictPropertyLiteralComparison(
      detector,
      "candidate",
      "code",
      CANONICAL_DEMO_WRITE_ERROR.databaseCode,
    ) &&
    hasStrictPropertyLiteralComparison(
      detector,
      "candidate",
      "constraint",
      CANONICAL_DEMO_WRITE_ERROR.constraint,
    ) &&
    hasStrictPropertyLiteralComparison(
      detector,
      "candidate",
      "message",
      CANONICAL_DEMO_WRITE_ERROR.message,
    ) &&
    hasIdentifier(detector, ["cause"]);
  if (!exactDetector) {
    report(
      "DB_DEMO_ERROR_DETECTOR_DRIFT",
      "isDemoWriteProtectionError must match code, constraint, and message through the cause chain",
      errorFileName,
      detector ?? errorFile.source,
    );
  }

  const routeFileName = "src/server/api/defineRoute.ts";
  const routeFile = await parsed(routeFileName);
  const defineRoute = functionFor(routeFile, "defineRoute");
  const mapping =
    defineRoute &&
    descendants(defineRoute, ts.isIfStatement).find((statement) =>
      hasCall(statement.expression, ["isDemoWriteProtectionError"]),
    );
  const canonicalReturn =
    mapping &&
    descendants(mapping.thenStatement, ts.isReturnStatement).some(
      (statement) => {
        const expression = unwrapExpression(statement.expression);
        return (
          expression &&
          ts.isCallExpression(expression) &&
          callName(expression) === "errorResponse" &&
          literalValue(expression.arguments[0]) ===
            CANONICAL_DEMO_WRITE_ERROR.code &&
          literalValue(expression.arguments[1]) ===
            CANONICAL_DEMO_WRITE_ERROR.message
        );
      },
    );
  const genericLog = defineRoute
    ? descendants(defineRoute, ts.isCallExpression).find(
        (call) =>
          callName(call) === "error" &&
          rootReceiverIdentifier(call) === "logger",
      )
    : null;
  if (
    !mapping ||
    !canonicalReturn ||
    (genericLog && mapping.getStart() > genericLog.getStart())
  ) {
    report(
      "DB_DEMO_ERROR_ROUTE_MAPPING",
      "defineRoute must map the exact database demo denial to canonical 403 before generic logging",
      routeFileName,
      defineRoute ?? routeFile.source,
    );
  }
}

function enclosingFunction(parsedFile, node) {
  let current = node.parent;
  let outermostNamed = null;
  let outermostAnonymous = null;
  while (current && current !== parsedFile.source) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) {
      let name = null;
      for (const [candidate, fn] of parsedFile.functions)
        if (fn === current) name = candidate;
      if (name) outermostNamed = { name, node: current };
      else outermostAnonymous = current;
    }
    current = current.parent;
  }
  if (outermostNamed) return outermostNamed;
  return outermostAnonymous
    ? { name: "<anonymous>", node: outermostAnonymous }
    : { name: "<module>", node: parsedFile.source };
}

function reachableFunctions(parsedFile, startName, seen = new Set()) {
  if (!startName || seen.has(startName)) return seen;
  seen.add(startName);
  const start = parsedFile.functions.get(startName);
  if (!start) return seen;
  for (const { name } of directCalls(start)) {
    if (name && parsedFile.functions.has(name))
      reachableFunctions(parsedFile, name, seen);
  }
  return seen;
}

function staticNameAliases(parsedFile) {
  const aliases = new Map();
  const ambiguous = new Set();
  const record = (local, target) => {
    if (!local || !target || local === target || ambiguous.has(local)) return;
    const previous = aliases.get(local);
    if (previous === undefined) aliases.set(local, target);
    else if (previous !== target) {
      aliases.delete(local);
      ambiguous.add(local);
    }
  };

  for (const specifier of descendants(
    parsedFile.source,
    ts.isImportSpecifier,
  )) {
    record(
      specifier.name.text,
      (specifier.propertyName ?? specifier.name).text,
    );
  }
  for (const declaration of descendants(
    parsedFile.source,
    ts.isVariableDeclaration,
  )) {
    const initializer = unwrapExpression(declaration.initializer);
    if (!initializer) continue;
    if (ts.isIdentifier(declaration.name)) {
      record(declaration.name.text, propertyName(initializer));
      continue;
    }
    if (ts.isObjectBindingPattern(declaration.name)) {
      for (const element of declaration.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        record(
          element.name.text,
          propertyName(element.propertyName ?? element.name),
        );
      }
    }
  }
  return aliases;
}

function resolveAliasedName(node, aliases) {
  let name = typeof node === "string" ? node : propertyName(node);
  const seen = new Set();
  while (name && aliases.has(name) && !seen.has(name)) {
    seen.add(name);
    name = aliases.get(name);
  }
  return name;
}

function mutationCallKind(call, aliases) {
  const name = resolveAliasedName(call.expression, aliases);
  return new Set(["insert", "update", "delete"]).has(name) ? name : null;
}

function rawSqlCallText(call, aliases) {
  const callee = unwrapExpression(call.expression);
  if (
    !callee ||
    !ts.isPropertyAccessExpression(callee) ||
    callee.name.text !== "raw" ||
    resolveAliasedName(callee.expression, aliases) !== "sql"
  ) {
    return undefined;
  }
  const argument = unwrapExpression(call.arguments[0]);
  if (
    argument &&
    (ts.isStringLiteral(argument) ||
      ts.isNoSubstitutionTemplateLiteral(argument))
  ) {
    return argument.text;
  }
  return null;
}

function discoverProjectWriteSinks(parsedFile, tables = PROJECT_OWNED_TABLES) {
  const projectTables = new Set(tables);
  const aliases = staticNameAliases(parsedFile);
  const detectUnresolvedRawSql =
    projectTables.size === PROJECT_OWNED_TABLES.length &&
    PROJECT_OWNED_TABLES.every((table) => projectTables.has(table));
  const snakeTables = new Map(
    tables.map((name) => [
      name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      name,
    ]),
  );
  const sinks = [];

  for (const call of descendants(parsedFile.source, ts.isCallExpression)) {
    const kind = mutationCallKind(call, aliases);
    if (kind && call.arguments.length > 0) {
      const table = resolveAliasedName(call.arguments[0], aliases);
      if (table && projectTables.has(table))
        sinks.push({ node: call, table, kind });
    }

    const rawText = rawSqlCallText(call, aliases);
    if (rawText === undefined) continue;
    if (rawText === null) {
      if (detectUnresolvedRawSql)
        sinks.push({
          node: call,
          table: "<dynamic>",
          kind: "raw-sql-unresolved",
        });
      continue;
    }
    const tokens = new Set(stringTokens(rawText));
    if (!["insert", "update", "delete"].some((token) => tokens.has(token)))
      continue;
    for (const [snake, table] of snakeTables) {
      if (tokens.has(snake)) {
        sinks.push({ node: call, table, kind: "raw-sql" });
      }
    }
    // A literal statement that names only schema-derived non-project tables is
    // outside this checker. Dynamic SQL cannot make that claim and is rejected
    // above because its target is unprovable.
  }
  for (const sqlNode of descendants(
    parsedFile.source,
    ts.isTaggedTemplateExpression,
  )) {
    const sqlText = taggedSqlText(sqlNode);
    if (sqlText === null) continue;
    const tokens = new Set(stringTokens(sqlText));
    if (!["insert", "update", "delete"].some((token) => tokens.has(token)))
      continue;
    let matched = false;
    for (const [snake, table] of snakeTables) {
      const expressionMatch = sqlNode.template.templateSpans?.some(
        (span) => resolveAliasedName(span.expression, aliases) === table,
      );
      if (tokens.has(snake) || expressionMatch) {
        sinks.push({ node: sqlNode, table, kind: "raw-sql" });
        matched = true;
      }
    }
    if (
      !matched &&
      detectUnresolvedRawSql &&
      ts.isTemplateExpression(sqlNode.template) &&
      sqlNode.template.templateSpans.length > 0
    )
      sinks.push({
        node: sqlNode,
        table: "<dynamic>",
        kind: "raw-sql-unresolved",
      });
  }
  return sinks;
}

function sinkOwnerKey(file, parsedFile, sink) {
  const owner = enclosingFunction(parsedFile, sink.node);
  return `${file}:${owner.name}:${sink.kind}`;
}

async function validateCheckerRegressionFixtures() {
  const terraformBlockFixture = [
    'resource "aws_cloudwatch_event_target" "reviewed" {',
    "  retry_policy { maximum_event_age_in_seconds = 60 maximum_retry_attempts = 1 }",
    "}",
    'resource "aws_cloudwatch_event_target" "decoy" {',
    "  retry_policy { maximum_event_age_in_seconds = 86400 maximum_retry_attempts = 185 }",
    "}",
  ].join(" ");
  const reviewedTerraformBlock = terraformResourceBlock(
    terraformBlockFixture,
    "aws_cloudwatch_event_target",
    "reviewed",
  );
  if (
    !reviewedTerraformBlock ||
    reviewedTerraformBlock.includes("maximum_event_age_in_seconds = 86400") ||
    !reviewedTerraformBlock.includes("maximum_retry_attempts = 1")
  ) {
    report(
      "CHECKER_TERRAFORM_RESOURCE_FIXTURE",
      "infrastructure pins must be satisfied inside the exact reviewed Terraform resource, not a decoy block",
    );
  }

  const exactSchedulerDependenciesFixture = `
resource "aws_scheduler_schedule" "beaver_project_asset_deletions" {
  depends_on = [
    aws_s3_bucket_notification.beaver_data_eventbridge,
    terraform_data.beaver_writer_operational_tuple,
  ]
}
`;
  const schedulerDependencyMutations = [
    exactSchedulerDependenciesFixture.replace(
      "    aws_s3_bucket_notification.beaver_data_eventbridge,",
      "    # aws_s3_bucket_notification.beaver_data_eventbridge,",
    ),
    exactSchedulerDependenciesFixture.replace(
      "    terraform_data.beaver_writer_operational_tuple,",
      '    "terraform_data.beaver_writer_operational_tuple",',
    ),
  ];
  if (
    projectAssetSchedulerDependencyIssues(exactSchedulerDependenciesFixture)
      .size > 0 ||
    schedulerDependencyMutations.some(
      (source) => projectAssetSchedulerDependencyIssues(source).size === 0,
    )
  ) {
    report(
      "CHECKER_PROJECT_ASSET_SCHEDULER_DEPENDENCY_FIXTURE",
      "the maintenance scheduler must structurally depend on both durable EventBridge delivery and the exact writer operational tuple; comments and quoted decoys do not count",
    );
  }

  const exactHardeningTombstoneFixture = `#!/usr/bin/env bash
set -euo pipefail
# RETIRED SECURITY BOUNDARY
cat >&2 <<'MESSAGE'
hardening.sh is deliberately side-effect-free.
No AWS command has been run.
Only the owner may apply Terraform or make AWS changes.
MESSAGE
exit 64
`;
  if (
    retiredHardeningTombstoneIssues(exactHardeningTombstoneFixture).size > 0 ||
    retiredHardeningTombstoneIssues(
      exactHardeningTombstoneFixture.replace("exit 64", "aws s3 ls\nexit 64"),
    ).size === 0
  ) {
    report(
      "CHECKER_HARDENING_TOMBSTONE_FIXTURE",
      "the retired hardening entrypoint must accept only the exact side-effect-free exit-64 command shape",
    );
  }

  const applicationProviderTask = LABEL_STUDIO_PROVIDER_TASKS.find(
    (task) => task.id === "application",
  );
  const reviewedProviderTaskBlock = applicationProviderTask
    ? [
        '{ name = "LABEL_STUDIO_URL", value = "https://labels.example.test" }',
        `{ name = "LABEL_STUDIO_INSTANCE_ID", value = "${applicationProviderTask.instanceIdentity}" }`,
        '{ name = "ROOT_ADMIN_EMAIL", value = var.root_admin_email }',
        'name      = "LABEL_STUDIO_API_KEY"',
      ].join("\n")
    : "";
  const aliasedBootstrapIdentityBlock = reviewedProviderTaskBlock.replace(
    "var.root_admin_email",
    "var.label_studio_admin_email",
  );
  const reviewedProviderIssues = applicationProviderTask
    ? labelStudioProviderTaskAuthorityIssues(
        reviewedProviderTaskBlock,
        applicationProviderTask,
      )
    : new Set(["missing-manifest-task"]);
  const aliasedProviderIssues = applicationProviderTask
    ? labelStudioProviderTaskAuthorityIssues(
        aliasedBootstrapIdentityBlock,
        applicationProviderTask,
      )
    : new Set();
  if (
    reviewedProviderIssues.size > 0 ||
    !aliasedProviderIssues.has("provider-bootstrap-authority")
  ) {
    report(
      "CHECKER_LABEL_STUDIO_BOOTSTRAP_ALIAS_FIXTURE",
      "an application task that aliases Label Studio's bootstrap email into root-admin authority must be rejected",
    );
  }

  const fixtures = [
    {
      id: "advisory-check-is-not-atomic",
      source: `async function sink(capability) {
        await assertProjectWriteCapability(capability, 1);
        await db.update(projects).set({ name: "unsafe" });
      }`,
      expected: "PROJECT_WRITE_NOT_ATOMIC",
    },
    {
      id: "wrapper-with-global-db-bypasses-transaction",
      source: `async function sink(capability) {
        await withProjectWrite(capability, 1, async (tx) => {
          await db.update(projects).set({ name: "unsafe" });
        });
      }`,
      expected: "PROJECT_WRITE_BYPASSES_TRANSACTION",
    },
    {
      id: "wrapper-transaction-is-atomic",
      source: `async function sink(capability) {
        await withProjectWrite(capability, 1, async (tx) => {
          await tx.update(projects).set({ name: "safe" });
        });
      }`,
      expected: null,
    },
    {
      id: "named-plural-callback-is-atomic",
      source: `async function sink(capabilities) {
        const write = async (transaction) => {
          await transaction.delete(annotations);
        };
        await withProjectWrites(capabilities, write);
      }`,
      expected: null,
    },
    {
      id: "storage-wrapper-transaction-is-atomic",
      source: `async function sink(capability, project) {
        await withProjectStorageWrite(capability, project.id, project.dataUrl, async (tx) => {
          await tx.delete(projects);
        });
      }`,
      expected: null,
    },
    {
      id: "existing-transaction-wrapper-is-atomic",
      source: `async function sink(tx, capabilities) {
        const write = async (lockedTx) => {
          await lockedTx.delete(projects);
        };
        await withProjectWritesInTransaction(tx, capabilities, write);
      }`,
      expected: null,
    },
    {
      id: "transaction-helper-provenance-is-atomic",
      source: `async function stageLocked(tx) {
        await tx.delete(projects);
      }
      async function sink(tx, capabilities) {
        const stage = async (lockedTx) => stageLocked(lockedTx);
        await withProjectWritesInTransaction(tx, capabilities, stage);
      }`,
      expected: null,
    },
    {
      id: "transaction-helper-global-db-is-not-atomic",
      source: `async function stageLocked(tx) {
        await db.delete(projects);
      }
      async function sink(tx, capabilities) {
        const stage = async (lockedTx) => stageLocked(lockedTx);
        await withProjectWritesInTransaction(tx, capabilities, stage);
      }`,
      expected: "PROJECT_WRITE_NOT_ATOMIC",
    },
  ];

  for (const fixture of fixtures) {
    const parsedFixture = parseText(`${fixture.id}.ts`, fixture.source);
    const sinks = discoverProjectWriteSinks(parsedFixture, [
      "projects",
      "annotations",
    ]);
    const sink = sinks[0];
    const actual = sink
      ? atomicSinkViolation(parsedFixture, sink)
      : "NO_SINK_DISCOVERED";
    if (sinks.length !== 1 || actual !== fixture.expected) {
      report(
        "CHECKER_REGRESSION_FIXTURE",
        `${fixture.id} classified as ${String(actual)} with ${sinks.length} sink(s); expected ${String(fixture.expected)}`,
      );
    }
  }

  const exactCapabilityBoundaryFixture = await readFile(
    path.join(ROOT, "src/server/api/project-write-capability.ts"),
    "utf8",
  );
  const capabilityBoundaryMutations = [
    exactCapabilityBoundaryFixture.replace(
      "for (const storageRoot of [...new Set(storageRoots)].sort()) {",
      "for (const storageRoot of storageRoots) {",
    ),
    exactCapabilityBoundaryFixture.replace(
      "(a, b) => a.projectId - b.projectId,",
      "(a, b) => b.projectId - a.projectId,",
    ),
    exactCapabilityBoundaryFixture.replace('.for("update")', '.for("share")'),
    exactCapabilityBoundaryFixture.replace(
      "prior.lifecycleEpoch !== capability.lifecycleEpoch",
      "false",
    ),
    exactCapabilityBoundaryFixture.replace(
      "  return write(tx);",
      "  return write(db);",
    ),
    exactCapabilityBoundaryFixture.replace(
      "return withProjectWritesOnTransaction(tx, capabilities, [], write);",
      "return withProjectWritesOnTransaction(db, capabilities, [], write);",
    ),
  ];
  const exactCapabilityBoundary = parseText(
    "exact-project-write-capability-fixture.ts",
    exactCapabilityBoundaryFixture,
  );
  if (
    projectStorageWriteBoundaryIssues(exactCapabilityBoundary).size > 0 ||
    capabilityBoundaryMutations.some(
      (source, index) =>
        projectStorageWriteBoundaryIssues(
          parseText(`unsafe-capability-boundary-${index}.ts`, source),
        ).size === 0,
    )
  ) {
    report(
      "CHECKER_EXISTING_TRANSACTION_BOUNDARY_FIXTURE",
      "existing-transaction boundaries must preserve exact delegation, conflicting-capability rejection, sorted storage/project locks, FOR UPDATE validation, and the supplied transaction tail",
    );
  }

  const exactAdminDeleteFixture = await readFile(
    path.join(ROOT, "src/server/services/admin-users.ts"),
    "utf8",
  );
  const adminDeleteMutations = [
    exactAdminDeleteFixture.replaceAll(
      "pg_try_advisory_xact_lock",
      "pg_advisory_xact_lock",
    ),
    exactAdminDeleteFixture.replaceAll(", eq(users.isRootAdmin, false)", ""),
    exactAdminDeleteFixture.replace(
      /if \(deleted\.length !== 1\) \{[\s\S]*?\}/u,
      "",
    ),
    exactAdminDeleteFixture.replace(
      "    await db.transaction(async (rootMutationTx) => {",
      "    await deleteProjectFully(ownedProjects[0], assertProjectWritable(ownedProjects[0]));\n    await db.transaction(async (rootMutationTx) => {",
    ),
    exactAdminDeleteFixture.replace(
      "        !guardedActor.isRootAdmin &&\n        guardedTarget.companyId !== guardedActor.companyId",
      "        !session.user.isRootAdmin &&\n        guardedTarget.companyId !== session.user.companyId",
    ),
    exactAdminDeleteFixture.replace(
      "await findReferencedProjects(\n        rootMutationTx,\n        guardedTarget.id,\n      )",
      "await findReferencedProjects(db, guardedTarget.id)",
    ),
    exactAdminDeleteFixture.replace(
      "      assertNoDemoProjects(ownedProjects);",
      "      // assertNoDemoProjects(ownedProjects);",
    ),
    exactAdminDeleteFixture.replace(
      "        .orderBy(users.id);",
      '        .orderBy(users.id)\n        .for("update");',
    ),
    exactAdminDeleteFixture.replace(
      "          rootMutationTx,\n          ownedProjects.map",
      "          db,\n          ownedProjects.map",
    ),
    exactAdminDeleteFixture.replace(
      "          cleanupCapabilities,\n          runCleanup,",
      "          [],\n          runCleanup,",
    ),
    exactAdminDeleteFixture.replace(
      "        await withProjectWritesInTransaction(\n          rootMutationTx,",
      "        await withProjectWrites(\n          rootMutationTx,",
    ),
    exactAdminDeleteFixture.replace(
      "        committedProjectDeletions = staged.deletions;",
      "        // committed deletion identities discarded",
    ),
    exactAdminDeleteFixture.replace(
      "    await reconcileCommittedProjectDeletions(committedProjectDeletions);",
      "    reconcileCommittedProjectDeletions(committedProjectDeletions);",
    ),
    exactAdminDeleteFixture.replace(
      "      mutationStarted = true;",
      "      await reconcileCommittedProjectDeletions(committedProjectDeletions);\n      mutationStarted = true;",
    ),
  ];
  if (
    adminUserDeletionAuthorityIssues(
      parseText("exact-admin-delete-fixture.ts", exactAdminDeleteFixture),
    ).size > 0 ||
    adminDeleteMutations.some(
      (source, index) =>
        adminUserDeletionAuthorityIssues(
          parseText(`unsafe-admin-delete-${index}.ts`, source),
        ).size === 0,
    )
  ) {
    report(
      "CHECKER_ROOT_ADMIN_DELETE_FIXTURE",
      "the checked try-lock, database-backed authority/demo scope, exact root delete, existing-transaction bulk staging, and post-commit reconciliation mutations must be rejected",
    );
  }

  const adminUpdateMutations = [
    exactAdminDeleteFixture.replace(
      "pg_try_advisory_xact_lock",
      "pg_advisory_xact_lock",
    ),
    exactAdminDeleteFixture.replace(
      '    if (!acquired) {\n      throw new ApiError("CONFLICT", "User authority change in progress");\n    }',
      "    // lock contention ignored",
    ),
    exactAdminDeleteFixture.replace(
      '      .orderBy(users.id)\n      .for("update");',
      '      .for("update"); // .orderBy(users.id)',
    ),
    exactAdminDeleteFixture.replace(
      "    if (role && actor.isRootAdmin) updates.role = role;",
      "    if (role && session.user.isRootAdmin) updates.role = role;",
    ),
    exactAdminDeleteFixture.replace(
      /if \(updated\.length !== 1\) \{[\s\S]*?\}/u,
      "",
    ),
  ];
  if (
    adminUserUpdateAuthorityIssues(
      parseText("exact-admin-update-fixture.ts", exactAdminDeleteFixture),
    ).size > 0 ||
    adminUpdateMutations.some(
      (source, index) =>
        adminUserUpdateAuthorityIssues(
          parseText(`unsafe-admin-update-${index}.ts`, source),
        ).size === 0,
    )
  ) {
    report(
      "CHECKER_ADMIN_UPDATE_AUTHORITY_FIXTURE",
      "the update path must reject blocking or unchecked locks, unordered actor/target reads, JWT-backed authority, and non-exact updates",
    );
  }

  const exactJwtAuthorityFixture = `
    export async function refreshJwtUserAuthority(token) {
      if (!Number.isSafeInteger(token.dbId) || Number(token.dbId) <= 0) return null;
      const [fresh] = await db.select({
        companyId: users.companyId,
        role: users.role,
        canRunModels: users.canRunModels,
        isRootAdmin: users.isRootAdmin,
      }).from(users).where(eq(users.id, token.dbId!)).limit(1);
      if (!fresh) return null;
      token.companyId = fresh.companyId;
      token.role = fresh.role;
      token.canRunModels = fresh.canRunModels;
      token.isRootAdmin = fresh.isRootAdmin;
      return token;
    }
  `;
  const exactAuthFixture = await readFile(
    path.join(ROOT, "src/lib/auth.ts"),
    "utf8",
  );
  const exactJwt = parseText(
    "exact-jwt-authority-fixture.ts",
    exactJwtAuthorityFixture,
  );
  const exactAuth = parseText("exact-auth-fixture.ts", exactAuthFixture);
  const staleMissingUser = parseText(
    "stale-missing-user-fixture.ts",
    exactJwtAuthorityFixture.replace(
      "if (!fresh) return null;",
      "if (!fresh) return token;",
    ),
  );
  const staleCompany = parseText(
    "stale-company-fixture.ts",
    exactJwtAuthorityFixture.replace(
      "      token.companyId = fresh.companyId;\n",
      "",
    ),
  );
  const staleRole = parseText(
    "stale-role-fixture.ts",
    exactJwtAuthorityFixture.replace("      token.role = fresh.role;\n", ""),
  );
  const guardedRefresh = parseText(
    "guarded-refresh-fixture.ts",
    exactAuthFixture.replace(
      'trigger !== "signIn"',
      'trigger !== "signIn" && token.dbId',
    ),
  );
  const blockingPromotion = parseText(
    "blocking-promotion-fixture.ts",
    exactAuthFixture.replace(
      "pg_try_advisory_xact_lock",
      "pg_advisory_xact_lock",
    ),
  );
  const uncheckedPromotion = parseText(
    "unchecked-promotion-fixture.ts",
    exactAuthFixture.replace(
      '              if (!acquired) return "busy" as const;\n',
      "              // lock contention ignored\n",
    ),
  );
  const partialCredentialAuthority = parseText(
    "partial-credential-authority-fixture.ts",
    exactAuthFixture.replace("              role: users.role,\n", ""),
  );
  const unconditionalPromotion = parseText(
    "unconditional-promotion-fixture.ts",
    exactAuthFixture.replace(", eq(users.isRootAdmin, false)", ""),
  );
  const stalePromotionResult = parseText(
    "stale-promotion-result-fixture.ts",
    exactAuthFixture.replace(
      "              const [current] = await tx\n",
      "              const [current] = await db\n",
    ),
  );
  if (
    jwtAuthorityIssues(exactJwt, exactAuth).size > 0 ||
    rootBootstrapPromotionIssues(exactAuth).size > 0 ||
    jwtAuthorityIssues(staleMissingUser, exactAuth).size === 0 ||
    jwtAuthorityIssues(staleCompany, exactAuth).size === 0 ||
    jwtAuthorityIssues(staleRole, exactAuth).size === 0 ||
    jwtAuthorityIssues(exactJwt, guardedRefresh).size === 0 ||
    rootBootstrapPromotionIssues(blockingPromotion).size === 0 ||
    rootBootstrapPromotionIssues(uncheckedPromotion).size === 0 ||
    rootBootstrapPromotionIssues(partialCredentialAuthority).size === 0 ||
    rootBootstrapPromotionIssues(unconditionalPromotion).size === 0 ||
    rootBootstrapPromotionIssues(stalePromotionResult).size === 0
  ) {
    report(
      "CHECKER_JWT_ROOT_PROMOTION_FIXTURE",
      "stale JWT claims, conditional refresh, partial credential authority, blocking or unchecked bootstrap locks, unconditional promotion, and stale post-lock reads must be rejected",
    );
  }

  const createAfterTombstoneCheck = parseText(
    "create-after-tombstone-check-fixture.ts",
    `
      import { lockProjectStorageRoot } from "@/server/api/project-write-capability";
      async function createProject(dataUrl) {
        return db.transaction(async (tx) => {
          const [retiredRoot] = await tx.select().from(projectAssetDeletions)
            .where(eq(projectAssetDeletions.storageRoot, dataUrl));
          const [inserted] = await tx.insert(projects).values({ dataUrl }).returning();
          await lockProjectStorageRoot(tx, dataUrl);
          if (retiredRoot) throw new ApiError("CONFLICT", "Project storage root has been retired");
          return inserted;
        });
      }
    `,
  );
  if (
    !projectCreateStorageRootIssues(
      createAfterTombstoneCheck,
      functionFor(createAfterTombstoneCheck, "createProject"),
    ).has("lock-tombstone-check-insert-order")
  ) {
    report(
      "CHECKER_STORAGE_ROOT_CREATE_ORDER_FIXTURE",
      "a project insert before the shared lock and permanent tombstone guard must be rejected",
    );
  }

  const callerReferences = parseText(
    "deletion-caller-reference-fixture.ts",
    `
    const exact = \`bp-project-delete:\${row.id}:\${row.invalidationGeneration}\`;
    const ambiguous = \`bp-project-delete:\${row.id}:\${Date.now()}\`;
  `,
  );
  if (
    !deterministicDeletionCallerReference(
      variableInitializer(callerReferences.source, "exact"),
    ) ||
    deterministicDeletionCallerReference(
      variableInitializer(callerReferences.source, "ambiguous"),
    )
  ) {
    report(
      "CHECKER_DELETION_CALLER_REFERENCE_FIXTURE",
      "CloudFront deletion caller references must derive only from tombstone id and durable generation",
    );
  }

  const lateIntentAfterDeleteS3 = parseText(
    "late-intent-after-delete-fixture.ts",
    `
    async function deleteS3PrefixAllVersions(prefix, options = {}) {
      await s3Client.send(new DeleteObjectsCommand({ Delete: { Objects: objects } }));
      await options.onObjectsFound?.();
    }
    function deleteProjectFiles(projectPath, options = {}) {
      return deleteS3PrefixAllVersions(\`\${projectPath}/\`, options);
    }
  `,
  );
  const minimalAssetReconciler = parseText(
    "minimal-asset-reconciler-fixture.ts",
    `
    async function purgeBothPrefixes(storageRoot, onFinalObjectsFound) {
      const results = await Promise.allSettled([
        deleteProjectFiles(storageRoot, { onObjectsFound: onFinalObjectsFound }),
        deleteProjectStagingFiles(storageRoot),
      ]);
      throw new AggregateError(results);
    }
    async function reconcileProjectAssetDeletion() {}
  `,
  );
  if (
    !projectAssetDeletionReconcilerIssues(
      minimalAssetReconciler,
      lateIntentAfterDeleteS3,
    ).has("durable-intent-before-first-final-delete")
  ) {
    report(
      "CHECKER_PREDELETE_INTENT_FIXTURE",
      "a late-object intent persisted only after DeleteObjects must be rejected",
    );
  }

  const reviewedDelegate = parseText(
    "src/server/services/reviewed-delegate-fixture.ts",
    `
    import { deleteProjectFully } from "@/lib/project-delete";
    async function deleteProject() {
      await deleteProjectFully(project, capability);
    }
  `,
  );
  const unreviewedDelegate = parseText(
    "src/server/services/unreviewed-delegate-fixture.ts",
    `
    import { deleteProjectFully } from "@/lib/unsafe-project-delete";
    async function deleteProject() {
      await deleteProjectFully(project, capability);
    }
  `,
  );
  if (
    !delegatesToReviewedInternalSink(
      reviewedDelegate,
      functionFor(reviewedDelegate, "deleteProject"),
    ) ||
    delegatesToReviewedInternalSink(
      unreviewedDelegate,
      functionFor(unreviewedDelegate, "deleteProject"),
    )
  ) {
    report(
      "CHECKER_REVIEWED_DELEGATE_FIXTURE",
      "only an exact imported file+symbol from INTERNAL_MUTATION_SINKS may satisfy cross-file atomic delegation",
    );
  }

  const exactModelSignerFixture = parseText(
    "exact-model-signer-fixture.ts",
    [
      "import { createPresignedPost as post } from '@aws-sdk/s3-presigned-post';",
      "import { canonicalModelStoragePath } from '@/lib/model-storage-authority';",
      "async function createModelUploadPresignedPost(modelName) {",
      "  const s3Path = canonicalModelStoragePath(modelName);",
      "  const key = `${s3Path}/model.pt`;",
      "  return post(client, { Key: key });",
      "}",
    ].join("\n"),
  );
  const unsafeModelSignerFixture = parseText(
    "unsafe-model-signer-fixture.ts",
    [
      "import { createPresignedPost as post } from '@aws-sdk/s3-presigned-post';",
      "import { canonicalModelStoragePath } from '@/lib/model-storage-authority';",
      "async function createModelUploadPresignedPost(modelName) {",
      "  const s3Path = canonicalModelStoragePath(modelName);",
      "  const key = `${s3Path}/original.pdf`;",
      "  return post(client, { Key: key });",
      "}",
    ].join("\n"),
  );
  if (
    !exactModelUploadSigner(
      exactModelSignerFixture,
      functionFor(exactModelSignerFixture, "createModelUploadPresignedPost"),
    ) ||
    exactModelUploadSigner(
      unsafeModelSignerFixture,
      functionFor(unsafeModelSignerFixture, "createModelUploadPresignedPost"),
    )
  ) {
    report(
      "CHECKER_MODEL_SIGNER_FIXTURE",
      "the model presign exemption must accept only the shared canonical path's model.pt",
    );
  }

  const projectLikeModelSink = parseText(
    "project-like-model-storage-fixture.ts",
    [
      "import { isCanonicalModelStoragePath } from '@/lib/model-storage-authority';",
      "async function registerModel(name, project) {",
      "  const s3Path = project.dataUrl;",
      "  await uploadToS3(`${s3Path}/config.yaml`, body);",
      "}",
    ].join("\n"),
  );
  const unsafeRegister = functionFor(projectLikeModelSink, "registerModel");
  const unsafeModelUpload = descendants(
    unsafeRegister,
    ts.isCallExpression,
  ).find((call) => callName(call) === "uploadToS3");
  if (
    !unsafeModelUpload ||
    modelStorageGuardBefore(
      projectLikeModelSink,
      unsafeRegister,
      [["name"], ["s3Path"]],
      "Invalid model storage path",
      unsafeModelUpload.getStart(),
    )
  ) {
    report(
      "CHECKER_PROJECT_LIKE_MODEL_PATH_FIXTURE",
      "a project-derived model s3Path without the canonical authority guard must be rejected",
    );
  }

  const legacyStagingProtocol = parseText(
    "legacy-staging-protocol-fixture.ts",
    [
      "function projectUploadStagingPrefix(projectPath) {",
      "  return `${projectPath}/staging/`;",
      "}",
      "function projectUploadStagingKey(projectPath, filename, index) {",
      "  const idx3 = index.toString().padStart(3, '0');",
      "  return `${projectPath}/staging/${idx3}_${filename}`;",
      "}",
      "async function createStagingUploadPresignedPost(projectPath, filename, index) {",
      "  const idx3 = index.toString().padStart(3, '0');",
      "  const safe = filename;",
      "  const stagingKey = `${projectPath}/staging/${idx3}_${safe}`;",
      "  return createPresignedPost(client, { Key: stagingKey });",
      "}",
      "async function createProject(dataUrl, sf) {",
      "  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(`${callerCompany.dataKey}/`)) {",
      "    throw new ApiError('VALIDATION', 'Invalid dataUrl — must be inside your company prefix (use /api/s3/staging-credentials to obtain one)');",
      "  }",
      "  const stagingPrefix = `${dataUrl}/staging/`;",
      "  if (!sf.stagingKey.startsWith(stagingPrefix)) throw new Error('bad key');",
      "  await headS3Object(sf.stagingKey);",
      "}",
    ].join("\n"),
  );
  const legacyPrefixFunction = functionFor(
    legacyStagingProtocol,
    "projectUploadStagingPrefix",
  );
  const legacyPrefixReturn = directReturnExpressions(legacyPrefixFunction)[0];
  const legacyKeyFunction = functionFor(
    legacyStagingProtocol,
    "projectUploadStagingKey",
  );
  const legacyKeyReturn = directReturnExpressions(legacyKeyFunction)[0];
  const legacySigner = functionFor(
    legacyStagingProtocol,
    "createStagingUploadPresignedPost",
  );
  const legacySignerKey = variableInitializer(legacySigner, "stagingKey");
  const legacyCreate = functionFor(legacyStagingProtocol, "createProject");
  const legacyCreateUsesExactKey = descendants(
    legacyCreate,
    ts.isCallExpression,
  ).some((call) => callName(call) === "projectUploadStagingKey");
  const legacyCreateUsesPrefix = descendants(
    legacyCreate,
    ts.isCallExpression,
  ).some(
    (call) =>
      callName(call) === "startsWith" &&
      hasPropertyAccess(call, "sf", "stagingKey"),
  );
  if (
    interpolationTemplateMatches(legacyPrefixReturn, "", [
      { identifier: "PROJECT_UPLOAD_STAGING_ROOT", suffix: "/" },
      { identifier: "projectPath", suffix: "/" },
    ]) ||
    exactProjectStagingKeyTemplate(legacyKeyReturn) ||
    exactIdentifierCall(legacySignerKey, "projectUploadStagingKey", [
      "projectPath",
      "filename",
      "index",
    ]) ||
    !templateStartsInProjectPrefix(legacySignerKey, "projectPath") ||
    legacyCreateUsesExactKey ||
    !legacyCreateUsesPrefix ||
    hasCanonicalProjectPathGuard(legacyStagingProtocol, legacyCreate)
  ) {
    report(
      "CHECKER_STAGING_ISOLATION_FIXTURE",
      "legacy projectPath/staging signers, helpers, and prefix-only validators must be rejected",
    );
  }

  const prefixOnlyPathAuthority = parseText(
    "prefix-only-project-path-fixture.ts",
    [
      "export function isSafeCompanyDataKey(dataKey) {",
      "  return dataKey.length > 0;",
      "}",
      "export function isCanonicalProjectPath(dataKey, projectPath) {",
      "  return projectPath.startsWith(`${dataKey}/`);",
      "}",
    ].join("\n"),
  );
  if (exactCanonicalProjectPathAuthority(prefixOnlyPathAuthority)) {
    report(
      "CHECKER_PROJECT_PATH_AUTHORITY_FIXTURE",
      "prefix-only project paths and slash/reserved company keys must be rejected",
    );
  }

  const latestStagingRead = parseText(
    "latest-staging-read-fixture.ts",
    `
    async function buildProjectPdf(manifest) {
      for (const sf of manifest) {
        const buf = await downloadFromS3(sf.stagingKey);
        await writeFile(sf.filename, buf);
      }
    }
  `,
  );
  const latestReadIssues = processingVersionReadIssues(
    latestStagingRead,
    functionFor(latestStagingRead, "buildProjectPdf"),
  );
  if (!latestReadIssues.has("versioned-download-before-use")) {
    report(
      "CHECKER_STAGING_LATEST_REPLAY_FIXTURE",
      "processing a mutable latest staging key without its stored S3 version must be rejected",
    );
  }

  const failOpenUploadFence = parseText(
    "fail-open-upload-fence-fixture.ts",
    [
      "function publish(project) {",
      "  const active = sql`",
      "    ${projects.createdAt} IS NOT NULL AND ${projects.createdAt}",
      "      + (${PROJECT_UPLOAD_PUBLICATION_FENCE_SECONDS} * INTERVAL '1 second')",
      "      > CURRENT_TIMESTAMP",
      "  `;",
      "  return active;",
      "}",
    ].join("\n"),
  );
  if (
    publicationFenceSqlNodes(functionFor(failOpenUploadFence, "publish"))
      .length !== 0
  ) {
    report(
      "CHECKER_UPLOAD_FENCE_POLARITY_FIXTURE",
      "a NULL-createdAt upload fence must fail closed rather than publish/delete",
    );
  }

  const exactProjectDeleteFixture = await readFile(
    path.join(ROOT, "src/lib/project-delete.ts"),
    "utf8",
  );
  const projectDeleteMutations = [
    exactProjectDeleteFixture.replace(
      "storageOwner.dataUrl !== project.dataUrl ||",
      "false || // storage-owner mismatch ignored",
    ),
    exactProjectDeleteFixture.replace(
      'eq(processingJobs.status, "running")',
      'eq(processingJobs.status, "completed")',
    ),
    exactProjectDeleteFixture.replace(
      'eq(projectMutationLeases.status, "active")',
      'eq(projectMutationLeases.status, "retired")',
    ),
    exactProjectDeleteFixture.replace(
      '"Project has linked labeling sessions"',
      '"Linked labeling sessions ignored"',
    ),
    exactProjectDeleteFixture.replace(
      '"Project has pending Label Studio provisioning"',
      '"Pending Label Studio provisioning ignored"',
    ),
    exactProjectDeleteFixture.replace(
      "${projects.createdAt} IS NULL\n        OR ${projects.createdAt}",
      "${projects.createdAt} IS NOT NULL\n        AND ${projects.createdAt}",
    ),
    exactProjectDeleteFixture.replace(
      "storageRoot: storageOwner.dataUrl,",
      "storageRoot: project.dataUrl,",
    ),
    exactProjectDeleteFixture.replace(
      "): Promise<StagedProjectAssetDeletion> {",
      "): Promise<StagedProjectAssetDeletion> {\n  await stopExecution(project.jobId);",
    ),
    exactProjectDeleteFixture.replace(
      "for (const entry of [...entries].sort(\n      (left, right) => left.project.id - right.project.id,\n    )) {",
      "for (const entry of entries) {",
    ),
    exactProjectDeleteFixture.replace(
      "return withProjectStorageWritesInTransaction(\n    tx,",
      "return withProjectWritesInTransaction(\n    tx,",
    ),
    exactProjectDeleteFixture.replace(
      "    } catch (err) {",
      "    } catch (err) {\n      throw err;",
    ),
    exactProjectDeleteFixture.replace(
      "  await reconcileCommittedProjectDeletions([deletion]);",
      "  reconcileCommittedProjectDeletions([deletion]);",
    ),
  ];
  const exactProjectDelete = parseText(
    "exact-project-delete-fixture.ts",
    exactProjectDeleteFixture,
  );
  if (
    quiescentDeleteIssues(
      exactProjectDelete,
      functionFor(exactProjectDelete, "deleteProjectFully"),
    ).size > 0 ||
    projectDeleteMutations.some((source, index) => {
      const parsedMutation = parseText(
        `unsafe-project-delete-${index}.ts`,
        source,
      );
      return (
        quiescentDeleteIssues(
          parsedMutation,
          functionFor(parsedMutation, "deleteProjectFully"),
        ).size === 0
      );
    })
  ) {
    report(
      "CHECKER_QUIESCENT_DELETE_FIXTURE",
      "locked quiescence, canonical ownership, durable staging, sorted bulk locks, transaction propagation, and post-commit continue-on-error reconciliation mutations must be rejected",
    );
  }

  const filteredLabelingBlocker = parseText(
    "filtered-labeling-blocker-fixture.ts",
    `
    async function publish(project, tx) {
      const [linkedLabelingSession] = await tx.select().from(labelingSessions).where(and(
        eq(labelingSessions.projectId, project.id),
        eq(labelingSessions.status, "active")
      ));
      if (linkedLabelingSession) {
        throw new ApiError("CONFLICT", "Project has linked labeling sessions");
      }
      await tx.update(projects).set({ isDemo: true });
    }
  `,
  );
  const filteredPublish = functionFor(filteredLabelingBlocker, "publish");
  const filteredPublishUpdate = descendants(
    filteredPublish,
    ts.isCallExpression,
  ).find(
    (call) =>
      callName(call) === "update" &&
      propertyName(call.arguments[0]) === "projects",
  );
  if (
    filteredPublishUpdate &&
    labelingBlockerBefore(filteredPublish, filteredPublishUpdate.getStart())
  ) {
    report(
      "CHECKER_LABELING_BLOCKER_FIXTURE",
      "publication/deletion must reject every labeling session, not only a filtered status subset",
    );
  }

  const lateProcessingIntent = parseText(
    "late-processing-intent-fixture.ts",
    [
      "async function createProject(capability, projectId) {",
      "  const executionName = 'job';",
      "  try {",
      "    await sfn.send(new StartExecutionCommand({ name: executionName }));",
      "    const expectedExecutionArn = `${STEP_FUNCTION_ARN}:${executionName}`;",
      "    await withProjectWrite(capability, projectId, async (tx) => {",
      "      await tx.insert(processingJobs).values({",
      "        projectId, executionId: expectedExecutionArn, status: 'running'",
      "      });",
      "    });",
      "  } catch (error) {",
      "    await withProjectWrite(capability, projectId, async (tx) => {",
      "      await tx.update(processingJobs)",
      "        .set({ error: 'Step Functions start outcome unknown' })",
      "        .where(eq(processingJobs.id, pendingJobId));",
      "    });",
      "    throw error;",
      "  }",
      "}",
    ].join("\n"),
  );
  const lateIntentIssues = processingStartIntentIssues(
    lateProcessingIntent,
    functionFor(lateProcessingIntent, "createProject"),
  );
  if (!lateIntentIssues.has("running-intent-before-send")) {
    report(
      "CHECKER_PROCESSING_INTENT_ORDER_FIXTURE",
      "a processing running intent inserted after StartExecution must be rejected",
    );
  }

  const swallowedAmbiguousStart = parseText(
    "swallowed-ambiguous-start-fixture.ts",
    [
      "async function createProject(capability, projectId) {",
      "  const executionName = 'job';",
      "  const expectedExecutionArn = `${STEP_FUNCTION_ARN}:${executionName}`;",
      "  await withProjectWrite(capability, projectId, async (tx) => {",
      "    await tx.insert(processingJobs).values({",
      "      projectId, executionId: expectedExecutionArn, status: 'running'",
      "    });",
      "  });",
      "  try {",
      "    await sfn.send(new StartExecutionCommand({ name: executionName }));",
      "  } catch (error) {",
      "    await withProjectWrite(capability, projectId, async (tx) => {",
      "      await tx.update(processingJobs)",
      "        .set({ error: 'Step Functions start outcome unknown' })",
      "        .where(eq(processingJobs.id, pendingJobId));",
      "    });",
      "  }",
      "}",
    ].join("\n"),
  );
  const swallowedStartIssues = processingStartIntentIssues(
    swallowedAmbiguousStart,
    functionFor(swallowedAmbiguousStart, "createProject"),
  );
  if (!swallowedStartIssues.has("ambiguous-start-fails-closed")) {
    report(
      "CHECKER_PROCESSING_AMBIGUOUS_FIXTURE",
      "an ambiguous StartExecution failure must retain the intent and propagate the failure",
    );
  }

  const directLabelingDelete = parseText(
    "direct-labeling-delete-fixture.ts",
    `
    async function deleteLabelingSession() {
      await withProjectMutationLease(
        capability,
        { kind: "labeling-session-delete", idempotencyKey: String(targetProject.id) },
        async () => {
          try {
            await deleteProject(provider, record.labelStudioProjectId);
          } catch (error) {
            logger.error(error);
          }
          await withProjectWrite(capability, targetProject.id, async (tx) => {
            await tx.delete(labelingSessions).where(eq(labelingSessions.id, sessionId));
          });
        },
      );
    }
  `,
  );
  const directLabelingDeleteIssues = labelingDeleteIssues(
    directLabelingDelete,
    functionFor(directLabelingDelete, "deleteLabelingSession"),
  );
  if (
    !directLabelingDeleteIssues.has("obsolete-project-wide-delete-lease") ||
    !directLabelingDeleteIssues.has("no-direct-provider-delete") ||
    !directLabelingDeleteIssues.has("atomic-retirement-enqueue-and-revocation")
  ) {
    report(
      "CHECKER_LABELING_DELETE_FIXTURE",
      "a project-wide lease with direct provider DELETE and no committed revoked retirement witness must be rejected",
    );
  }

  const lateLabelingIntent = parseText(
    "late-labeling-intent-fixture.ts",
    [
      "async function createLabelingSessions() {",
      "  return withProjectMutationLease(",
      "    capability,",
      "    { kind: 'labeling-session-create', idempotencyKey: String(project.id) },",
      "    async () => {",
      "      const lsProject = await createProject(provider, title, config);",
      "      let record;",
      "      try {",
      "        await importTasks(provider, lsProject.id, chunk);",
      "        record = await withProjectWrite(capability, project.id, async (tx) => {",
      "          const [inserted] = await tx.insert(labelingSessions).values({",
      "            labelStudioProjectId: lsProject.id, status: 'provisioning'",
      "          }).returning();",
      "          return inserted;",
      "        });",
      "        await withProjectWrite(capability, project.id, async (tx) => {",
      "          await tx.update(labelingSessions)",
      "            .set({ status: 'active', updatedAt: sql`CURRENT_TIMESTAMP` });",
      "        });",
      "      } catch (error) {",
      "        let providerDeleted = false;",
      "        await deleteProject(provider, lsProject.id).then(() => {",
      "          providerDeleted = true;",
      "        }).catch((cleanupError) => {",
      "          logger.error('[LABELING] Failed to compensate orphan Label Studio project:', cleanupError);",
      "        });",
      "        if (providerDeleted && record) {",
      "          await withProjectWrite(capability, project.id, async (tx) => {",
      "            await tx.delete(labelingSessions).where(eq(labelingSessions.id, record.id));",
      "          });",
      "        }",
      "        throw error;",
      "      }",
      "    },",
      "  );",
      "}",
    ].join("\n"),
  );
  const lateLabelingIntentIssues = labelingCreateIssues(
    lateLabelingIntent,
    functionFor(lateLabelingIntent, "createLabelingSessions"),
  );
  if (!lateLabelingIntentIssues.has("provisioning-intent-before-import")) {
    report(
      "CHECKER_LABELING_INTENT_ORDER_FIXTURE",
      "a Label Studio task import before its provisional local intent must be rejected",
    );
  }

  const rawGrantTokenPersistence = parseText(
    "raw-labeling-grant-token-fixture.ts",
    [
      "async function createLabelingSessions() {",
      "  return withProjectMutationLease(",
      "    capability,",
      "    { kind: 'labeling-session-create', idempotencyKey: String(project.id) },",
      "    async () => {",
      "      const preparedTasks = [];",
      "      const intentId = 'intent';",
      "      const persistKnownProvider = async (options) => {",
      "        await withProjectWrite(capability, project.id, async (tx) => {",
      "          if (options.insertGrants) {",
      "            await tx.insert(labelStudioAssetGrants).values(",
      "              preparedTasks.map(({ grant }) => ({",
      "                id: grant.id, projectId: project.id, companyId: project.companyId,",
      "                lifecycleEpoch: project.lifecycleEpoch, provisioningIntentId: intentId,",
      "                tokenHash: grant.tokenHash, token: grant.token,",
      "                snapshotVersionId: grant.snapshotVersionId, state: 'provisioning'",
      "              })),",
      "            );",
      "          }",
      "        });",
      "      };",
      "      await persistKnownProvider({ insertGrants: true });",
      "      await importTasks(provider, lsProject.id, preparedTasks.map(({ grant }) => ({",
      "        data: { image: labelStudioAssetUrl(grant.id, grant.token) }",
      "      })));",
      "    },",
      "  );",
      "}",
    ].join("\n"),
  );
  const rawGrantTokenIssues = labelingCreateIssues(
    rawGrantTokenPersistence,
    functionFor(rawGrantTokenPersistence, "createLabelingSessions"),
  );
  if (!rawGrantTokenIssues.has("hashed-grants-committed-before-import")) {
    report(
      "CHECKER_LABELING_RAW_GRANT_TOKEN_FIXTURE",
      "persisting a raw Label Studio bearer beside its hash must be rejected",
    );
  }

  const unsafeLabelingCompensation = parseText(
    "unsafe-labeling-compensation-fixture.ts",
    [
      "async function createLabelingSessions() {",
      "  return withProjectMutationLease(",
      "    capability,",
      "    { kind: 'labeling-session-create', idempotencyKey: String(project.id) },",
      "    async () => {",
      "      const lsProject = await createProject(provider, title, config);",
      "      let record;",
      "      try {",
      "        record = await withProjectWrite(capability, project.id, async (tx) => {",
      "          const [inserted] = await tx.insert(labelingSessions).values({",
      "            labelStudioProjectId: lsProject.id, status: 'provisioning'",
      "          }).returning();",
      "          return inserted;",
      "        });",
      "        await importTasks(provider, lsProject.id, chunk);",
      "        await withProjectWrite(capability, project.id, async (tx) => {",
      "          await tx.update(labelingSessions)",
      "            .set({ status: 'active', updatedAt: sql`CURRENT_TIMESTAMP` });",
      "        });",
      "      } catch (error) {",
      "        try {",
      "          await deleteProject(provider, lsProject.id);",
      "        } catch (cleanupError) {",
      "          logger.error('[LABELING] Failed to compensate orphan Label Studio project:', cleanupError);",
      "        }",
      "        await withProjectWrite(capability, project.id, async (tx) => {",
      "          await tx.delete(labelingSessions).where(eq(labelingSessions.id, record.id));",
      "        });",
      "        throw error;",
      "      }",
      "    },",
      "  );",
      "}",
    ].join("\n"),
  );
  const unsafeCompensationIssues = labelingCreateIssues(
    unsafeLabelingCompensation,
    functionFor(unsafeLabelingCompensation, "createLabelingSessions"),
  );
  if (
    !unsafeCompensationIssues.has("provider-compensation-observed") ||
    !unsafeCompensationIssues.has("retain-intent-until-provider-compensated")
  ) {
    report(
      "CHECKER_LABELING_COMPENSATION_FIXTURE",
      "local Label Studio intent cleanup must remain gated on confirmed provider compensation",
    );
  }

  const schemaFixture = parseText(
    "schema-project-fk-fixture.ts",
    `
    const projects = pgTable("projects", { id: integer("id") });
    const directProjectChild = pgTable("direct_project_child", {
      id: integer("id"),
      projectId: integer("project_id").references(() => projects.id),
    });
    const indirectProjectChild = pgTable("indirect_project_child", {
      id: integer("id"),
      directId: integer("direct_id").references(() => directProjectChild.id),
    });
    const unrelated = pgTable("unrelated", { id: integer("id") });
  `,
  );
  const fixtureOwned = transitiveProjectOwnedTables(
    schemaTableGraph(schemaFixture),
  );
  const fixtureDrift = projectOwnershipDrift(
    fixtureOwned,
    new Set(),
    new Set(["projects"]),
  );
  if (
    !fixtureOwned.has("directProjectChild") ||
    !fixtureOwned.has("indirectProjectChild") ||
    fixtureOwned.has("unrelated") ||
    JSON.stringify(fixtureDrift.missingFromManifest) !==
      JSON.stringify(["directProjectChild", "indirectProjectChild"])
  ) {
    report(
      "CHECKER_SCHEMA_OWNERSHIP_FIXTURE",
      "schema-derived ownership must discover direct and transitive project FKs omitted from a hand manifest",
    );
  }

  const unsafeLeaseFixture = parseText(
    "unsafe-lease-clock-fixture.ts",
    [
      "async function unsafeLease(tx) {",
      "  const now = new Date();",
      "  await tx.delete(projectMutationLeases).where(lte(projectMutationLeases.expiresAt, now));",
      "  await tx.select().from(projectMutationLeases).where(and(",
      "    eq(projectMutationLeases.status, 'active'),",
      "    gt(projectMutationLeases.expiresAt, now)",
      "  ));",
      "  await tx.insert(projectMutationLeases).values({",
      "    expiresAt: new Date(Date.now() + 30000),",
      "    heartbeatAt: new Date(),",
      "  });",
      "}",
    ].join("\n"),
  );
  const unsafeLease = functionFor(unsafeLeaseFixture, "unsafeLease");
  const unsafeLeaseSinks = discoverProjectWriteSinks(unsafeLeaseFixture, [
    "projectMutationLeases",
  ]);
  if (
    !unsafeLease ||
    !usesExpiryBasedLeaseRetirement(unsafeLease) ||
    !hasAppClockAssignment(unsafeLease, "expiresAt") ||
    !hasAppClockAssignment(unsafeLease, "heartbeatAt") ||
    !unsafeLeaseSinks.some((sink) => sink.kind === "delete") ||
    hasFailClosedActiveLeasePredicate(unsafeLease)
  ) {
    report(
      "CHECKER_LEASE_CLOCK_FIXTURE",
      "app-clock lease metadata and expiry-based reap/live predicates must be rejected",
    );
  }

  const swallowedReleaseFixture = parseText(
    "swallowed-release-fixture.ts",
    `
    async function withProjectMutationLease(capability, lease, operation) {
      try {
        return await operation(lease);
      } finally {
        clearTimeout(timer);
        try {
          await releaseProjectMutationLease(capability, lease);
        } catch (releaseError) {
          // unsafe: surviving-project release failure disappears
        }
      }
    }
  `,
  );
  const swallowedRelease = functionFor(
    swallowedReleaseFixture,
    "withProjectMutationLease",
  );
  if (!swallowedRelease || hasSafeLeaseReleaseFinally(swallowedRelease)) {
    report(
      "CHECKER_LEASE_RELEASE_FIXTURE",
      "a generic catch-swallow around durable lease release must be rejected",
    );
  }

  const aliasedWriteFixture = parseText(
    "aliased-project-write-fixture.ts",
    `
    const projectTable = projects;
    const mutateProject = db.update;
    async function aliasedWrites(dynamicStatement) {
      await mutateProject(projectTable).set({ name: "renamed" });
      await db.delete(projectTable);
      await sql.raw("update projects set name = 'raw'");
      await db.execute(sql\`delete from \${projectTable} where id = 1\`);
      await sql.raw(dynamicStatement);
    }
  `,
  );
  const aliasedWriteSignatures = new Set(
    discoverProjectWriteSinks(aliasedWriteFixture).map(
      (sink) => `${sink.kind}:${sink.table}`,
    ),
  );
  for (const signature of [
    "update:projects",
    "delete:projects",
    "raw-sql:projects",
    "raw-sql-unresolved:<dynamic>",
  ]) {
    if (!aliasedWriteSignatures.has(signature)) {
      report(
        "CHECKER_ALIASED_WRITE_FIXTURE",
        `project write discovery missed ${signature}`,
      );
    }
  }

  const delegatedRouteFixture = parseText(
    "src/app/api/fixture/route.ts",
    `
    import { reviewedWriter as renamedWriter } from "@/server/services/reviewed-writer";
    function localDelegate() { return renamedWriter(); }
    export async function POST() { return localDelegate(); }
  `,
  );
  const delegatedRouteCalls = importedCallsTransitively(
    delegatedRouteFixture,
    functionFor(delegatedRouteFixture, "POST"),
  );
  if (
    delegatedRouteCalls.length !== 1 ||
    delegatedRouteCalls[0].sourceFile !==
      "src/server/services/reviewed-writer.ts" ||
    delegatedRouteCalls[0].symbol !== "reviewedWriter"
  ) {
    report(
      "CHECKER_ROUTE_DELEGATION_FIXTURE",
      "mutation route binding must follow local delegates and named import aliases",
    );
  }

  const exemptWriterFixture = parseText(
    "scripts/unsafe-ledger-writer.ts",
    `
    async function arbitraryLedgerRewrite() {
      await db.update(computeUsage).set({ pages: 0 });
    }
  `,
  );
  const exemptSink = discoverProjectWriteSinks(exemptWriterFixture, [
    "computeUsage",
  ])[0];
  const allowedFixtureWriters = new Set([
    "src/lib/compute-usage.ts:stampReservationJob:update",
  ]);
  if (
    !exemptSink ||
    allowedFixtureWriters.has(
      sinkOwnerKey(
        "scripts/unsafe-ledger-writer.ts",
        exemptWriterFixture,
        exemptSink,
      ),
    )
  ) {
    report(
      "CHECKER_PROJECT_FK_EXEMPTION_FIXTURE",
      "a project-FK exemption must not permit an undeclared writer",
    );
  }
}

async function validateExemptProjectFkWrites(files) {
  for (const exemption of PROJECT_FK_TABLE_EXEMPTIONS) {
    const declared = new Set(
      exemption.writers.map((writer) => writer.join(":")),
    );
    const discovered = new Set();
    for (const file of files) {
      const parsedFile = await parsed(file);
      for (const sink of discoverProjectWriteSinks(parsedFile, [
        exemption.table,
      ])) {
        const key = sinkOwnerKey(file, parsedFile, sink);
        discovered.add(key);
        if (!declared.has(key)) {
          const owner = enclosingFunction(parsedFile, sink.node);
          report(
            "UNCLASSIFIED_PROJECT_FK_EXEMPT_WRITE",
            `${sink.kind}(${exemption.table}) in ${owner.name} is not an allowed ${exemption.policy} writer`,
            file,
            sink.node,
          );
        }
      }
    }
    for (const key of declared) {
      if (!discovered.has(key)) {
        report(
          "STALE_PROJECT_FK_EXEMPT_WRITER",
          `${exemption.table} declares writer ${key}, but that sink does not exist`,
        );
      }
    }
  }
}

async function validateWriteCoverage(files, protectedTables) {
  const coveredByFile = new Map();
  for (const surface of MUTATION_SURFACES) {
    for (const [file, symbol] of surface.checks) {
      if (!symbol) continue;
      const parsedFile = await parsed(file);
      const covered = coveredByFile.get(file) ?? new Set();
      for (const name of reachableFunctions(parsedFile, symbol))
        covered.add(name);
      coveredByFile.set(file, covered);
    }
  }
  for (const [file, symbol] of INTERNAL_MUTATION_SINKS) {
    const parsedFile = await parsed(file);
    const covered = coveredByFile.get(file) ?? new Set();
    for (const name of reachableFunctions(parsedFile, symbol))
      covered.add(name);
    coveredByFile.set(file, covered);
  }

  for (const file of files) {
    const parsedFile = await parsed(file);
    const covered = coveredByFile.get(file) ?? new Set();
    const sinks = discoverProjectWriteSinks(parsedFile, [...protectedTables]);

    for (const sink of sinks) {
      if (sink.kind === "raw-sql-unresolved") {
        report(
          "UNPROVABLE_PROJECT_RAW_SQL",
          "dynamic mutating SQL cannot prove that its target is outside the project-owned table set",
          file,
          sink.node,
        );
        continue;
      }
      const owner = enclosingFunction(parsedFile, sink.node);
      if (!covered.has(owner.name)) {
        report(
          "UNCLASSIFIED_PROJECT_WRITE",
          `${sink.kind}(${sink.table}) in ${owner.name} is absent from the mutation/internal-sink manifest`,
          file,
          sink.node,
        );
      }

      const lifecycleException = LIFECYCLE_EXCEPTIONS.find(
        (exception) =>
          exception.sourceFile === file && exception.symbol === owner.name,
      );
      let sanctionedLifecycleSink = false;
      if (
        lifecycleException &&
        sink.table === "projects" &&
        sink.kind === "update"
      ) {
        const columns = setColumnsForUpdateSink(sink);
        sanctionedLifecycleSink =
          columns.length > 0 &&
          columns.every((column) =>
            lifecycleException.allowedColumns.includes(column),
          );
        if (!sanctionedLifecycleSink) {
          report(
            "LIFECYCLE_EXCEPTION_WRITE_DRIFT",
            `${owner.name} project update writes ${columns.join(", ") || "an unprovable column set"}`,
            file,
            sink.node,
          );
        }
      }

      const isNewPrivateProjectInsert = MUTATION_SURFACES.some(
        (surface) =>
          surface.policy === "new-private-project" &&
          surface.checks.some(
            ([sourceFile, symbol]) =>
              sourceFile === file &&
              symbol === owner.name &&
              sink.table === "projects" &&
              sink.kind === "insert",
          ),
      );
      const nullProjectChatInsert = isProvablyNullProjectChatInsert(sink);
      const reviewedParentLockedIntentSink =
        file === "src/lib/label-studio-project-intent.ts" &&
        sink.table === "labelStudioProjectIntents" &&
        new Set([
          "claimCandidate",
          "deleteClaimedIntent",
          "rescheduleClaimedIntent",
          "persistDiscoveredProviderIdentity",
        ]).has(owner.name);
      const reviewedProjectTransactionHelper =
        file === "src/lib/label-studio-asset-grant.ts" &&
        sink.table === "labelStudioAssetGrants" &&
        LABEL_STUDIO_GRANT_TRANSACTION_HELPERS.has(owner.name) &&
        mutationReceiver(sink) === "tx";
      const atomicExempt =
        sanctionedLifecycleSink ||
        isNewPrivateProjectInsert ||
        nullProjectChatInsert ||
        reviewedParentLockedIntentSink ||
        reviewedProjectTransactionHelper;

      if (sink.table === "projects") {
        const writesLifecycleEpoch =
          sink.kind === "raw-sql"
            ? sqlHasAll(sink.node, ["lifecycle_epoch"])
            : setColumnsForUpdateSink(sink).includes("lifecycleEpoch");
        if (writesLifecycleEpoch && !sanctionedLifecycleSink) {
          report(
            "UNSANCTIONED_LIFECYCLE_EPOCH_WRITE",
            `${owner.name} writes lifecycleEpoch outside the sole manageDemo lifecycle exception`,
            file,
            sink.node,
          );
        }
      }

      if (!atomicExempt) {
        const atomicViolation = atomicSinkViolation(parsedFile, sink);
        if (atomicViolation === "PROJECT_WRITE_NOT_ATOMIC") {
          report(
            atomicViolation,
            `${sink.kind}(${sink.table}) in ${owner.name} is not inside a withProjectWrite(s) callback`,
            file,
            sink.node,
          );
        } else if (atomicViolation === "PROJECT_WRITE_BYPASSES_TRANSACTION") {
          report(
            atomicViolation,
            `${sink.kind}(${sink.table}) in ${owner.name} must use the withProjectWrite(s) transaction handle`,
            file,
            sink.node,
          );
        }
      }
    }
  }
}

async function validateDemoResolverCoverage(files) {
  const classifiedFiles = new Set([
    ...MUTATION_SURFACES.flatMap((surface) => [
      surface.routeFile,
      ...surface.checks.map(([file]) => file),
    ]),
    ...PUBLIC_DEMO_SURFACES.flatMap((surface) => [
      surface.routeFile,
      ...surface.sources,
    ]),
    ...PUBLIC_DEMO_SHARED_DEPENDENCIES.map(
      (dependency) => dependency.sourceFile,
    ),
    ...DEMO_RESOLVER_SHARED_DEPENDENCIES.map(
      (dependency) => dependency.sourceFile,
    ),
    ...LIFECYCLE_EXCEPTIONS.map((exception) => exception.sourceFile),
  ]);

  for (const file of files) {
    const parsedFile = await parsed(file);
    const markers = [];
    for (const object of descendants(
      parsedFile.source,
      ts.isObjectLiteralExpression,
    )) {
      const prop = objectProperty(object, "allowDemo");
      if (
        prop &&
        ts.isPropertyAssignment(prop) &&
        literalValue(prop.initializer) === true
      )
        markers.push(prop);
    }
    for (const call of descendants(parsedFile.source, ts.isCallExpression)) {
      if (callName(call) !== "eq" || call.arguments.length < 2) continue;
      const left = unwrapExpression(call.arguments[0]);
      if (
        ts.isPropertyAccessExpression(left) &&
        propertyName(left.expression) === "projects" &&
        left.name.text === "isDemo" &&
        literalValue(call.arguments[1]) === true
      ) {
        markers.push(call);
      }
    }
    for (const tagged of descendants(
      parsedFile.source,
      ts.isTaggedTemplateExpression,
    )) {
      if (sqlHasAll(tagged, ["is_demo", "true"])) markers.push(tagged);
    }
    if (markers.length > 0 && !classifiedFiles.has(file)) {
      report(
        "UNCLASSIFIED_DEMO_RESOLVER",
        `${file} contains a demo-public resolver/query but is absent from the public/mutation manifest`,
        file,
        markers[0],
      );
    }
  }
}

/**
 * Canonical project roots are private. This pin deliberately spans application,
 * browser, external-provider, schema, and edge configuration so a future
 * convenience URL cannot silently restore the bucket-wide bearer surface.
 */
async function validateProjectAssetDeliveryPolicy() {
  const files = {
    route: "src/app/api/project-assets/[id]/[...asset]/route.ts",
    legacyThumbnailRoute: "src/app/api/projects/[id]/thumbnail/[page]/route.ts",
    service: "src/server/services/project-assets.ts",
    pages: "src/server/services/pages.ts",
    s3: "src/lib/s3.ts",
    projects: "src/server/services/projects.ts",
    processing: "src/lib/processing.ts",
    symbolSearch: "src/server/services/symbol-search.ts",
    labeling: "src/server/services/labeling.ts",
    viewer: "src/components/viewer/PDFViewer.tsx",
    page: "src/components/viewer/PDFPage.tsx",
    sidebar: "src/components/viewer/PageSidebar.tsx",
    session: "src/stores/sessionStore.ts",
    terraform: "infrastructure/terraform/s3.tf",
    transport: "src/lib/project-asset-transport.ts",
    uploadAuthority: "src/lib/project-upload-authority.ts",
    lifecycleMigration: "drizzle/0033_project_lifecycle_epoch_and_leases.sql",
    deletionMigration: "drizzle/0034_project_asset_deletion_outbox.sql",
  };
  const contents = Object.fromEntries(
    await Promise.all(
      Object.entries(files).map(async ([key, file]) => [
        key,
        await readFile(path.join(ROOT, file), "utf8"),
      ]),
    ),
  );

  const fail = (message, key = "service") =>
    report("PROJECT_ASSET_DELIVERY_DRIFT", message, files[key]);
  const publicSnapshotGate = terraformResourceBlock(
    contents.terraform,
    "aws_cloudfront_function",
    "beaver_public_snapshot_gate",
  );
  const cloudFrontDistribution = terraformResourceBlock(
    contents.terraform,
    "aws_cloudfront_distribution",
    "beaver",
  );
  const projectDataBucketPolicy = terraformResourceBlock(
    contents.terraform,
    "aws_s3_bucket_policy",
    "beaver_data",
  );
  const assetFence = "await assertCurrentProjectAssetRead(project);";
  const firstAssetFence = contents.service.indexOf(assetFence);
  const s3AssetRead = contents.service.indexOf(
    "object = await getS3ObjectStream",
  );
  const boundAssetBody = contents.service.indexOf(
    "const boundBody = requestBoundBody(",
  );
  const secondAssetFence = contents.service.indexOf(
    assetFence,
    firstAssetFence + assetFence.length,
  );
  const thirdAssetFence = contents.service.indexOf(
    assetFence,
    secondAssetFence + assetFence.length,
  );

  if (
    !textHasAll(contents.route, [
      'param: "id"',
      "allowDemo: true",
      'kind: "raw"',
      "serveProjectAsset",
      "withProjectAssetResponsePolicy",
    ])
  ) {
    fail(
      "asset route must use canonical tenant/demo resolution and raw delivery",
      "route",
    );
  }
  if (
    !textHasAll(contents.service, [
      'asset !== "original.pdf"',
      'asset !== "thumbnail.png"',
      "PAGE_ASSET_RE",
      "SINGLE_BYTE_RANGE_RE",
      "PROBE_CONTENT_RANGE_RE",
      "PDF_RANGE_PROBE_HEADER",
      "PDF_RANGE_PROBE_UPSTREAM_RANGE",
      "isPdfRangeProbe",
      "advertisedContentLength",
      "assertCurrentProjectAssetRead",
      '.for("share")',
      "isCanonicalProjectPath",
      "current.lifecycleEpoch !== project.lifecycleEpoch",
      '"admin-reprocess:thumbnails"',
      "getS3ObjectStream",
      "signal: req.signal",
      "req.signal.aborted",
      "status: 499",
      "requestBoundBody",
      "const boundBody = requestBoundBody(",
      "object.contentLength,",
      "object.bodySettled,",
      "new Response(boundBody.stream()",
      "Number.isSafeInteger(expectedLength)",
      "nextBytesRead === exactLength",
      "cancelUpstream(signal.reason)",
      "await cancelUpstream()",
      "upstreamSettled.catch(() => undefined)",
      ".catch(() => undefined)",
      "object.body.cancel()",
      '"Cache-Control": "private, no-store"',
      '"X-Content-Type-Options": "nosniff"',
      'asset === "original.pdf" ? "application/pdf" : "image/png"',
      '"Cookie, Authorization, Range, X-BlueprintParser-PDF-Range-Probe"',
      "requestedRange && object.contentRange ? 206 : 200",
    ]) ||
    firstAssetFence < 0 ||
    s3AssetRead < firstAssetFence ||
    boundAssetBody < s3AssetRead ||
    secondAssetFence < boundAssetBody ||
    thirdAssetFence >= 0 ||
    !hasCanonicalProjectAssetFinalization(contents.service) ||
    contents.service.includes("object.contentType") ||
    contents.service.includes("getS3Url") ||
    contents.service.includes("CLOUDFRONT_DOMAIN")
  ) {
    fail(
      "asset gateway allowlist, current admission, forced MIME, Range, all-outcome no-store, or private-S3 contract drifted",
    );
  }
  if (
    !textHasAll(contents.transport, [
      'PDF_RANGE_PROBE_HEADER = "x-blueprintparser-pdf-range-probe"',
      'PDF_RANGE_PROBE_VALUE = "1"',
      'PDF_RANGE_PROBE_UPSTREAM_RANGE = "bytes=0-0"',
    ]) ||
    !textHasAll(contents.viewer, [
      "[PDF_RANGE_PROBE_HEADER]: PDF_RANGE_PROBE_VALUE",
    ])
  ) {
    fail(
      "pdf.js must mark its capability probe so the gateway bounds the upstream S3 read",
      "transport",
    );
  }
  if (
    !textHasAll(contents.legacyThumbnailRoute, [
      "getPageThumbnail",
      "withProjectAssetResponsePolicy",
    ]) ||
    !textHasAll(contents.pages, [
      "getPageThumbnail",
      "assertCurrentProjectAssetRead(project)",
      '"Cache-Control": "private, no-store"',
    ])
  ) {
    fail(
      "legacy thumbnail alias must delegate to the same current-row and all-outcome response policy",
      "legacyThumbnailRoute",
    );
  }
  if (
    contents.s3.includes("export function getS3Url") ||
    contents.s3.includes("warmCloudFrontCache") ||
    !textHasAll(contents.s3, [
      "getS3ObjectStream",
      "signal?: AbortSignal",
      "abortSignal: options.signal",
      "transformToWebStream",
    ])
  ) {
    fail(
      "S3 must expose streaming private reads, not generic project CDN URL builders",
      "s3",
    );
  }
  if (
    !textHasAll(contents.projects, [
      "projectAssetBaseUrl(project.publicId)",
      'projectAssetUrl(project.publicId, "original.pdf")',
      'projectAssetUrl(p.publicId, "thumbnail.png")',
      '"Cache-Control", "private, no-store"',
      '"Cache-Control", "public, no-store"',
    ])
  ) {
    fail(
      "project metadata/gallery must publish opaque same-origin asset URLs with no-store",
      "projects",
    );
  }
  if (
    contents.processing.includes("getS3Url") ||
    contents.processing.includes("warmCloudFrontCache") ||
    !contents.processing.includes("downloadFromS3(originalKey)")
  ) {
    fail(
      "processing must read canonical assets with task-role S3 authority",
      "processing",
    );
  }
  if (
    contents.symbolSearch.includes("getS3Url") ||
    !contents.symbolSearch.includes(
      "downloadFromS3(`${project.dataUrl}/original.pdf`)",
    )
  ) {
    fail(
      "symbol search must not fetch a canonical project through the public edge",
      "symbolSearch",
    );
  }
  if (
    contents.labeling.includes("getS3Url") ||
    contents.labeling.includes("getPresignedGetUrl") ||
    !textHasAll(contents.labeling, [
      "canonicalPageAsset(pageNumber)",
      "requireVersionedSource(sourceKey)",
      "copyS3ObjectVersion",
      "uploadS3VersionedSnapshot",
      "labelStudioAssetUrl(grant.id, grant.token)",
      "activateLabelStudioAssetGrants",
      "revokeIntentLabelStudioAssetGrants",
      "revokeSessionLabelStudioAssetGrants",
    ])
  ) {
    fail(
      "Label Studio tasks must use canonical immutable snapshots and revocable application grant URLs, never S3/CDN presigns",
      "labeling",
    );
  }

  for (const key of ["viewer", "page", "sidebar", "session"]) {
    if (
      contents[key].includes("NEXT_PUBLIC_CLOUDFRONT_DOMAIN") ||
      contents[key].includes("NEXT_PUBLIC_S3_BUCKET") ||
      contents[key].includes("dataUrl") ||
      !contents[key].includes("assetBaseUrl")
    ) {
      fail(
        "browser project assets must use only the opaque same-origin assetBaseUrl",
        key,
      );
    }
  }

  if (
    !textHasAll(contents.viewer, [
      "PDFDocumentLoadingTask",
      "disableStream: true",
      "disableAutoFetch: true",
      "rangeChunkSize: 1024 * 1024",
      "loadingTask.destroy()",
    ]) ||
    contents.viewer.includes("rangeChunkSize: 65536")
  ) {
    fail(
      "PDF transport must use cancellable bounded gateway ranges rather than a whole-document stream",
      "viewer",
    );
  }

  if (
    !textHasAll(publicSnapshotGate, [
      'comment = "Deny every viewer request; project assets use the application gateway"',
      "statusCode: 404",
      '"cache-control": { value: "private, no-store" }',
    ]) ||
    !textHasAll(cloudFrontDistribution, [
      'event_type   = "viewer-request"',
      "aws_cloudfront_function.beaver_public_snapshot_gate.arn",
    ]) ||
    !textHasAll(projectDataBucketPolicy, [
      'Resource = "${aws_s3_bucket.beaver_data.arn}/models/*"',
      'Resource = "${aws_s3_bucket.beaver_data.arn}/_bp-staging/*"',
      'Resource = "${aws_s3_bucket.beaver_data.arn}/tmp/*"',
      'Resource = "${aws_s3_bucket.beaver_data.arn}/config/*"',
      'Resource = "${aws_s3_bucket.beaver_data.arn}/csi-databases/*"',
    ]) ||
    publicSnapshotGate.includes("return event.request") ||
    projectDataBucketPolicy.includes('Effect = "Allow"') ||
    projectDataBucketPolicy.includes('Sid    = "AllowCloudFrontOAC"') ||
    projectDataBucketPolicy.includes(
      'Resource = "${aws_s3_bucket.beaver_data.arn}/*"',
    ) ||
    projectDataBucketPolicy.includes(
      'Resource = "${aws_s3_bucket.beaver_data.arn}/_bp-public/*"',
    )
  ) {
    fail(
      "CloudFront must deny every viewer request and its OAC must have no S3 read Allow",
      "terraform",
    );
  }
  if (
    !textHasAll(contents.uploadAuthority, [
      'PROJECT_UPLOAD_STAGING_ROOT = "_bp-staging"',
      '"_bp-public"',
      "RESERVED_STORAGE_ROOTS",
      "isSafeCompanyDataKey",
    ]) ||
    (contents.lifecycleMigration.match(/'_bp-public'/g) ?? []).length !== 3 ||
    !contents.deletionMigration.includes("'_bp-public'")
  ) {
    fail(
      "the future public prefix must remain reserved from tenant roots and deletion tombstones",
      "uploadAuthority",
    );
  }
}

const productionScriptFiles = await walk("scripts");
const productionFiles = [
  ...(await walk("src")),
  ...productionScriptFiles,
].filter(
  (file) => file !== "src/lib/db/seed.ts" && !file.startsWith("src/test/"),
);

await validateCheckerRegressionFixtures();
await validateManifestShape();
await validateMutationRouteBindings();
await validateDemoClassificationContracts();
await validateMutationPolicies();
await validateInternalSinks();
await validatePublicPolicies();
await validateDemoRouteCoverage();
await validateCrossTenantAndCapabilitySemantics();
const schemaOwnership = await validateSchemaDerivedOwnership();
await validateLeaseFoundation();
await validateProjectUploadAuthority(productionFiles);
await validateModelStorageAuthority(productionFiles);
await validateQuiescentProjectDelete();
await validateProjectAssetDeletionProtocol(productionFiles);
await validateProcessingStartIntent();
await validateLabelStudioCredentialTombstone();
await validateLabelStudioProviderBindingPolicy();
await validateLabelStudioProjectIntentProtocol();
await validateLabelStudioAssetGrantProtocol();
await validateLabelStudioAccessLogSecretPolicy();
await validateLabelStudioAssetRatePolicy();
await validateMiddlewareRateLimitIdentityPolicy();
await validateEdgeClientIpPolicy();
await validateProviderJobStatusAuthorities();
await validateLabelingExternalAuthority();
await validateTriggerInventory();
await validateCanonicalDbErrorMapping();
await validateRootAndJwtAuthority();
await validateDurableMutationDomains(productionFiles);
await validateExemptProjectFkWrites(productionFiles);
await validateWriteCoverage(productionFiles, schemaOwnership.protectedTables);
await validateDemoResolverCoverage(productionFiles);
await validateProjectAssetDeliveryPolicy();

violations.sort(
  (a, b) =>
    a.location.localeCompare(b.location) ||
    a.code.localeCompare(b.code) ||
    a.message.localeCompare(b.message),
);

if (violations.length > 0) {
  console.error(
    `Project security policy check failed with ${violations.length} violation(s):`,
  );
  for (const violation of violations) {
    console.error(
      `- [${violation.code}] ${violation.location} — ${violation.message}`,
    );
  }
  process.exitCode = 1;
} else {
  console.log("Project security policy check passed.");
}
