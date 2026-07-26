// Resolver hooks so BARE NODE can load this repo's TypeScript modules directly.
//
// WHY THIS EXISTS. The accuracy harness and the otsu probe import
// `src/workers/bucket-fill.worker.ts` to drive the legacy leg against its REAL exported
// primitives. Node's type-stripping loads .ts fine, but node does not resolve either of the two
// things this codebase's source uses everywhere:
//   1. the "@/" tsconfig path alias  ("@/*" -> "./src/*", 3,356 usages)
//   2. extensionless specifiers      ("@/lib/foo" rather than "@/lib/foo.ts")
// vitest and Turbopack resolve both, so PRODUCT GATES STAY GREEN WHILE BARE-NODE TOOLING BREAKS.
//
// That is exactly what happened when the mask-ops move gave the worker its first import: the
// bucket suite passed, `npm run build` passed, and the accuracy instrument was dead. The fix
// belongs HERE, in tooling — not in making product source non-idiomatic to suit a probe.
//
// Import this module for its side effect BEFORE importing any repo .ts module.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const SRC = resolvePath(fileURLToPath(new URL("../..", import.meta.url)), "src");

registerHooks({
  resolve(specifier, context, nextResolve) {
    // "@/x" -> <repo>/src/x, trying the extensionless variants node cannot.
    if (specifier.startsWith("@/")) {
      const base = resolvePath(SRC, specifier.slice(2));
      for (const cand of [base, base + ".ts", base + ".tsx", base + ".mjs", base + ".js",
                          resolvePath(base, "index.ts"), resolvePath(base, "index.tsx")]) {
        if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
      }
      throw new Error(`_ts-resolve: cannot resolve "${specifier}" under ${SRC}`);
    }
    // Relative specifier with no extension: try .ts / .tsx before giving up.
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL) {
      const base = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      for (const cand of [base + ".ts", base + ".tsx", resolvePath(base, "index.ts")]) {
        if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
