#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# CV Lambda Pipeline Deploy Script
# Builds the OpenCV+Tesseract Lambda container image, pushes to ECR, and
# creates or updates the Lambda function.
#
# First-time: run setup-lambda-iam.sh first to create the IAM role.
# ─────────────────────────────────────────────────────────────────────────────

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "${PROJECT_DIR}/.deploy.env" ] && source "${PROJECT_DIR}/.deploy.env"

: "${AWS_ACCOUNT:?ERROR: Set AWS_ACCOUNT in .deploy.env or environment}"
: "${AWS_REGION:?ERROR: Set AWS_REGION in .deploy.env or environment}"
: "${ECR_CV_REPO:?ERROR: Set ECR_CV_REPO in .deploy.env or environment}"
: "${LAMBDA_FUNCTION_NAME:?ERROR: Set LAMBDA_FUNCTION_NAME in .deploy.env or environment}"
: "${LAMBDA_ROLE_ARN:?ERROR: Set LAMBDA_ROLE_ARN in .deploy.env or environment}"

ECR_BASE="${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  CV Lambda Pipeline → Deploy${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# 1. ECR Login
echo -e "${GREEN}▶${NC} Logging into ECR..."
aws ecr get-login-password --region "${AWS_REGION}" \
    | docker login --username AWS --password-stdin "${ECR_BASE}" 2>/dev/null
echo -e "${GREEN}✔${NC} ECR login successful"

# 2. Ensure ECR repo exists
if ! aws ecr describe-repositories --repository-names "${ECR_CV_REPO}" --region "${AWS_REGION}" > /dev/null 2>&1; then
  echo -e "\n${GREEN}▶${NC} Creating ECR repository ${BOLD}${ECR_CV_REPO}${NC}..."
  aws ecr create-repository \
      --repository-name "${ECR_CV_REPO}" \
      --image-tag-mutability MUTABLE \
      --image-scanning-configuration scanOnPush=true \
      --region "${AWS_REGION}" > /dev/null
  echo -e "${GREEN}✔${NC} ECR repository created"
fi

# 3. Build
echo -e "\n${GREEN}▶${NC} Building CV Lambda image..."
docker build -f Dockerfile.lambda -t "${ECR_CV_REPO}:latest" "${PROJECT_DIR}"
echo -e "${GREEN}✔${NC} Build complete"

# 4. Tag & Push
ECR_URL="${ECR_BASE}/${ECR_CV_REPO}:latest"
echo -e "\n${GREEN}▶${NC} Pushing to ${ECR_URL}..."
docker tag "${ECR_CV_REPO}:latest" "${ECR_URL}"
docker push "${ECR_URL}"
echo -e "${GREEN}✔${NC} Push complete"

# 5. Create or update Lambda function
echo -e "\n${GREEN}▶${NC} Updating Lambda function ${BOLD}${LAMBDA_FUNCTION_NAME}${NC}..."
if aws lambda get-function --function-name "${LAMBDA_FUNCTION_NAME}" --region "${AWS_REGION}" > /dev/null 2>&1; then
  aws lambda update-function-code \
      --function-name "${LAMBDA_FUNCTION_NAME}" \
      --image-uri "${ECR_URL}" \
      --region "${AWS_REGION}" \
      --output text \
      --query 'FunctionName' > /dev/null
  echo -e "${GREEN}✔${NC} Lambda function updated"
else
  echo -e "  Creating new Lambda function..."
  aws lambda create-function \
      --function-name "${LAMBDA_FUNCTION_NAME}" \
      --package-type Image \
      --code "ImageUri=${ECR_URL}" \
      --role "${LAMBDA_ROLE_ARN}" \
      --timeout 120 \
      --memory-size 2048 \
      --ephemeral-storage '{"Size": 1024}' \
      --architectures x86_64 \
      --region "${AWS_REGION}" \
      --output text \
      --query 'FunctionName' > /dev/null
  echo -e "${GREEN}✔${NC} Lambda function created"
fi

# 6. Done
echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✔${NC} ${BOLD}CV Lambda deployed!${NC}"
echo ""
echo -e "  Test with:"
echo -e "  ${CYAN}aws lambda invoke --function-name ${LAMBDA_FUNCTION_NAME} --region ${AWS_REGION} --payload '{\"action\":\"template_match\",\"s3_bucket\":\"test\",\"page_s3_keys\":[],\"result_s3_key\":\"test\",\"template_s3_key\":\"test\"}' /dev/stdout${NC}"
echo ""
echo -e "  View logs:"
echo -e "  ${CYAN}aws logs tail /aws/lambda/${LAMBDA_FUNCTION_NAME} --since 5m --region ${AWS_REGION} --follow${NC}"
echo ""
