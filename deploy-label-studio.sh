#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Label Studio Deploy Script
# Forces a new deployment of the Label Studio ECS service.
# Uses the official Docker Hub image (no build step needed).
# ─────────────────────────────────────────────────────────────────────────────

AWS_REGION="us-east-1"
ECS_CLUSTER="beaver-cluster"
ECS_SERVICE="beaver-label-studio"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  Label Studio → Deploy to AWS${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

echo -e "${GREEN}▶${NC} Updating ECS service ${BOLD}${ECS_SERVICE}${NC}..."
aws ecs update-service \
    --cluster "${ECS_CLUSTER}" \
    --service "${ECS_SERVICE}" \
    --force-new-deployment \
    --region "${AWS_REGION}" \
    --output text \
    --query 'service.serviceName' > /dev/null
echo -e "${GREEN}✔${NC} Deployment triggered"

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✔${NC} ${BOLD}Label Studio deploy complete!${NC}"
echo ""
echo -e "  Watch progress:"
echo -e "  ${CYAN}aws ecs describe-services --cluster ${ECS_CLUSTER} --services ${ECS_SERVICE} --region ${AWS_REGION} --query 'services[0].{running:runningCount,desired:desiredCount,pending:pendingCount}'${NC}"
echo ""
echo -e "  View logs:"
echo -e "  ${CYAN}aws logs tail /ecs/beaver-label-studio --since 5m --region ${AWS_REGION} --follow${NC}"
echo ""
echo -e "  Access: ${BOLD}https://labelstudio.blueprintparser.com${NC}"
echo ""
