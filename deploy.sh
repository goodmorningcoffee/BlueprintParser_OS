#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# BlueprintParser 2 Deploy Script
# Builds, pushes Docker image to ECR, and updates ECS service.
# Uses the SAME ECR repo and ECS service as blueprintparser_current.
# ─────────────────────────────────────────────────────────────────────────────

AWS_ACCOUNT="100328509916"
AWS_REGION="us-east-1"
ECR_BASE="${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com"
ECR_REPO="beaver-app"
ECS_CLUSTER="beaver-cluster"
ECS_SERVICE="beaver-app"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

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
docker build -t "${ECR_REPO}:latest" "${PROJECT_DIR}"
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
echo -e "  ${CYAN}aws logs tail /ecs/beaver-app --since 5m --region ${AWS_REGION} --follow${NC}"
echo ""
