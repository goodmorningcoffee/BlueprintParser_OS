#!/usr/bin/env bash
set -euo pipefail

# BuildKit is required for the RUN --mount=type=cache directives in Dockerfile.
# Default since Docker 23 but explicit removes ambiguity across dev environments.
export DOCKER_BUILDKIT=1

# ─────────────────────────────────────────────────────────────────────────────
# BlueprintParser 2 Deploy Script
# Builds, pushes Docker image to ECR, and updates ECS service.
# Uses the SAME ECR repo and ECS service as blueprintparser_current.
# ─────────────────────────────────────────────────────────────────────────────

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "${PROJECT_DIR}/.deploy.env" ] && source "${PROJECT_DIR}/.deploy.env"

: "${AWS_ACCOUNT:?ERROR: Set AWS_ACCOUNT in .deploy.env or environment}"
: "${AWS_REGION:?ERROR: Set AWS_REGION in .deploy.env or environment}"
: "${ECR_REPO:?ERROR: Set ECR_REPO in .deploy.env or environment}"
: "${ECS_CLUSTER:?ERROR: Set ECS_CLUSTER in .deploy.env or environment}"
: "${ECS_SERVICE:?ERROR: Set ECS_SERVICE in .deploy.env or environment}"

ECR_BASE="${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  BlueprintParser 2 → Deploy to AWS${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# 1. ECR Login
echo -e "${GREEN}▶${NC} Logging into ECR..."
aws ecr get-login-password --region "${AWS_REGION}" \
    | docker login --username AWS --password-stdin "${ECR_BASE}" 2>/dev/null
echo -e "${GREEN}✔${NC} ECR login successful"

# 2. Build
echo -e "\n${GREEN}▶${NC} Building Docker image..."
docker build \
  --build-arg NEXT_PUBLIC_CLOUDFRONT_DOMAIN="${CLOUDFRONT_DOMAIN:-}" \
  --build-arg NEXT_PUBLIC_S3_BUCKET="${S3_BUCKET:-}" \
  -t "${ECR_REPO}:latest" "${PROJECT_DIR}"
echo -e "${GREEN}✔${NC} Build complete"

# 3. Tag & Push
ECR_URL="${ECR_BASE}/${ECR_REPO}:latest"
echo -e "\n${GREEN}▶${NC} Pushing to ${ECR_URL}..."
docker tag "${ECR_REPO}:latest" "${ECR_URL}"
docker push "${ECR_URL}"
echo -e "${GREEN}✔${NC} Push complete"

# 4. Update ECS Service
echo -e "\n${GREEN}▶${NC} Updating ECS service ${BOLD}${ECS_SERVICE}${NC}..."
aws ecs update-service \
    --cluster "${ECS_CLUSTER}" \
    --service "${ECS_SERVICE}" \
    --force-new-deployment \
    --region "${AWS_REGION}" \
    --output text \
    --query 'service.serviceName' > /dev/null
echo -e "${GREEN}✔${NC} Deployment triggered"

# 5. Status
echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✔${NC} ${BOLD}Deploy complete!${NC}"
echo ""
echo -e "  Watch deployment progress:"
echo -e "  ${CYAN}aws ecs describe-services --cluster ${ECS_CLUSTER} --services ${ECS_SERVICE} --region ${AWS_REGION} --query 'services[0].{running:runningCount,desired:desiredCount,pending:pendingCount}'${NC}"
echo ""
echo -e "  View logs:"
echo -e "  ${CYAN}aws logs tail ${LOG_GROUP:-/ecs/${ECS_SERVICE}} --since 5m --region ${AWS_REGION} --follow${NC}"
echo ""
