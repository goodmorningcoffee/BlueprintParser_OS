#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { assertLocalSchemaMutationTarget } from "./run-local-drizzle-command.mjs";

config({ path: ".env.local", override: false, quiet: true });
config({ override: false, quiet: true });
assertLocalSchemaMutationTarget();

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(
  projectDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);
const result = spawnSync(executable, ["src/lib/db/seed.ts"], {
  cwd: projectDir,
  env: process.env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
