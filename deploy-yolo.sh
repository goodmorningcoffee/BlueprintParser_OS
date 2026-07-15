#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/lib/ecs-schema-tools.sh
source "${PROJECT_DIR}/scripts/lib/ecs-schema-tools.sh"
DEPLOY_ENV_FILE="${BP_DEPLOY_ENV_FILE:-${PROJECT_DIR}/.deploy.env}"
[ -f "${DEPLOY_ENV_FILE}" ] && source "${DEPLOY_ENV_FILE}"

bp_require_env AWS_ACCOUNT AWS_REGION
bp_assert_caller_account
command -v docker >/dev/null 2>&1 || bp_die "docker is required"

ECR_YOLO_REPO="${ECR_YOLO_REPO:-beaver-yolo-pipeline}"
[ "${ECR_YOLO_REPO}" = "beaver-yolo-pipeline" ] ||
  bp_die "ECR_YOLO_REPO must be the canonical beaver-yolo-pipeline repository"

ECR_BASE="${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE_TAG="${BP_YOLO_IMAGE_TAG:-yolo-deploy-$(git -C "${PROJECT_DIR}" rev-parse --short=12 HEAD)-$(date -u +%Y%m%d%H%M%S)}"
LOCAL_IMAGE="${ECR_YOLO_REPO}:${IMAGE_TAG}"
ECR_TAG="${ECR_BASE}/${ECR_YOLO_REPO}:${IMAGE_TAG}"

if bp_aws ecr describe-images \
  --repository-name "${ECR_YOLO_REPO}" \
  --image-ids "imageTag=${IMAGE_TAG}" \
  --region "${AWS_REGION}" >/dev/null 2>&1; then
  bp_die "refusing to reuse existing immutable YOLO tag ${IMAGE_TAG}"
fi

export DOCKER_BUILDKIT=1
bp_aws ecr get-login-password --region "${AWS_REGION}" |
  docker login --username AWS --password-stdin "${ECR_BASE}" >/dev/null
docker build --platform linux/amd64 -f Dockerfile.yolo -t "${LOCAL_IMAGE}" "${PROJECT_DIR}"
docker tag "${LOCAL_IMAGE}" "${ECR_TAG}"
docker push "${ECR_TAG}"

DIGEST=$(bp_aws ecr describe-images \
  --repository-name "${ECR_YOLO_REPO}" \
  --image-ids "imageTag=${IMAGE_TAG}" \
  --region "${AWS_REGION}" \
  --query 'imageDetails[0].imageDigest' \
  --output text)
bp_validate_digest "${DIGEST}"

cat <<EOF
Published immutable YOLO processing image:
  ${ECR_BASE}/${ECR_YOLO_REPO}@${DIGEST}

Review and apply the digest through Terraform; SageMaker never consumes a tag:
  export TF_VAR_beaver_yolo_image_digest=${DIGEST}
  terraform -chdir=infrastructure/terraform plan
  terraform -chdir=infrastructure/terraform apply
EOF
