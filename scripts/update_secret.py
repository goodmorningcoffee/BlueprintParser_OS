#!/usr/bin/env python3
"""
Update a secret across local .env.local, AWS Secrets Manager, and ECS.

Usage:
  python3 scripts/update_secret.py GROQ_API_KEY                    # interactive, full chain
  python3 scripts/update_secret.py GROQ_API_KEY gsk_new_key        # pass value directly
  python3 scripts/update_secret.py GROQ_API_KEY --local-only       # skip AWS
  python3 scripts/update_secret.py GROQ_API_KEY gsk_x --no-restart # skip ECS redeploy
"""

import os
import sys
import getpass
import re
import ssl
import subprocess
import json
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

ENV_FILE = Path(__file__).resolve().parent.parent / ".env.local"
ENV_EXAMPLE = Path(__file__).resolve().parent.parent / ".env.example"
TFVARS_FILE = Path(__file__).resolve().parent.parent / "infrastructure" / "terraform" / "terraform.tfvars"

DEPLOY_ENV = Path(__file__).resolve().parent.parent / ".deploy.env"

# Read from .deploy.env if it exists
_deploy_config: dict[str, str] = {}
if DEPLOY_ENV.exists():
    for line in DEPLOY_ENV.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            _deploy_config[k.strip()] = v.strip()

AWS_REGION = os.environ.get("AWS_REGION", _deploy_config.get("AWS_REGION", "us-east-1"))
SECRETS_PREFIX = os.environ.get("SECRETS_PREFIX", _deploy_config.get("SECRETS_PREFIX", "beaver"))
ECS_CLUSTER = os.environ.get("ECS_CLUSTER", _deploy_config.get("ECS_CLUSTER", "blueprintparser-cluster"))
ECS_SERVICE = os.environ.get("ECS_SERVICE", _deploy_config.get("ECS_SERVICE", "blueprintparser-app"))

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


def validate_key(key_name: str, value: str) -> bool:
    """Validate a key if we know how."""
    spec = VALIDATORS.get(key_name)
    if not spec:
        return True  # no validation for unknown keys

    # Prefix check
    expected_prefix = spec.get("prefix")
    if expected_prefix and not value.startswith(expected_prefix):
        print(f"  Warning: {key_name} typically starts with '{expected_prefix}'")

    # API validation
    url = spec.get("url")
    if not url:
        return True

    req = Request(url, headers={"Authorization": f"Bearer {value}"})
    for ctx in [None, ssl._create_unverified_context()]:
        try:
            with urlopen(req, timeout=10, context=ctx) as resp:
                if resp.status == 200:
                    if ctx is not None:
                        print("  (SSL verification skipped — missing CA certs)")
                    return True
        except HTTPError as e:
            print(f"  API returned {e.code}: {e.reason}")
            return False
        except URLError as e:
            if "CERTIFICATE_VERIFY_FAILED" in str(e.reason) and ctx is None:
                continue
            print(f"  Network error: {e.reason}")
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


def run_aws(args: list[str]) -> tuple[bool, str]:
    """Run an AWS CLI command. Returns (success, output)."""
    try:
        result = subprocess.run(
            ["aws"] + args,
            capture_output=True, text=True, timeout=30,
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
    secret_id = f"{SECRETS_PREFIX}/{key_name}"
    ok, output = run_aws([
        "secretsmanager", "update-secret",
        "--secret-id", secret_id,
        "--secret-string", value,
        "--region", AWS_REGION,
    ])
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


def restart_ecs() -> bool:
    """Force ECS to redeploy and pick up new secrets."""
    print(f"  Restarting ECS service {ECS_SERVICE}...")
    ok, output = run_aws([
        "ecs", "update-service",
        "--cluster", ECS_CLUSTER,
        "--service", ECS_SERVICE,
        "--force-new-deployment",
        "--region", AWS_REGION,
    ])
    if ok:
        print(f"  ECS redeploy triggered — new tasks will pick up the updated secret")
        return True

    print(f"  ECS restart failed: {output}")
    return False


def main():
    # Parse args
    args = sys.argv[1:]
    local_only = "--local-only" in args
    no_restart = "--no-restart" in args
    args = [a for a in args if not a.startswith("--")]

    if len(args) < 1:
        print("Usage: python3 scripts/update_secret.py KEY_NAME [value] [--local-only] [--no-restart]")
        print("\nExamples:")
        print("  python3 scripts/update_secret.py GROQ_API_KEY")
        print("  python3 scripts/update_secret.py GROQ_API_KEY gsk_new_key")
        print("  python3 scripts/update_secret.py ANTHROPIC_API_KEY --local-only")
        sys.exit(1)

    key_name = args[0]

    # Get value
    if len(args) > 1:
        value = args[1]
    else:
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
        print("  Validation failed. Continue anyway? (y/n): ", end="")
        if input().strip().lower() != "y":
            sys.exit(1)
        print()

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
    if no_restart:
        print("[5/5] Skipping ECS restart (--no-restart)")
    elif sm_ok:
        print("[5/5] Restarting ECS...")
        restart_ecs()
    else:
        print("[5/5] Skipping ECS restart (Secrets Manager update failed)")

    print(f"\nDone.")


if __name__ == "__main__":
    main()
