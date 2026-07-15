#!/usr/bin/env python3
"""
Update a secret across local .env.local, AWS Secrets Manager, and ECS.

Usage:
  python3 scripts/update_secret.py GROQ_API_KEY                    # interactive, full chain
  python3 scripts/update_secret.py GROQ_API_KEY --local-only       # skip AWS
"""

import getpass
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

ENV_FILE = Path(__file__).resolve().parent.parent / ".env.local"
ENV_EXAMPLE = Path(__file__).resolve().parent.parent / ".env.example"
TFVARS_FILE = Path(__file__).resolve().parent.parent / "infrastructure" / "terraform" / "terraform.tfvars"

DEPLOY_ENV = Path(__file__).resolve().parent.parent / ".deploy.env"
os.umask(0o077)

# Read from .deploy.env if it exists
_deploy_config: dict[str, str] = {}
if DEPLOY_ENV.exists():
    for line in DEPLOY_ENV.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            _deploy_config[k.strip()] = v.strip()

AWS_REGION = os.environ.get("AWS_REGION", _deploy_config.get("AWS_REGION", "us-east-1"))
AWS_ACCOUNT = os.environ.get("AWS_ACCOUNT", _deploy_config.get("AWS_ACCOUNT", ""))
ECS_CLUSTER = os.environ.get("ECS_CLUSTER", _deploy_config.get("ECS_CLUSTER", ""))
ECS_SERVICE = os.environ.get("ECS_SERVICE", _deploy_config.get("ECS_SERVICE", ""))
ECR_REPO = os.environ.get("ECR_REPO", _deploy_config.get("ECR_REPO", ""))

# Known key validators
VALIDATORS = {
    "GROQ_API_KEY": {
        "prefix": "gsk_",
        "url": "https://api.groq.com/openai/v1/models",
    },
    "ANTHROPIC_API_KEY": {
        "prefix": "sk-ant-",
    },
}
ALLOWED_KEY_NAMES = frozenset(VALIDATORS)
CANONICAL_SECRET_IDS = {
    "ANTHROPIC_API_KEY": "beaver/ANTHROPIC_API_KEY",
    "GROQ_API_KEY": "beaver/GROQ_API_KEY",
}


def validate_key(key_name: str, value: str) -> bool:
    """Validate a key if we know how."""
    spec = VALIDATORS.get(key_name)
    if not spec:
        return True  # no validation for unknown keys

    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        print("  API keys may contain only letters, digits, underscore, and hyphen")
        return False

    # Prefix check
    expected_prefix = spec.get("prefix")
    if expected_prefix and not value.startswith(expected_prefix):
        print(f"  Warning: {key_name} typically starts with '{expected_prefix}'")

    # API validation
    url = spec.get("url")
    if not url:
        return True

    req = Request(url, headers={"Authorization": f"Bearer {value}"})
    try:
        with urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except HTTPError as e:
        print(f"  API returned {e.code}: {e.reason}")
        return False
    except URLError as e:
        print(f"  Network/TLS error: {e.reason}")
        return False
    return False


def update_env_local(key_name: str, value: str) -> bool:
    """Update or insert key in .env.local."""
    if not ENV_FILE.exists():
        if ENV_EXAMPLE.exists():
            ENV_FILE.write_text(ENV_EXAMPLE.read_text())
            print(f"  Created {ENV_FILE.name} from {ENV_EXAMPLE.name}")
        else:
            ENV_FILE.write_text("")
            print(f"  Created empty {ENV_FILE.name}")

    content = ENV_FILE.read_text()
    pattern = rf"^{re.escape(key_name)}=.*$"

    if re.search(pattern, content, re.MULTILINE):
        content = re.sub(pattern, f"{key_name}={value}", content, flags=re.MULTILINE)
    else:
        content = content.rstrip("\n") + f"\n{key_name}={value}\n"

    ENV_FILE.write_text(content)
    return True


def update_tfvars(key_name: str, value: str) -> bool:
    """Update or insert key in terraform.tfvars (HCL format)."""
    if not TFVARS_FILE.exists():
        print(f"  {TFVARS_FILE} not found — skipping")
        return False

    # Terraform vars use snake_case, env vars use UPPER_SNAKE_CASE
    tf_var_name = key_name.lower()
    content = TFVARS_FILE.read_text()
    pattern = rf'^{re.escape(tf_var_name)}\s*=\s*".*"$'

    if re.search(pattern, content, re.MULTILINE):
        content = re.sub(pattern, f'{tf_var_name} = "{value}"', content, flags=re.MULTILINE)
    else:
        content = content.rstrip("\n") + f'\n\n# Added by update_secret.py\n{tf_var_name} = "{value}"\n'

    TFVARS_FILE.write_text(content)
    return True


def run_aws(args: list[str], stdin_text: str | None = None) -> tuple[bool, str]:
    """Run an AWS CLI command. Returns (success, output)."""
    try:
        result = subprocess.run(
            ["aws"] + args,
            capture_output=True, text=True, timeout=30, input=stdin_text,
        )
        if result.returncode == 0:
            return True, result.stdout.strip()
        return False, result.stderr.strip()
    except FileNotFoundError:
        return False, "AWS CLI not installed"
    except subprocess.TimeoutExpired:
        return False, "Command timed out"


def update_secrets_manager(key_name: str, value: str) -> bool:
    """Update the secret in AWS Secrets Manager."""
    secret_id = CANONICAL_SECRET_IDS[key_name]
    ok, output = run_aws([
        "secretsmanager", "put-secret-value",
        "--secret-id", secret_id,
        "--secret-string", "file:///dev/stdin",
        "--region", AWS_REGION,
    ], stdin_text=value)
    if ok:
        print(f"  Updated Secrets Manager: {secret_id}")
        return True

    if "ResourceNotFoundException" in output:
        print(f"  Secret '{secret_id}' not found in Secrets Manager")
        print(f"  Run 'terraform apply' to create it first")
    elif "UnrecognizedClientException" in output or "credentials" in output.lower():
        print(f"  AWS credentials not configured — skipping Secrets Manager")
    else:
        print(f"  Secrets Manager error: {output}")
    return False


def assert_cloud_identity() -> bool:
    """Refuse cloud writes outside the one canonical deployment identity."""
    if not re.fullmatch(r"[0-9]{12}", AWS_ACCOUNT):
        print("  AWS_ACCOUNT must be the canonical 12-digit account", file=sys.stderr)
        return False
    if ECS_CLUSTER != "beaver-cluster" or ECS_SERVICE != "beaver-app" or ECR_REPO != "beaver-app":
        print("  Cloud secret updates require canonical beaver cluster/service/repository", file=sys.stderr)
        return False
    ok, output = run_aws([
        "sts", "get-caller-identity",
        "--query", "Account",
        "--output", "text",
        "--region", AWS_REGION,
    ])
    if not ok or output != AWS_ACCOUNT:
        print("  AWS caller account identity does not match AWS_ACCOUNT", file=sys.stderr)
        return False
    return True


def activate_via_canonical_deploy() -> bool:
    """Use deploy.sh admission rather than a direct ECS force deployment."""
    ok, task_definition = run_aws([
        "ecs", "describe-services",
        "--cluster", ECS_CLUSTER,
        "--services", ECS_SERVICE,
        "--region", AWS_REGION,
        "--query", "services[0].taskDefinition",
        "--output", "text",
    ])
    if not ok:
        print(f"  Could not resolve the service-bound task definition: {task_definition}")
        return False
    ok, image = run_aws([
        "ecs", "describe-task-definition",
        "--task-definition", task_definition,
        "--region", AWS_REGION,
        "--query", "taskDefinition.containerDefinitions[0].image",
        "--output", "text",
    ])
    digest = image.rsplit("@", 1)[-1] if ok else ""
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        print("  Service-bound app image is not digest pinned; refusing activation")
        return False

    deploy = ENV_FILE.parent / "deploy.sh"
    result = subprocess.run([str(deploy), "activate", digest], text=True)
    return result.returncode == 0


def main():
    # Parse args
    args = sys.argv[1:]
    local_only = "--local-only" in args
    unknown_flags = [
        arg for arg in args
        if arg.startswith("--") and arg != "--local-only"
    ]
    if unknown_flags:
        print(f"Unknown option: {unknown_flags[0]}", file=sys.stderr)
        sys.exit(1)
    args = [a for a in args if not a.startswith("--")]

    if len(args) < 1:
        print("Usage: python3 scripts/update_secret.py KEY_NAME [--local-only]")
        print("\nExamples:")
        print("  python3 scripts/update_secret.py GROQ_API_KEY")
        print("  python3 scripts/update_secret.py ANTHROPIC_API_KEY --local-only")
        sys.exit(1)

    key_name = args[0]
    if key_name not in ALLOWED_KEY_NAMES:
        allowed = ", ".join(sorted(ALLOWED_KEY_NAMES))
        print(
            f"Refusing unsupported secret {key_name}. "
            f"This helper is restricted to rotatable API keys: {allowed}",
            file=sys.stderr,
        )
        sys.exit(1)

    if len(args) != 1:
        print(
            "Refusing a secret value in process arguments; enter it at the hidden prompt",
            file=sys.stderr,
        )
        sys.exit(1)

    # Get value
    value = getpass.getpass(f"Enter value for {key_name} (input hidden): ").strip()

    if not value:
        print("No value provided. Aborting.")
        sys.exit(1)

    print(f"\n=== Updating {key_name} ===\n")

    # Step 1: Validate
    print("[1/5] Validating...")
    if validate_key(key_name, value):
        print("  Valid\n")
    else:
        print("  Validation failed; refusing to store or transmit the secret")
        sys.exit(1)

    # For a cloud rotation, establish the exact deployment authority before
    # changing either local file. A mistaken account/cluster must leave every
    # local and cloud copy untouched.
    if not local_only and not assert_cloud_identity():
        sys.exit(1)

    # Step 2: Update .env.local
    print("[2/5] Updating .env.local...")
    update_env_local(key_name, value)
    print(f"  Done\n")

    # Step 3: Update terraform.tfvars
    print("[3/5] Updating terraform.tfvars...")
    if update_tfvars(key_name, value):
        print(f"  Done\n")
    else:
        print()

    if local_only:
        print("[4/5] Skipping Secrets Manager (--local-only)")
        print("[5/5] Skipping ECS restart (--local-only)")
        print(f"\nDone. Restart your dev server for changes to take effect.")
        return

    # Step 4: Update Secrets Manager
    print("[4/5] Updating AWS Secrets Manager...")
    sm_ok = update_secrets_manager(key_name, value)
    print()

    # Step 5: Restart ECS
    if not sm_ok:
        print("[5/5] Skipping activation (Secrets Manager update failed)")
        print(
            "  Rotation incomplete: local files contain the new value, but the AWS "
            "write did not report success. AWSCURRENT may be unchanged or may already "
            "contain the new version. Inspect Secrets Manager version stages and "
            "CloudTrail, then reconcile deliberately; do not retry or roll back blindly."
        )
        sys.exit(1)

    print("[5/5] Running canonical deployment admission...")
    if not activate_via_canonical_deploy():
        print(
            "  AWS AWSCURRENT now contains the new value, but canonical activation "
            "did not complete verification. Existing and newly launched tasks may "
            "temporarily use different injected values, and the app rollout outcome "
            "may be unknown. Do not blindly roll back AWSCURRENT or rotate again; "
            "inspect ECS deployment/task state, resolve the deploy error, and rerun "
            "deploy.sh activate with the same service-bound digest."
        )
        sys.exit(1)

    print("\nDone.")


if __name__ == "__main__":
    main()
