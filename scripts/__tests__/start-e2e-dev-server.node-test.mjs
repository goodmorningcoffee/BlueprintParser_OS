import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cleanNextDevCache,
  installSignalForwarding,
  resolveNextAppRoot,
} from "../../e2e/start-dev-server.mjs";

test("cleanNextDevCache removes only the disposable Next dev subtree", (context) => {
  const root = mkdtempSync(join(tmpdir(), "bp-e2e-dev-cache-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const devSentinel = join(root, ".next", "dev", "route-manifest.json");
  const productionSentinel = join(
    root,
    ".next",
    "server",
    "app-paths-manifest.json",
  );
  mkdirSync(join(root, ".next", "dev"), { recursive: true });
  mkdirSync(join(root, ".next", "server"), { recursive: true });
  writeFileSync(devSentinel, "stale");
  writeFileSync(productionSentinel, "keep");

  cleanNextDevCache(root);

  assert.equal(existsSync(join(root, ".next", "dev")), false);
  assert.equal(existsSync(productionSentinel), true);
});

test("resolveNextAppRoot accepts only a real package root with a local Next CLI", (context) => {
  const root = mkdtempSync(join(tmpdir(), "bp-e2e-app-root-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  assert.throws(() => resolveNextAppRoot(root), /unvalidated E2E app root/);
  writeFileSync(join(root, "package.json"), "{}");
  assert.throws(() => resolveNextAppRoot(root), /unvalidated E2E app root/);

  const nextCli = join(root, "node_modules", "next", "dist", "bin", "next");
  mkdirSync(join(root, "node_modules", "next", "dist", "bin"), {
    recursive: true,
  });
  writeFileSync(nextCli, "");
  assert.equal(resolveNextAppRoot(root), root);
});

test("signal forwarding relays only the first termination signal and can detach", () => {
  const hostProcess = new EventEmitter();
  const killedWith = [];
  const child = {
    kill(signal) {
      killedWith.push(signal);
    },
  };
  const forwarding = installSignalForwarding(child, hostProcess);

  hostProcess.emit("SIGTERM");
  hostProcess.emit("SIGINT");
  assert.deepEqual(killedWith, ["SIGTERM"]);
  assert.equal(forwarding.forwardedSignal, "SIGTERM");

  forwarding.dispose();
  hostProcess.emit("SIGTERM");
  assert.deepEqual(killedWith, ["SIGTERM"]);
});
