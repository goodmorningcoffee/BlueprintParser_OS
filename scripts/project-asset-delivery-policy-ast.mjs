import { createHash } from "node:crypto";

import ts from "typescript";

// Stream teardown is an ordering-sensitive security/performance boundary. The semantic checks below
// explain the contract; this digest makes the complete reviewed function fail closed against any
// unmodeled control-flow, shadowing, or pre-settlement byte-delivery mutation.
const REVIEWED_REQUEST_BOUND_BODY_SHA256 =
  "7bf3967849f47fa0fc40c6284ea47a8c0bdb29bc199e86907a1b75f9de6aae4e";

function isIdentifier(node, name) {
  return ts.isIdentifier(node) && node.text === name;
}

function isPropertyAccess(node, owner, property) {
  return (
    ts.isPropertyAccessExpression(node) &&
    isIdentifier(node.expression, owner) &&
    node.name.text === property
  );
}

function isAssignment(statement, left, right) {
  return (
    ts.isExpressionStatement(statement) &&
    ts.isBinaryExpression(statement.expression) &&
    statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    isIdentifier(statement.expression.left, left) &&
    right(statement.expression.right)
  );
}

function isCallStatement(statement, owner, property, argument) {
  if (
    !ts.isExpressionStatement(statement) ||
    !ts.isCallExpression(statement.expression) ||
    !isPropertyAccess(statement.expression.expression, owner, property) ||
    statement.expression.arguments.length !== (argument ? 1 : 0)
  ) {
    return false;
  }
  return argument ? argument(statement.expression.arguments[0]) : true;
}

function isNegatedIdentifier(node, name) {
  return (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.ExclamationToken &&
    isIdentifier(node.operand, name)
  );
}

function isExactLengthCondition(node) {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
    ts.isBinaryExpression(node.left) &&
    node.left.operatorToken.kind ===
      ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    isIdentifier(node.left.left, "exactLength") &&
    node.left.right.kind === ts.SyntaxKind.NullKeyword &&
    ts.isBinaryExpression(node.right) &&
    node.right.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    isIdentifier(node.right.left, "nextBytesRead") &&
    isIdentifier(node.right.right, "exactLength")
  );
}

function isAwaitedSharedCancel(statement) {
  return (
    ts.isExpressionStatement(statement) &&
    ts.isAwaitExpression(statement.expression) &&
    ts.isCallExpression(statement.expression.expression) &&
    isIdentifier(
      statement.expression.expression.expression,
      "cancelUpstream",
    ) &&
    statement.expression.expression.arguments.length === 0
  );
}

function collectDescendants(root, predicate) {
  const matches = [];
  const visit = (node) => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
}

function isMethodCall(node, property, argumentCount, owner) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === property &&
    node.arguments.length === argumentCount &&
    owner(node.expression.expression)
  );
}

function unwrapParentheses(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isCancelStartedDeclaration(declaration) {
  if (
    !isIdentifier(declaration.name, "cancelStarted") ||
    !declaration.initializer ||
    !isMethodCall(
      declaration.initializer,
      "catch",
      1,
      (cancelCall) =>
        isMethodCall(cancelCall, "cancel", 1, (reader) =>
          isIdentifier(reader, "reader"),
        ) && isIdentifier(cancelCall.arguments[0], "reason"),
    )
  ) {
    return false;
  }
  return true;
}

function isUpstreamSettlement(element) {
  if (!ts.isSpreadElement(element)) return false;
  const conditional = unwrapParentheses(element.expression);
  if (
    !ts.isConditionalExpression(conditional) ||
    !isIdentifier(conditional.condition, "upstreamSettled") ||
    !ts.isArrayLiteralExpression(conditional.whenTrue) ||
    conditional.whenTrue.elements.length !== 1 ||
    !ts.isArrayLiteralExpression(conditional.whenFalse) ||
    conditional.whenFalse.elements.length !== 0
  ) {
    return false;
  }
  return isMethodCall(conditional.whenTrue.elements[0], "catch", 1, (owner) =>
    isIdentifier(owner, "upstreamSettled"),
  );
}

function isSharedCancelPromiseAssignment(expression) {
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !isIdentifier(expression.left, "cancelPromise")
  ) {
    return false;
  }
  const finallyCall = expression.right;
  if (
    !isMethodCall(finallyCall, "finally", 1, ts.isCallExpression) ||
    !isIdentifier(finallyCall.arguments[0], "detach")
  ) {
    return false;
  }
  const thenCall = finallyCall.expression.expression;
  if (!isMethodCall(thenCall, "then", 1, ts.isCallExpression)) return false;
  const promiseAll = thenCall.expression.expression;
  if (
    !isMethodCall(promiseAll, "all", 1, (owner) =>
      isIdentifier(owner, "Promise"),
    ) ||
    !ts.isArrayLiteralExpression(promiseAll.arguments[0])
  ) {
    return false;
  }
  const elements = promiseAll.arguments[0].elements;
  return (
    elements.length === 2 &&
    isIdentifier(elements[0], "cancelStarted") &&
    isUpstreamSettlement(elements[1])
  );
}

function isNamedBinding(node, name) {
  if (
    !ts.isVariableDeclaration(node) &&
    !ts.isFunctionDeclaration(node) &&
    !ts.isParameter(node)
  ) {
    return false;
  }
  const bindingContains = (binding) => {
    if (isIdentifier(binding, name)) return true;
    if (
      !ts.isObjectBindingPattern(binding) &&
      !ts.isArrayBindingPattern(binding)
    ) {
      return false;
    }
    return binding.elements.some(
      (element) =>
        ts.isBindingElement(element) && bindingContains(element.name),
    );
  };
  return Boolean(node.name && bindingContains(node.name));
}

function hasCanonicalSharedCancel(requestBoundBody) {
  const bindings = collectDescendants(requestBoundBody, (node) =>
    isNamedBinding(node, "cancelUpstream"),
  );
  if (bindings.length !== 1 || !ts.isVariableDeclaration(bindings[0])) {
    return false;
  }
  const initializer = bindings[0].initializer;
  if (
    !initializer ||
    !ts.isArrowFunction(initializer) ||
    !ts.isBlock(initializer.body)
  ) {
    return false;
  }

  const cancelStarted = collectDescendants(
    initializer.body,
    (node) =>
      ts.isVariableDeclaration(node) &&
      isIdentifier(node.name, "cancelStarted"),
  );
  const cancelPromiseAssignments = collectDescendants(
    initializer.body,
    (node) =>
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isIdentifier(node.left, "cancelPromise"),
  );
  const returns = initializer.body.statements.filter(ts.isReturnStatement);
  return (
    cancelStarted.length === 1 &&
    isCancelStartedDeclaration(cancelStarted[0]) &&
    cancelPromiseAssignments.length === 1 &&
    isSharedCancelPromiseAssignment(cancelPromiseAssignments[0]) &&
    returns.length === 1 &&
    Boolean(returns[0].expression) &&
    isIdentifier(returns[0].expression, "cancelPromise")
  );
}

function isAbortGate(statement) {
  if (
    !ts.isIfStatement(statement) ||
    Boolean(statement.elseStatement) ||
    !isPropertyAccess(statement.expression, "signal", "aborted") ||
    !ts.isBlock(statement.thenStatement)
  ) {
    return false;
  }
  const [closeIf, returnStatement] = statement.thenStatement.statements;
  if (
    statement.thenStatement.statements.length !== 2 ||
    !ts.isIfStatement(closeIf) ||
    Boolean(closeIf.elseStatement) ||
    !isNegatedIdentifier(closeIf.expression, "settled") ||
    !ts.isBlock(closeIf.thenStatement) ||
    closeIf.thenStatement.statements.length !== 2 ||
    !isAssignment(
      closeIf.thenStatement.statements[0],
      "settled",
      (right) => right.kind === ts.SyntaxKind.TrueKeyword,
    ) ||
    !isCallStatement(closeIf.thenStatement.statements[1], "controller", "close")
  ) {
    return false;
  }
  return ts.isReturnStatement(returnStatement);
}

function isFinalEmission(statement) {
  if (
    !ts.isIfStatement(statement) ||
    Boolean(statement.elseStatement) ||
    !isNegatedIdentifier(statement.expression, "settled") ||
    !ts.isBlock(statement.thenStatement)
  ) {
    return false;
  }
  const statements = statement.thenStatement.statements;
  return (
    statements.length === 4 &&
    isAssignment(statements[0], "bytesRead", (right) =>
      isIdentifier(right, "nextBytesRead"),
    ) &&
    isCallStatement(statements[1], "controller", "enqueue", (argument) =>
      isPropertyAccess(argument, "chunk", "value"),
    ) &&
    isAssignment(
      statements[2],
      "settled",
      (right) => right.kind === ts.SyntaxKind.TrueKeyword,
    ) &&
    isCallStatement(statements[3], "controller", "close")
  );
}

/**
 * Pin the security-relevant final-frame order inside requestBoundBody:
 * exact length -> actual shared teardown -> abort gate -> final bytes -> EOF.
 */
export function hasCanonicalProjectAssetFinalization(sourceText) {
  const source = ts.createSourceFile(
    "src/server/services/project-assets.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const requestBoundBody = source.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "requestBoundBody",
  );
  if (!requestBoundBody?.body) return false;
  const reviewedDigest = createHash("sha256")
    // Source control may materialize CRLF on another workstation; line endings do not alter the
    // reviewed TypeScript semantics and therefore are normalized before the exact-content pin.
    .update(requestBoundBody.getText(source).replace(/\r\n?/gu, "\n"))
    .digest("hex");
  if (reviewedDigest !== REVIEWED_REQUEST_BOUND_BODY_SHA256) return false;
  if (!hasCanonicalSharedCancel(requestBoundBody.body)) return false;

  const pullMethods = collectDescendants(
    requestBoundBody.body,
    (node) =>
      ts.isMethodDeclaration(node) &&
      Boolean(node.name && isIdentifier(node.name, "pull")),
  );
  if (pullMethods.length !== 1 || !pullMethods[0].body) return false;
  const pull = pullMethods[0];
  const streamObject = pull.parent;
  const streamConstructor = streamObject.parent;
  if (
    !ts.isObjectLiteralExpression(streamObject) ||
    !ts.isNewExpression(streamConstructor) ||
    !isIdentifier(streamConstructor.expression, "ReadableStream") ||
    streamConstructor.arguments?.[0] !== streamObject
  ) {
    return false;
  }

  const exactBranches = collectDescendants(
    pull.body,
    (node) => ts.isIfStatement(node) && isExactLengthCondition(node.expression),
  );
  if (exactBranches.length !== 1) return false;
  const exactBranch = exactBranches[0];
  const chunkElse = exactBranch.parent;
  const chunkDone = chunkElse.parent;
  if (
    !ts.isBlock(chunkElse) ||
    !ts.isIfStatement(chunkDone) ||
    chunkDone.elseStatement !== chunkElse ||
    !isPropertyAccess(chunkDone.expression, "chunk", "done") ||
    chunkElse.statements.at(-1) !== exactBranch ||
    !ts.isBlock(exactBranch.thenStatement)
  ) {
    return false;
  }
  const statements = exactBranch.thenStatement.statements;
  return (
    statements.length === 3 &&
    isAwaitedSharedCancel(statements[0]) &&
    isAbortGate(statements[1]) &&
    isFinalEmission(statements[2])
  );
}
