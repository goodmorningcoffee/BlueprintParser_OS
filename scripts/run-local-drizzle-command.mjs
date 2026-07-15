#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const ALLOWED_COMMANDS = new Set(["migrate", "push", "studio"]);
const CONNECTION_TARGET_OVERRIDE_PARAMETERS = new Set([
  "host",
  "hostaddr",
  "service",
  "servicefile",
]);
const CLOUD_RUNTIME_SIGNALS = [
  "AWS_EXECUTION_ENV",
  "ECS_CONTAINER_METADATA_URI",
  "ECS_CONTAINER_METADATA_URI_V4",
];

export function assertLocalSchemaMutationTarget(env = process.env) {
  if (env.NODE_ENV === "production") {
    throw new Error(
      "Refusing local schema mutation with NODE_ENV=production; use the dedicated singleton migrator workflow",
    );
  }

  const cloudSignal = CLOUD_RUNTIME_SIGNALS.find((name) => env[name]);
  if (cloudSignal) {
    throw new Error(
      `Refusing local schema mutation inside a cloud container (${cloudSignal} is set)`,
    );
  }

  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for a local schema mutation");
  }

  let databaseUrl;
  try {
    databaseUrl = new URL(env.DATABASE_URL);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
    !LOOPBACK_HOSTS.has(databaseUrl.hostname)
  ) {
    throw new Error(
      "Refusing schema mutation against a non-loopback database; production migrations must use scripts/p2-schema-cutover.sh",
    );
  }
  const targetOverride = [...databaseUrl.searchParams.keys()].find((name) =>
    CONNECTION_TARGET_OVERRIDE_PARAMETERS.has(name.toLowerCase()),
  );
  if (targetOverride) {
    throw new Error(
      `Refusing DATABASE_URL target override parameter (${targetOverride}); URI authority must be the effective loopback target`,
    );
  }
}

function main() {
  config({ path: ".env.local", override: false, quiet: true });
  config({ override: false, quiet: true });

  const command = process.argv[2];
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new Error(
      "Usage: node scripts/run-local-drizzle-command.mjs migrate|push|studio",
    );
  }
  assertLocalSchemaMutationTarget();

  const projectDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const executable = path.join(
    projectDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "drizzle-kit.cmd" : "drizzle-kit",
  );
  const result = spawnSync(executable, [command], {
    cwd: projectDir,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `[local-schema] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
