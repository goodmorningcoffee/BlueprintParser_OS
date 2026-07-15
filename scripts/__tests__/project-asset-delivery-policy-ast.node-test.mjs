import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { hasCanonicalProjectAssetFinalization } from "../project-asset-delivery-policy-ast.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const SERVICE = path.join(REPO_ROOT, "src/server/services/project-assets.ts");
const BRANCH_START = `if (exactLength !== null && nextBytesRead === exactLength) {
              await cancelUpstream();`;

async function productionSource() {
  return readFile(SERVICE, "utf8");
}

function mutateOnce(source, before, after) {
  const mutated = source.replace(before, after);
  assert.notEqual(
    mutated,
    source,
    "mutation target must match production source",
  );
  return mutated;
}

function blockStartingAt(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, "block marker must match production source");
  const open = source.indexOf("{", start + marker.length);
  assert.notEqual(open, -1, "mutated statement must have a block");
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail("mutated statement block must close");
}

test("project asset finalization pins teardown before final framed bytes", async () => {
  assert.equal(
    hasCanonicalProjectAssetFinalization(await productionSource()),
    true,
  );
});

test("project asset finalization treats CRLF as the same reviewed source", async () => {
  const crlfSource = (await productionSource()).replace(/\n/gu, "\r\n");
  assert.equal(hasCanonicalProjectAssetFinalization(crlfSource), true);
});

test("project asset finalization rejects enqueue before shared teardown", async () => {
  const source = await productionSource();
  const mutated = mutateOnce(
    source,
    BRANCH_START,
    `if (exactLength !== null && nextBytesRead === exactLength) {
              controller.enqueue(chunk.value);
              await cancelUpstream();`,
  );
  assert.equal(hasCanonicalProjectAssetFinalization(mutated), false);
});

test("project asset finalization rejects a missing branch teardown", async () => {
  const source = await productionSource();
  const mutated = mutateOnce(
    source,
    BRANCH_START,
    "if (exactLength !== null && nextBytesRead === exactLength) {",
  );
  // The zero-length start path still contains `await cancelUpstream()`; a global
  // marker check must not let that unrelated call authorize final-frame delivery.
  assert.match(mutated, /await cancelUpstream\(\);/u);
  assert.equal(hasCanonicalProjectAssetFinalization(mutated), false);
});

test("project asset finalization rejects a decoy before an unsafe live branch", async () => {
  const source = await productionSource();
  const canonicalBranch = blockStartingAt(
    source,
    "if (exactLength !== null && nextBytesRead === exactLength)",
  );
  const unsafeBranch = mutateOnce(
    canonicalBranch,
    "await cancelUpstream();",
    "controller.enqueue(chunk.value);\n              await cancelUpstream();",
  );
  const mutated = mutateOnce(
    source,
    canonicalBranch,
    `if (bytesRead < 0) {\n${canonicalBranch}\n            }\n            ${unsafeBranch}`,
  );
  assert.equal(hasCanonicalProjectAssetFinalization(mutated), false);
});

test("project asset finalization rejects detached Node-close settlement", async () => {
  const source = await productionSource();
  const sharedAssignment = blockStartingAt(source, "if (!cancelPromise)");
  const detachedAssignment = sharedAssignment.replace(
    /cancelPromise = Promise\.all\([\s\S]*?\)\n\s*\.then\(\(\) => undefined\)\n\s*\.finally\(detach\);/u,
    `if (upstreamSettled) void upstreamSettled.catch(() => undefined);
      cancelPromise = cancelStarted.then(() => undefined).finally(detach);`,
  );
  assert.notEqual(
    detachedAssignment,
    sharedAssignment,
    "shared settlement mutation must match production source",
  );
  const mutated = mutateOnce(source, sharedAssignment, detachedAssignment);
  assert.match(mutated, /upstreamSettled\.catch\(\(\) => undefined\)/u);
  assert.equal(hasCanonicalProjectAssetFinalization(mutated), false);
});

test("project asset finalization rejects a pull-local cancel shadow", async () => {
  const source = await productionSource();
  const mutated = mutateOnce(
    source,
    "async pull(controller) {",
    `async pull(controller) {
        const cancelUpstream = async () => undefined;`,
  );
  assert.equal(hasCanonicalProjectAssetFinalization(mutated), false);
});

test("project asset finalization rejects a destructured cancel shadow", async () => {
  const source = await productionSource();
  const mutated = mutateOnce(
    source,
    "async pull(controller) {",
    `async pull(controller) {
        const { cancelUpstream } = {
          cancelUpstream: async () => undefined,
        };`,
  );
  assert.equal(hasCanonicalProjectAssetFinalization(mutated), false);
});

test("project asset finalization rejects an abort-gate else emission", async () => {
  const source = await productionSource();
  const mutated = mutateOnce(
    source,
    `                }
                return;
              }
              if (!settled) {`,
    `                }
                return;
              } else {
                controller.enqueue(chunk.value);
              }
              if (!settled) {`,
  );
  assert.equal(hasCanonicalProjectAssetFinalization(mutated), false);
});

test("project asset finalization rejects an early final-frame enqueue", async () => {
  const source = await productionSource();
  const marker = "if (exactLength !== null && nextBytesRead === exactLength) {";
  const mutated = mutateOnce(
    source,
    marker,
    `controller.enqueue(chunk.value);
            ${marker}`,
  );
  assert.equal(hasCanonicalProjectAssetFinalization(mutated), false);
});

test("project asset finalization rejects an early shared-cancel return", async () => {
  const source = await productionSource();
  const mutated = mutateOnce(
    source,
    "if (!cancelPromise) {",
    `if (!cancelPromise) {
      return Promise.resolve();`,
  );
  assert.equal(hasCanonicalProjectAssetFinalization(mutated), false);
});

test("project asset finalization rejects a pre-settled cancel promise", async () => {
  const source = await productionSource();
  const mutated = mutateOnce(
    source,
    "let cancelPromise: Promise<void> | null = null;",
    "let cancelPromise: Promise<void> | null = Promise.resolve();",
  );
  assert.equal(hasCanonicalProjectAssetFinalization(mutated), false);
});

test("project asset finalization rejects replacement of the Node-close witness", async () => {
  const source = await productionSource();
  const mutated = mutateOnce(
    source,
    "const reader = body.getReader();",
    `upstreamSettled = Promise.resolve();
  const reader = body.getReader();`,
  );
  assert.equal(hasCanonicalProjectAssetFinalization(mutated), false);
});
