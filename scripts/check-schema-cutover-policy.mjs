#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { load as loadYaml } from "js-yaml";
import ts from "typescript";

const files = Object.fromEntries(
  await Promise.all(
    [
      "Dockerfile",
      ".dockerignore",
      ".github/workflows/ci.yml",
      "CONTRIBUTING.md",
      "README.md",
      "deploy.sh",
      "ecs-tune.sh",
      "entrypoint.sh",
      "install_setup.sh",
      "infrastructure/terraform/ecr.tf",
      "infrastructure/terraform/ecs.tf",
      "infrastructure/terraform/backend.hcl.example",
      "infrastructure/terraform/iam.tf",
      "infrastructure/terraform/main.tf",
      "infrastructure/terraform/project-asset-deletions.tf",
      "infrastructure/terraform/rds.tf",
      "infrastructure/terraform/s3.tf",
      "infrastructure/terraform/secrets.tf",
      "infrastructure/terraform/stepfunctions.tf",
      "infrastructure/terraform/variables.tf",
      "package.json",
      "root_admin.sh",
      "scripts/create-local-root-admin.mjs",
      "scripts/cost-control.sh",
      "scripts/database-tls.mjs",
      "scripts/lib/ecs-schema-tools.sh",
      "scripts/p2-schema-cutover.sh",
      "scripts/assert-schema-current.mjs",
      "scripts/assert-schema-migration-ready.mjs",
      "scripts/run-local-drizzle-command.mjs",
      "scripts/run-schema-migrations.mjs",
      "scripts/schema-migration-contract.mjs",
      "scripts/setup.sh",
      "src/lib/db/index.ts",
      "src/lib/yolo.ts",
      "src/lib/yolo-instances.ts",
      "src/server/services/yolo-instance.ts",
      "drizzle/0033_project_lifecycle_epoch_and_leases.sql",
    ].map(async (file) => [file, await readFile(file, "utf8")]),
  ),
);

const repositorySourceExtensions = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".sh",
  ".ts",
  ".tsx",
]);
const ignoredRepositoryDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "performance-results",
  "playwright-report",
  "test-results",
]);

async function repositorySourcePaths(directory = ".") {
  const paths = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const relative =
      directory === "." ? entry.name : join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredRepositoryDirectories.has(entry.name)) {
        paths.push(...(await repositorySourcePaths(relative)));
      }
    } else if (
      entry.isFile() &&
      repositorySourceExtensions.has(extname(entry.name))
    ) {
      paths.push(relative);
    }
  }
  return paths;
}

const repositorySources = Object.fromEntries(
  await Promise.all(
    (await repositorySourcePaths())
      .sort()
      .map(async (file) => [file, await readFile(file, "utf8")]),
  ),
);

const violations = [];
function report(file, invariant, detail) {
  violations.push(`${file}: ${invariant}; ${detail}`);
}

function hclTokens(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === "\n") {
      tokens.push({ type: "newline", value: "\n" });
      index += 1;
      continue;
    }
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "#" || source.startsWith("//", index)) {
      index = source.indexOf("\n", index);
      if (index < 0) break;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      const comment = source.slice(index, end < 0 ? source.length : end + 2);
      for (const match of comment.matchAll(/\n/gu)) {
        tokens.push({ type: "newline", value: match[0] });
      }
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (character === '"') {
      let value = "";
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\" && index + 1 < source.length) {
          value += source.slice(index, index + 2);
          index += 2;
        } else if (source[index] === '"') {
          index += 1;
          break;
        } else {
          value += source[index];
          index += 1;
        }
      }
      tokens.push({ type: "string", value });
      continue;
    }
    if (source.startsWith("<<", index)) {
      const header = source
        .slice(index)
        .match(/^<<(-?)([A-Za-z_][A-Za-z0-9_]*)[^\n]*\n/u);
      if (header) {
        const allowIndent = header[1] === "-";
        const delimiter = header[2];
        const contentStart = index + header[0].length;
        const terminator = new RegExp(
          `^${allowIndent ? "[ \\t]*" : ""}${delimiter}[ \\t]*$`,
          "mu",
        );
        const remainder = source.slice(contentStart);
        const match = terminator.exec(remainder);
        const contentEnd = match ? contentStart + match.index : source.length;
        tokens.push({
          type: "string",
          value: source.slice(contentStart, contentEnd),
        });
        index = match
          ? contentStart + match.index + match[0].length
          : source.length;
        continue;
      }
    }
    if (/[A-Za-z0-9_$!./:@*?+<>|-]/u.test(character)) {
      const start = index;
      while (
        index < source.length &&
        /[A-Za-z0-9_$!./:@*?+<>|-]/u.test(source[index])
      ) {
        index += 1;
      }
      tokens.push({ type: "word", value: source.slice(start, index) });
      continue;
    }
    tokens.push({ type: "symbol", value: character });
    index += 1;
  }
  return tokens;
}

function nextHclToken(tokens, index) {
  let next = index;
  while (tokens[next]?.type === "newline") next += 1;
  return next;
}

function hclBlocks(source) {
  const tokens = hclTokens(source);
  const blocks = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== "word") continue;
    let cursor = nextHclToken(tokens, index + 1);
    const labels = [];
    while (tokens[cursor]?.type === "string") {
      labels.push(tokens[cursor].value);
      cursor = nextHclToken(tokens, cursor + 1);
    }
    if (tokens[cursor]?.value !== "{") continue;

    let depth = 1;
    let close = cursor + 1;
    while (close < tokens.length && depth > 0) {
      if (tokens[close].value === "{") depth += 1;
      if (tokens[close].value === "}") depth -= 1;
      close += 1;
    }
    if (depth === 0) {
      blocks.push({
        type: tokens[index].value,
        labels,
        open: cursor,
        close: close - 1,
        tokens,
      });
    }
  }
  return blocks;
}

function findHclBlocks(file, type, labels, within) {
  return hclBlocks(files[file]).filter(
    (block) =>
      block.type === type &&
      block.labels.length === labels.length &&
      block.labels.every((label, index) => label === labels[index]) &&
      (!within || (block.open > within.open && block.close < within.close)),
  );
}

function directHclAssignments(block, name) {
  const assignments = [];
  const { tokens } = block;
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  for (let index = block.open + 1; index < block.close; index += 1) {
    const token = tokens[index];
    if (token.value === "{") braces += 1;
    else if (token.value === "}") braces -= 1;
    else if (token.value === "[") brackets += 1;
    else if (token.value === "]") brackets -= 1;
    else if (token.value === "(") parentheses += 1;
    else if (token.value === ")") parentheses -= 1;
    if (
      braces !== 0 ||
      brackets !== 0 ||
      parentheses !== 0 ||
      token.type !== "word" ||
      token.value !== name
    ) {
      continue;
    }
    const equals = nextHclToken(tokens, index + 1);
    if (tokens[equals]?.value !== "=") continue;

    const value = [];
    let valueBraces = 0;
    let valueBrackets = 0;
    let valueParentheses = 0;
    for (let cursor = equals + 1; cursor < block.close; cursor += 1) {
      const current = tokens[cursor];
      if (
        current.type === "newline" &&
        valueBraces === 0 &&
        valueBrackets === 0 &&
        valueParentheses === 0
      ) {
        break;
      }
      if (current.value === "{") valueBraces += 1;
      else if (current.value === "}") valueBraces -= 1;
      else if (current.value === "[") valueBrackets += 1;
      else if (current.value === "]") valueBrackets -= 1;
      else if (current.value === "(") valueParentheses += 1;
      else if (current.value === ")") valueParentheses -= 1;
      if (current.type !== "newline") value.push(current);
    }
    assignments.push(value);
  }
  return assignments;
}

function requireHclBlock(file, type, labels, invariant) {
  const blocks = findHclBlocks(file, type, labels);
  if (blocks.length !== 1) {
    report(
      file,
      invariant,
      `expected one ${type} ${labels.join(" ")} block, found ${blocks.length}`,
    );
    return null;
  }
  return blocks[0];
}

function requireHclStringAssignment(file, block, name, expected, invariant) {
  if (!block) return;
  const assignments = directHclAssignments(block, name);
  if (
    assignments.length !== 1 ||
    assignments[0].length !== 1 ||
    assignments[0][0].type !== "string" ||
    assignments[0][0].value !== expected
  ) {
    report(
      file,
      invariant,
      `${name} must be the exact string ${JSON.stringify(expected)}`,
    );
  }
}

function requireHclWordAssignment(file, block, name, expected, invariant) {
  if (!block) return;
  const assignments = directHclAssignments(block, name);
  if (
    assignments.length !== 1 ||
    assignments[0].length !== 1 ||
    assignments[0][0].type !== "word" ||
    assignments[0][0].value !== expected
  ) {
    report(file, invariant, `${name} must be the exact expression ${expected}`);
  }
}

function requireHclExpressionAssignment(
  file,
  block,
  name,
  expected,
  invariant,
) {
  if (!block) return;
  const assignments = directHclAssignments(block, name);
  if (
    assignments.length !== 1 ||
    assignments[0].length !== expected.length ||
    assignments[0].some(
      (token, index) =>
        token.type !== expected[index][0] || token.value !== expected[index][1],
    )
  ) {
    report(
      file,
      invariant,
      `${name} does not match its required exact expression`,
    );
  }
}

function requireNestedHclBlock(file, parent, type, invariant) {
  if (!parent) return null;
  const blocks = findHclBlocks(file, type, [], parent);
  if (blocks.length !== 1) {
    report(
      file,
      invariant,
      `expected one ${type} block inside ${parent.type} ${parent.labels.join(" ")}, found ${blocks.length}`,
    );
    return null;
  }
  return blocks[0];
}

function hclBlockContainsSequence(block, expected) {
  if (!block) return false;
  const tokens = block.tokens
    .slice(block.open + 1, block.close)
    .filter((token) => token.type !== "newline");
  return tokens.some((_, start) =>
    expected.every(
      ([type, value], offset) =>
        tokens[start + offset]?.type === type &&
        tokens[start + offset]?.value === value,
    ),
  );
}

function requireHclRegexValidation(file, block, pattern, variable, invariant) {
  if (!block) return;
  const validations = findHclBlocks(file, "validation", [], block);
  if (validations.length !== 1) {
    report(
      file,
      invariant,
      `expected one validation block, found ${validations.length}`,
    );
    return;
  }
  const conditions = directHclAssignments(validations[0], "condition");
  const expected = [
    ["word", "can"],
    ["symbol", "("],
    ["word", "regex"],
    ["symbol", "("],
    ["string", pattern],
    ["symbol", ","],
    ["word", `var.${variable}`],
    ["symbol", ")"],
    ["symbol", ")"],
  ];
  if (
    conditions.length !== 1 ||
    conditions[0].length !== expected.length ||
    conditions[0].some(
      (token, index) =>
        token.type !== expected[index][0] || token.value !== expected[index][1],
    )
  ) {
    report(
      file,
      invariant,
      `${variable} must use its exact digest-only regex validation condition`,
    );
  }
}

function requireNestedHclLabeledBlock(file, parent, type, labels, invariant) {
  if (!parent) return null;
  const blocks = findHclBlocks(file, type, labels, parent);
  if (blocks.length !== 1) {
    report(
      file,
      invariant,
      `expected one ${type} ${labels.join(" ")} block inside ${parent.type} ${parent.labels.join(" ")}, found ${blocks.length}`,
    );
    return null;
  }
  return blocks[0];
}

function descendants(node, predicate) {
  const matches = [];
  const visit = (current) => {
    if (predicate(current)) matches.push(current);
    current.forEachChild(visit);
  };
  visit(node);
  return matches;
}

function tsPropertyName(name) {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

function requireTsProperty(file, object, name, invariant) {
  if (!object || !ts.isObjectLiteralExpression(object)) {
    report(file, invariant, `${name} must be inside an object literal`);
    return null;
  }
  if (object.properties.some(ts.isSpreadAssignment)) {
    report(file, invariant, `${name} may not be shadowed by an object spread`);
  }
  const namedProperties = object.properties.filter(
    (property) => "name" in property && tsPropertyName(property.name) === name,
  );
  if (namedProperties.length !== 1) {
    report(
      file,
      invariant,
      `expected one structural ${name} property, found ${namedProperties.length}`,
    );
    return null;
  }
  if (ts.isPropertyAssignment(namedProperties[0])) {
    return namedProperties[0].initializer;
  }
  if (ts.isShorthandPropertyAssignment(namedProperties[0])) {
    return namedProperties[0].name;
  }
  report(file, invariant, `${name} must be a data property`);
  return null;
}

function compactTsText(node, sourceFile) {
  return node?.getText(sourceFile).replace(/\s+/gu, "") ?? "";
}

function requireTsCompactText(
  file,
  node,
  sourceFile,
  expected,
  invariant,
  detail,
) {
  if (!node || compactTsText(node, sourceFile) !== expected) {
    report(file, invariant, detail);
  }
}

function shellLogicalLines(source) {
  const lines = [];
  let logical = "";
  let quote = null;
  let heredoc = null;
  const physicalLines = source.replaceAll("\r\n", "\n").split("\n");

  for (const physical of physicalLines) {
    if (heredoc) {
      if (new RegExp(`^[ \\t]*${heredoc}[ \\t]*$`, "u").test(physical)) {
        heredoc = null;
      }
      continue;
    }

    let escaped = false;
    let pendingHeredoc = null;
    for (let index = 0; index < physical.length; index += 1) {
      const character = physical[index];
      if (quote === "'") {
        logical += character;
        if (character === "'") quote = null;
        continue;
      }
      if (quote === '"') {
        logical += character;
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quote = null;
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        logical += character;
        continue;
      }
      const previous = index === 0 ? "" : physical[index - 1];
      if (character === "#" && (index === 0 || /[\s;|&()]/u.test(previous))) {
        break;
      }
      if (physical.startsWith("<<", index)) {
        const match = physical
          .slice(index)
          .match(/^<<-?[ \\t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/u);
        if (match) pendingHeredoc = match[2];
      }
      logical += character;
    }

    if (quote) {
      logical += "\n";
      continue;
    }
    if (/(?<!\\)\\[ \\t]*$/u.test(logical)) {
      logical = logical.replace(/\\[ \\t]*$/u, " ");
      continue;
    }
    const trimmed = logical.trim();
    if (trimmed) lines.push(trimmed.replace(/\s+/gu, " "));
    logical = "";
    if (pendingHeredoc) heredoc = pendingHeredoc;
  }
  if (logical.trim()) lines.push(logical.trim().replace(/\s+/gu, " "));
  return lines;
}

function shellFunction(lines, name) {
  const start = lines.findIndex((line) =>
    new RegExp(`^${name}\\(\\)[ \\t]*\\{$`, "u").test(line),
  );
  if (start < 0) return null;
  let depth = 1;
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    let quote = null;
    let escaped = false;
    for (const character of line) {
      if (quote === "'") {
        if (character === "'") quote = null;
      } else if (quote === '"') {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quote = null;
      } else if (character === "'" || character === '"') quote = character;
      else if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
    }
    if (depth === 0) return body;
    body.push(line);
  }
  return null;
}

function shellSingleQuotedNodePrograms(file) {
  const source = files[file];
  const programs = [];
  const marker = "node -e '";
  let cursor = 0;
  while (cursor < source.length) {
    const invocation = source.indexOf(marker, cursor);
    if (invocation < 0) break;
    const start = invocation + marker.length;
    // A literal single quote cannot occur inside a shell single-quoted
    // argument, so the next quote is the program delimiter rather than data.
    const end = source.indexOf("'", start);
    if (end < 0) break;
    const text = source.slice(start, end);
    programs.push(
      ts.createSourceFile(
        `${file}.node-e-${programs.length}.js`,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      ),
    );
    cursor = end + 1;
  }
  return programs;
}

function tsVariableInitializer(sourceFile, name) {
  const declarations = descendants(
    sourceFile,
    (node) =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name,
  );
  return declarations.length === 1 ? declarations[0].initializer : null;
}

function regexTestReceivers(programs, argument) {
  const matches = [];
  for (const program of programs) {
    for (const call of descendants(
      program,
      (node) =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "test" &&
        node.arguments.length === 1,
    )) {
      if (compactTsText(call.arguments[0], program) === argument) {
        matches.push({
          program,
          receiver: call.expression.expression,
        });
      }
    }
  }
  return matches;
}

function shellCaseBranches(lines, selector) {
  const start = lines.findIndex((line) => line === `case ${selector} in`);
  if (start < 0) return null;
  const branches = new Map();
  let active = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "esac") return branches;
    if (!active) {
      const header = line.match(/^([^()]+)\)[ \\t]*(.*)$/u);
      if (!header) continue;
      active = header[1].trim();
      branches.set(active, []);
      if (header[2] && header[2] !== ";;") {
        branches.get(active).push(header[2].replace(/[ \\t]*;;$/u, ""));
      }
      if (header[2].endsWith(";;")) active = null;
      continue;
    }
    if (line === ";;") {
      active = null;
    } else if (line.endsWith(";;")) {
      branches.get(active).push(line.replace(/[ \\t]*;;$/u, ""));
      active = null;
    } else {
      branches.get(active).push(line);
    }
  }
  return null;
}

function yamlRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function enabledWorkflowStep(step) {
  const record = yamlRecord(step);
  return Boolean(
    record &&
    record.if === undefined &&
    record["continue-on-error"] === undefined,
  );
}

function exactRunStep(steps, command) {
  return steps.find(
    (step) =>
      enabledWorkflowStep(step) &&
      typeof step.run === "string" &&
      step.run.trim() === command,
  );
}

function exactActionStep(steps, action) {
  return steps.find(
    (step) => enabledWorkflowStep(step) && step.uses === action,
  );
}

function workflowDatabaseUrl(value, pathname) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
      url.port !== "5432" ||
      url.pathname !== pathname ||
      !url.username ||
      !url.password
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function requireAll(file, values, invariant) {
  const missing = values.filter((value) => !files[file].includes(value));
  if (missing.length > 0) {
    violations.push(`${file}: ${invariant}; missing ${missing.join(", ")}`);
  }
}
function forbid(file, values, invariant) {
  const found = values.filter((value) => files[file].includes(value));
  if (found.length > 0) {
    violations.push(`${file}: ${invariant}; found ${found.join(", ")}`);
  }
}
function requireOccurrences(file, value, expected, invariant) {
  const actual = files[file].split(value).length - 1;
  if (actual !== expected) {
    violations.push(
      `${file}: ${invariant}; expected ${expected} occurrences of ${value}, found ${actual}`,
    );
  }
}
function requirePattern(file, pattern, invariant) {
  if (!pattern.test(files[file])) {
    violations.push(`${file}: ${invariant}; missing ${pattern}`);
  }
}

const terraformAuthorityInvariant =
  "Terraform state coordinates must remain partial and the provider must be account-pinned";
const terraformConfiguration = requireHclBlock(
  "infrastructure/terraform/main.tf",
  "terraform",
  [],
  terraformAuthorityInvariant,
);
const partialS3Backend = requireNestedHclLabeledBlock(
  "infrastructure/terraform/main.tf",
  terraformConfiguration,
  "backend",
  ["s3"],
  terraformAuthorityInvariant,
);
for (const coordinate of ["bucket", "key", "region", "dynamodb_table"]) {
  if (
    partialS3Backend &&
    directHclAssignments(partialS3Backend, coordinate).length > 0
  ) {
    report(
      "infrastructure/terraform/main.tf",
      terraformAuthorityInvariant,
      `the tracked backend block must not assign ${coordinate}`,
    );
  }
}
const awsProvider = requireHclBlock(
  "infrastructure/terraform/main.tf",
  "provider",
  ["aws"],
  terraformAuthorityInvariant,
);
requireHclExpressionAssignment(
  "infrastructure/terraform/main.tf",
  awsProvider,
  "allowed_account_ids",
  [
    ["symbol", "["],
    ["word", "var.account_id"],
    ["symbol", "]"],
  ],
  terraformAuthorityInvariant,
);
requireAll(
  "infrastructure/terraform/backend.hcl.example",
  [
    'bucket         = "CHANGEME-terraform-state-bucket"',
    'key            = "CHANGEME/terraform.tfstate"',
    'region         = "CHANGEME-region"',
    'dynamodb_table = "CHANGEME-terraform-lock-table"',
  ],
  "the tracked backend template must contain placeholders rather than deployment authority",
);

const databaseTlsInvariant =
  "production PostgreSQL clients must use the fixed AWS RDS trust bundle with server verification";
const tlsSource = ts.createSourceFile(
  "scripts/database-tls.mjs",
  files["scripts/database-tls.mjs"],
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const tlsPathDeclarations = descendants(
  tlsSource,
  (node) =>
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "AWS_RDS_CA_BUNDLE_PATH",
);
const tlsPath =
  tlsPathDeclarations.length === 1 ? tlsPathDeclarations[0].initializer : null;
if (
  !tlsPath ||
  !ts.isStringLiteral(tlsPath) ||
  tlsPath.text !== "/etc/ssl/certs/aws-rds-global-bundle.pem"
) {
  report(
    "scripts/database-tls.mjs",
    databaseTlsInvariant,
    "AWS_RDS_CA_BUNDLE_PATH must be the fixed image-owned path",
  );
}
const databaseUrlValidators = tlsSource.statements.filter(
  (statement) =>
    ts.isFunctionDeclaration(statement) &&
    statement.name?.text === "validateProductionDatabaseUrl",
);
const databaseUrlValidator =
  databaseUrlValidators.length === 1 ? databaseUrlValidators[0] : null;
if (!databaseUrlValidator?.body) {
  report(
    "scripts/database-tls.mjs",
    databaseTlsInvariant,
    "expected one validateProductionDatabaseUrl function",
  );
} else {
  const urlConstructors = descendants(
    databaseUrlValidator.body,
    (node) =>
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL",
  );
  requireTsCompactText(
    "scripts/database-tls.mjs",
    urlConstructors.length === 1 ? urlConstructors[0] : null,
    tlsSource,
    "newURL(value)",
    databaseTlsInvariant,
    "production DATABASE_URL must be parsed structurally",
  );
  const databaseNameDecoders = descendants(
    databaseUrlValidator.body,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "decodeURIComponent",
  );
  requireTsCompactText(
    "scripts/database-tls.mjs",
    databaseNameDecoders.length === 1 ? databaseNameDecoders[0] : null,
    tlsSource,
    "decodeURIComponent(url.pathname.slice(1))",
    databaseTlsInvariant,
    "the canonical database path must be decoded before validation",
  );
  const authorityConditions = databaseUrlValidator.body.statements.filter(
    ts.isIfStatement,
  );
  requireTsCompactText(
    "scripts/database-tls.mjs",
    authorityConditions.length === 1 ? authorityConditions[0].expression : null,
    tlsSource,
    'url.protocol!=="postgresql:"||url.username===""||url.password===""||url.hostname===""||url.port!=="5432"||!/^\\/[^/]+$/u.test(url.pathname)||databaseName===""||databaseName.includes("/")||url.search!==""||url.hash!==""',
    databaseTlsInvariant,
    "production DATABASE_URL must have exact protocol, authority, port, path, and no override channels",
  );
}
const tlsFunctions = tlsSource.statements.filter(
  (statement) =>
    ts.isFunctionDeclaration(statement) &&
    statement.name?.text === "databaseTlsOptions",
);
const tlsFunction = tlsFunctions.length === 1 ? tlsFunctions[0] : null;
if (!tlsFunction?.body) {
  report(
    "scripts/database-tls.mjs",
    databaseTlsInvariant,
    "expected one databaseTlsOptions function",
  );
} else {
  requireTsCompactText(
    "scripts/database-tls.mjs",
    tlsFunction.body.statements[0],
    tlsSource,
    'if(env.NODE_ENV!=="production")returnundefined;',
    databaseTlsInvariant,
    "only non-production runtimes may omit TLS options",
  );
  requireTsCompactText(
    "scripts/database-tls.mjs",
    tlsFunction.body.statements[1],
    tlsSource,
    "validateProductionDatabaseUrl(env.DATABASE_URL);",
    databaseTlsInvariant,
    "production DATABASE_URL authority must be validated before the CA is read",
  );
  const caDeclarations = descendants(
    tlsFunction.body,
    (node) =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "ca",
  );
  const caRead =
    caDeclarations.length === 1 ? caDeclarations[0].initializer : null;
  requireTsCompactText(
    "scripts/database-tls.mjs",
    caRead,
    tlsSource,
    'readTrustedBundle(AWS_RDS_CA_BUNDLE_PATH,"utf8")',
    databaseTlsInvariant,
    "the trusted bundle read must use only the fixed code-owned path",
  );
  const environmentReads = descendants(
    tlsFunction.body,
    (node) =>
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "env",
  ).map((node) => compactTsText(node, tlsSource));
  if (
    environmentReads.length !== 2 ||
    environmentReads[0] !== "env.NODE_ENV" ||
    environmentReads[1] !== "env.DATABASE_URL"
  ) {
    report(
      "scripts/database-tls.mjs",
      databaseTlsInvariant,
      "only NODE_ENV and the structurally validated DATABASE_URL may influence production TLS",
    );
  }
  const tlsReturns = descendants(
    tlsFunction.body,
    (node) =>
      ts.isReturnStatement(node) &&
      Boolean(node.expression) &&
      ts.isObjectLiteralExpression(node.expression),
  );
  const tlsOptions = tlsReturns.length === 1 ? tlsReturns[0].expression : null;
  const ca = requireTsProperty(
    "scripts/database-tls.mjs",
    tlsOptions,
    "ca",
    databaseTlsInvariant,
  );
  const rejectUnauthorized = requireTsProperty(
    "scripts/database-tls.mjs",
    tlsOptions,
    "rejectUnauthorized",
    databaseTlsInvariant,
  );
  requireTsCompactText(
    "scripts/database-tls.mjs",
    ca,
    tlsSource,
    "ca",
    databaseTlsInvariant,
    "production TLS must return the validated cached AWS CA",
  );
  requireTsCompactText(
    "scripts/database-tls.mjs",
    rejectUnauthorized,
    tlsSource,
    "true",
    databaseTlsInvariant,
    "production TLS must set rejectUnauthorized to true",
  );
  if (
    !tlsOptions ||
    !ts.isObjectLiteralExpression(tlsOptions) ||
    tlsOptions.properties.length !== 2
  ) {
    report(
      "scripts/database-tls.mjs",
      databaseTlsInvariant,
      "production TLS options must contain only ca and rejectUnauthorized",
    );
  }
}

function repositoryScriptKind(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".ts")) return ts.ScriptKind.TS;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function isTestDatabaseSource(file) {
  return (
    file.startsWith("e2e/") ||
    file.startsWith("src/test/") ||
    file.includes("/__tests__/") ||
    /(?:^|\/)[^/]+\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(file)
  );
}

function sourceLoadsPg(sourceFile) {
  return (
    descendants(
      sourceFile,
      (node) =>
        (ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === "pg") ||
        (ts.isCallExpression(node) &&
          node.arguments.length === 1 &&
          ts.isStringLiteral(node.arguments[0]) &&
          node.arguments[0].text === "pg" &&
          ((ts.isIdentifier(node.expression) &&
            node.expression.text === "require") ||
            node.expression.kind === ts.SyntaxKind.ImportKeyword)),
    ).length > 0
  );
}

function pgClientConstructors(sourceFile) {
  if (!sourceLoadsPg(sourceFile)) return [];
  return descendants(
    sourceFile,
    (node) =>
      ts.isNewExpression(node) &&
      ((ts.isIdentifier(node.expression) &&
        ["Client", "Pool"].includes(node.expression.text)) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ["Client", "Pool"].includes(node.expression.name.text))),
  );
}

function importsDatabaseTlsOptions(sourceFile) {
  return sourceFile.statements.filter(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      (statement.moduleSpecifier.text === "./database-tls.mjs" ||
        /(?:^|\/)scripts\/database-tls\.mjs$/u.test(
          statement.moduleSpecifier.text,
        )) &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) => element.name.text === "databaseTlsOptions",
      ),
  );
}

const localDatabaseClientSources = new Set([
  "scripts/create-local-root-admin.mjs",
  "src/lib/db/seed.ts",
]);
for (const [file, source] of Object.entries(repositorySources)) {
  if (file.endsWith(".sh") || isTestDatabaseSource(file)) continue;
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    repositoryScriptKind(file),
  );
  const clients = pgClientConstructors(sourceFile);
  if (clients.length === 0) continue;

  if (localDatabaseClientSources.has(file)) {
    const localAuthorityCalls = descendants(
      sourceFile,
      (node) =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "assertLocalSchemaMutationTarget" &&
        node.arguments.length === 0,
    );
    if (
      localAuthorityCalls.length !== 1 ||
      clients.some((client) => localAuthorityCalls[0].pos > client.pos)
    ) {
      report(
        file,
        databaseTlsInvariant,
        "the exact local-only authority check must precede every pg client",
      );
    }
    continue;
  }

  if (importsDatabaseTlsOptions(sourceFile).length !== 1) {
    report(
      file,
      databaseTlsInvariant,
      "every production pg client source must import the shared TLS authority",
    );
  }
  for (const client of clients) {
    const config =
      client.arguments?.length === 1 &&
      ts.isObjectLiteralExpression(client.arguments[0])
        ? client.arguments[0]
        : null;
    const connectionString = requireTsProperty(
      file,
      config,
      "connectionString",
      databaseTlsInvariant,
    );
    const ssl = requireTsProperty(file, config, "ssl", databaseTlsInvariant);
    requireTsCompactText(
      file,
      connectionString,
      sourceFile,
      "process.env.DATABASE_URL",
      databaseTlsInvariant,
      "production pg clients must use the DATABASE_URL validated by the TLS helper",
    );
    requireTsCompactText(
      file,
      ssl,
      sourceFile,
      "databaseTlsOptions()",
      databaseTlsInvariant,
      "production pg clients must use databaseTlsOptions()",
    );
  }
  if (
    descendants(
      sourceFile,
      (node) =>
        ts.isPropertyAssignment(node) &&
        tsPropertyName(node.name) === "rejectUnauthorized" &&
        node.initializer.kind === ts.SyntaxKind.FalseKeyword,
    ).length > 0
  ) {
    report(
      file,
      databaseTlsInvariant,
      "rejectUnauthorized: false is forbidden",
    );
  }
}

for (const [file, source] of Object.entries(repositorySources)) {
  if (
    !file.endsWith(".sh") ||
    !/new\s+(?:Client|Pool)\s*\(/u.test(source) ||
    ["install_setup.sh", "root_admin.sh"].includes(file)
  ) {
    continue;
  }
  report(
    file,
    databaseTlsInvariant,
    "shell-embedded pg clients require an explicit reviewed structural policy",
  );
}
requireOccurrences(
  "install_setup.sh",
  "new Pool",
  1,
  "the installer may retain only its exact local read-only health client",
);
requireAll(
  "install_setup.sh",
  [
    'BP_HEALTH_DATABASE_URL="$CFG_DATABASE_URL" node -e',
    "new Pool({connectionString:process.env.BP_HEALTH_DATABASE_URL})",
    "SELECT count(*) as c FROM information_schema.tables WHERE table_schema=" +
      `${String.fromCharCode(92).repeat(2)}'public${String.fromCharCode(92).repeat(2)}'`,
  ],
  "the installer pg exception must remain the exact local metadata health check",
);

const rootAdminInvariant =
  "root_admin must expose only its reviewed menu, remote SQL, and canonical service authority";
const rootAdminSource = files["root_admin.sh"];
const remoteRootAdminStart = rootAdminSource.indexOf("(async()=>{");
const remoteRootAdminEndMarker =
  "})().catch(error=>{console.error('Operation failed:',error.message);process.exit(1);});";
const remoteRootAdminEnd = rootAdminSource.indexOf(
  remoteRootAdminEndMarker,
  remoteRootAdminStart,
);
const remoteRootAdminCode =
  remoteRootAdminStart >= 0 && remoteRootAdminEnd >= 0
    ? rootAdminSource.slice(
        remoteRootAdminStart,
        remoteRootAdminEnd + remoteRootAdminEndMarker.length,
      )
    : "";
const remoteRootAdmin = ts.createSourceFile(
  "root_admin.remote.js",
  remoteRootAdminCode,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
if (
  remoteRootAdminStart < 0 ||
  remoteRootAdminEnd < 0 ||
  remoteRootAdmin.parseDiagnostics.length > 0
) {
  report(
    "root_admin.sh",
    rootAdminInvariant,
    "the sole embedded remote JavaScript program is missing or malformed",
  );
}

function frozenObjectLiteral(node) {
  return node &&
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Object" &&
    node.expression.name.text === "freeze" &&
    node.arguments.length === 1 &&
    ts.isObjectLiteralExpression(node.arguments[0])
    ? node.arguments[0]
    : null;
}

const operationDeclarations = descendants(
  remoteRootAdmin,
  (node) =>
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "operations",
);
const operationsObject =
  operationDeclarations.length === 1
    ? frozenObjectLiteral(operationDeclarations[0].initializer)
    : null;
const operationProperties =
  operationsObject?.properties.filter(ts.isPropertyAssignment) ?? [];
const operationNames = operationProperties.map((property) =>
  tsPropertyName(property.name),
);
if (
  !operationsObject ||
  operationProperties.length !== 3 ||
  operationNames.join(",") !== "list,promote,demote"
) {
  report(
    "root_admin.sh",
    rootAdminInvariant,
    "the remote operation allowlist must be exactly list, promote, demote",
  );
}
const parameterMarker = `${String.fromCharCode(92)}$1`;
const requiredRootAdminOperations = new Map([
  [
    "list",
    {
      mutation: "false",
      text: "SELECT email, is_root_admin FROM public.users ORDER BY lower(email), email",
      values: "[]",
    },
  ],
  [
    "promote",
    {
      mutation: "true",
      text: `UPDATE public.users SET is_root_admin = true WHERE email = ${parameterMarker} AND is_root_admin = false RETURNING email, is_root_admin`,
      values: "[email]",
    },
  ],
  [
    "demote",
    {
      mutation: "true",
      text: `UPDATE public.users AS target SET is_root_admin = false WHERE target.email = ${parameterMarker} AND target.is_root_admin = true AND EXISTS (SELECT 1 FROM public.users AS other WHERE other.is_root_admin = true AND other.id <> target.id) RETURNING target.email, target.is_root_admin`,
      values: "[email]",
    },
  ],
]);
for (const property of operationProperties) {
  const name = tsPropertyName(property.name);
  const expected = requiredRootAdminOperations.get(name);
  const spec = frozenObjectLiteral(property.initializer);
  const textValue = requireTsProperty(
    "root_admin.sh",
    spec,
    "text",
    rootAdminInvariant,
  );
  const valuesValue = requireTsProperty(
    "root_admin.sh",
    spec,
    "values",
    rootAdminInvariant,
  );
  const mutationValue = requireTsProperty(
    "root_admin.sh",
    spec,
    "mutation",
    rootAdminInvariant,
  );
  if (
    !expected ||
    !textValue ||
    !ts.isStringLiteral(textValue) ||
    textValue.text !== expected.text ||
    compactTsText(valuesValue, remoteRootAdmin) !== expected.values ||
    compactTsText(mutationValue, remoteRootAdmin) !== expected.mutation ||
    spec?.properties.length !== 3
  ) {
    report(
      "root_admin.sh",
      rootAdminInvariant,
      `${name ?? "unknown"} must retain its exact SQL, values, and mutation shape`,
    );
  }
}
const remoteQueries = descendants(
  remoteRootAdmin,
  (node) =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "client" &&
    node.expression.name.text === "query",
).map((query) => compactTsText(query, remoteRootAdmin));
const exactRemoteQueries = [
  "client.query('BEGIN')",
  "client.query('SELECTpg_catalog.pg_advisory_xact_lock(737375864)')",
  "client.query(spec.text,spec.values)",
  "client.query('COMMIT')",
  "client.query('ROLLBACK')",
];
if (
  remoteQueries.length !== exactRemoteQueries.length ||
  remoteQueries.some((query, index) => query !== exactRemoteQueries[index])
) {
  report(
    "root_admin.sh",
    rootAdminInvariant,
    "remote client.query calls must be exactly BEGIN, advisory lock, allowlisted operation, COMMIT, ROLLBACK",
  );
}
const remotePools = pgClientConstructors(remoteRootAdmin);
const remotePoolConfig =
  remotePools.length === 1 &&
  remotePools[0].arguments?.length === 1 &&
  ts.isObjectLiteralExpression(remotePools[0].arguments[0])
    ? remotePools[0].arguments[0]
    : null;
requireTsCompactText(
  "root_admin.sh",
  requireTsProperty(
    "root_admin.sh",
    remotePoolConfig,
    "connectionString",
    rootAdminInvariant,
  ),
  remoteRootAdmin,
  "process.env.DATABASE_URL",
  rootAdminInvariant,
  "the remote Pool must use the validated DATABASE_URL",
);
requireTsCompactText(
  "root_admin.sh",
  requireTsProperty(
    "root_admin.sh",
    remotePoolConfig,
    "ssl",
    rootAdminInvariant,
  ),
  remoteRootAdmin,
  "databaseTlsOptions(process.env)",
  rootAdminInvariant,
  "the remote Pool must pass its complete environment to databaseTlsOptions",
);
const rootAdminProtectionConditions = descendants(
  remoteRootAdmin,
  ts.isIfStatement,
).map((statement) => compactTsText(statement.expression, remoteRootAdmin));
if (
  !rootAdminProtectionConditions.includes(
    "operation==='demote'&&bootstrapEmail!==''&&bootstrapEmail.toLowerCase()===email.trim().toLowerCase()",
  )
) {
  report(
    "root_admin.sh",
    rootAdminInvariant,
    "remote demotion must refuse the configured ROOT_ADMIN_EMAIL identity",
  );
}

const rootAdminLines = shellLogicalLines(rootAdminSource);
const rootAdminMenu = shellCaseBranches(rootAdminLines, '"${choice}"');
const rootAdminOperationCase = shellCaseBranches(
  rootAdminLines,
  '"${operation}"',
);
if (
  !rootAdminMenu ||
  [...rootAdminMenu.keys()].join(",") !== "1,2,3,4,q|Q,*" ||
  rootAdminMenu.get("1")?.[0] !== "list_users" ||
  rootAdminMenu.get("2")?.[0] !== "promote_user" ||
  rootAdminMenu.get("3")?.[0] !== "demote_user" ||
  rootAdminMenu.get("4")?.[0] !== "show_root_email_setup"
) {
  report(
    "root_admin.sh",
    rootAdminInvariant,
    "the executable menu must expose only the four reviewed choices and quit",
  );
}
if (
  !rootAdminOperationCase ||
  [...rootAdminOperationCase.keys()].join(",") !== "list,promote|demote,*"
) {
  report(
    "root_admin.sh",
    rootAdminInvariant,
    "run_fixed_operation must accept only list, promote, and demote",
  );
}
const verifiedTaskFunction = shellFunction(rootAdminLines, "verified_task_arn");
const verifiedTaskOrder = [
  "assert_caller_account || return 1",
  "service_task_definition=$(canonical_service_task_definition) || return 1",
  'assert_service_task_definition_contract "${service_task_definition}" || return 1',
  "task_arn=$(single_running_service_task) || return 1",
  'assert_task_belongs_to_service "${task_arn}" "${service_task_definition}" || return 1',
].map((command) => verifiedTaskFunction?.indexOf(command) ?? -1);
if (
  verifiedTaskOrder.some((index) => index < 0) ||
  verifiedTaskOrder.some(
    (index, position) =>
      position > 0 && index <= verifiedTaskOrder[position - 1],
  )
) {
  report(
    "root_admin.sh",
    rootAdminInvariant,
    "caller, service revision, task contract, task selection, and membership checks must stay ordered",
  );
}
requireAll(
  "root_admin.sh",
  [
    'source "${SCRIPT_DIR}/scripts/lib/ecs-schema-tools.sh"',
    'bp_assert_task_definition_contract "${task_definition}" app',
    'bp_task_definition_image "${task_definition}"',
    'bp_assert_database_secret_identity "${database_selector}"',
    'image_prefix="${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com/${CANONICAL_ECR_REPO}@"',
    'bp_validate_digest "${digest}"',
  ],
  "root_admin must verify the exact live app revision, digest, and database secret before task selection",
);
if (
  descendants(
    tlsSource,
    (node) =>
      ts.isPropertyAssignment(node) &&
      tsPropertyName(node.name) === "rejectUnauthorized" &&
      node.initializer.kind === ts.SyntaxKind.FalseKeyword,
  ).length > 0
) {
  report(
    "scripts/database-tls.mjs",
    databaseTlsInvariant,
    "rejectUnauthorized: false is forbidden",
  );
}

const dockerInstructions = shellLogicalLines(files.Dockerfile);
const rdsCaStage = dockerInstructions.findIndex(
  (line) => line === "FROM alpine:3.21 AS rds-ca",
);
const nextStageAfterRdsCa = dockerInstructions.findIndex(
  (line, index) => index > rdsCaStage && line.startsWith("FROM "),
);
const runnerStage = dockerInstructions.findIndex((line) =>
  / AS runner$/u.test(line),
);
const rdsBundleInstalls = dockerInstructions
  .map((line, index) => [line, index])
  .filter(
    ([line, index]) =>
      index > rdsCaStage &&
      index < nextStageAfterRdsCa &&
      line.startsWith("RUN apk add --no-cache ca-certificates curl && curl ") &&
      line.includes(
        "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem",
      ) &&
      line.includes("--output /aws-rds-global-bundle.pem") &&
      line.includes("-----BEGIN CERTIFICATE-----") &&
      line.includes("-----END CERTIFICATE-----") &&
      line.endsWith("chmod 0444 /aws-rds-global-bundle.pem"),
  );
const runnerBundleCopies = dockerInstructions.filter(
  (line, index) =>
    index > runnerStage &&
    line ===
      "COPY --from=rds-ca /aws-rds-global-bundle.pem /etc/ssl/certs/aws-rds-global-bundle.pem",
);
if (
  rdsCaStage < 0 ||
  nextStageAfterRdsCa < 0 ||
  runnerStage < 0 ||
  rdsBundleInstalls.length !== 1 ||
  runnerBundleCopies.length !== 1
) {
  report(
    "Dockerfile",
    databaseTlsInvariant,
    "the runner must install and validate the official global RDS bundle at the fixed path",
  );
}
const rdsParameterGroup = requireHclBlock(
  "infrastructure/terraform/rds.tf",
  "resource",
  ["aws_db_parameter_group", "beaver"],
  databaseTlsInvariant,
);
const forceSslParameters = rdsParameterGroup
  ? findHclBlocks(
      "infrastructure/terraform/rds.tf",
      "parameter",
      [],
      rdsParameterGroup,
    ).filter((block) => {
      const names = directHclAssignments(block, "name");
      return (
        names.length === 1 &&
        names[0].length === 1 &&
        names[0][0].type === "string" &&
        names[0][0].value === "rds.force_ssl"
      );
    })
  : [];
const forceSslParameter =
  forceSslParameters.length === 1 ? forceSslParameters[0] : null;
if (!forceSslParameter) {
  report(
    "infrastructure/terraform/rds.tf",
    databaseTlsInvariant,
    "expected one rds.force_ssl parameter",
  );
}
requireHclStringAssignment(
  "infrastructure/terraform/rds.tf",
  forceSslParameter,
  "value",
  "1",
  databaseTlsInvariant,
);
const databaseInstance = requireHclBlock(
  "infrastructure/terraform/rds.tf",
  "resource",
  ["aws_db_instance", "beaver"],
  databaseTlsInvariant,
);
requireHclWordAssignment(
  "infrastructure/terraform/rds.tf",
  databaseInstance,
  "parameter_group_name",
  "aws_db_parameter_group.beaver.name",
  databaseTlsInvariant,
);

const terraformVariablesInvariant =
  "the writer image must be digest-only and the maintenance launcher must have a disable switch";
const appDigestVariable = requireHclBlock(
  "infrastructure/terraform/variables.tf",
  "variable",
  ["beaver_app_image_digest"],
  terraformVariablesInvariant,
);
requireHclWordAssignment(
  "infrastructure/terraform/variables.tf",
  appDigestVariable,
  "type",
  "string",
  terraformVariablesInvariant,
);
requireHclRegexValidation(
  "infrastructure/terraform/variables.tf",
  appDigestVariable,
  "^sha256:[0-9a-f]{64}$",
  "beaver_app_image_digest",
  terraformVariablesInvariant,
);
const yoloDigestVariable = requireHclBlock(
  "infrastructure/terraform/variables.tf",
  "variable",
  ["beaver_yolo_image_digest"],
  terraformVariablesInvariant,
);
requireHclWordAssignment(
  "infrastructure/terraform/variables.tf",
  yoloDigestVariable,
  "type",
  "string",
  terraformVariablesInvariant,
);
requireHclRegexValidation(
  "infrastructure/terraform/variables.tf",
  yoloDigestVariable,
  "^sha256:[0-9a-f]{64}$",
  "beaver_yolo_image_digest",
  terraformVariablesInvariant,
);
const terraformAccountInvariant =
  "Terraform must require a validated deployment account and pin the AWS provider to it";
const awsAccountVariable = requireHclBlock(
  "infrastructure/terraform/variables.tf",
  "variable",
  ["account_id"],
  terraformAccountInvariant,
);
requireHclWordAssignment(
  "infrastructure/terraform/variables.tf",
  awsAccountVariable,
  "type",
  "string",
  terraformAccountInvariant,
);
requireHclRegexValidation(
  "infrastructure/terraform/variables.tf",
  awsAccountVariable,
  "^[0-9]{12}$",
  "account_id",
  terraformAccountInvariant,
);
if (
  awsAccountVariable &&
  directHclAssignments(awsAccountVariable, "default").length > 0
) {
  report(
    "infrastructure/terraform/variables.tf",
    terraformAccountInvariant,
    "account_id must remain required and may not have a tracked default",
  );
}
if (
  findHclBlocks("infrastructure/terraform/variables.tf", "variable", [
    "aws_account_id",
  ]).length > 0
) {
  report(
    "infrastructure/terraform/variables.tf",
    terraformAccountInvariant,
    "account_id must remain the sole deployment account authority",
  );
}
for (const variable of [
  "ecs_autoscaling_enabled",
  "maintenance_worker_schedule_enabled",
]) {
  const block = requireHclBlock(
    "infrastructure/terraform/variables.tf",
    "variable",
    [variable],
    terraformVariablesInvariant,
  );
  requireHclWordAssignment(
    "infrastructure/terraform/variables.tf",
    block,
    "type",
    "bool",
    terraformVariablesInvariant,
  );
}
const labelStudioImageVariable = requireHclBlock(
  "infrastructure/terraform/variables.tf",
  "variable",
  ["label_studio_image"],
  terraformVariablesInvariant,
);
requireHclWordAssignment(
  "infrastructure/terraform/variables.tf",
  labelStudioImageVariable,
  "type",
  "string",
  terraformVariablesInvariant,
);
requireHclRegexValidation(
  "infrastructure/terraform/variables.tf",
  labelStudioImageVariable,
  "^heartexlabs/label-studio@sha256:[0-9a-f]{64}$",
  "label_studio_image",
  terraformVariablesInvariant,
);

const ecrImmutabilityInvariant =
  "the application and YOLO repositories must reject tag replacement";
const applicationRepository = requireHclBlock(
  "infrastructure/terraform/ecr.tf",
  "resource",
  ["aws_ecr_repository", "beaver_app"],
  ecrImmutabilityInvariant,
);
requireHclStringAssignment(
  "infrastructure/terraform/ecr.tf",
  applicationRepository,
  "image_tag_mutability",
  "IMMUTABLE",
  ecrImmutabilityInvariant,
);
const yoloRepository = requireHclBlock(
  "infrastructure/terraform/ecr.tf",
  "resource",
  ["aws_ecr_repository", "beaver_yolo_pipeline"],
  ecrImmutabilityInvariant,
);
requireHclStringAssignment(
  "infrastructure/terraform/ecr.tf",
  yoloRepository,
  "image_tag_mutability",
  "IMMUTABLE",
  ecrImmutabilityInvariant,
);

const cloudFrontCutoverInvariant =
  "the data-bucket policy must wait for an unconditional deployed viewer-request 404 gate";
const publicSnapshotGate = requireHclBlock(
  "infrastructure/terraform/s3.tf",
  "resource",
  ["aws_cloudfront_function", "beaver_public_snapshot_gate"],
  cloudFrontCutoverInvariant,
);
requireHclStringAssignment(
  "infrastructure/terraform/s3.tf",
  publicSnapshotGate,
  "runtime",
  "cloudfront-js-2.0",
  cloudFrontCutoverInvariant,
);
requireHclWordAssignment(
  "infrastructure/terraform/s3.tf",
  publicSnapshotGate,
  "publish",
  "true",
  cloudFrontCutoverInvariant,
);
const gateCodeAssignments = publicSnapshotGate
  ? directHclAssignments(publicSnapshotGate, "code")
  : [];
if (
  gateCodeAssignments.length !== 1 ||
  gateCodeAssignments[0].length !== 1 ||
  gateCodeAssignments[0][0].type !== "string"
) {
  report(
    "infrastructure/terraform/s3.tf",
    cloudFrontCutoverInvariant,
    "the gate must have one structural JavaScript code assignment",
  );
} else {
  const gateSource = ts.createSourceFile(
    "beaver-public-snapshot-gate.js",
    gateCodeAssignments[0][0].value,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const handlers = gateSource.statements.filter(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "handler",
  );
  const handler = handlers.length === 1 ? handlers[0] : null;
  const returnStatement =
    handler?.body?.statements.length === 1 &&
    ts.isReturnStatement(handler.body.statements[0])
      ? handler.body.statements[0]
      : null;
  const response = returnStatement?.expression;
  const statusCode = requireTsProperty(
    "infrastructure/terraform/s3.tf",
    response,
    "statusCode",
    cloudFrontCutoverInvariant,
  );
  const body = requireTsProperty(
    "infrastructure/terraform/s3.tf",
    response,
    "body",
    cloudFrontCutoverInvariant,
  );
  const headers = requireTsProperty(
    "infrastructure/terraform/s3.tf",
    response,
    "headers",
    cloudFrontCutoverInvariant,
  );
  const cacheControl = requireTsProperty(
    "infrastructure/terraform/s3.tf",
    headers,
    "cache-control",
    cloudFrontCutoverInvariant,
  );
  const cacheControlValue = requireTsProperty(
    "infrastructure/terraform/s3.tf",
    cacheControl,
    "value",
    cloudFrontCutoverInvariant,
  );
  if (gateSource.statements.length !== 1 || !handler || !returnStatement) {
    report(
      "infrastructure/terraform/s3.tf",
      cloudFrontCutoverInvariant,
      "handler must contain only the unconditional deny response",
    );
  }
  if (
    !statusCode ||
    !ts.isNumericLiteral(statusCode) ||
    statusCode.text !== "404"
  ) {
    report(
      "infrastructure/terraform/s3.tf",
      cloudFrontCutoverInvariant,
      "handler statusCode must be the numeric literal 404",
    );
  }
  if (!body || !ts.isStringLiteral(body) || body.text !== "Not found") {
    report(
      "infrastructure/terraform/s3.tf",
      cloudFrontCutoverInvariant,
      "handler body must be the fixed Not found response",
    );
  }
  if (
    !cacheControlValue ||
    !ts.isStringLiteral(cacheControlValue) ||
    cacheControlValue.text !== "private, no-store"
  ) {
    report(
      "infrastructure/terraform/s3.tf",
      cloudFrontCutoverInvariant,
      "handler must emit private, no-store",
    );
  }
}
const cloudFrontDistribution = requireHclBlock(
  "infrastructure/terraform/s3.tf",
  "resource",
  ["aws_cloudfront_distribution", "beaver"],
  cloudFrontCutoverInvariant,
);
const defaultCacheBehavior = requireNestedHclBlock(
  "infrastructure/terraform/s3.tf",
  cloudFrontDistribution,
  "default_cache_behavior",
  cloudFrontCutoverInvariant,
);
const viewerGateAssociation = requireNestedHclBlock(
  "infrastructure/terraform/s3.tf",
  defaultCacheBehavior,
  "function_association",
  cloudFrontCutoverInvariant,
);
requireHclStringAssignment(
  "infrastructure/terraform/s3.tf",
  viewerGateAssociation,
  "event_type",
  "viewer-request",
  cloudFrontCutoverInvariant,
);
requireHclWordAssignment(
  "infrastructure/terraform/s3.tf",
  viewerGateAssociation,
  "function_arn",
  "aws_cloudfront_function.beaver_public_snapshot_gate.arn",
  cloudFrontCutoverInvariant,
);
const dataBucketPolicy = requireHclBlock(
  "infrastructure/terraform/s3.tf",
  "resource",
  ["aws_s3_bucket_policy", "beaver_data"],
  cloudFrontCutoverInvariant,
);
requireHclExpressionAssignment(
  "infrastructure/terraform/s3.tf",
  dataBucketPolicy,
  "depends_on",
  [
    ["symbol", "["],
    ["word", "aws_cloudfront_distribution.beaver"],
    ["symbol", "]"],
  ],
  cloudFrontCutoverInvariant,
);
requireAll(
  "README.md",
  [
    "First private CloudFront cutover (owner-run once)",
    "apply only `aws_cloudfront_function.beaver_public_snapshot_gate` and `aws_cloudfront_distribution.beaver`",
    "`aws_s3_bucket_policy.beaver_data` is absent from that apply",
    "distribution status is `Deployed`",
    "HTTP 404 with no asset bytes",
    "`/*` CloudFront invalidation",
    "full Terraform plan/apply",
    "Never add a reopen/public flag",
  ],
  "the owner runbook must preserve the one-time gate-first cutover sequence",
);

const yoloRuntimeInvariant =
  "YOLO jobs must use canonical account-owned resources, an immutable image, and isolated bounded processing";
const yoloSource = ts.createSourceFile(
  "src/lib/yolo.ts",
  files["src/lib/yolo.ts"],
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const yoloFunctions = (name) =>
  yoloSource.statements.filter(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
const authorityFunctions = yoloFunctions("assertYoloRuntimeAuthority");
const authorityFunction =
  authorityFunctions.length === 1 ? authorityFunctions[0] : null;
if (!authorityFunction?.body) {
  report(
    "src/lib/yolo.ts",
    yoloRuntimeInvariant,
    "expected one assertYoloRuntimeAuthority function",
  );
} else {
  if (descendants(authorityFunction.body, ts.isReturnStatement).length > 0) {
    report(
      "src/lib/yolo.ts",
      yoloRuntimeInvariant,
      "runtime authority may not contain an early-return bypass",
    );
  }
  const authorityConditions = new Map(
    authorityFunction.body.statements
      .filter(ts.isIfStatement)
      .map((statement) => [
        compactTsText(statement.expression, yoloSource),
        statement,
      ]),
  );
  for (const condition of [
    "!account||!/^[0-9]{12}$/.test(account)",
    "!region||!/^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$/.test(region)",
    "!ECR_IMAGE||!expectedImage.test(ECR_IMAGE)",
    "SAGEMAKER_ROLE!==`arn:aws:iam::${account}:role/beaver-sagemaker-role`",
    "S3_BUCKET!==`beaver-data-${account}`",
  ]) {
    const statement = authorityConditions.get(condition);
    if (
      !statement ||
      descendants(statement.thenStatement, ts.isThrowStatement).length !== 1
    ) {
      report(
        "src/lib/yolo.ts",
        yoloRuntimeInvariant,
        `missing throwing authority guard ${condition}`,
      );
    }
  }
  const expectedImageDeclarations = descendants(
    authorityFunction.body,
    (node) =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "expectedImage",
  );
  const expectedImage =
    expectedImageDeclarations.length === 1
      ? expectedImageDeclarations[0].initializer
      : null;
  const escapedRegexDot = String.fromCharCode(92).repeat(2);
  const canonicalImageExpression = [
    "newRegExp(`^${account}",
    escapedRegexDot,
    ".dkr",
    escapedRegexDot,
    ".ecr",
    escapedRegexDot,
    ".${region}",
    escapedRegexDot,
    ".amazonaws",
    escapedRegexDot,
    ".com/beaver-yolo-pipeline@sha256:[0-9a-f]{64}$`,)",
  ].join("");
  requireTsCompactText(
    "src/lib/yolo.ts",
    expectedImage,
    yoloSource,
    canonicalImageExpression,
    yoloRuntimeInvariant,
    "the accepted image must be the canonical account/region repository@sha256 form",
  );
}

const startYoloFunctions = yoloFunctions("startYoloJob");
const startYoloFunction =
  startYoloFunctions.length === 1 ? startYoloFunctions[0] : null;
if (!startYoloFunction?.body) {
  report(
    "src/lib/yolo.ts",
    yoloRuntimeInvariant,
    "expected one startYoloJob function",
  );
} else {
  requireTsCompactText(
    "src/lib/yolo.ts",
    startYoloFunction.body.statements[0],
    yoloSource,
    "assertYoloRuntimeAuthority();",
    yoloRuntimeInvariant,
    "runtime authority must be the first executable job-start statement",
  );
  // [2026-10-21 owner ask] The instance type is root-selectable, but ONLY from the code allowlist:
  // the second statement reads it through readYoloInstanceType (lenient, default ml.g4dn.xlarge),
  // `instanceType` is bound nowhere else, and the allowlist/reader are frozen below.
  requireTsCompactText(
    "src/lib/yolo.ts",
    startYoloFunction.body.statements[1],
    yoloSource,
    "constinstanceType=awaitreadYoloInstanceType();",
    yoloRuntimeInvariant,
    "the instance type must be read once, right after the authority check, via readYoloInstanceType()",
  );
  const instanceTypeBindings = descendants(
    startYoloFunction,
    (node) =>
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "instanceType",
  );
  const instanceTypeWrites = descendants(
    startYoloFunction.body,
    (node) =>
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === "instanceType",
  );
  if (instanceTypeBindings.length !== 1 || instanceTypeWrites.length !== 0) {
    report(
      "src/lib/yolo.ts",
      yoloRuntimeInvariant,
      "instanceType must be bound exactly once in startYoloJob and never reassigned",
    );
  }
  const readerImports = yoloSource.statements.filter(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "@/server/services/yolo-instance" &&
      compactTsText(statement.importClause, yoloSource) === "{readYoloInstanceType}",
  );
  if (readerImports.length !== 1 || yoloFunctions("readYoloInstanceType").length !== 0) {
    report(
      "src/lib/yolo.ts",
      yoloRuntimeInvariant,
      "readYoloInstanceType must be the services/yolo-instance reader, imported once and not redefined",
    );
  }
  // [2026-10-22 owner: "ability to modify timeout time in the admin"] MaxRuntimeInSeconds is the
  // root-set app_settings value, read third through readYoloMaxRuntimeSeconds (bounded 900..86400,
  // default 3600 — frozen below), bound once and never reassigned.
  requireTsCompactText(
    "src/lib/yolo.ts",
    startYoloFunction.body.statements[2],
    yoloSource,
    "constmaxRuntimeSeconds=awaitreadYoloMaxRuntimeSeconds();",
    yoloRuntimeInvariant,
    "the job timeout must be read once, right after the instance type, via readYoloMaxRuntimeSeconds()",
  );
  const runtimeBindings = descendants(
    startYoloFunction,
    (node) =>
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "maxRuntimeSeconds",
  );
  const runtimeWrites = descendants(
    startYoloFunction.body,
    (node) =>
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === "maxRuntimeSeconds",
  );
  if (runtimeBindings.length !== 1 || runtimeWrites.length !== 0) {
    report(
      "src/lib/yolo.ts",
      yoloRuntimeInvariant,
      "maxRuntimeSeconds must be bound exactly once in startYoloJob and never reassigned",
    );
  }
  const runtimeReaderImports = yoloSource.statements.filter(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "@/server/services/yolo-instance" &&
      compactTsText(statement.importClause, yoloSource) === "{readYoloMaxRuntimeSeconds}",
  );
  if (runtimeReaderImports.length !== 1 || yoloFunctions("readYoloMaxRuntimeSeconds").length !== 0) {
    report(
      "src/lib/yolo.ts",
      yoloRuntimeInvariant,
      "readYoloMaxRuntimeSeconds must be the services/yolo-instance reader, imported once and not redefined",
    );
  }
  const commandDeclarations = descendants(
    startYoloFunction.body,
    (node) =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "command",
  );
  const commandExpression =
    commandDeclarations.length === 1
      ? commandDeclarations[0].initializer
      : null;
  const commandConfig =
    commandExpression &&
    ts.isNewExpression(commandExpression) &&
    ts.isIdentifier(commandExpression.expression) &&
    commandExpression.expression.text === "CreateProcessingJobCommand" &&
    commandExpression.arguments?.length === 1 &&
    ts.isObjectLiteralExpression(commandExpression.arguments[0])
      ? commandExpression.arguments[0]
      : null;
  if (!commandConfig) {
    report(
      "src/lib/yolo.ts",
      yoloRuntimeInvariant,
      "command must be the sole structural CreateProcessingJobCommand object",
    );
  }
  const sagemakerSends = descendants(
    startYoloFunction.body,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "sagemakerClient" &&
      node.expression.name.text === "send",
  );
  if (
    sagemakerSends.length !== 1 ||
    compactTsText(sagemakerSends[0], yoloSource) !==
      "sagemakerClient.send(command)"
  ) {
    report(
      "src/lib/yolo.ts",
      yoloRuntimeInvariant,
      "the canonical command must be the only SageMaker send",
    );
  }
  const processingResources = requireTsProperty(
    "src/lib/yolo.ts",
    commandConfig,
    "ProcessingResources",
    yoloRuntimeInvariant,
  );
  const clusterConfig = requireTsProperty(
    "src/lib/yolo.ts",
    processingResources,
    "ClusterConfig",
    yoloRuntimeInvariant,
  );
  const appSpecification = requireTsProperty(
    "src/lib/yolo.ts",
    commandConfig,
    "AppSpecification",
    yoloRuntimeInvariant,
  );
  const networkConfig = requireTsProperty(
    "src/lib/yolo.ts",
    commandConfig,
    "NetworkConfig",
    yoloRuntimeInvariant,
  );
  const stoppingCondition = requireTsProperty(
    "src/lib/yolo.ts",
    commandConfig,
    "StoppingCondition",
    yoloRuntimeInvariant,
  );
  for (const [parent, property, expected, detail] of [
    [clusterConfig, "InstanceCount", "1", "InstanceCount must remain 1"],
    [
      clusterConfig,
      "InstanceType",
      "instanceTypeasProcessingInstanceType",
      "InstanceType must come from the allowlisted readYoloInstanceType() setting",
    ],
    [clusterConfig, "VolumeSizeInGB", "30", "VolumeSizeInGB must remain 30"],
    [appSpecification, "ImageUri", "ECR_IMAGE", "ImageUri must use ECR_IMAGE"],
    [
      networkConfig,
      "EnableNetworkIsolation",
      "true",
      "EnableNetworkIsolation must be true",
    ],
    [
      stoppingCondition,
      "MaxRuntimeInSeconds",
      "maxRuntimeSeconds",
      "MaxRuntimeInSeconds must come from the bounded readYoloMaxRuntimeSeconds() setting",
    ],
    [
      commandConfig,
      "RoleArn",
      "SAGEMAKER_ROLE",
      "RoleArn must use SAGEMAKER_ROLE",
    ],
  ]) {
    const value = requireTsProperty(
      "src/lib/yolo.ts",
      parent,
      property,
      yoloRuntimeInvariant,
    );
    requireTsCompactText(
      "src/lib/yolo.ts",
      value,
      yoloSource,
      expected,
      yoloRuntimeInvariant,
      detail,
    );
  }
  const processingInputs = requireTsProperty(
    "src/lib/yolo.ts",
    commandConfig,
    "ProcessingInputs",
    yoloRuntimeInvariant,
  );
  const expectedInputs = [
    ["images", "`s3://${S3_BUCKET}/${projectDataUrl}/pages/`"],
    ["models", "`s3://${S3_BUCKET}/${modelS3Path}/`"],
  ];
  if (
    !processingInputs ||
    !ts.isArrayLiteralExpression(processingInputs) ||
    processingInputs.elements.length !== expectedInputs.length
  ) {
    report(
      "src/lib/yolo.ts",
      yoloRuntimeInvariant,
      "ProcessingInputs must contain exactly the canonical pages and model inputs",
    );
  } else {
    for (const [index, [name, s3Uri]] of expectedInputs.entries()) {
      const input = processingInputs.elements[index];
      const inputName = requireTsProperty(
        "src/lib/yolo.ts",
        input,
        "InputName",
        yoloRuntimeInvariant,
      );
      const s3Input = requireTsProperty(
        "src/lib/yolo.ts",
        input,
        "S3Input",
        yoloRuntimeInvariant,
      );
      const uri = requireTsProperty(
        "src/lib/yolo.ts",
        s3Input,
        "S3Uri",
        yoloRuntimeInvariant,
      );
      requireTsCompactText(
        "src/lib/yolo.ts",
        inputName,
        yoloSource,
        JSON.stringify(name),
        yoloRuntimeInvariant,
        `ProcessingInputs[${index}] must retain its canonical name`,
      );
      requireTsCompactText(
        "src/lib/yolo.ts",
        uri,
        yoloSource,
        s3Uri,
        yoloRuntimeInvariant,
        `ProcessingInputs[${index}] must retain its canonical S3 URI`,
      );
    }
  }
  const outputConfig = requireTsProperty(
    "src/lib/yolo.ts",
    commandConfig,
    "ProcessingOutputConfig",
    yoloRuntimeInvariant,
  );
  const outputs = requireTsProperty(
    "src/lib/yolo.ts",
    outputConfig,
    "Outputs",
    yoloRuntimeInvariant,
  );
  const output =
    outputs &&
    ts.isArrayLiteralExpression(outputs) &&
    outputs.elements.length === 1
      ? outputs.elements[0]
      : null;
  const s3Output = requireTsProperty(
    "src/lib/yolo.ts",
    output,
    "S3Output",
    yoloRuntimeInvariant,
  );
  const outputUri = requireTsProperty(
    "src/lib/yolo.ts",
    s3Output,
    "S3Uri",
    yoloRuntimeInvariant,
  );
  requireTsCompactText(
    "src/lib/yolo.ts",
    outputUri,
    yoloSource,
    "`s3://${S3_BUCKET}/${projectDataUrl}/yolo-output/${modelName}/`",
    yoloRuntimeInvariant,
    "the processing output must remain under the canonical project yolo-output prefix",
  );
}

// [2026-10-22 owner: "take full advantage of the larger GPU and its larger quota"] startYoloBatchJob
// starts ONE job for up to 9 projects. It must hold every invariant of startYoloJob (authority first,
// allowlisted instance, bounded timeout, one instance, 30 GB, the immutable image, network isolation,
// the canonical role, its own sole send), each project's input must be its canonical pages prefix,
// each output its canonical yolo-output prefix, and the model input the canonical model prefix. No
// other function in src/lib/yolo.ts may build a CreateProcessingJobCommand.
const batchYoloFunctions = yoloFunctions("startYoloBatchJob");
const batchYoloFunction = batchYoloFunctions.length === 1 ? batchYoloFunctions[0] : null;
if (!batchYoloFunction?.body) {
  report("src/lib/yolo.ts", yoloRuntimeInvariant, "expected one startYoloBatchJob function");
} else {
  for (const [index, expected, detail] of [
    [0, "assertYoloRuntimeAuthority();", "runtime authority must be the first statement of startYoloBatchJob"],
    [1, "constinstanceType=awaitreadYoloInstanceType();", "startYoloBatchJob must read the instance type second"],
    [2, "constmaxRuntimeSeconds=awaitreadYoloMaxRuntimeSeconds();", "startYoloBatchJob must read the timeout third"],
  ]) {
    requireTsCompactText("src/lib/yolo.ts", batchYoloFunction.body.statements[index], yoloSource, expected, yoloRuntimeInvariant, detail);
  }
  for (const name of ["instanceType", "maxRuntimeSeconds"]) {
    const bindings = descendants(
      batchYoloFunction,
      (node) => (ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name) && node.name.text === name,
    );
    const writes = descendants(
      batchYoloFunction.body,
      (node) =>
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        node.left.text === name,
    );
    if (bindings.length !== 1 || writes.length !== 0) {
      report("src/lib/yolo.ts", yoloRuntimeInvariant, `${name} must be bound exactly once in startYoloBatchJob and never reassigned`);
    }
  }
  const batchCommands = descendants(
    batchYoloFunction.body,
    (node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "command",
  );
  const batchExpression = batchCommands.length === 1 ? batchCommands[0].initializer : null;
  const batchConfig =
    batchExpression &&
    ts.isNewExpression(batchExpression) &&
    ts.isIdentifier(batchExpression.expression) &&
    batchExpression.expression.text === "CreateProcessingJobCommand" &&
    batchExpression.arguments?.length === 1 &&
    ts.isObjectLiteralExpression(batchExpression.arguments[0])
      ? batchExpression.arguments[0]
      : null;
  if (!batchConfig) {
    report("src/lib/yolo.ts", yoloRuntimeInvariant, "startYoloBatchJob's command must be the sole structural CreateProcessingJobCommand object");
  }
  const batchSends = descendants(
    batchYoloFunction.body,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "sagemakerClient" &&
      node.expression.name.text === "send",
  );
  if (batchSends.length !== 1 || compactTsText(batchSends[0], yoloSource) !== "sagemakerClient.send(command)") {
    report("src/lib/yolo.ts", yoloRuntimeInvariant, "startYoloBatchJob's canonical command must be its only SageMaker send");
  }
  const prop = (parent, name) => requireTsProperty("src/lib/yolo.ts", parent, name, yoloRuntimeInvariant);
  const cluster = prop(prop(batchConfig, "ProcessingResources"), "ClusterConfig");
  for (const [parent, property, expected, detail] of [
    [cluster, "InstanceCount", "1", "batch InstanceCount must remain 1"],
    [cluster, "InstanceType", "instanceTypeasProcessingInstanceType", "batch InstanceType must come from readYoloInstanceType()"],
    [cluster, "VolumeSizeInGB", "30", "batch VolumeSizeInGB must remain 30"],
    [prop(batchConfig, "AppSpecification"), "ImageUri", "ECR_IMAGE", "batch ImageUri must use ECR_IMAGE"],
    [prop(batchConfig, "NetworkConfig"), "EnableNetworkIsolation", "true", "batch EnableNetworkIsolation must be true"],
    [prop(batchConfig, "StoppingCondition"), "MaxRuntimeInSeconds", "maxRuntimeSeconds", "batch MaxRuntimeInSeconds must come from readYoloMaxRuntimeSeconds()"],
    [batchConfig, "RoleArn", "SAGEMAKER_ROLE", "batch RoleArn must use SAGEMAKER_ROLE"],
  ]) {
    requireTsCompactText("src/lib/yolo.ts", prop(parent, property), yoloSource, expected, yoloRuntimeInvariant, detail);
  }
  const batchInputs = prop(batchConfig, "ProcessingInputs");
  const inputElements = batchInputs && ts.isArrayLiteralExpression(batchInputs) ? batchInputs.elements : [];
  const spreadInputs = inputElements.length === 2 && ts.isSpreadElement(inputElements[0]) ? inputElements[0].expression : null;
  const modelInput = inputElements.length === 2 ? inputElements[1] : null;
  if (!spreadInputs || !modelInput) {
    report("src/lib/yolo.ts", yoloRuntimeInvariant, "batch ProcessingInputs must be the mapped project pages inputs followed by the model input");
  }
  const mapBody = (expr) =>
    expr &&
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    compactTsText(expr.expression, yoloSource) === "projectDataUrls.map" &&
    expr.arguments.length === 1 &&
    ts.isArrowFunction(expr.arguments[0]) &&
    ts.isParenthesizedExpression(expr.arguments[0].body) &&
    ts.isObjectLiteralExpression(expr.arguments[0].body.expression)
      ? expr.arguments[0].body.expression
      : null;
  const pagesInput = mapBody(spreadInputs);
  requireTsCompactText("src/lib/yolo.ts", prop(prop(pagesInput, "S3Input"), "S3Uri"), yoloSource,
    "`s3://${S3_BUCKET}/${dataUrl}/pages/`", yoloRuntimeInvariant, "each batch project input must be its canonical pages prefix");
  requireTsCompactText("src/lib/yolo.ts", prop(prop(modelInput, "S3Input"), "S3Uri"), yoloSource,
    "`s3://${S3_BUCKET}/${modelS3Path}/`", yoloRuntimeInvariant, "the batch model input must be the canonical model prefix");
  const batchOutput = mapBody(prop(prop(batchConfig, "ProcessingOutputConfig"), "Outputs"));
  requireTsCompactText("src/lib/yolo.ts", prop(prop(batchOutput, "S3Output"), "S3Uri"), yoloSource,
    "`s3://${S3_BUCKET}/${dataUrl}/yolo-output/${modelName}/`", yoloRuntimeInvariant,
    "each batch project output must remain under its canonical yolo-output prefix");
}
const processingJobCommands = descendants(
  yoloSource,
  (node) => ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "CreateProcessingJobCommand",
);
const commandOwners = processingJobCommands.map((node) => {
  let cursor = node.parent;
  while (cursor && !ts.isFunctionDeclaration(cursor)) cursor = cursor.parent;
  return cursor?.name?.text ?? "<module>";
});
if (commandOwners.some((owner) => owner !== "startYoloJob" && owner !== "startYoloBatchJob")) {
  report("src/lib/yolo.ts", yoloRuntimeInvariant, "only startYoloJob and startYoloBatchJob may build a CreateProcessingJobCommand");
}

// [2026-10-21; stage 2 2026-10-22, owner: "select any gpu that we have a quota for"] The YOLO instance
// allowlist bounds the hardware by FAMILY, not size: NVIDIA CUDA families (g4dn/g5/g6/g6e/p3/p4d/p5)
// for gpu() entries and plain m5/c5 for cpu() entries, any size; default ml.g4dn.xlarge. The run-path
// reader can only ever return an allowlisted type or that default, and the root-set timeout below
// (900..86400 s, default 3600) caps each job's billed time.
const yoloInstanceInvariant =
  "the YOLO instance type must come from the bounded code allowlist, defaulting to ml.g4dn.xlarge";
const yoloInstancesFile = "src/lib/yolo-instances.ts";
const yoloInstancesSource = ts.createSourceFile(
  yoloInstancesFile,
  files[yoloInstancesFile],
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const allowedYoloGpuInstance = /^ml\.(?:g4dn|g5|g6|g6e|p3|p4d|p5)\.(?:[1-9][0-9]?)?xlarge$/u;
const allowedYoloCpuInstance = /^ml\.(?:m5|c5)\.(?:[1-9][0-9]?)?xlarge$/u;
requireTsCompactText(
  yoloInstancesFile,
  tsVariableInitializer(yoloInstancesSource, "DEFAULT_YOLO_INSTANCE_TYPE"),
  yoloInstancesSource,
  '"ml.g4dn.xlarge"',
  yoloInstanceInvariant,
  "DEFAULT_YOLO_INSTANCE_TYPE must remain ml.g4dn.xlarge",
);
const yoloInstanceOptions = tsVariableInitializer(yoloInstancesSource, "YOLO_INSTANCE_OPTIONS");
if (
  !yoloInstanceOptions ||
  !ts.isArrayLiteralExpression(yoloInstanceOptions) ||
  yoloInstanceOptions.elements.length === 0 ||
  yoloInstanceOptions.elements.some(
    (element) =>
      !ts.isCallExpression(element) ||
      !ts.isIdentifier(element.expression) ||
      !["gpu", "cpu"].includes(element.expression.text) ||
      !element.arguments[0] ||
      !ts.isStringLiteral(element.arguments[0]) ||
      !(element.expression.text === "gpu" ? allowedYoloGpuInstance : allowedYoloCpuInstance).test(
        element.arguments[0].text,
      ),
  )
) {
  report(
    yoloInstancesFile,
    yoloInstanceInvariant,
    "YOLO_INSTANCE_OPTIONS must be a literal list of gpu() entries in g4dn/g5/g6/g6e/p3/p4d/p5 and cpu() entries in m5/c5",
  );
}
for (const [name, expected, detail] of [
  ["YOLO_INSTANCE_TYPES", "YOLO_INSTANCE_OPTIONS.map((o)=>o.type)", "YOLO_INSTANCE_TYPES must be derived from YOLO_INSTANCE_OPTIONS"],
]) {
  requireTsCompactText(
    yoloInstancesFile,
    tsVariableInitializer(yoloInstancesSource, name),
    yoloInstancesSource,
    expected,
    yoloInstanceInvariant,
    detail,
  );
}
const yoloInstanceFunction = (sourceFile, name) => {
  const found = sourceFile.statements.filter(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  return found.length === 1 ? found[0] : null;
};
requireTsCompactText(
  yoloInstancesFile,
  yoloInstanceFunction(yoloInstancesSource, "isYoloInstanceType")?.body,
  yoloInstancesSource,
  '{returntypeofvalue==="string"&&YOLO_INSTANCE_TYPES.includes(value);}',
  yoloInstanceInvariant,
  "isYoloInstanceType must accept exactly the allowlisted strings",
);
const resolveBody = compactTsText(
  yoloInstanceFunction(yoloInstancesSource, "resolveYoloInstanceSetting")?.body,
  yoloInstancesSource,
);
if (
  !resolveBody.endsWith(
    "returnisYoloInstanceType(raw)?{instanceType:raw,valid:true,raw}:{instanceType:DEFAULT_YOLO_INSTANCE_TYPE,valid:false,raw};}",
  ) ||
  (resolveBody.match(/return/gu) ?? []).length !== 1
) {
  report(
    yoloInstancesFile,
    yoloInstanceInvariant,
    "resolveYoloInstanceSetting may only return an allowlisted type or the default",
  );
}
const yoloInstanceServiceFile = "src/server/services/yolo-instance.ts";
const yoloInstanceServiceSource = ts.createSourceFile(
  yoloInstanceServiceFile,
  files[yoloInstanceServiceFile],
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const readerFunction = yoloInstanceFunction(yoloInstanceServiceSource, "readYoloInstanceType");
const readerReturns = readerFunction
  ? descendants(readerFunction, ts.isReturnStatement).map((node) =>
      compactTsText(node, yoloInstanceServiceSource),
    )
  : [];
if (
  !readerFunction ||
  readerReturns.length !== 2 ||
  !readerReturns.every((text) =>
    ["returnresolved.instanceType;", "returnDEFAULT_YOLO_INSTANCE_TYPE;"].includes(text),
  ) ||
  !compactTsText(readerFunction.body, yoloInstanceServiceSource).includes(
    "constresolved=resolveYoloInstanceSetting(value);",
  )
) {
  report(
    yoloInstanceServiceFile,
    yoloInstanceInvariant,
    "readYoloInstanceType must return only resolveYoloInstanceSetting(...).instanceType or DEFAULT_YOLO_INSTANCE_TYPE",
  );
}

// [2026-10-22] The job timeout: bounds and default are literal, the predicate and lenient resolver can
// only yield an in-bounds integer or the default, and the run-path reader returns nothing else.
const yoloRuntimeSettingInvariant =
  "the YOLO job timeout must be a bounded root setting (900..86400 s), defaulting to 3600";
for (const [name, expected] of [
  ["DEFAULT_YOLO_MAX_RUNTIME_SECONDS", "3600"],
  ["MIN_YOLO_MAX_RUNTIME_SECONDS", "900"],
  ["MAX_YOLO_MAX_RUNTIME_SECONDS", "86400"],
]) {
  requireTsCompactText(
    yoloInstancesFile,
    tsVariableInitializer(yoloInstancesSource, name),
    yoloInstancesSource,
    expected,
    yoloRuntimeSettingInvariant,
    `${name} must remain ${expected}`,
  );
}
requireTsCompactText(
  yoloInstancesFile,
  yoloInstanceFunction(yoloInstancesSource, "isYoloMaxRuntimeSeconds")?.body,
  yoloInstancesSource,
  '{returntypeofvalue==="number"&&Number.isInteger(value)&&value>=MIN_YOLO_MAX_RUNTIME_SECONDS&&value<=MAX_YOLO_MAX_RUNTIME_SECONDS;}',
  yoloRuntimeSettingInvariant,
  "isYoloMaxRuntimeSeconds must accept exactly the in-bounds integers",
);
const resolveRuntimeBody = compactTsText(
  yoloInstanceFunction(yoloInstancesSource, "resolveYoloMaxRuntimeSetting")?.body,
  yoloInstancesSource,
);
if (
  !resolveRuntimeBody.endsWith(
    "returnisYoloMaxRuntimeSeconds(raw)?{seconds:raw,valid:true,raw}:{seconds:DEFAULT_YOLO_MAX_RUNTIME_SECONDS,valid:false,raw};}",
  ) ||
  (resolveRuntimeBody.match(/return/gu) ?? []).length !== 1
) {
  report(
    yoloInstancesFile,
    yoloRuntimeSettingInvariant,
    "resolveYoloMaxRuntimeSetting may only return an in-bounds timeout or the default",
  );
}
const runtimeReader = yoloInstanceFunction(yoloInstanceServiceSource, "readYoloMaxRuntimeSeconds");
const runtimeReaderReturns = runtimeReader
  ? descendants(runtimeReader, ts.isReturnStatement).map((node) =>
      compactTsText(node, yoloInstanceServiceSource),
    )
  : [];
if (
  !runtimeReader ||
  runtimeReaderReturns.length !== 2 ||
  !runtimeReaderReturns.every((text) =>
    ["returnresolved.seconds;", "returnDEFAULT_YOLO_MAX_RUNTIME_SECONDS;"].includes(text),
  ) ||
  !compactTsText(runtimeReader.body, yoloInstanceServiceSource).includes(
    "constresolved=resolveYoloMaxRuntimeSetting(value);",
  )
) {
  report(
    yoloInstanceServiceFile,
    yoloRuntimeSettingInvariant,
    "readYoloMaxRuntimeSeconds must return only resolveYoloMaxRuntimeSetting(...).seconds or DEFAULT_YOLO_MAX_RUNTIME_SECONDS",
  );
}

requireAll(
  "infrastructure/terraform/ecs.tf",
  [
    'family                   = "beaver-app"',
    'family                   = "beaver-cpu-pipeline"',
    'family                   = "beaver-schema-migrator"',
    "it must never bind a new app revision as a side effect",
    "ignore_changes = [task_definition]",
    "dynamic_scaling_in_suspended  = !var.ecs_autoscaling_enabled",
    "dynamic_scaling_out_suspended = !var.ecs_autoscaling_enabled",
    "scheduled_scaling_suspended   = !var.ecs_autoscaling_enabled",
    'command   = ["./entrypoint.sh", "worker", "node", "scripts/process-worker.js"]',
    'command   = ["./entrypoint.sh", "migrate"]',
    "image     = var.label_studio_image",
    'database_url_secret_value_from = "${aws_secretsmanager_secret.database_url.arn}:::${aws_secretsmanager_secret_version.database_url.version_id}"',
  ],
  "app, CPU worker, and singleton migrator must share the exact digest and guarded entrypoints",
);
const writerTaskInvariant =
  "app, CPU worker, and singleton migrator must share the exact digest and guarded entrypoints";
const writerTaskDefinitions = new Map();
for (const [name, family] of [
  ["beaver_app", "beaver-app"],
  ["beaver_cpu_pipeline", "beaver-cpu-pipeline"],
  ["beaver_schema_migrator", "beaver-schema-migrator"],
]) {
  const task = requireHclBlock(
    "infrastructure/terraform/ecs.tf",
    "resource",
    ["aws_ecs_task_definition", name],
    writerTaskInvariant,
  );
  writerTaskDefinitions.set(name, task);
  requireHclStringAssignment(
    "infrastructure/terraform/ecs.tf",
    task,
    "family",
    family,
    writerTaskInvariant,
  );
  const runtime = requireNestedHclBlock(
    "infrastructure/terraform/ecs.tf",
    task,
    "runtime_platform",
    writerTaskInvariant,
  );
  requireHclStringAssignment(
    "infrastructure/terraform/ecs.tf",
    runtime,
    "operating_system_family",
    "LINUX",
    writerTaskInvariant,
  );
  requireHclStringAssignment(
    "infrastructure/terraform/ecs.tf",
    runtime,
    "cpu_architecture",
    "X86_64",
    writerTaskInvariant,
  );
}
const migratorRoleInvariant =
  "the schema migrator must use a dedicated ECS-assumable role with no permission policies";
const migratorTaskRole = requireHclBlock(
  "infrastructure/terraform/iam.tf",
  "resource",
  ["aws_iam_role", "beaver_schema_migrator_task_role"],
  migratorRoleInvariant,
);
requireHclStringAssignment(
  "infrastructure/terraform/iam.tf",
  migratorTaskRole,
  "name",
  "beaver-schema-migrator-task-role",
  migratorRoleInvariant,
);
if (
  !hclBlockContainsSequence(migratorTaskRole, [
    ["word", "Action"],
    ["symbol", "="],
    ["string", "sts:AssumeRole"],
    ["word", "Effect"],
    ["symbol", "="],
    ["string", "Allow"],
    ["word", "Principal"],
    ["symbol", "="],
    ["symbol", "{"],
    ["word", "Service"],
    ["symbol", "="],
    ["string", "ecs-tasks.amazonaws.com"],
  ])
) {
  report(
    "infrastructure/terraform/iam.tf",
    migratorRoleInvariant,
    "the dedicated role trust must allow only ECS tasks to assume it",
  );
}
requireHclWordAssignment(
  "infrastructure/terraform/ecs.tf",
  writerTaskDefinitions.get("beaver_schema_migrator"),
  "task_role_arn",
  "aws_iam_role.beaver_schema_migrator_task_role.arn",
  migratorRoleInvariant,
);
for (const block of hclBlocks(files["infrastructure/terraform/iam.tf"]).filter(
  (candidate) =>
    candidate.type === "resource" &&
    ["aws_iam_role_policy", "aws_iam_role_policy_attachment"].includes(
      candidate.labels[0],
    ),
)) {
  if (
    hclBlockContainsSequence(block, [
      ["word", "aws_iam_role.beaver_schema_migrator_task_role.id"],
    ]) ||
    hclBlockContainsSequence(block, [
      ["word", "aws_iam_role.beaver_schema_migrator_task_role.name"],
    ])
  ) {
    report(
      "infrastructure/terraform/iam.tf",
      migratorRoleInvariant,
      `permission resource ${block.labels.join(" ")} must not target the migrator role`,
    );
  }
}
const ecsLocals = requireHclBlock(
  "infrastructure/terraform/ecs.tf",
  "locals",
  [],
  writerTaskInvariant,
);
requireHclStringAssignment(
  "infrastructure/terraform/ecs.tf",
  ecsLocals,
  "beaver_app_image",
  "${aws_ecr_repository.beaver_app.repository_url}@${var.beaver_app_image_digest}",
  writerTaskInvariant,
);
if (
  !hclBlockContainsSequence(writerTaskDefinitions.get("beaver_app"), [
    ["word", "name"],
    ["symbol", "="],
    ["string", "YOLO_ECR_IMAGE"],
    ["symbol", ","],
    ["word", "value"],
    ["symbol", "="],
    [
      "string",
      "${aws_ecr_repository.beaver_yolo_pipeline.repository_url}@${var.beaver_yolo_image_digest}",
    ],
  ])
) {
  report(
    "infrastructure/terraform/ecs.tf",
    writerTaskInvariant,
    "the app task YOLO_ECR_IMAGE must use the immutable repository@digest variable",
  );
}
for (const [name, value] of [
  ["S3_BUCKET", "aws_s3_bucket.beaver_data.id"],
  ["AWS_REGION", "var.aws_region"],
  ["AWS_ACCOUNT", "data.aws_caller_identity.current.account_id"],
  ["SAGEMAKER_ROLE_ARN", "aws_iam_role.beaver_sagemaker_role.arn"],
]) {
  if (
    !hclBlockContainsSequence(writerTaskDefinitions.get("beaver_app"), [
      ["word", "name"],
      ["symbol", "="],
      ["string", name],
      ["symbol", ","],
      ["word", "value"],
      ["symbol", "="],
      ["word", value],
    ])
  ) {
    report(
      "infrastructure/terraform/ecs.tf",
      yoloRuntimeInvariant,
      `${name} must use the canonical Terraform-owned runtime value`,
    );
  }
}

const yoloIamInvariant =
  "the SageMaker execution role must have only canonical input/output and repository authority";
const sagemakerRole = requireHclBlock(
  "infrastructure/terraform/iam.tf",
  "resource",
  ["aws_iam_role", "beaver_sagemaker_role"],
  yoloIamInvariant,
);
requireHclStringAssignment(
  "infrastructure/terraform/iam.tf",
  sagemakerRole,
  "name",
  "beaver-sagemaker-role",
  yoloIamInvariant,
);
for (const sequence of [
  [
    ["word", "Action"],
    ["symbol", "="],
    ["string", "sts:AssumeRole"],
  ],
  [
    ["word", "Service"],
    ["symbol", "="],
    ["string", "sagemaker.amazonaws.com"],
  ],
]) {
  if (!hclBlockContainsSequence(sagemakerRole, sequence)) {
    report(
      "infrastructure/terraform/iam.tf",
      yoloIamInvariant,
      "the execution-role trust must be SageMaker-only",
    );
  }
}
const sagemakerS3Policy = requireHclBlock(
  "infrastructure/terraform/iam.tf",
  "resource",
  ["aws_iam_role_policy", "beaver_sagemaker_s3"],
  yoloIamInvariant,
);
requireHclWordAssignment(
  "infrastructure/terraform/iam.tf",
  sagemakerS3Policy,
  "role",
  "aws_iam_role.beaver_sagemaker_role.id",
  yoloIamInvariant,
);
for (const sequence of [
  [
    ["word", "Sid"],
    ["symbol", "="],
    ["string", "ReadOnlyCanonicalInputs"],
  ],
  [
    ["word", "Resource"],
    ["symbol", "="],
    ["symbol", "["],
    ["string", "${aws_s3_bucket.beaver_data.arn}/models/*"],
    ["symbol", ","],
    ["string", "${aws_s3_bucket.beaver_data.arn}/*/*/pages/*"],
    ["symbol", ","],
    ["symbol", "]"],
  ],
  [
    ["word", "Sid"],
    ["symbol", "="],
    ["string", "WriteOnlyCanonicalOutputs"],
  ],
  [
    ["word", "Resource"],
    ["symbol", "="],
    ["string", "${aws_s3_bucket.beaver_data.arn}/*/*/yolo-output/*"],
  ],
  [
    ["word", "Sid"],
    ["symbol", "="],
    ["string", "ListOnlyCanonicalPrefixes"],
  ],
  [
    ["string", "s3:prefix"],
    ["symbol", "="],
    ["symbol", "["],
    ["string", "models/*"],
    ["symbol", ","],
    ["string", "*/*/pages/*"],
    ["symbol", ","],
    ["string", "*/*/yolo-output/*"],
    ["symbol", ","],
    ["symbol", "]"],
  ],
]) {
  if (!hclBlockContainsSequence(sagemakerS3Policy, sequence)) {
    report(
      "infrastructure/terraform/iam.tf",
      yoloIamInvariant,
      "the execution-role S3 policy lost a canonical scoped statement",
    );
  }
}
if (
  hclBlockContainsSequence(sagemakerS3Policy, [
    ["word", "Resource"],
    ["symbol", "="],
    ["string", "*"],
  ])
) {
  report(
    "infrastructure/terraform/iam.tf",
    yoloIamInvariant,
    "the execution-role S3 policy may not use a wildcard Resource",
  );
}
const sagemakerEcrPolicy = requireHclBlock(
  "infrastructure/terraform/iam.tf",
  "resource",
  ["aws_iam_role_policy", "beaver_sagemaker_ecr"],
  yoloIamInvariant,
);
requireHclWordAssignment(
  "infrastructure/terraform/iam.tf",
  sagemakerEcrPolicy,
  "role",
  "aws_iam_role.beaver_sagemaker_role.id",
  yoloIamInvariant,
);
for (const sequence of [
  [
    ["word", "Action"],
    ["symbol", "="],
    ["string", "ecr:GetAuthorizationToken"],
    ["word", "Resource"],
    ["symbol", "="],
    ["string", "*"],
  ],
  [
    ["word", "Sid"],
    ["symbol", "="],
    ["string", "PullOnlyCanonicalYoloRepository"],
  ],
  [
    ["word", "Resource"],
    ["symbol", "="],
    ["word", "aws_ecr_repository.beaver_yolo_pipeline.arn"],
  ],
]) {
  if (!hclBlockContainsSequence(sagemakerEcrPolicy, sequence)) {
    report(
      "infrastructure/terraform/iam.tf",
      yoloIamInvariant,
      "the execution-role ECR policy must limit pulls to the YOLO repository",
    );
  }
}
const ecsSagemakerPolicy = requireHclBlock(
  "infrastructure/terraform/iam.tf",
  "resource",
  ["aws_iam_role_policy", "beaver_ecs_task_sagemaker"],
  yoloIamInvariant,
);
requireHclWordAssignment(
  "infrastructure/terraform/iam.tf",
  ecsSagemakerPolicy,
  "role",
  "aws_iam_role.beaver_ecs_task_role.id",
  yoloIamInvariant,
);
for (const sequence of [
  [
    ["word", "Resource"],
    ["symbol", "="],
    [
      "string",
      "arn:aws:sagemaker:${var.aws_region}:${data.aws_caller_identity.current.account_id}:processing-job/*",
    ],
  ],
  [
    ["word", "Action"],
    ["symbol", "="],
    ["string", "iam:PassRole"],
    ["word", "Resource"],
    ["symbol", "="],
    ["word", "aws_iam_role.beaver_sagemaker_role.arn"],
  ],
  [
    ["string", "iam:PassedToService"],
    ["symbol", "="],
    ["string", "sagemaker.amazonaws.com"],
  ],
]) {
  if (!hclBlockContainsSequence(ecsSagemakerPolicy, sequence)) {
    report(
      "infrastructure/terraform/iam.tf",
      yoloIamInvariant,
      "the caller policy must remain scoped to processing jobs and the exact pass role",
    );
  }
}
if (
  hclTokens(files["infrastructure/terraform/iam.tf"]).some(
    (token) =>
      token.type === "string" &&
      token.value.includes("AmazonSageMakerFullAccess"),
  )
) {
  report(
    "infrastructure/terraform/iam.tf",
    yoloIamInvariant,
    "AmazonSageMakerFullAccess may not be attached or referenced",
  );
}
const appService = requireHclBlock(
  "infrastructure/terraform/ecs.tf",
  "resource",
  ["aws_ecs_service", "beaver_app"],
  writerTaskInvariant,
);
requireHclStringAssignment(
  "infrastructure/terraform/ecs.tf",
  appService,
  "platform_version",
  "1.4.0",
  writerTaskInvariant,
);
const appServiceLifecycle = requireNestedHclBlock(
  "infrastructure/terraform/ecs.tf",
  appService,
  "lifecycle",
  writerTaskInvariant,
);
requireHclExpressionAssignment(
  "infrastructure/terraform/ecs.tf",
  appServiceLifecycle,
  "ignore_changes",
  [
    ["symbol", "["],
    ["word", "task_definition"],
    ["symbol", "]"],
  ],
  writerTaskInvariant,
);
const autoscalingTarget = requireHclBlock(
  "infrastructure/terraform/ecs.tf",
  "resource",
  ["aws_appautoscaling_target", "beaver_ecs"],
  writerTaskInvariant,
);
const suspendedState = requireNestedHclBlock(
  "infrastructure/terraform/ecs.tf",
  autoscalingTarget,
  "suspended_state",
  writerTaskInvariant,
);
for (const property of [
  "dynamic_scaling_in_suspended",
  "dynamic_scaling_out_suspended",
  "scheduled_scaling_suspended",
]) {
  requireHclWordAssignment(
    "infrastructure/terraform/ecs.tf",
    suspendedState,
    property,
    "!var.ecs_autoscaling_enabled",
    writerTaskInvariant,
  );
}
const writerTupleInvariant =
  "Terraform must admit only the exact singleton live tuple or exact drained outage tuple";
for (const [name, expected] of [
  [
    "beaver_writer_outage_tuple",
    "var.ecs_desired_count==0&&var.ecs_min_count==0&&var.ecs_max_count==1&&!var.ecs_autoscaling_enabled&&!var.maintenance_worker_schedule_enabled",
  ],
  [
    "beaver_writer_live_tuple",
    "var.ecs_desired_count==1&&var.ecs_min_count==1&&var.ecs_max_count==1&&var.ecs_autoscaling_enabled&&var.maintenance_worker_schedule_enabled",
  ],
  [
    "beaver_writer_operational_tuple_valid",
    "local.beaver_writer_outage_tuple||local.beaver_writer_live_tuple",
  ],
]) {
  const assignments = ecsLocals ? directHclAssignments(ecsLocals, name) : [];
  const actual = assignments[0]?.map((token) => token.value).join("");
  if (assignments.length !== 1 || actual !== expected) {
    report(
      "infrastructure/terraform/ecs.tf",
      writerTupleInvariant,
      `${name} must be the exact fail-closed expression`,
    );
  }
}
const writerTupleFence = requireHclBlock(
  "infrastructure/terraform/ecs.tf",
  "resource",
  ["terraform_data", "beaver_writer_operational_tuple"],
  writerTupleInvariant,
);
const writerTupleLifecycle = requireNestedHclBlock(
  "infrastructure/terraform/ecs.tf",
  writerTupleFence,
  "lifecycle",
  writerTupleInvariant,
);
const writerTuplePrecondition = requireNestedHclBlock(
  "infrastructure/terraform/ecs.tf",
  writerTupleLifecycle,
  "precondition",
  writerTupleInvariant,
);
requireHclWordAssignment(
  "infrastructure/terraform/ecs.tf",
  writerTuplePrecondition,
  "condition",
  "local.beaver_writer_operational_tuple_valid",
  writerTupleInvariant,
);
const writerEpochInvariant =
  "the canonical remote writer-mode epoch must rotate only across exact live/outage transitions and bind every local witness";
const writerModeEpoch = requireHclBlock(
  "infrastructure/terraform/ecs.tf",
  "resource",
  ["terraform_data", "beaver_writer_mode_epoch"],
  writerEpochInvariant,
);
const modeExpression = [
  ["word", "local.beaver_writer_outage_tuple"],
  ["word", "?"],
  ["string", "outage"],
  ["word", ":"],
  ["string", "live"],
];
requireHclExpressionAssignment(
  "infrastructure/terraform/ecs.tf",
  writerModeEpoch,
  "input",
  modeExpression,
  writerEpochInvariant,
);
requireHclExpressionAssignment(
  "infrastructure/terraform/ecs.tf",
  writerModeEpoch,
  "triggers_replace",
  [["symbol", "["], ...modeExpression, ["symbol", "]"]],
  writerEpochInvariant,
);
const writerEpochLifecycle = requireNestedHclBlock(
  "infrastructure/terraform/ecs.tf",
  writerModeEpoch,
  "lifecycle",
  writerEpochInvariant,
);
const writerEpochPrecondition = requireNestedHclBlock(
  "infrastructure/terraform/ecs.tf",
  writerEpochLifecycle,
  "precondition",
  writerEpochInvariant,
);
requireHclWordAssignment(
  "infrastructure/terraform/ecs.tf",
  writerEpochPrecondition,
  "condition",
  "local.beaver_writer_operational_tuple_valid",
  writerEpochInvariant,
);
const appServiceTags = appService
  ? directHclAssignments(appService, "tags")
  : [];
const appServiceTagTokens =
  appServiceTags.length === 1 ? appServiceTags[0] : [];
const tagSequenceCount = (expected) =>
  appServiceTagTokens.filter((_, start) =>
    expected.every(
      ([type, value], offset) =>
        appServiceTagTokens[start + offset]?.type === type &&
        appServiceTagTokens[start + offset]?.value === value,
    ),
  ).length;
if (
  appServiceTags.length !== 1 ||
  tagSequenceCount([
    ["word", "BlueprintParserWriterMode"],
    ["symbol", "="],
    ...modeExpression,
  ]) !== 1 ||
  tagSequenceCount([
    ["word", "BlueprintParserWriterModeEpoch"],
    ["symbol", "="],
    ["word", "sha256"],
    ["symbol", "("],
    ["word", "terraform_data.beaver_writer_mode_epoch.id"],
    ["symbol", ")"],
  ]) !== 1 ||
  !hclBlockContainsSequence(appService, [
    ["word", "terraform_data.beaver_writer_mode_epoch"],
  ])
) {
  report(
    "infrastructure/terraform/ecs.tf",
    writerEpochInvariant,
    "the app service must expose the exact mode and sha256(terraform_data.beaver_writer_mode_epoch.id) tags and depend on the epoch resource",
  );
}
for (const [file, block] of [
  ["infrastructure/terraform/ecs.tf", appService],
  ["infrastructure/terraform/ecs.tf", autoscalingTarget],
  [
    "infrastructure/terraform/stepfunctions.tf",
    requireHclBlock(
      "infrastructure/terraform/stepfunctions.tf",
      "resource",
      ["aws_sfn_state_machine", "beaver_process_blueprint"],
      writerTupleInvariant,
    ),
  ],
  [
    "infrastructure/terraform/project-asset-deletions.tf",
    requireHclBlock(
      "infrastructure/terraform/project-asset-deletions.tf",
      "resource",
      ["aws_scheduler_schedule", "beaver_project_asset_deletions"],
      writerTupleInvariant,
    ),
  ],
]) {
  if (
    !hclBlockContainsSequence(block, [
      ["word", "terraform_data.beaver_writer_operational_tuple"],
    ])
  ) {
    report(
      file,
      writerTupleInvariant,
      `${block?.type ?? "launcher"} ${block?.labels?.join(" ") ?? "block"} must depend on the tuple fence`,
    );
  }
}
requirePattern(
  "infrastructure/terraform/ecs.tf",
  /^\s*beaver_app_image\s*=\s*"\$\{aws_ecr_repository\.beaver_app\.repository_url\}@\$\{var\.beaver_app_image_digest\}"\s*$/mu,
  "every application writer must share the exact digest image local",
);
requireOccurrences(
  "infrastructure/terraform/ecs.tf",
  "runtime_platform {",
  3,
  "the app, CPU worker, and migrator must pin the Linux/X86_64 runtime platform",
);
requireOccurrences(
  "infrastructure/terraform/ecs.tf",
  'cpu_architecture        = "X86_64"',
  3,
  "every primary writer runtime must be X86_64",
);
requireOccurrences(
  "infrastructure/terraform/ecs.tf",
  'operating_system_family = "LINUX"',
  3,
  "every primary writer runtime must be Linux",
);
requirePattern(
  "infrastructure/terraform/ecs.tf",
  /^\s*platform_version\s*=\s*"1\.4\.0"\s*$/mu,
  "the app service must pin Fargate platform 1.4.0",
);
requireOccurrences(
  "infrastructure/terraform/ecs.tf",
  "valueFrom = local.database_url_secret_value_from",
  3,
  "the app, CPU worker, and migrator must share the exact DATABASE_URL version selector",
);
requireOccurrences(
  "infrastructure/terraform/project-asset-deletions.tf",
  "runtime_platform {",
  1,
  "the maintenance writer must pin the Linux/X86_64 runtime platform",
);
requireOccurrences(
  "infrastructure/terraform/project-asset-deletions.tf",
  'cpu_architecture        = "X86_64"',
  1,
  "the maintenance writer runtime must be X86_64",
);
requireOccurrences(
  "infrastructure/terraform/project-asset-deletions.tf",
  'operating_system_family = "LINUX"',
  1,
  "the maintenance writer runtime must be Linux",
);
requireOccurrences(
  "infrastructure/terraform/project-asset-deletions.tf",
  "valueFrom = local.database_url_secret_value_from",
  1,
  "the maintenance writer must share the exact DATABASE_URL version selector",
);
requirePattern(
  "infrastructure/terraform/project-asset-deletions.tf",
  /^\s*platform_version\s*=\s*"1\.4\.0"\s*$/mu,
  "the maintenance schedule must launch the pinned Fargate platform",
);
const maintenanceWriterInvariant =
  "the scheduled database writer must use the digest, schema guard, and disable switch";
const maintenanceTask = requireHclBlock(
  "infrastructure/terraform/project-asset-deletions.tf",
  "resource",
  ["aws_ecs_task_definition", "beaver_project_asset_deletions"],
  maintenanceWriterInvariant,
);
requireHclStringAssignment(
  "infrastructure/terraform/project-asset-deletions.tf",
  maintenanceTask,
  "family",
  "beaver-project-asset-deletions",
  maintenanceWriterInvariant,
);
const maintenanceRuntime = requireNestedHclBlock(
  "infrastructure/terraform/project-asset-deletions.tf",
  maintenanceTask,
  "runtime_platform",
  maintenanceWriterInvariant,
);
for (const [property, value] of [
  ["operating_system_family", "LINUX"],
  ["cpu_architecture", "X86_64"],
]) {
  requireHclStringAssignment(
    "infrastructure/terraform/project-asset-deletions.tf",
    maintenanceRuntime,
    property,
    value,
    maintenanceWriterInvariant,
  );
}
for (const sequence of [
  [
    ["word", "image"],
    ["symbol", "="],
    ["word", "local.beaver_app_image"],
  ],
  [
    ["word", "command"],
    ["symbol", "="],
    ["symbol", "["],
    ["string", "./entrypoint.sh"],
    ["symbol", ","],
    ["string", "worker"],
    ["symbol", ","],
    ["string", "node"],
    ["symbol", ","],
    ["string", "scripts/project-asset-deletion-worker.js"],
    ["symbol", "]"],
  ],
  [
    ["word", "name"],
    ["symbol", "="],
    ["string", "DATABASE_URL"],
    ["word", "valueFrom"],
    ["symbol", "="],
    ["word", "local.database_url_secret_value_from"],
  ],
]) {
  if (!hclBlockContainsSequence(maintenanceTask, sequence)) {
    report(
      "infrastructure/terraform/project-asset-deletions.tf",
      maintenanceWriterInvariant,
      "the maintenance task definition lost an exact image, command, or DATABASE_URL binding",
    );
  }
}
const maintenanceSchedule = requireHclBlock(
  "infrastructure/terraform/project-asset-deletions.tf",
  "resource",
  ["aws_scheduler_schedule", "beaver_project_asset_deletions"],
  maintenanceWriterInvariant,
);
const maintenanceEcsParameters = requireNestedHclBlock(
  "infrastructure/terraform/project-asset-deletions.tf",
  maintenanceSchedule,
  "ecs_parameters",
  maintenanceWriterInvariant,
);
requireHclStringAssignment(
  "infrastructure/terraform/project-asset-deletions.tf",
  maintenanceEcsParameters,
  "platform_version",
  "1.4.0",
  maintenanceWriterInvariant,
);
const notificationOwnershipInvariant =
  "Terraform may own the complete data-bucket notification configuration only after explicit owner inventory acknowledgement";
const notificationAcknowledgement = requireHclBlock(
  "infrastructure/terraform/variables.tf",
  "variable",
  ["acknowledge_beaver_data_notification_takeover"],
  notificationOwnershipInvariant,
);
requireHclWordAssignment(
  "infrastructure/terraform/variables.tf",
  notificationAcknowledgement,
  "type",
  "bool",
  notificationOwnershipInvariant,
);
requireHclWordAssignment(
  "infrastructure/terraform/variables.tf",
  notificationAcknowledgement,
  "default",
  "false",
  notificationOwnershipInvariant,
);
const bucketNotification = requireHclBlock(
  "infrastructure/terraform/project-asset-deletions.tf",
  "resource",
  ["aws_s3_bucket_notification", "beaver_data_eventbridge"],
  notificationOwnershipInvariant,
);
requireHclWordAssignment(
  "infrastructure/terraform/project-asset-deletions.tf",
  bucketNotification,
  "eventbridge",
  "true",
  notificationOwnershipInvariant,
);
const bucketNotificationLifecycle = requireNestedHclBlock(
  "infrastructure/terraform/project-asset-deletions.tf",
  bucketNotification,
  "lifecycle",
  notificationOwnershipInvariant,
);
const bucketNotificationPrecondition = requireNestedHclBlock(
  "infrastructure/terraform/project-asset-deletions.tf",
  bucketNotificationLifecycle,
  "precondition",
  notificationOwnershipInvariant,
);
requireHclWordAssignment(
  "infrastructure/terraform/project-asset-deletions.tf",
  bucketNotificationPrecondition,
  "condition",
  "var.acknowledge_beaver_data_notification_takeover",
  notificationOwnershipInvariant,
);
for (const dependency of [
  "aws_cloudwatch_event_target.beaver_project_staging_object_created",
  "aws_sqs_queue_policy.beaver_project_asset_events",
  "aws_sqs_queue_policy.beaver_project_asset_event_delivery_dlq",
]) {
  if (!hclBlockContainsSequence(bucketNotification, [["word", dependency]])) {
    report(
      "infrastructure/terraform/project-asset-deletions.tf",
      notificationOwnershipInvariant,
      `bucket notification must depend on ${dependency}`,
    );
  }
}
if (
  !hclBlockContainsSequence(maintenanceSchedule, [
    ["word", "aws_s3_bucket_notification.beaver_data_eventbridge"],
  ])
) {
  report(
    "infrastructure/terraform/project-asset-deletions.tf",
    notificationOwnershipInvariant,
    "maintenance schedule must remain behind durable EventBridge notification delivery",
  );
}
requirePattern(
  "infrastructure/terraform/stepfunctions.tf",
  /^\s*PlatformVersion\s*=\s*"1\.4\.0"\s*$/mu,
  "the CPU state-machine launcher must pin the Fargate platform",
);
requireAll(
  "infrastructure/terraform/secrets.tf",
  [
    "urlencode(var.db_username)",
    "urlencode(var.db_password)",
    "urlencode(aws_db_instance.beaver.db_name)",
  ],
  "the canonical DATABASE_URL must percent-encode every operator-controlled URL component",
);
forbid(
  "infrastructure/terraform/ecs.tf",
  ["BP_SCHEMA_MIGRATION_MODE"],
  "the migrator task definition must remain unarmed until the cutover supplies a one-run override",
);
forbid(
  "infrastructure/terraform/ecs.tf",
  ["heartexlabs/label-studio:latest"],
  "the Label Studio service must use a reviewed immutable manifest digest",
);
requireAll(
  "infrastructure/terraform/stepfunctions.tf",
  [
    "ignore_changes = [logging_configuration]",
    "aws_iam_role_policy.beaver_sfn_ecs",
  ],
  "Terraform must manage an exact-revision CPU target after its narrowed role policy exists",
);
const stateMachineInvariant =
  "Terraform must manage an exact-revision CPU target after its narrowed role policy exists";
const stateMachine = requireHclBlock(
  "infrastructure/terraform/stepfunctions.tf",
  "resource",
  ["aws_sfn_state_machine", "beaver_process_blueprint"],
  stateMachineInvariant,
);
const stateMachineLifecycle = requireNestedHclBlock(
  "infrastructure/terraform/stepfunctions.tf",
  stateMachine,
  "lifecycle",
  stateMachineInvariant,
);
requireHclExpressionAssignment(
  "infrastructure/terraform/stepfunctions.tf",
  stateMachineLifecycle,
  "ignore_changes",
  [
    ["symbol", "["],
    ["word", "logging_configuration"],
    ["symbol", "]"],
  ],
  stateMachineInvariant,
);
for (const sequence of [
  [
    ["word", "PlatformVersion"],
    ["symbol", "="],
    ["string", "1.4.0"],
  ],
  [
    ["word", "TaskDefinition"],
    ["symbol", "="],
    ["word", "aws_ecs_task_definition.beaver_cpu_pipeline.arn"],
  ],
  [["word", "aws_iam_role_policy.beaver_sfn_ecs"]],
]) {
  if (!hclBlockContainsSequence(stateMachine, sequence)) {
    report(
      "infrastructure/terraform/stepfunctions.tf",
      stateMachineInvariant,
      "the state machine lost its platform, exact task revision, or narrowed-policy dependency",
    );
  }
}
requirePattern(
  "infrastructure/terraform/stepfunctions.tf",
  /^\s*TaskDefinition\s*=\s*aws_ecs_task_definition\.beaver_cpu_pipeline\.arn\s*$/mu,
  "the live state-machine definition must pin the exact CPU task revision",
);
forbid(
  "infrastructure/terraform/stepfunctions.tf",
  [
    'TaskDefinition = "beaver-cpu-pipeline"',
    "logging_configuration, definition",
  ],
  "the live state-machine definition may not drift to a family-only target",
);
requireAll(
  "infrastructure/terraform/iam.tf",
  [
    "task-definition/${aws_ecs_task_definition.beaver_cpu_pipeline.family}:*",
    '"iam:PassedToService" = "ecs-tasks.amazonaws.com"',
  ],
  "Step Functions may launch CPU-family revisions only and pass roles only to ECS tasks",
);
requireAll(
  "infrastructure/terraform/project-asset-deletions.tf",
  [
    "image     = local.beaver_app_image",
    'command   = ["./entrypoint.sh", "worker", "node", "scripts/project-asset-deletion-worker.js"]',
    'state      = var.maintenance_worker_schedule_enabled ? "ENABLED" : "DISABLED"',
  ],
  "the scheduled database writer must use the digest, schema guard, and disable switch",
);
forbid(
  "infrastructure/terraform/ecs.tf",
  ["aws_ecr_repository.beaver_app.repository_url}:latest"],
  "no app-image database writer may consume mutable latest",
);
forbid(
  "infrastructure/terraform/project-asset-deletions.tf",
  ["aws_ecr_repository.beaver_app.repository_url}:latest"],
  "the scheduled writer may not consume mutable latest",
);

requireAll(
  "entrypoint.sh",
  [
    'mode="${1:-app}"',
    "exec node scripts/assert-schema-current.mjs",
    "node scripts/assert-schema-current.mjs",
    "exec node scripts/run-schema-migrations.mjs",
    "exec node scripts/assert-schema-migration-ready.mjs",
    'exec "$@"',
  ],
  "normal app and worker startup must verify schema while only explicit migrate mode can change it",
);
forbid(
  "entrypoint.sh",
  [
    "drizzle-orm",
    "migrate(db",
    "Running database migrations",
    "projects",
    "UPDATE ",
    "INSERT ",
    "DELETE ",
    "TRUNCATE ",
    "new Pool",
    "require('pg')",
    'require("pg")',
  ],
  "the normal container entrypoint must not contain an implicit migrator or project-data authority",
);
const entrypointInvariant =
  "normal app and worker startup must verify schema while only explicit migrate mode can change it";
const entrypointLines = shellLogicalLines(files["entrypoint.sh"]);
const entrypointBranches = shellCaseBranches(entrypointLines, '"${mode}"');
if (!entrypointLines.includes('mode="${1:-app}"') || !entrypointBranches) {
  report(
    "entrypoint.sh",
    entrypointInvariant,
    "the executable default mode assignment or mode case block is missing",
  );
} else {
  const requiredBranchCommands = new Map([
    ["schema-check", ["exec node scripts/assert-schema-current.mjs"]],
    [
      "schema-readiness",
      ["shift", 'exec node scripts/assert-schema-migration-ready.mjs "${1:-}"'],
    ],
    ["migrate", ["exec node scripts/run-schema-migrations.mjs"]],
    [
      "worker",
      ["shift", "node scripts/assert-schema-current.mjs", 'exec "$@"'],
    ],
    ["app", ["node scripts/assert-schema-current.mjs"]],
  ]);
  for (const [mode, commands] of requiredBranchCommands) {
    const branch = entrypointBranches.get(mode) ?? [];
    const positions = commands.map((command) => branch.indexOf(command));
    if (
      positions.some((position) => position < 0) ||
      positions.some(
        (position, index) => index > 0 && position <= positions[index - 1],
      )
    ) {
      report(
        "entrypoint.sh",
        entrypointInvariant,
        `${mode} must execute ${commands.join(" then ")}`,
      );
    }
  }
  for (const [mode, branch] of entrypointBranches) {
    if (
      mode !== "migrate" &&
      branch.some((line) =>
        /^(?:exec[ \\t]+)?node[ \\t]+scripts\/run-schema-migrations\.mjs(?:[ \\t]|$)/u.test(
          line,
        ),
      )
    ) {
      report(
        "entrypoint.sh",
        entrypointInvariant,
        `${mode} may not invoke the production migrator`,
      );
    }
  }
}
if (!entrypointLines.includes("exec node server.js")) {
  report(
    "entrypoint.sh",
    entrypointInvariant,
    "normal startup must end by executing the application server",
  );
}
requireAll(
  "Dockerfile",
  ['CMD ["./entrypoint.sh", "app"]'],
  "the default image role must be schema-checking app startup",
);

requireAll(
  "scripts/run-schema-migrations.mjs",
  [
    'P2_MODE = "p2-0037-singleton-quiescent"',
    'EMPTY_BOOTSTRAP_MODE = "empty-database-singleton-quiescent"',
    'client.query("SET search_path = public")',
    "pg_catalog.pg_try_advisory_lock($1)",
    "assertP2LocalMigrationContract(local)",
    "assertP2CutoverStart(local, before)",
    "assertEmptyDatabaseBootstrapStart(client, local, before)",
    "assertLegacyStorageNamespaces(client)",
    "assertLegacyLabelingRowsRetired(client, local, before)",
    "assertSchemaCurrent(local, after)",
    "pg_catalog.pg_advisory_unlock($1)",
  ],
  "the only production migrator must require explicit mode, exact boundary, a singleton lock, and postcondition",
);
forbid(
  "scripts/run-schema-migrations.mjs",
  [
    "SET search_path = public, pg_catalog",
    "SET search_path = pg_catalog, public",
  ],
  "the migrator must retain implicit pg_catalog precedence and public as its DDL target",
);
requireAll(
  "scripts/assert-schema-migration-ready.mjs",
  [
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    'client.query("SET search_path = public")',
    "pg_catalog.pg_try_advisory_lock($1)",
    "assertP2LocalMigrationContract(local)",
    "assertP2CutoverStart(local, applied)",
    "assertEmptyDatabaseBootstrapStart(client, local, applied)",
    "assertLegacyStorageNamespaces(client)",
    "assertLegacyLabelingRowsRetired(client, local, applied)",
  ],
  "pre-retirement readiness must be read-only, locked, search-path pinned, and mode exact",
);
requireAll(
  "scripts/schema-migration-contract.mjs",
  [
    'P2_DURABLE_CHECKPOINT_TAG = "0032_chat_global_nullable_project"',
    'P2_PRE_CUTOVER_TAG = "0036_project_asset_object_event_generation"',
    'P2_BOUNDARY_TAG = "0037_label_studio_asset_grants"',
    'P2_CURRENT_TAG = "0039_runtime_state"',
    "ORDER BY created_at ASC",
    "expected.length === applied.length",
    "expected.every((entry, index) => matches(entry, applied[index]))",
    "entry.when === applied.when",
    "entry.hash === applied.hash",
    "assertEmptyDatabaseBootstrapStart",
    "assertLegacyStorageNamespaces",
    "assertLegacyLabelingRowsRetired",
    "assertP2LocalMigrationContract",
    "pg_catalog.pg_depend",
    "pg_catalog.pg_describe_object",
    "pg_catalog.pg_namespace",
  ],
  "schema admission must compare both journal timestamp and SQL hash at the exact P2 boundary",
);

requireAll(
  "deploy.sh",
  [
    "publish_image",
    "activate_image",
    "bp_validate_digest",
    "bp_assert_task_definition_image",
    "bp_assert_task_definition_contract",
    "bp_task_definition_label_studio_identity",
    "bp_assert_state_machine_task_definition",
    "bp_assert_maintenance_schedule_contract",
    "bp_assert_service_autoscaling_state 1 1 false",
    "bp_service_task_definition",
    "bp_task_definition_image",
    "activate is same-digest only",
    "run_writer_cohort_mode",
    "preflight_writer_cohort",
    "BP_CANDIDATE_IMAGE_DIGEST",
    "bp_assert_task_role_has_no_permissions",
    'command\":[\"./entrypoint.sh\",\"schema-check\"]',
    "bp_run_one_off_task",
    "--force-new-deployment",
    'bp_assert_service_revision_stable "${app_td}" 1',
    "docker build --platform linux/amd64",
  ],
  "ordinary deploy must publish a digest and pass a remote read-only schema check before rolling",
);
const deployInvariant =
  "ordinary deploy must publish a digest and pass a remote read-only schema check before rolling";
const deployLines = shellLogicalLines(files["deploy.sh"]);
const publishImage = shellFunction(deployLines, "publish_image");
const activateImage = shellFunction(deployLines, "activate_image");
const deployCohortMode = shellFunction(deployLines, "run_writer_cohort_mode");
const deployCohortPreflight = shellFunction(
  deployLines,
  "preflight_writer_cohort",
);
const requireShellFunctionLines = (file, invariant, name, lines, patterns) => {
  if (!lines) {
    report(file, invariant, `${name} function is missing or unbalanced`);
    return;
  }
  for (const [description, pattern] of patterns) {
    if (!lines.some((line) => pattern.test(line))) {
      report(file, invariant, `${name} is missing ${description}`);
    }
  }
};
requireShellFunctionLines(
  "deploy.sh",
  deployInvariant,
  "publish_image",
  publishImage,
  [
    [
      "the canonical repository check",
      /^\[ "\$\{ECR_REPO\}" = "beaver-app" \] \|\| bp_die /u,
    ],
    ["the immutable digest validation", /^bp_validate_digest "\$\{digest\}"$/u],
    ["the amd64 image build", /^docker build --platform linux\/amd64 /u],
  ],
);
requireShellFunctionLines(
  "deploy.sh",
  deployInvariant,
  "activate_image",
  activateImage,
  [
    ["input digest validation", /^bp_validate_digest "\$\{digest\}"$/u],
    [
      "the currently bound service revision lookup",
      /^current_service_td=\$\(bp_service_task_definition\)$/u,
    ],
    [
      "the currently bound service image lookup",
      /^current_service_image=\$\(bp_task_definition_image "\$\{current_service_td\}"\)$/u,
    ],
    ["the same-digest-only refusal", /^bp_die "activate is same-digest only:/u],
    [
      "all writer task image assertions",
      /^migrator_td=\$\(bp_assert_task_definition_image "\$\{MIGRATOR_FAMILY\}" "\$\{expected_image\}"\)$/u,
    ],
    [
      "all writer task contract assertions",
      /^migrator_database=\$\(bp_assert_task_definition_contract "\$\{migrator_td\}" migrator\)$/u,
    ],
    [
      "the policy-free migrator role assertion",
      /^bp_assert_task_role_has_no_permissions "beaver-schema-migrator-task-role"$/u,
    ],
    [
      "the exact state-machine target assertion",
      /^bp_assert_state_machine_task_definition "\$\{cpu_td\}" "\$\{canonical_cluster_arn\}"$/u,
    ],
    [
      "the maintenance schedule assertion",
      /^bp_assert_maintenance_schedule_contract /u,
    ],
    [
      "the read-only schema-check override",
      /^overrides='\{"containerOverrides":\[\{"name":"beaver-schema-migrator","command":\["\.\/entrypoint\.sh","schema-check"\]\}\]\}'$/u,
    ],
    [
      "the read-only schema-check task",
      /^bp_run_one_off_task "\$\{migrator_td\}" "\$\{overrides\}" >\/dev\/null$/u,
    ],
    [
      "the admitted service deployment",
      /^bp_aws ecs update-service .* --force-new-deployment /u,
    ],
    [
      "the positive-count stable-service assertion",
      /^bp_assert_service_revision_stable "\$\{app_td\}" 1$/u,
    ],
    [
      "the live autoscaling assertion",
      /^bp_assert_service_autoscaling_state 1 1 false$/u,
    ],
  ],
);
requireShellFunctionLines(
  "deploy.sh",
  deployInvariant,
  "run_writer_cohort_mode",
  deployCohortMode,
  [
    ["the candidate digest validation", /^bp_validate_digest "\$\{digest\}"$/u],
    [
      "the exact P2 cohort delegation",
      /^BP_APP_IMAGE_DIGEST="\$\{digest\}" "\$\{PROJECT_DIR\}\/scripts\/p2-schema-cutover\.sh" "\$\{mode\}"$/u,
    ],
  ],
);
requireShellFunctionLines(
  "deploy.sh",
  deployInvariant,
  "preflight_writer_cohort",
  deployCohortPreflight,
  [
    [
      "the baseline digest validation",
      /^bp_validate_digest "\$\{baseline_digest\}"$/u,
    ],
    [
      "the intended candidate digest validation",
      /^bp_validate_digest "\$\{candidate_digest\}"$/u,
    ],
    [
      "the candidate-bound outage preflight delegation",
      /^BP_APP_IMAGE_DIGEST="\$\{baseline_digest\}" BP_CANDIDATE_IMAGE_DIGEST="\$\{candidate_digest\}" "\$\{PROJECT_DIR\}\/scripts\/p2-schema-cutover\.sh" preflight-outage$/u,
    ],
  ],
);
const serviceImagePosition =
  activateImage?.findIndex((line) =>
    /^current_service_image=\$\(bp_task_definition_image /u.test(line),
  ) ?? -1;
const sameDigestRefusalPosition =
  activateImage?.findIndex((line) =>
    /^bp_die "activate is same-digest only:/u.test(line),
  ) ?? -1;
const candidateAdmissionPosition =
  activateImage?.findIndex((line) =>
    /^app_td=\$\(bp_assert_task_definition_image /u.test(line),
  ) ?? -1;
if (
  serviceImagePosition < 0 ||
  sameDigestRefusalPosition <= serviceImagePosition ||
  candidateAdmissionPosition <= sameDigestRefusalPosition
) {
  report(
    "deploy.sh",
    deployInvariant,
    "activate must reject a new digest from the bound service before candidate admission",
  );
}
forbid(
  "deploy.sh",
  [':latest"', ":latest'"],
  "ordinary deploy must not publish or activate mutable latest",
);

requireAll(
  "scripts/lib/ecs-schema-tools.sh",
  [
    "container.entryPoint",
    "container.environmentFiles",
    "duplicate environment names",
    "DATABASE_URL authority",
    "DATABASE_URL version selector",
    "NODE_ENV authority",
    "runtime platform",
    "BP_SCHEMA_MIGRATION_MODE",
    "failures.length !== 0",
    "tasks.length !== expected.length",
    "ecs wait services-stable",
    'rollout_state}" != "COMPLETED',
    "--client-token",
    "--started-by",
    "RunTask outcome is unknown",
    "task may still be running",
    "--version-id",
    "--version-stage",
    "--platform-version 1.4.0",
    "Target.Arn",
    "Target.EcsParameters.PlatformVersion",
    "const exactKeys",
    'exactKeys(definition, ["Comment", "StartAt", "States"])',
    'exactKeys(states, ["CPUProcessing", "ProcessingComplete", "ProcessingFailed", "ValidateInput"])',
    "exactKeys(state",
    "exactKeys(parameters",
    "exactKeys(overrides",
    "exactKeys(containerOverride",
    'entry["Value.$"]',
    "LABEL_STUDIO_URL",
    "LABEL_STUDIO_INSTANCE_ID",
    "LABEL_STUDIO_API_KEY",
    "fs-(?:[0-9a-f]{8}|[0-9a-f]{17})",
    "const expectedEnvironment = {",
    "const dataBucket = `beaver-data-${account}`",
    "const cloudFrontDomain = `assets.${domain}`",
    "const labelStudioUrl = `https://labelstudio.${domain}`",
    "const appUrl = `https://app.${domain}`",
    "const sagemakerRoleArn = `arn:aws:iam::${account}:role/beaver-sagemaker-role`",
    "const projectAssetEventQueueUrl = `https://sqs.${region}.amazonaws.com/${account}/beaver-project-asset-events`",
    'LAMBDA_CV_FUNCTION_NAME: "beaver-cv-pipeline"',
    "const expectedYoloPrefix = `${account}.dkr.ecr.${region}.amazonaws.com/beaver-yolo-pipeline@`",
    'taskRole: "beaver-schema-migrator-task-role"',
    "bp_assert_task_role_has_no_permissions",
    "iam list-role-policies",
    "iam list-attached-role-policies",
    "expected stable app service count must be an explicit nonnegative integer",
    "bp_assert_service_autoscaling_state",
    "ScalableTargets[0].MaxCapacity",
  ],
  "shared ECS admission helpers must fail closed on structural, pagination, rollout, and ambiguous-task drift",
);
const oneOffTaskInvariant =
  "one-off ECS tasks must preserve deterministic admission identity and fail closed on ambiguous RunTask, waiter, or terminal-state outcomes";
const ecsSchemaLines = shellLogicalLines(
  files["scripts/lib/ecs-schema-tools.sh"],
);
const oneOffTask = shellFunction(ecsSchemaLines, "bp_run_one_off_task");
requireShellFunctionLines(
  "scripts/lib/ecs-schema-tools.sh",
  oneOffTaskInvariant,
  "bp_run_one_off_task",
  oneOffTask,
  [
    [
      "the explicit lowercase client-token validation",
      /^if \[\[ ! "\$\{requested_client_token\}" =~ \^bp-\[a-z0-9\]/u,
    ],
    [
      "the exact requested client-token reuse",
      /^client_token="\$\{requested_client_token\}"$/u,
    ],
    [
      "the deterministic started-by projection",
      /^started_by="\$\{client_token:0:36\}"$/u,
    ],
    ["the ECS client-token argument", /^--client-token "\$\{client_token\}"$/u],
    ["the ECS started-by argument", /^--started-by "\$\{started_by\}"$/u],
    [
      "the fail-closed RunTask command",
      /^if ! response=\$\(bp_aws "\$\{args\[@\]\}"\); then$/u,
    ],
    [
      "the ambiguous RunTask refusal",
      /^bp_die "ECS RunTask outcome is unknown .*do not change writer state/u,
    ],
    [
      "the fail-closed tasks-stopped waiter",
      /^if ! bp_aws ecs wait tasks-stopped /u,
    ],
    [
      "the ambiguous waiter refusal",
      /^bp_die "ECS waiter failed .*Do not restore writers/u,
    ],
    [
      "the fail-closed terminal describe",
      /^if ! response=\$\(bp_aws ecs describe-tasks /u,
    ],
    [
      "the unverified terminal-state refusal",
      /^bp_die "could not verify terminal task .*do not change writer state"$/u,
    ],
  ],
);
const oneOffTaskLines = oneOffTask ?? [];
const oneOffLinePositions = (expected) =>
  oneOffTaskLines.flatMap((line, index) => (line === expected ? [index] : []));
const explicitTokenDefaultPositions = oneOffLinePositions(
  "local explicit_client_token=false",
);
const requestedTokenBranchPositions = oneOffLinePositions(
  'if [ -n "${requested_client_token}" ]; then',
);
const requestedTokenReusePositions = oneOffLinePositions(
  'client_token="${requested_client_token}"',
);
const explicitTokenTruePositions = oneOffLinePositions(
  "explicit_client_token=true",
);
const randomTokenPositions = oneOffLinePositions(
  'client_token="bp-schema-$(date -u +%s)-${BASHPID}-${RANDOM}"',
);
const explicitTokenElsePosition = oneOffTaskLines.findIndex(
  (line, index) =>
    line === "else" && index > (explicitTokenTruePositions[0] ?? -1),
);
const explicitTokenFiPosition = oneOffTaskLines.findIndex(
  (line, index) => line === "fi" && index > explicitTokenElsePosition,
);
if (
  explicitTokenDefaultPositions.length !== 1 ||
  requestedTokenBranchPositions.length !== 1 ||
  requestedTokenReusePositions.length !== 1 ||
  explicitTokenTruePositions.length !== 1 ||
  randomTokenPositions.length !== 1 ||
  explicitTokenElsePosition < 0 ||
  explicitTokenFiPosition < 0 ||
  !(
    explicitTokenDefaultPositions[0] < requestedTokenBranchPositions[0] &&
    requestedTokenBranchPositions[0] < requestedTokenReusePositions[0] &&
    requestedTokenReusePositions[0] < explicitTokenTruePositions[0] &&
    explicitTokenTruePositions[0] < explicitTokenElsePosition &&
    explicitTokenElsePosition < randomTokenPositions[0] &&
    randomTokenPositions[0] < explicitTokenFiPosition
  )
) {
  report(
    "scripts/lib/ecs-schema-tools.sh",
    oneOffTaskInvariant,
    "sparse replay admission must derive its sole true provenance from the validated explicit client-token branch",
  );
}

const expectedClusterPositions = oneOffLinePositions(
  'expected_cluster="arn:aws:ecs:${AWS_REGION}:${AWS_ACCOUNT}:cluster/${ECS_CLUSTER##*/}"',
);
const oneOffAdmissionLines = oneOffTaskLines
  .map((line, index) => ({ line, index }))
  .filter(
    ({ line }) =>
      line.startsWith(
        "if ! task_arn=$(printf '%s' \"${response}\" | node -e '",
      ) &&
      line.endsWith(
        '\' "${task_definition}" "${expected_cluster}" "${AWS_ACCOUNT}" "${AWS_REGION}" "${ECS_CLUSTER##*/}" "${explicit_client_token}"); then',
      ),
  );
if (
  expectedClusterPositions.length !== 1 ||
  oneOffAdmissionLines.length !== 1 ||
  expectedClusterPositions[0] >= (oneOffAdmissionLines[0]?.index ?? -1)
) {
  report(
    "scripts/lib/ecs-schema-tools.sh",
    oneOffTaskInvariant,
    "RunTask admission must receive the exact task definition, canonical cluster/account/region/name identity, and explicit-token provenance",
  );
}

const waiterPositions = oneOffLinePositions(
  'if ! bp_aws ecs wait tasks-stopped --cluster "${ECS_CLUSTER}" --tasks "${task_arn}" --region "${AWS_REGION}"; then',
);
const terminalDescribePositions = oneOffLinePositions(
  'if ! response=$(bp_aws ecs describe-tasks --cluster "${ECS_CLUSTER}" --tasks "${task_arn}" --region "${AWS_REGION}" --output json); then',
);
const expectedContainerFamilyPositions = oneOffLinePositions(
  'expected_container="${task_definition##*/}"',
);
const expectedContainerNamePositions = oneOffLinePositions(
  'expected_container="${expected_container%%:*}"',
);
const terminalProofLines = oneOffTaskLines
  .map((line, index) => ({ line, index }))
  .filter(
    ({ line }) =>
      line.startsWith("if ! printf '%s' \"${response}\" | node -e '") &&
      line.endsWith(
        '\' "${task_arn}" "${task_definition}" "${expected_cluster}" "${expected_container}"; then',
      ),
  );
if (
  waiterPositions.length !== 1 ||
  terminalDescribePositions.length !== 1 ||
  expectedContainerFamilyPositions.length !== 1 ||
  expectedContainerNamePositions.length !== 1 ||
  terminalProofLines.length !== 1 ||
  !(
    waiterPositions[0] < terminalDescribePositions[0] &&
    terminalDescribePositions[0] < expectedContainerFamilyPositions[0] &&
    expectedContainerFamilyPositions[0] < expectedContainerNamePositions[0] &&
    expectedContainerNamePositions[0] < terminalProofLines[0].index
  )
) {
  report(
    "scripts/lib/ecs-schema-tools.sh",
    oneOffTaskInvariant,
    "the exact task waiter must precede an authoritative terminal DescribeTasks proof for the admitted ARN, definition, cluster, and container",
  );
}

const ecsSchemaNodePrograms = shellSingleQuotedNodePrograms(
  "scripts/lib/ecs-schema-tools.sh",
);
const oneOffAdmissionPrograms = ecsSchemaNodePrograms.filter(
  (program) =>
    tsVariableInitializer(program, "stoppedSparseReplay") &&
    tsVariableInitializer(program, "legacyTaskArn") &&
    tsVariableInitializer(program, "longTaskArn"),
);
const oneOffAdmissionProgram =
  oneOffAdmissionPrograms.length === 1 ? oneOffAdmissionPrograms[0] : null;
if (
  !oneOffAdmissionProgram ||
  oneOffAdmissionProgram.parseDiagnostics.length > 0
) {
  report(
    "scripts/lib/ecs-schema-tools.sh",
    oneOffTaskInvariant,
    "RunTask response must have one parseable full-identity or sparse-replay admission proof",
  );
} else {
  const requireAdmissionInitializer = (name, expected, detail) =>
    requireTsCompactText(
      "scripts/lib/ecs-schema-tools.sh",
      tsVariableInitializer(oneOffAdmissionProgram, name),
      oneOffAdmissionProgram,
      expected,
      oneOffTaskInvariant,
      detail,
    );
  requireAdmissionInitializer(
    "response",
    "JSON.parse(input)",
    "RunTask admission must parse the captured JSON response",
  );
  requireAdmissionInitializer(
    "task",
    "response?.tasks?.[0]",
    "RunTask admission must inspect the sole response task",
  );
  requireAdmissionInitializer(
    "hasTaskDefinition",
    'Object.hasOwn(task??{},"taskDefinitionArn")',
    "sparse replay must prove that the taskDefinitionArn property is absent",
  );
  requireAdmissionInitializer(
    "hasCluster",
    'Object.hasOwn(task??{},"clusterArn")',
    "sparse replay must prove that the clusterArn property is absent",
  );
  requireAdmissionInitializer(
    "fullIdentity",
    "task?.taskDefinitionArn===expectedTaskDefinition&&task?.clusterArn===expectedCluster",
    "ordinary RunTask admission must require the exact task definition and cluster",
  );
  requireAdmissionInitializer(
    "stoppedSparseReplay",
    'explicitClientToken==="true"&&!hasTaskDefinition&&!hasCluster&&task?.lastStatus==="STOPPED"&&task?.desiredStatus==="STOPPED"',
    "sparse replay must require explicit-token provenance, both absent identity properties, and STOPPED/STOPPED",
  );
  requireAdmissionInitializer(
    "legacyTaskArn",
    'newRegExp(`^arn:aws:ecs:${expectedRegion}:${expectedAccount}:task/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`,"u",)',
    "legacy task ARNs must be canonical and bound to the expected region and account",
  );
  requireAdmissionInitializer(
    "longTaskArn",
    'newRegExp(`^arn:aws:ecs:${expectedRegion}:${expectedAccount}:task/${expectedClusterName}/[0-9a-f]{32}$`,"u",)',
    "long task ARNs must be canonical and bound to the expected region, account, and cluster",
  );

  const admissionArgumentDeclarations = descendants(
    oneOffAdmissionProgram,
    (node) =>
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      compactTsText(node.initializer, oneOffAdmissionProgram) ===
        "process.argv.slice(1)",
  );
  if (
    admissionArgumentDeclarations.length !== 1 ||
    compactTsText(
      admissionArgumentDeclarations[0]?.name,
      oneOffAdmissionProgram,
    ) !==
      "[expectedTaskDefinition,expectedCluster,expectedAccount,expectedRegion,expectedClusterName,explicitClientToken,]"
  ) {
    report(
      "scripts/lib/ecs-schema-tools.sh",
      oneOffTaskInvariant,
      "RunTask admission arguments must preserve exact task, cluster, account, region, cluster-name, and explicit-token provenance",
    );
  }
  const admissionGuards = descendants(
    oneOffAdmissionProgram,
    ts.isIfStatement,
  ).filter((statement) =>
    compactTsText(statement.expression, oneOffAdmissionProgram).includes(
      "!fullIdentity&&!stoppedSparseReplay",
    ),
  );
  const expectedAdmissionGuard =
    '!Array.isArray(response?.tasks)||response.tasks.length!==1||!Array.isArray(response?.failures)||response.failures.length!==0||typeoftask?.taskArn!=="string"||(!legacyTaskArn.test(task.taskArn)&&!longTaskArn.test(task.taskArn))||(!fullIdentity&&!stoppedSparseReplay)';
  if (
    admissionGuards.length !== 1 ||
    compactTsText(admissionGuards[0]?.expression, oneOffAdmissionProgram) !==
      expectedAdmissionGuard ||
    compactTsText(admissionGuards[0]?.thenStatement, oneOffAdmissionProgram) !==
      "process.exit(2);"
  ) {
    report(
      "scripts/lib/ecs-schema-tools.sh",
      oneOffTaskInvariant,
      "RunTask admission must require exactly one canonical task, no failures, and exact full identity or exact stopped sparse replay",
    );
  }
  const admittedArnWrites = descendants(
    oneOffAdmissionProgram,
    ts.isCallExpression,
  ).filter(
    (call) =>
      compactTsText(call, oneOffAdmissionProgram) ===
      "process.stdout.write(task.taskArn)",
  );
  if (admittedArnWrites.length !== 1) {
    report(
      "scripts/lib/ecs-schema-tools.sh",
      oneOffTaskInvariant,
      "RunTask admission must return the sole structurally admitted task ARN",
    );
  }
}

const terminalTaskPrograms = ecsSchemaNodePrograms.filter(
  (program) =>
    program.getFullText().includes("expectedArn") &&
    tsVariableInitializer(program, "container") &&
    program.getFullText().includes("container?.exitCode"),
);
const terminalTaskProgram =
  terminalTaskPrograms.length === 1 ? terminalTaskPrograms[0] : null;
if (!terminalTaskProgram || terminalTaskProgram.parseDiagnostics.length > 0) {
  report(
    "scripts/lib/ecs-schema-tools.sh",
    oneOffTaskInvariant,
    "terminal DescribeTasks must have one parseable authoritative task/container proof",
  );
} else {
  requireTsCompactText(
    "scripts/lib/ecs-schema-tools.sh",
    tsVariableInitializer(terminalTaskProgram, "response"),
    terminalTaskProgram,
    "JSON.parse(input)",
    oneOffTaskInvariant,
    "terminal proof must parse the authoritative DescribeTasks JSON response",
  );
  requireTsCompactText(
    "scripts/lib/ecs-schema-tools.sh",
    tsVariableInitializer(terminalTaskProgram, "task"),
    terminalTaskProgram,
    "response?.tasks?.[0]",
    oneOffTaskInvariant,
    "terminal proof must inspect the sole described task",
  );
  requireTsCompactText(
    "scripts/lib/ecs-schema-tools.sh",
    tsVariableInitializer(terminalTaskProgram, "container"),
    terminalTaskProgram,
    "task?.containers?.[0]",
    oneOffTaskInvariant,
    "terminal proof must inspect the sole described container",
  );
  const terminalArgumentDeclarations = descendants(
    terminalTaskProgram,
    (node) =>
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      compactTsText(node.initializer, terminalTaskProgram) ===
        "process.argv.slice(1)",
  );
  if (
    terminalArgumentDeclarations.length !== 1 ||
    compactTsText(
      terminalArgumentDeclarations[0]?.name,
      terminalTaskProgram,
    ) !==
      "[expectedArn,expectedTaskDefinition,expectedCluster,expectedContainer]"
  ) {
    report(
      "scripts/lib/ecs-schema-tools.sh",
      oneOffTaskInvariant,
      "terminal proof arguments must preserve the admitted ARN, task definition, cluster, and expected container",
    );
  }
  const terminalGuards = descendants(
    terminalTaskProgram,
    ts.isIfStatement,
  ).filter((statement) =>
    compactTsText(statement.expression, terminalTaskProgram).includes(
      "container?.exitCode",
    ),
  );
  const expectedTerminalGuard =
    '!Array.isArray(response?.tasks)||response.tasks.length!==1||!Array.isArray(response?.failures)||response.failures.length!==0||task?.taskArn!==expectedArn||task?.taskDefinitionArn!==expectedTaskDefinition||task?.clusterArn!==expectedCluster||task?.lastStatus!=="STOPPED"||!Array.isArray(task?.containers)||task.containers.length!==1||container?.name!==expectedContainer||container?.lastStatus!=="STOPPED"||container?.exitCode!==0';
  if (
    terminalGuards.length !== 1 ||
    compactTsText(terminalGuards[0]?.expression, terminalTaskProgram) !==
      expectedTerminalGuard ||
    compactTsText(terminalGuards[0]?.thenStatement, terminalTaskProgram) !==
      "process.exit(2);"
  ) {
    report(
      "scripts/lib/ecs-schema-tools.sh",
      oneOffTaskInvariant,
      "terminal DescribeTasks must prove exactly one failure-free matching STOPPED task with one matching STOPPED exit-zero container",
    );
  }
}

const databaseSecretIdentityPrograms = ecsSchemaNodePrograms.filter(
  (program) =>
    program.getFullText().includes("expectedHost") &&
    program.getFullText().includes("DATABASE_URL identity validation failed"),
);
const databaseSecretIdentityProgram =
  databaseSecretIdentityPrograms.length === 1
    ? databaseSecretIdentityPrograms[0]
    : null;
const databaseSecretProtocolConditions = databaseSecretIdentityProgram
  ? descendants(databaseSecretIdentityProgram, ts.isIfStatement).filter(
      (statement) =>
        compactTsText(
          statement.expression,
          databaseSecretIdentityProgram,
        ).includes("url.protocol"),
    )
  : [];
if (
  databaseSecretIdentityPrograms.length !== 1 ||
  databaseSecretIdentityProgram?.parseDiagnostics.length > 0 ||
  databaseSecretProtocolConditions.length !== 1 ||
  compactTsText(
    databaseSecretProtocolConditions[0]?.expression,
    databaseSecretIdentityProgram,
  ) !== 'url.protocol!=="postgresql:"'
) {
  report(
    "scripts/lib/ecs-schema-tools.sh",
    databaseTlsInvariant,
    "the streamed canonical live DATABASE_URL secret must require the exact postgresql: protocol",
  );
}

const cutoverLines = shellLogicalLines(files["scripts/p2-schema-cutover.sh"]);
const cutoverNodePrograms = shellSingleQuotedNodePrograms(
  "scripts/p2-schema-cutover.sh",
);
const writerSnapshotPrograms = cutoverNodePrograms.filter(
  (program) =>
    tsVariableInitializer(program, "modes") &&
    tsVariableInitializer(program, "epochs"),
);
const writerSnapshotProgram =
  writerSnapshotPrograms.length === 1 ? writerSnapshotPrograms[0] : null;
if (
  !writerSnapshotProgram ||
  writerSnapshotProgram.parseDiagnostics.length > 0 ||
  compactTsText(
    tsVariableInitializer(writerSnapshotProgram, "modes"),
    writerSnapshotProgram,
  ) !== 'exact("BlueprintParserWriterMode")' ||
  compactTsText(
    tsVariableInitializer(writerSnapshotProgram, "epochs"),
    writerSnapshotProgram,
  ) !== 'exact("BlueprintParserWriterModeEpoch")'
) {
  report(
    "scripts/p2-schema-cutover.sh",
    writerEpochInvariant,
    "writer_mode_snapshot must parse exactly one canonical writer mode and epoch tag",
  );
}
const writerSnapshotConditions = writerSnapshotProgram
  ? descendants(writerSnapshotProgram, ts.isIfStatement).filter((statement) =>
      compactTsText(statement.expression, writerSnapshotProgram).includes(
        "epochs.length",
      ),
    )
  : [];
if (
  writerSnapshotConditions.length !== 1 ||
  compactTsText(
    writerSnapshotConditions[0]?.expression,
    writerSnapshotProgram,
  ) !==
    "modes.length!==1||modes[0].value!==expectedMode||epochs.length!==1||!/^[0-9a-f]{64}$/u.test(epochs[0].value)"
) {
  report(
    "scripts/p2-schema-cutover.sh",
    writerEpochInvariant,
    "the remote service tag must bind the expected mode to exactly one 64-lowercase-hex epoch",
  );
}
for (const [argument, detail] of [
  [
    "epochs[0].value",
    "the remote writer-mode tag epoch must be exact lowercase SHA-256 hex",
  ],
  [
    "outageEpoch",
    "a newly written witness must accept only an exact lowercase-hex epoch",
  ],
  [
    "record.outageEpoch",
    "a loaded witness must accept only an exact lowercase-hex epoch",
  ],
  [
    "nonce",
    "a newly written witness must accept only an exact lowercase-hex nonce",
  ],
  [
    "record.nonce",
    "a loaded witness must accept only an exact lowercase-hex nonce",
  ],
]) {
  const receivers = regexTestReceivers(cutoverNodePrograms, argument);
  if (
    receivers.length !== 1 ||
    compactTsText(receivers[0]?.receiver, receivers[0]?.program) !==
      "/^[0-9a-f]{64}$/u"
  ) {
    report("scripts/p2-schema-cutover.sh", writerEpochInvariant, detail);
  }
}
const witnessWriterPrograms = cutoverNodePrograms.filter(
  (program) =>
    regexTestReceivers([program], "outageEpoch").length === 1 &&
    tsVariableInitializer(program, "record"),
);
const witnessWriterProgram =
  witnessWriterPrograms.length === 1 ? witnessWriterPrograms[0] : null;
const witnessRecord = witnessWriterProgram
  ? tsVariableInitializer(witnessWriterProgram, "record")
  : null;
const witnessRecordEpoch = requireTsProperty(
  "scripts/p2-schema-cutover.sh",
  witnessRecord,
  "outageEpoch",
  writerEpochInvariant,
);
requireTsCompactText(
  "scripts/p2-schema-cutover.sh",
  witnessRecordEpoch,
  witnessWriterProgram,
  "outageEpoch",
  writerEpochInvariant,
  "the owner-local witness record must persist the remotely observed outage epoch",
);
const witnessLoaderPrograms = cutoverNodePrograms.filter(
  (program) => regexTestReceivers([program], "record.outageEpoch").length === 1,
);
const witnessLoaderProgram =
  witnessLoaderPrograms.length === 1 ? witnessLoaderPrograms[0] : null;
const witnessExpectedKeys = witnessLoaderProgram
  ? tsVariableInitializer(witnessLoaderProgram, "expectedKeys")
  : null;
const writerWitnessReceiptKeys = [
  "account",
  "baselineCpuTaskDefinition",
  "baselineDigest",
  "baselineMaintenanceTaskDefinition",
  "baselineMigratorTaskDefinition",
  "baselineTaskDefinition",
  "candidateCpuTaskDefinition",
  "candidateDigest",
  "candidateMaintenanceTaskDefinition",
  "candidateMigratorTaskDefinition",
  "candidateTaskDefinition",
  "cluster",
  "databaseSecret",
  "ecrRepo",
  "expiresAtEpoch",
  "issuedAtEpoch",
  "nonce",
  "outageEpoch",
  "phase",
  "region",
  "scheduleGeneration",
  "service",
  "version",
];
const witnessRecordKeys =
  witnessRecord && ts.isObjectLiteralExpression(witnessRecord)
    ? witnessRecord.properties.map((property) =>
        "name" in property ? tsPropertyName(property.name) : null,
      )
    : [];
const witnessLoaderKeys =
  witnessExpectedKeys && ts.isArrayLiteralExpression(witnessExpectedKeys)
    ? witnessExpectedKeys.elements.map((element) =>
        ts.isStringLiteral(element) ? element.text : null,
      )
    : [];
if (
  !witnessRecord ||
  !ts.isObjectLiteralExpression(witnessRecord) ||
  witnessRecordKeys.some((key) => key === null) ||
  JSON.stringify([...witnessRecordKeys].sort()) !==
    JSON.stringify(writerWitnessReceiptKeys) ||
  JSON.stringify(witnessLoaderKeys) !== JSON.stringify(writerWitnessReceiptKeys)
) {
  report(
    "scripts/p2-schema-cutover.sh",
    writerEpochInvariant,
    "the exact v2 receipt schema must bind every baseline/candidate task definition, digest, database secret, epoch, schedule timestamp, issue/expiry time, and nonce",
  );
}
const witnessRecordVersion = requireTsProperty(
  "scripts/p2-schema-cutover.sh",
  witnessRecord,
  "version",
  writerEpochInvariant,
);
const witnessRecordCandidateDigest = requireTsProperty(
  "scripts/p2-schema-cutover.sh",
  witnessRecord,
  "candidateDigest",
  writerEpochInvariant,
);
requireTsCompactText(
  "scripts/p2-schema-cutover.sh",
  witnessRecordVersion,
  witnessWriterProgram,
  "2",
  writerEpochInvariant,
  "the writer witness must remain exact schema version 2",
);
requireTsCompactText(
  "scripts/p2-schema-cutover.sh",
  witnessRecordCandidateDigest,
  witnessWriterProgram,
  "candidateDigestArg",
  writerEpochInvariant,
  "the writer witness must bind the explicitly intended candidate digest",
);
for (const [name, expected, detail] of [
  [
    "ttl",
    "Number(ttlArg)",
    "the receipt TTL must come from the fixed shell constant",
  ],
  [
    "creating",
    'issuedAtArg==="-"&&expiresAtArg==="-"&&nonceArg==="-"',
    "new receipt timing and nonce authority must be created as one tuple",
  ],
  [
    "issuedAtEpoch",
    "creating?nowEpoch:Number(issuedAtArg)",
    "receipt rewrites must preserve the original issue time",
  ],
  [
    "durable",
    'phase==="quiescent-bound"',
    "only the fully bound phase may be nonexpiring",
  ],
  [
    "expiresAtEpoch",
    "durable?null:(creating?nowEpoch+ttl:Number(expiresAtArg))",
    "transient receipts must preserve their fixed absolute expiry",
  ],
  [
    "nonce",
    'creating?randomBytes(32).toString("hex"):nonceArg',
    "receipt rewrites must preserve the original nonce",
  ],
]) {
  requireTsCompactText(
    "scripts/p2-schema-cutover.sh",
    witnessWriterProgram
      ? tsVariableInitializer(witnessWriterProgram, name)
      : null,
    witnessWriterProgram,
    expected,
    writerEpochInvariant,
    detail,
  );
}
const writerReceiptConditions = witnessWriterProgram
  ? descendants(witnessWriterProgram, ts.isIfStatement).filter((statement) =>
      compactTsText(statement.expression, witnessWriterProgram).includes(
        "candidate-admitted",
      ),
    )
  : [];
const loaderReceiptConditions = witnessLoaderProgram
  ? descendants(witnessLoaderProgram, ts.isIfStatement).filter((statement) =>
      compactTsText(statement.expression, witnessLoaderProgram).includes(
        "candidate-admitted",
      ),
    )
  : [];
const writerReceiptCondition = compactTsText(
  writerReceiptConditions[0]?.expression,
  witnessWriterProgram,
);
const loaderReceiptCondition = compactTsText(
  loaderReceiptConditions[0]?.expression,
  witnessLoaderProgram,
);
if (
  writerReceiptConditions.length !== 1 ||
  !writerReceiptCondition.includes(
    '!["outage-preflight","candidate-admitted","empty-bootstrap-armed","quiescent-bound"].includes(phase)',
  ) ||
  !writerReceiptCondition.includes(
    'durable?expiresAtArg!=="null":(!Number.isSafeInteger(expiresAtEpoch)||expiresAtEpoch!==issuedAtEpoch+ttl||expiresAtEpoch<=nowEpoch)',
  ) ||
  !writerReceiptCondition.includes(
    'phase==="candidate-admitted"&&(bootstrap||!validCandidateDefinitions)',
  ) ||
  loaderReceiptConditions.length !== 1 ||
  !loaderReceiptCondition.includes(
    '!["outage-preflight","candidate-admitted","empty-bootstrap-armed","quiescent-bound"].includes(record.phase)',
  ) ||
  !loaderReceiptCondition.includes(
    'record.phase==="quiescent-bound"?record.expiresAtEpoch!==null:(!Number.isSafeInteger(record.expiresAtEpoch)||record.expiresAtEpoch!==record.issuedAtEpoch+21600||record.expiresAtEpoch<=nowEpoch)',
  ) ||
  !loaderReceiptCondition.includes('record.phase==="candidate-admitted"')
) {
  report(
    "scripts/p2-schema-cutover.sh",
    writerEpochInvariant,
    "transient baseline, candidate-admitted, and empty-bootstrap receipts must expire after exactly six hours while only a fully proved quiescent-bound receipt is durable",
  );
}
const quiescentPreflight = shellFunction(
  cutoverLines,
  "assert_quiescent_preflight",
);
const verifyRestored = shellFunction(cutoverLines, "verify_restored");
const cutoverShellInvariant =
  "cutover must prove every launcher/writer is quiescent, migrate once, bind at zero, and verify restore";
requireShellFunctionLines(
  "scripts/p2-schema-cutover.sh",
  cutoverShellInvariant,
  "assert_quiescent_preflight",
  quiescentPreflight,
  [
    [
      "the disabled maintenance schedule assertion",
      /^assert_eq "\$\{schedule_state\}" "DISABLED" /u,
    ],
    ["the zero desired-count assertion", /^assert_eq "\$\{desired\}" "0" /u],
    ["the zero running-count assertion", /^assert_eq "\$\{running\}" "0" /u],
    ["the zero pending-count assertion", /^assert_eq "\$\{pending\}" "0" /u],
    ["the zero minimum assertion", /^assert_eq "\$\{min_capacity\}" "0" /u],
    ["the bounded maximum assertion", /^assert_eq "\$\{max_capacity\}" "1" /u],
    [
      "dynamic scale-in suspension",
      /^assert_boolean "\$\{scale_in_suspended\}" true /u,
    ],
    [
      "dynamic scale-out suspension",
      /^assert_boolean "\$\{scale_out_suspended\}" true /u,
    ],
    [
      "scheduled scaling suspension",
      /^assert_boolean "\$\{scheduled_scaling_suspended\}" true /u,
    ],
    [
      "the zero running-execution assertion",
      /^assert_eq "\$\{running_executions\}" "0" /u,
    ],
    ["the standalone writer-task assertion", /^assert_no_writer_tasks$/u],
  ],
);
requireShellFunctionLines(
  "scripts/p2-schema-cutover.sh",
  cutoverShellInvariant,
  "verify_restored",
  verifyRestored,
  [
    [
      "the restored positive service assertion",
      /^bp_assert_service_revision_stable "\$\{APP_TASK_DEFINITION\}" 1$/u,
    ],
    ["the exact restored desired count", /^assert_eq "\$\{desired\}" "1" /u],
    ["the exact restored running count", /^assert_eq "\$\{running\}" "1" /u],
    ["the exact restored minimum", /^assert_eq "\$\{min_capacity\}" "1" /u],
    ["the restored maximum assertion", /^assert_eq "\$\{max_capacity\}" "1" /u],
    [
      "restored dynamic scale-in",
      /^assert_boolean "\$\{scale_in_suspended\}" false /u,
    ],
    [
      "restored dynamic scale-out",
      /^assert_boolean "\$\{scale_out_suspended\}" false /u,
    ],
    [
      "restored scheduled scaling",
      /^assert_boolean "\$\{scheduled_scaling_suspended\}" false /u,
    ],
  ],
);
requireAll(
  "scripts/p2-schema-cutover.sh",
  [
    'assert_eq "${schedule_state}" "DISABLED"',
    'assert_eq "${desired}" "0"',
    'assert_eq "${running}" "0"',
    'assert_eq "${pending}" "0"',
    'assert_eq "${min_capacity}" "0"',
    'assert_eq "${max_capacity}" "1"',
    'assert_boolean "${scale_in_suspended}" true',
    'assert_boolean "${scale_out_suspended}" true',
    'assert_boolean "${scheduled_scaling_suspended}" true',
    'assert_boolean "${scale_out_suspended}" false',
    'assert_eq "${running_executions}" "0"',
    "MAINTENANCE_MAX_EVENT_AGE_SECONDS=600",
    "ECS_CONSISTENCY_WINDOW_SECONDS=300",
    "QUIESCENCE_OBSERVATION_SECONDS=300",
    'sleep "${QUIESCENCE_OBSERVATION_SECONDS}"',
    "bp_assert_task_definition_contract",
    "bp_task_definition_label_studio_identity",
    "bp_assert_state_machine_task_definition",
    "bp_assert_maintenance_schedule_contract",
    "BP_SCHEMA_MIGRATION_MODE",
    "schema-readiness",
    "readiness_overrides",
    "retire_pre_boundary_task_definitions",
    "ecs deregister-task-definition",
    'bp_assert_service_revision_stable "${APP_TASK_DEFINITION}" 0',
    'bp_assert_service_revision_stable "${APP_TASK_DEFINITION}" 1',
    'assert_eq "${desired}" "1"',
    'assert_eq "${running}" "1"',
    'assert_eq "${min_capacity}" "1"',
    "assert_no_writer_tasks",
    "bp_run_one_off_task",
    "--desired-count 0",
    "verify-restored",
  ],
  "cutover must prove every launcher/writer is quiescent, migrate once, bind at zero, and verify restore",
);
forbid(
  "scripts/p2-schema-cutover.sh",
  [
    "BP_RESTORED_DESIRED_COUNT",
    "BP_RESTORED_MIN_COUNT",
    "BP_REQUIRE_COHORT_WITNESS",
  ],
  "restore must require the exact live tuple and an unconditional cohort witness",
);
const writerWitnessInvariant =
  "candidate and P2-boundary rollouts must serialize an exact candidate-bound, epoch-bound owner receipt before mutation and consume it only after exact live restore";
const writerOperationLock = shellFunction(
  cutoverLines,
  "acquire_writer_operation_lock",
);
const writerModeSnapshot = shellFunction(cutoverLines, "writer_mode_snapshot");
const assertWitnessEpoch = shellFunction(
  cutoverLines,
  "assert_witness_outage_epoch",
);
const outagePreflight = shellFunction(
  cutoverLines,
  "preflight_writer_outage_cohort",
);
const witnessedBaseline = shellFunction(
  cutoverLines,
  "assert_witnessed_baseline_binding",
);
const admittedCandidateContract = shellFunction(
  cutoverLines,
  "assert_admitted_candidate_contract",
);
const admittedServiceBinding = shellFunction(
  cutoverLines,
  "assert_admitted_service_binding",
);
const writeCandidateAdmission = shellFunction(
  cutoverLines,
  "write_candidate_admission",
);
const bindQuiescent = shellFunction(
  cutoverLines,
  "bind_quiescent_writer_cohort",
);
const retirePreBoundaryDefinitions = shellFunction(
  cutoverLines,
  "retire_pre_boundary_task_definitions",
);
const assertRetainedDefinitions = shellFunction(
  cutoverLines,
  "assert_retained_task_definitions_only",
);
const verifyWriterCohort = shellFunction(
  cutoverLines,
  "verify_writer_cohort_restored",
);
requireShellFunctionLines(
  "scripts/p2-schema-cutover.sh",
  writerWitnessInvariant,
  "acquire_writer_operation_lock",
  writerOperationLock,
  [
    [
      "the owner-local nonblocking flock",
      /^if ! flock -n "\$\{WRITER_OPERATION_LOCK_FD\}"; then$/u,
    ],
    ["the immutable held descriptor", /^readonly WRITER_OPERATION_LOCK_FD$/u],
  ],
);
requireShellFunctionLines(
  "scripts/p2-schema-cutover.sh",
  writerWitnessInvariant,
  "writer_mode_snapshot",
  writerModeSnapshot,
  [
    [
      "the canonical ECS service ARN derivation",
      /^expected_service_arn="arn:aws:ecs:\$\{AWS_REGION\}:\$\{AWS_ACCOUNT\}:service\/\$\{ECS_CLUSTER##\*\/\}\/\$\{ECS_SERVICE##\*\/\}"$/u,
    ],
    [
      "the exact service ARN assertion",
      /^assert_eq "\$\{service_arn\}" "\$\{expected_service_arn\}" "writer-mode epoch service ARN" \|\| return 1$/u,
    ],
    [
      "the remote ECS tag read",
      /^tags_json=\$\(bp_aws ecs list-tags-for-resource /u,
    ],
  ],
);
requireShellFunctionLines(
  "scripts/p2-schema-cutover.sh",
  writerWitnessInvariant,
  "assert_witness_outage_epoch",
  assertWitnessEpoch,
  [
    [
      "the live remote outage-epoch read",
      /^current_epoch=\$\(writer_mode_snapshot outage\)$/u,
    ],
    [
      "the exact receipt/remote epoch equality",
      /^assert_eq "\$\{current_epoch\}" "\$\{WRITER_WITNESS_OUTAGE_EPOCH\}" "writer witness outage epoch"$/u,
    ],
  ],
);
if (
  cutoverLines.filter(
    (line) => line === "readonly WRITER_WITNESS_TTL_SECONDS=21600",
  ).length !== 1 ||
  cutoverLines.filter((line) => line === "acquire_writer_operation_lock")
    .length !== 1
) {
  report(
    "scripts/p2-schema-cutover.sh",
    writerWitnessInvariant,
    "the operation lock must be acquired exactly once and transient receipt TTL must remain exactly six hours",
  );
}
requireShellFunctionLines(
  "scripts/p2-schema-cutover.sh",
  writerWitnessInvariant,
  "preflight_writer_outage_cohort",
  outagePreflight,
  [
    [
      "the old-digest outage proof",
      /^assert_quiescent_preflight "\$\{expected_image\}"$/u,
    ],
    [
      "the bound service task-definition equality",
      /^assert_eq "\$\{service_task_definition\}" "\$\{APP_TASK_DEFINITION\}" /u,
    ],
    [
      "the baseline witness write",
      /^write_writer_outage_witness outage-preflight /u,
    ],
    [
      "the stable remote outage epoch re-read",
      /^final_epoch=\$\(writer_mode_snapshot outage\)$/u,
    ],
  ],
);
requireShellFunctionLines(
  "scripts/p2-schema-cutover.sh",
  writerWitnessInvariant,
  "assert_witnessed_baseline_binding",
  witnessedBaseline,
  [
    ["the witness load", /^load_writer_outage_witness$/u],
    [
      "the preflight-phase assertion",
      /^assert_eq "\$\{WRITER_WITNESS_PHASE\}" outage-preflight /u,
    ],
    [
      "the intended candidate assertion",
      /^assert_eq "\$\{WRITER_WITNESS_CANDIDATE_DIGEST\}" "\$\{candidate_digest\}" /u,
    ],
    ["the remote outage epoch assertion", /^assert_witness_outage_epoch$/u],
    [
      "the exact baseline service binding",
      /^assert_eq "\$\{service_task_definition\}" "\$\{WRITER_WITNESS_BASELINE_TASK_DEFINITION\}" /u,
    ],
    [
      "the zero-count baseline stability proof",
      /^bp_assert_service_revision_stable "\$\{service_task_definition\}" 0$/u,
    ],
  ],
);
requireShellFunctionLines(
  "scripts/p2-schema-cutover.sh",
  writerWitnessInvariant,
  "assert_admitted_candidate_contract",
  admittedCandidateContract,
  [
    [
      "the candidate-admitted phase assertion",
      /^assert_eq "\$\{WRITER_WITNESS_PHASE\}" candidate-admitted /u,
    ],
    [
      "the exact candidate digest assertion",
      /^assert_eq "\$\{WRITER_WITNESS_CANDIDATE_DIGEST\}" "\$\{candidate_digest\}" /u,
    ],
    [
      "the exact candidate app task definition",
      /^assert_eq "\$\{WRITER_WITNESS_CANDIDATE_TASK_DEFINITION\}" "\$\{APP_TASK_DEFINITION\}" /u,
    ],
    [
      "the exact candidate CPU task definition",
      /^assert_eq "\$\{WRITER_WITNESS_CANDIDATE_CPU_TASK_DEFINITION\}" "\$\{CPU_TASK_DEFINITION\}" /u,
    ],
    [
      "the exact candidate maintenance task definition",
      /^assert_eq "\$\{WRITER_WITNESS_CANDIDATE_MAINTENANCE_TASK_DEFINITION\}" "\$\{MAINTENANCE_TASK_DEFINITION\}" /u,
    ],
    [
      "the exact candidate migrator task definition",
      /^assert_eq "\$\{WRITER_WITNESS_CANDIDATE_MIGRATOR_TASK_DEFINITION\}" "\$\{MIGRATOR_TASK_DEFINITION\}" /u,
    ],
    [
      "the exact candidate database secret",
      /^assert_eq "\$\{WRITER_WITNESS_DATABASE_SECRET\}" "\$\{APP_DATABASE_SECRET\}" /u,
    ],
    ["the live outage epoch recheck", /^assert_witness_outage_epoch$/u],
  ],
);
requireShellFunctionLines(
  "scripts/p2-schema-cutover.sh",
  writerWitnessInvariant,
  "assert_admitted_service_binding",
  admittedServiceBinding,
  [
    [
      "the exact baseline service retry branch",
      /^if \[ "\$\{service_task_definition\}" = "\$\{WRITER_WITNESS_BASELINE_TASK_DEFINITION\}" \]; then$/u,
    ],
    [
      "the exact candidate service retry branch",
      /^elif \[ "\$\{service_task_definition\}" = "\$\{WRITER_WITNESS_CANDIDATE_TASK_DEFINITION\}" \]; then$/u,
    ],
    [
      "the baseline image binding",
      /^assert_eq "\$\{service_image\}" "\$\{baseline_image\}" /u,
    ],
    [
      "the candidate image binding",
      /^assert_eq "\$\{service_image\}" "\$\{candidate_image\}" /u,
    ],
    [
      "the refusal of every unrecorded service revision",
      /^bp_die "app service uses .*expected the admitted baseline or candidate task definition"$/u,
    ],
    [
      "the exact selected zero-count stability proof",
      /^bp_assert_service_revision_stable "\$\{service_task_definition\}" 0$/u,
    ],
  ],
);
requireShellFunctionLines(
  "scripts/p2-schema-cutover.sh",
  writerWitnessInvariant,
  "write_candidate_admission",
  writeCandidateAdmission,
  [
    [
      "the candidate-admitted write-ahead phase",
      /^write_writer_outage_witness candidate-admitted /u,
    ],
    [
      "all four exact baseline task definitions",
      /^write_writer_outage_witness candidate-admitted .*"\$\{WRITER_WITNESS_BASELINE_TASK_DEFINITION\}" "\$\{WRITER_WITNESS_BASELINE_CPU_TASK_DEFINITION\}" "\$\{WRITER_WITNESS_BASELINE_MAINTENANCE_TASK_DEFINITION\}" "\$\{WRITER_WITNESS_BASELINE_MIGRATOR_TASK_DEFINITION\}" /u,
    ],
    [
      "all four exact candidate task definitions",
      /"\$\{candidate_digest\}" "\$\{APP_TASK_DEFINITION\}" "\$\{CPU_TASK_DEFINITION\}" "\$\{MAINTENANCE_TASK_DEFINITION\}" "\$\{MIGRATOR_TASK_DEFINITION\}" /u,
    ],
    [
      "the original database, epoch, issue, expiry, and nonce tuple",
      /"\$\{APP_DATABASE_SECRET\}" "\$\{WRITER_WITNESS_OUTAGE_EPOCH\}" "\$\{generation\}" "\$\{WRITER_WITNESS_ISSUED_AT_EPOCH\}" "\$\{WRITER_WITNESS_EXPIRES_AT_EPOCH\}" "\$\{WRITER_WITNESS_NONCE\}"$/u,
    ],
    ["the persisted receipt reload", /^load_writer_outage_witness$/u],
    [
      "the admitted receipt revalidation",
      /^assert_admitted_candidate_contract "\$\{candidate_digest\}"$/u,
    ],
  ],
);
requireShellFunctionLines(
  "scripts/p2-schema-cutover.sh",
  writerWitnessInvariant,
  "bind_quiescent_writer_cohort",
  bindQuiescent,
  [
    [
      "the baseline-phase prerequisite",
      /^assert_witnessed_baseline_binding "\$\{candidate_digest\}"$/u,
    ],
    ["the candidate-admitted retry phase", /^candidate-admitted\)$/u],
    [
      "the candidate outage proof",
      /^assert_quiescent_preflight "\$\{candidate_image\}"$/u,
    ],
    [
      "the exact admitted service retry",
      /^assert_admitted_service_binding "\$\{candidate_image\}"$/u,
    ],
    [
      "the write-ahead candidate admission",
      /^write_candidate_admission "\$\{candidate_digest\}"$/u,
    ],
    ["the remote outage epoch assertion", /^assert_witness_outage_epoch$/u],
    ["the zero-count service bind", /^bp_aws ecs update-service /u],
    [
      "the bound candidate stability proof",
      /^bp_assert_service_revision_stable "\$\{WRITER_WITNESS_CANDIDATE_TASK_DEFINITION\}" 0$/u,
    ],
    [
      "the bound candidate witness",
      /^write_writer_outage_witness quiescent-bound /u,
    ],
  ],
);
for (const [name, lines, expectedCalls] of [
  [
    "retire_pre_boundary_task_definitions",
    retirePreBoundaryDefinitions,
    [
      'retire_other_active_revisions "${APP_FAMILY}" "${APP_TASK_DEFINITION}"',
      'retire_other_active_revisions "${CPU_FAMILY}" "${CPU_TASK_DEFINITION}"',
      'retire_other_active_revisions "${MAINTENANCE_FAMILY}" "${MAINTENANCE_TASK_DEFINITION}"',
      'retire_other_active_revisions "${MIGRATOR_FAMILY}" "${MIGRATOR_TASK_DEFINITION}"',
    ],
  ],
  [
    "assert_retained_task_definitions_only",
    assertRetainedDefinitions,
    [
      'assert_eq "${revisions}" "${APP_TASK_DEFINITION}" "sole retained ACTIVE app task definition"',
      'assert_eq "${revisions}" "${CPU_TASK_DEFINITION}" "sole retained ACTIVE CPU task definition"',
      'assert_eq "${revisions}" "${MAINTENANCE_TASK_DEFINITION}" "sole retained ACTIVE maintenance task definition"',
      'assert_eq "${revisions}" "${MIGRATOR_TASK_DEFINITION}" "sole retained ACTIVE migrator task definition"',
    ],
  ],
]) {
  if (
    !lines ||
    expectedCalls.some(
      (expected) => lines.filter((line) => line === expected).length !== 1,
    )
  ) {
    report(
      "scripts/p2-schema-cutover.sh",
      writerWitnessInvariant,
      `${name} must cover each of the four exact writer families exactly once`,
    );
  }
}
requireShellFunctionLines(
  "scripts/p2-schema-cutover.sh",
  writerWitnessInvariant,
  "verify_writer_cohort_restored",
  verifyWriterCohort,
  [
    ["the witness load", /^load_writer_outage_witness$/u],
    [
      "the bound-phase assertion",
      /^assert_eq "\$\{WRITER_WITNESS_PHASE\}" quiescent-bound /u,
    ],
    [
      "the exact live verification",
      /^verify_restored "\$\{expected_image\}"$/u,
    ],
    [
      "the canonical live epoch read",
      /^live_epoch=\$\(writer_mode_snapshot live\)$/u,
    ],
    ["the witness consumption", /^rm -- "\$\{witness_path\}"$/u],
  ],
);
requireAll(
  "scripts/p2-schema-cutover.sh",
  [
    "acquire_writer_operation_lock",
    "writer_mode_snapshot",
    "write_writer_outage_witness",
    "load_writer_outage_witness",
    "assert_witness_outage_epoch",
    "outage-preflight",
    "candidate-admitted",
    "empty-bootstrap-armed",
    "quiescent-bound",
    "empty-database-strict-readiness",
    "empty-database-armed-retry-readiness",
    'migration_client_token="bp-empty-${WRITER_WITNESS_NONCE:0:48}"',
    'migration_client_token="bp-p2-${WRITER_WITNESS_NONCE:0:48}"',
    "baselineCpuTaskDefinition",
    "baselineMaintenanceTaskDefinition",
    "baselineMigratorTaskDefinition",
    "candidateCpuTaskDefinition",
    "candidateMaintenanceTaskDefinition",
    "candidateMigratorTaskDefinition",
    "issuedAtEpoch",
    "expiresAtEpoch",
    "scheduleGeneration",
    'run_migration_and_bind "${EXPECTED_IMAGE}" "${P2_MIGRATION_MODE}" "P2 boundary" "witnessed-boundary"',
    'run_migration_and_bind "${EXPECTED_IMAGE}" "${EMPTY_BOOTSTRAP_MODE}" "empty-database bootstrap" "empty-bootstrap"',
    'verify_writer_cohort_restored "${EXPECTED_IMAGE}" "${BP_APP_IMAGE_DIGEST}"',
  ],
  writerWitnessInvariant,
);
const migrationAndBind = shellFunction(cutoverLines, "run_migration_and_bind");
const commandPosition = (pattern) =>
  migrationAndBind?.findIndex((line) => pattern.test(line)) ?? -1;
const commandPositions = (pattern) =>
  (migrationAndBind ?? [])
    .map((line, index) => (pattern.test(line) ? index : -1))
    .filter((index) => index >= 0);
const preflights = (migrationAndBind ?? [])
  .map((line, index) =>
    line === 'assert_quiescent_preflight "${expected_image}"' ? index : -1,
  )
  .filter((index) => index >= 0);
const ordered = [
  commandPosition(
    /^assert_witnessed_baseline_binding "\$\{BP_APP_IMAGE_DIGEST\}"$/u,
  ),
  preflights[0] ?? -1,
  commandPosition(/^sleep "\$\{QUIESCENCE_OBSERVATION_SECONDS\}"$/u),
  preflights[1] ?? -1,
  commandPosition(
    /^bp_run_one_off_task "\$\{MIGRATOR_TASK_DEFINITION\}" "\$\{readiness_overrides\}" >\/dev\/null$/u,
  ),
  commandPosition(/^write_candidate_admission "\$\{BP_APP_IMAGE_DIGEST\}"$/u),
  commandPosition(/^bp_aws ecs update-service /u),
  commandPosition(/^retire_pre_boundary_task_definitions$/u),
  commandPosition(
    /^sleep "\$\{TASK_DEFINITION_DEREGISTRATION_WINDOW_SECONDS\}"$/u,
  ),
  commandPositions(/^assert_retained_task_definitions_only$/u)[0] ?? -1,
  preflights[2] ?? -1,
  commandPosition(
    /^migration_client_token="bp-p2-\$\{WRITER_WITNESS_NONCE:0:48\}"$/u,
  ),
  commandPosition(
    /^bp_run_one_off_task "\$\{MIGRATOR_TASK_DEFINITION\}" "\$\{overrides\}" "\$\{migration_client_token\}" >\/dev\/null$/u,
  ),
  commandPositions(/^assert_retained_task_definitions_only$/u)[1] ?? -1,
  commandPositions(
    /^assert_admitted_candidate_contract "\$\{BP_APP_IMAGE_DIGEST\}"$/u,
  ).at(-1) ?? -1,
  commandPosition(/^write_writer_outage_witness quiescent-bound /u),
];
if (
  !migrationAndBind ||
  preflights.length !== 3 ||
  commandPositions(/^assert_retained_task_definitions_only$/u).length !== 2 ||
  ordered.some((position) => position < 0) ||
  ordered.some((position, index) => index > 0 && position <= ordered[index - 1])
) {
  violations.push(
    `scripts/p2-schema-cutover.sh: witnessed baseline/candidate admission, readiness, zero-count binding, retirement, enforcement, final preflight, deterministic migration, post-run revalidation, and durable-witness order drifted (preflights=${preflights.join(",")}; ordered=${ordered.join(",")})`,
  );
}

requireAll(
  "README.md",
  [
    "Migration `0037` is a **writer-outage compatibility boundary**",
    "scripts/p2-schema-cutover.sh preflight-outage",
    "scripts/p2-schema-cutover.sh run",
    "scripts/p2-schema-cutover.sh bootstrap-empty",
    "scripts/p2-schema-cutover.sh verify-restored",
    "./deploy.sh preflight-outage sha256:CURRENT_DIGEST sha256:CANDIDATE_DIGEST",
    "BP_CANDIDATE_IMAGE_DIGEST=sha256:CANDIDATE_DIGEST",
    "`ecs_autoscaling_enabled = false`",
    "prevent external principals from starting the Step Functions state machine",
    "deregisters every other ACTIVE revision",
    "read-only database-readiness",
    "-target=aws_ecr_repository.beaver_app",
  ],
  "the owner runbook must disclose the exact outage sequence and residual external-principal boundary",
);

requireAll(
  "scripts/run-local-drizzle-command.mjs",
  [
    'env.NODE_ENV === "production"',
    "LOOPBACK_HOSTS",
    "CLOUD_RUNTIME_SIGNALS",
    '"studio"',
    "Refusing schema mutation against a non-loopback database",
  ],
  "developer schema commands must refuse production, cloud-container, and non-loopback targets",
);
requireAll(
  "package.json",
  [
    '"db:migrate": "node scripts/run-local-drizzle-command.mjs migrate"',
    '"db:push": "node scripts/run-local-drizzle-command.mjs push"',
    '"db:studio": "node scripts/run-local-drizzle-command.mjs studio"',
  ],
  "package schema mutation commands must use the local-only guard",
);
for (const file of [
  "README.md",
  "CONTRIBUTING.md",
  "install_setup.sh",
  "scripts/setup.sh",
]) {
  forbid(
    file,
    ["npx drizzle-kit migrate"],
    "operator/developer entrypoints may not bypass the local or singleton migration guards",
  );
}
requireAll(
  "scripts/create-local-root-admin.mjs",
  ["assertLocalSchemaMutationTarget();", 'import("pg")'],
  "the setup DML boundary must refuse remote/cloud authority before loading PostgreSQL",
);
if (
  files["scripts/create-local-root-admin.mjs"].indexOf(
    "assertLocalSchemaMutationTarget();",
  ) > files["scripts/create-local-root-admin.mjs"].indexOf('import("pg")')
) {
  violations.push(
    "scripts/create-local-root-admin.mjs: local authority must be checked before pg is loaded",
  );
}
requireAll(
  "install_setup.sh",
  ["umask 077"],
  "setup-created secret files and backups must default to owner-only permissions",
);
if (!shellLogicalLines(files["install_setup.sh"]).includes("umask 077")) {
  report(
    "install_setup.sh",
    "setup-created secret files and backups must default to owner-only permissions",
    "the executable top-level umask 077 command is missing",
  );
}
requireAll(
  ".dockerignore",
  [".env*", ".deploy.env*", "!.env.example", "!.deploy.env.example"],
  "container build context must exclude local deployment and application secrets",
);
requireAll(
  "infrastructure/terraform/ecr.tf",
  ['tagPrefixList = ["v"]', 'tagPrefixList = ["deploy-"]'],
  "immutable deploy tags must participate in bounded ECR retention",
);
forbid(
  "infrastructure/terraform/ecr.tf",
  ['tagPrefixList = ["v", "deploy-"]'],
  "ECR tagPrefixList entries are conjunctive, so version and deploy prefixes require separate rules",
);
requireAll(
  "drizzle/0033_project_lifecycle_epoch_and_leases.sql",
  [
    "LOCK TABLE companies, projects IN SHARE ROW EXCLUSIVE MODE",
    "Invalid legacy company storage namespace before migration 0033",
    "Invalid legacy project storage root before migration 0033",
    "companies_data_key_storage_namespace_guard",
    "CREATE TRIGGER projects_lifecycle_guard",
  ],
  "migration 0033 must fence and validate legacy roots before installing permanent guards",
);
forbid(
  "ecs-tune.sh",
  [
    "register-task-definition",
    "update-service",
    "update-function-configuration",
    "deregister-task-definition",
  ],
  "the tuning helper must remain Terraform-only and may not bypass canonical activation",
);
requireAll(
  "scripts/cost-control.sh",
  [
    "Read-only production cost and writer-state report",
    "bp_assert_caller_account",
    "Change app desired/minimum counts",
    "verify-restored",
    "authorization belongs to callers",
  ],
  "the cost report must direct writer restoration through Terraform and canonical schema admission",
);
forbid(
  "scripts/cost-control.sh",
  [
    "update-service",
    "put-role-policy",
    "delete-role-policy",
    "register-task-definition",
    "run-task",
  ],
  "the cost report must remain read-only and may not mutate ECS/IAM or claim a false Step Functions fence",
);
const workflowFile = ".github/workflows/ci.yml";
const workflowInfrastructureInvariant =
  "CI must parse, format-check, initialize, and validate Terraform without a backend";
const workflowDatabaseInvariant =
  "the authoritative CI job must run the required PostgreSQL 17 database gate against its isolated local service";
let workflow = null;
try {
  workflow = yamlRecord(loadYaml(files[workflowFile]));
} catch (error) {
  report(
    workflowFile,
    workflowInfrastructureInvariant,
    `invalid YAML: ${error.message}`,
  );
}
const checksJob = yamlRecord(yamlRecord(workflow?.jobs)?.checks);
if (
  !checksJob ||
  checksJob.if !== undefined ||
  checksJob["continue-on-error"] !== undefined
) {
  report(
    workflowFile,
    workflowDatabaseInvariant,
    "jobs.checks must exist and may not be conditional or continue-on-error",
  );
} else {
  const steps = Array.isArray(checksJob.steps) ? checksJob.steps : [];
  for (const action of ["hashicorp/setup-terraform@v3"]) {
    if (!exactActionStep(steps, action)) {
      report(
        workflowFile,
        workflowInfrastructureInvariant,
        `jobs.checks is missing the unconditional ${action} step`,
      );
    }
  }
  for (const command of [
    "terraform fmt -check -recursive infrastructure/terraform",
    "terraform -chdir=infrastructure/terraform init -backend=false -input=false",
    "terraform -chdir=infrastructure/terraform validate",
  ]) {
    if (!exactRunStep(steps, command)) {
      report(
        workflowFile,
        workflowInfrastructureInvariant,
        `jobs.checks is missing the unconditional exact step ${command}`,
      );
    }
  }

  const postgres = yamlRecord(yamlRecord(checksJob.services)?.postgres);
  if (
    !postgres ||
    typeof postgres.image !== "string" ||
    !/^postgres:17(?:$|[-.])/u.test(postgres.image)
  ) {
    report(
      workflowFile,
      workflowDatabaseInvariant,
      "jobs.checks.services.postgres.image must pin PostgreSQL major version 17",
    );
  }
  const postgresEnvironment = yamlRecord(postgres?.env);
  const postgresUser = String(postgresEnvironment?.POSTGRES_USER ?? "");
  const postgresPassword = String(postgresEnvironment?.POSTGRES_PASSWORD ?? "");
  const postgresDatabase = String(postgresEnvironment?.POSTGRES_DB ?? "");
  if (!postgresUser || !postgresPassword || !postgresDatabase) {
    report(
      workflowFile,
      workflowDatabaseInvariant,
      "the postgres service must define nonempty user, password, and database values",
    );
  }
  if (
    !Array.isArray(postgres?.ports) ||
    !postgres.ports.some((port) => String(port) === "5432:5432")
  ) {
    report(
      workflowFile,
      workflowDatabaseInvariant,
      "the postgres service must expose only the expected localhost test port mapping",
    );
  }

  const scriptTests = exactRunStep(steps, "npm run test:scripts");
  if (!scriptTests) {
    report(
      workflowFile,
      workflowDatabaseInvariant,
      "jobs.checks must execute npm run test:scripts unconditionally",
    );
  }
  const effectiveTestEnvironment = {
    ...(yamlRecord(checksJob.env) ?? {}),
    ...(yamlRecord(scriptTests?.env) ?? {}),
  };
  if (String(effectiveTestEnvironment.BP_REQUIRE_TEST_DB ?? "") !== "1") {
    report(
      workflowFile,
      workflowDatabaseInvariant,
      "BP_REQUIRE_TEST_DB must equal 1 for the script-test step",
    );
  }
  const adminUrl = workflowDatabaseUrl(
    effectiveTestEnvironment.BP_TEST_ADMIN_URL,
    "/postgres",
  );
  const testUrl = workflowDatabaseUrl(
    effectiveTestEnvironment.BP_TEST_DATABASE_URL,
    `/${postgresDatabase}`,
  );
  if (
    !adminUrl ||
    !testUrl ||
    adminUrl.username !== postgresUser ||
    adminUrl.password !== postgresPassword ||
    testUrl.username !== postgresUser ||
    testUrl.password !== postgresPassword ||
    effectiveTestEnvironment.DATABASE_URL !==
      effectiveTestEnvironment.BP_TEST_DATABASE_URL
  ) {
    report(
      workflowFile,
      workflowDatabaseInvariant,
      "the guarded admin/test URLs must match the localhost postgres service and DATABASE_URL",
    );
  }
}
forbid(
  "root_admin.sh",
  ["Run custom SQL", "ALTER TABLE", "reset_password", "ensure_column"],
  "the routine root-admin helper may not expose arbitrary SQL, DDL, or command-visible secrets",
);

if (violations.length > 0) {
  console.error(`Schema cutover policy check failed (${violations.length}):`);
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Schema cutover policy check passed.");
}
