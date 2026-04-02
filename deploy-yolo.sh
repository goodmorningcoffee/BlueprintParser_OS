#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# YOLO Pipeline Deploy Script
# Builds GPU inference image and pushes to ECR for SageMaker.
# ─────────────────────────────────────────────────────────────────────────────

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "${PROJECT_DIR}/.deploy.env" ] && source "${PROJECT_DIR}/.deploy.env"

: "${AWS_ACCOUNT:?ERROR: Set AWS_ACCOUNT in .deploy.env or environment}"
: "${AWS_REGION:?ERROR: Set AWS_REGION in .deploy.env or environment}"
ECR_REPO="${ECR_YOLO_REPO:-${ECR_REPO:?ERROR: Set ECR_YOLO_REPO or ECR_REPO in .deploy.env}}"
ECR_BASE="${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  YOLO Pipeline → Deploy to ECR${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# 1. ECR Login
echo -e "${GREEN}▶${NC} Logging into ECR..."
aws ecr get-login-password --region "${AWS_REGION}" \
    | docker login --username AWS --password-stdin "${ECR_BASE}" 2>/dev/null
echo -e "${GREEN}✔${NC} ECR login successful"

# 2. Build
echo -e "\n${GREEN}▶${NC} Building YOLO inference image..."
docker build -f Dockerfile.yolo -t "${ECR_REPO}:latest" "${PROJECT_DIR}"
echo -e "${GREEN}✔${NC} Build complete"

# 3. Tag & Push
ECR_URL="${ECR_BASE}/${ECR_REPO}:latest"
echo -e "\n${GREEN}▶${NC} Pushing to ${ECR_URL}..."
docker tag "${ECR_REPO}:latest" "${ECR_URL}"
docker push "${ECR_URL}"
echo -e "${GREEN}✔${NC} Push complete"

# 4. Done (no ECS update — SageMaker pulls the image directly)
echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✔${NC} ${BOLD}YOLO image deployed!${NC}"
echo ""
echo -e "  SageMaker will pull this image when a YOLO job starts."
echo -e "  Image: ${CYAN}${ECR_URL}${NC}"
echo ""
