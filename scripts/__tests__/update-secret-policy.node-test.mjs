import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("secret helper refuses structural and unknown secret identities", () => {
  for (const key of [
    "DATABASE_URL",
    "NODE_ENV",
    "STEP_FUNCTION_ARN",
    "S3_BUCKET",
    "LABEL_STUDIO_API_KEY",
    "UNKNOWN_KEY",
  ]) {
    const result = spawnSync(
      "python3",
      ["scripts/update_secret.py", key, "not-written", "--local-only"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing unsupported secret/u);
    assert.doesNotMatch(result.stdout, /Updating \.env\.local/u);
  }
});

test("secret helper refuses plaintext values in process arguments", () => {
  const result = spawnSync(
    "python3",
    [
      "scripts/update_secret.py",
      "ANTHROPIC_API_KEY",
      "sk-ant-not-written",
      "--local-only",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing a secret value in process arguments/u);
  assert.doesNotMatch(result.stdout, /Updating \.env\.local/u);
});

test("secret helper never disables TLS or passes plaintext in AWS argv", async () => {
  const source = await readFile("scripts/update_secret.py", "utf8");
  assert.doesNotMatch(source, /_create_unverified_context|CERT_NONE/u);
  assert.match(source, /"--secret-string", "file:\/\/\/dev\/stdin"/u);
  assert.match(source, /stdin_text=value/u);
  assert.match(source, /ALLOWED_KEY_NAMES = frozenset\(VALIDATORS\)/u);
  assert.match(source, /"ANTHROPIC_API_KEY": "beaver\/ANTHROPIC_API_KEY"/u);
  assert.match(source, /"GROQ_API_KEY": "beaver\/GROQ_API_KEY"/u);
  assert.match(source, /"secretsmanager", "put-secret-value"/u);
  assert.match(source, /\[str\(deploy\), "activate", digest\]/u);
  assert.doesNotMatch(
    source,
    /update-service|force-new-deployment|--no-restart/u,
  );
});

test("cloud identity refusal happens before either local secret file changes", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "bp-update-secret-"));
  const envFile = path.join(fixture, ".env.local");
  const tfvarsFile = path.join(fixture, "terraform.tfvars");
  await writeFile(envFile, "ANTHROPIC_API_KEY=original\n");
  await writeFile(tfvarsFile, 'anthropic_api_key = "original"\n');
  const harness = String.raw`
import importlib.util
import os
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location("update_secret", "scripts/update_secret.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.ENV_FILE = Path(os.environ["BP_TEST_ENV_FILE"])
module.ENV_EXAMPLE = Path(os.environ["BP_TEST_ENV_FILE"] + ".missing")
module.TFVARS_FILE = Path(os.environ["BP_TEST_TFVARS_FILE"])
module.getpass.getpass = lambda _prompt: "sk-ant-test-value"
module.validate_key = lambda _name, _value: True
module.assert_cloud_identity = lambda: False
sys.argv = ["update_secret.py", "ANTHROPIC_API_KEY"]
try:
    module.main()
except SystemExit as error:
    if error.code != 1:
        raise
else:
    raise SystemExit("expected identity refusal")
`;
  try {
    const result = spawnSync("python3", ["-c", harness], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        BP_TEST_ENV_FILE: envFile,
        BP_TEST_TFVARS_FILE: tfvarsFile,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await readFile(envFile, "utf8"),
      "ANTHROPIC_API_KEY=original\n",
    );
    assert.equal(
      await readFile(tfvarsFile, "utf8"),
      'anthropic_api_key = "original"\n',
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

function runCloudFailureHarness(scenario) {
  const harness = String.raw`
import importlib.util
import os
import sys

spec = importlib.util.spec_from_file_location("update_secret", "scripts/update_secret.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
scenario = os.environ["BP_TEST_SCENARIO"]
module.getpass.getpass = lambda _prompt: "sk-ant-test-value"
module.validate_key = lambda _name, _value: True
module.assert_cloud_identity = lambda: True
module.update_env_local = lambda _name, _value: True
module.update_tfvars = lambda _name, _value: True
module.update_secrets_manager = lambda _name, _value: scenario != "secret"
def activate():
    if scenario == "secret":
        raise RuntimeError("activation must not run after a cloud write failure")
    return False
module.activate_via_canonical_deploy = activate
sys.argv = ["update_secret.py", "ANTHROPIC_API_KEY"]
try:
    module.main()
except SystemExit as error:
    if error.code != 1:
        raise
else:
    raise SystemExit("expected partial rotation to fail")
`;
  return spawnSync("python3", ["-c", harness], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, BP_TEST_SCENARIO: scenario },
  });
}

test("Secrets Manager write failure is nonzero and never attempts activation", () => {
  const result = runCloudFailureHarness("secret");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Rotation incomplete/u);
  assert.match(result.stdout, /write did not report success/u);
  assert.match(result.stdout, /AWSCURRENT may be unchanged/u);
  assert.match(result.stdout, /Secrets Manager version stages and CloudTrail/u);
  assert.match(result.stdout, /do not retry or roll back blindly/u);
});

test("activation failure explains the split injected-value recovery state", () => {
  const result = runCloudFailureHarness("activate");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /AWSCURRENT now contains the new value/u);
  assert.match(result.stdout, /temporarily use different injected values/u);
  assert.match(result.stdout, /Do not blindly roll back AWSCURRENT/u);
  assert.match(result.stdout, /same service-bound digest/u);
});
