#!/usr/bin/env bash
set -euo pipefail

# Read-only sizing assistant. Terraform owns task-definition registration and
# deploy.sh owns schema/target admission plus activation; this helper may not
# mutate either ECS or Lambda directly.
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "${PROJECT_DIR}/.deploy.env" ] && source "${PROJECT_DIR}/.deploy.env"

: "${AWS_REGION:?ERROR: Set AWS_REGION in .deploy.env or environment}"
: "${ECS_CLUSTER:?ERROR: Set ECS_CLUSTER in .deploy.env or environment}"
: "${ECS_SERVICE:?ERROR: Set ECS_SERVICE in .deploy.env or environment}"
[ "${ECS_CLUSTER}" = "beaver-cluster" ] || {
  echo "ERROR: ECS_CLUSTER must be beaver-cluster" >&2
  exit 1
}
[ "${ECS_SERVICE}" = "beaver-app" ] || {
  echo "ERROR: ECS_SERVICE must be beaver-app" >&2
  exit 1
}
command -v aws >/dev/null 2>&1 || {
  echo "ERROR: aws CLI not found" >&2
  exit 1
}

readonly TIER_LABELS=("Cheap" "Balanced" "Performance" "Overpowered")
readonly TIER_CPU=("1024" "2048" "4096" "8192")
readonly TIER_MEM=("2048" "4096" "8192" "16384")
readonly TIER_DESC=("1 vCPU / 2 GB" "2 vCPU / 4 GB" "4 vCPU / 8 GB" "8 vCPU / 16 GB")

fmt_month_cost() {
  local cpu_units="$1" mem_mib="$2"
  local cpu_x=$((cpu_units * 40480 / 1024))
  local mem_x=$((mem_mib * 4445 / 1024))
  printf '%s' "$(((cpu_x + mem_x) * 730 / 1000000))"
}

# Display the service-bound revision, never family-latest: family-latest can be
# an unadmitted or re-registered pre-boundary definition.
service_task_definition=$(aws ecs describe-services \
  --cluster "${ECS_CLUSTER}" \
  --services "${ECS_SERVICE}" \
  --region "${AWS_REGION}" \
  --query 'services[0].taskDefinition' \
  --output text)
[[ "${service_task_definition}" =~ :task-definition/beaver-app:[0-9]+$ ]] || {
  echo "ERROR: service is not bound to a canonical beaver-app revision" >&2
  exit 1
}
current_cpu=$(aws ecs describe-task-definition \
  --task-definition "${service_task_definition}" --region "${AWS_REGION}" \
  --query 'taskDefinition.cpu' --output text)
current_memory=$(aws ecs describe-task-definition \
  --task-definition "${service_task_definition}" --region "${AWS_REGION}" \
  --query 'taskDefinition.memory' --output text)
current_image=$(aws ecs describe-task-definition \
  --task-definition "${service_task_definition}" --region "${AWS_REGION}" \
  --query 'taskDefinition.containerDefinitions[0].image' --output text)
current_digest="${current_image##*@}"
[[ "${current_digest}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo "ERROR: service-bound app image is not digest pinned: ${current_image}" >&2
  exit 1
}

printf '\nService-bound revision: %s\n' "${service_task_definition}"
printf 'Current size: cpu=%s memory=%s (~$%s/month at one 24/7 task)\n\n' \
  "${current_cpu}" "${current_memory}" \
  "$(fmt_month_cost "${current_cpu}" "${current_memory}")"
printf 'Choose a Terraform-managed tier:\n'
for index in "${!TIER_LABELS[@]}"; do
  marker=""
  if [ "${TIER_CPU[$index]}" = "${current_cpu}" ] &&
    [ "${TIER_MEM[$index]}" = "${current_memory}" ]; then
    marker=" (current)"
  fi
  printf '  %s. %-12s %-18s ~$%s/month%s\n' \
    "$((index + 1))" "${TIER_LABELS[$index]}" "${TIER_DESC[$index]}" \
    "$(fmt_month_cost "${TIER_CPU[$index]}" "${TIER_MEM[$index]}")" "${marker}"
done

read -r -p "Tier [1-4, q to cancel]: " tier_choice
case "${tier_choice}" in
  q|Q|quit|"") echo "Cancelled."; exit 0 ;;
  1|2|3|4) index=$((tier_choice - 1)) ;;
  *) echo "ERROR: invalid tier: ${tier_choice}" >&2; exit 1 ;;
esac

new_cpu="${TIER_CPU[$index]}"
new_memory="${TIER_MEM[$index]}"
cat <<EOF

No AWS resources were changed. Review and run the canonical Terraform/deploy flow:

  export TF_VAR_ecs_cpu=${new_cpu}
  export TF_VAR_ecs_memory=${new_memory}
  export TF_VAR_beaver_app_image_digest=${current_digest}
  terraform -chdir=infrastructure/terraform plan -out=ecs-sizing.tfplan
  terraform -chdir=infrastructure/terraform apply ecs-sizing.tfplan
  ./deploy.sh activate ${current_digest}

Terraform registers the digest-pinned revision while intentionally leaving the
service binding unchanged. deploy.sh then rechecks schema history, all writer
targets, and rollout stability before activation. Delete the local plan artifact
after use; never commit it.
EOF
