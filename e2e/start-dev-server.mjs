// Next 16 persists `next dev` output under .next/dev. An interrupted or concurrent dev process can
// leave that generated route graph internally inconsistent: source routes still exist, while the
// dev app-path manifest returns framework HTML 404s for them. E2E must exercise the current source
// tree, so discard only that disposable dev cache before starting its dedicated server.
import { spawn } from "node:child_process";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function resolveNextAppRoot(
  requestedRoot = process.env.BP_E2E_APP_ROOT || repositoryRoot,
) {
  const root = realpathSync(resolve(requestedRoot));
  const packagePath = resolve(root, "package.json");
  const nextCli = resolve(root, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(packagePath) || !existsSync(nextCli)) {
    throw new Error(
      `Refusing to start an unvalidated E2E app root without package.json and Next.js: ${root}`,
    );
  }
  return root;
}

export function cleanNextDevCache(root) {
  const nextRoot = resolve(root, ".next");
  const nextDevCache = resolve(nextRoot, "dev");
  if (dirname(nextDevCache) !== nextRoot) {
    throw new Error("Refusing to clean a path outside .next");
  }
  rmSync(nextDevCache, { recursive: true, force: true });
}

export function startNextDevServer(
  args = process.argv.slice(2),
  root = resolveNextAppRoot(),
) {
  const nextCli = resolve(
    root,
    "node_modules",
    "next",
    "dist",
    "bin",
    "next",
  );
  cleanNextDevCache(root);
  return spawn(process.execPath, [nextCli, "dev", "--turbopack", ...args], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
}

export function installSignalForwarding(child, hostProcess = process) {
  let forwardedSignal = null;
  const listeners = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const listener = () => {
      if (forwardedSignal) return;
      forwardedSignal = signal;
      child.kill(signal);
    };
    listeners.set(signal, listener);
    hostProcess.on(signal, listener);
  }

  return {
    get forwardedSignal() {
      return forwardedSignal;
    },
    dispose() {
      for (const [signal, listener] of listeners) {
        hostProcess.off(signal, listener);
      }
    },
  };
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isMain) {
  const child = startNextDevServer();
  const forwarding = installSignalForwarding(child);

  child.once("error", (error) => {
    forwarding.dispose();
    console.error("[e2e-dev-server] failed to start Next.js", error);
    process.exitCode = 1;
  });

  child.once("exit", (code, signal) => {
    forwarding.dispose();
    if (signal && !forwarding.forwardedSignal) {
      console.error(`[e2e-dev-server] Next.js exited from ${signal}`);
    }
    process.exitCode = code ?? (forwarding.forwardedSignal ? 0 : 1);
  });
}
