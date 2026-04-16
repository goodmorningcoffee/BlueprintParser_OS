#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# One-time IAM setup for the CV Lambda Pipeline.
# Creates the Lambda execution role and adds lambda:InvokeFunction to the
# ECS task role so the web server can fan out CV jobs.
#
# Run this ONCE before the first deploy-lambda.sh.
# ─────────────────────────────────────────────────────────────────────────────

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "${PROJECT_DIR}/.deploy.env" ] && source "${PROJECT_DIR}/.deploy.env"

: "${AWS_ACCOUNT:?ERROR: Set AWS_ACCOUNT in .deploy.env or environment}"
: "${AWS_REGION:?ERROR: Set AWS_REGION in .deploy.env or environment}"
: "${LAMBDA_FUNCTION_NAME:?ERROR: Set LAMBDA_FUNCTION_NAME in .deploy.env or environment}"
: "${ECS_TASK_ROLE:?ERROR: Set ECS_TASK_ROLE in .deploy.env or environment}"

LAMBDA_ROLE_NAME="${LAMBDA_FUNCTION_NAME}-role"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  CV Lambda IAM Setup${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ─── 1. Create Lambda execution role ──────────────────────────

TRUST_POLICY='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}'

if aws iam get-role --role-name "${LAMBDA_ROLE_NAME}" > /dev/null 2>&1; then
  echo -e "${GREEN}✔${NC} Lambda role ${BOLD}${LAMBDA_ROLE_NAME}${NC} already exists"
else
  echo -e "${GREEN}▶${NC} Creating Lambda execution role ${BOLD}${LAMBDA_ROLE_NAME}${NC}..."
  aws iam create-role \
      --role-name "${LAMBDA_ROLE_NAME}" \
      --assume-role-policy-document "${TRUST_POLICY}" \
      --output text --query 'Role.Arn' > /dev/null
  echo -e "${GREEN}✔${NC} Role created"
fi

LAMBDA_ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT}:role/${LAMBDA_ROLE_NAME}"

# Attach basic execution policy (CloudWatch Logs)
echo -e "${GREEN}▶${NC} Attaching AWSLambdaBasicExecutionRole..."
aws iam attach-role-policy \
    --role-name "${LAMBDA_ROLE_NAME}" \
    --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" 2>/dev/null || true
echo -e "${GREEN}✔${NC} Basic execution policy attached"

# Add S3 read/write for page images and results
S3_POLICY='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:PutObject"],
    "Resource": "arn:aws:s3:::beaver-data-*/*"
  }]
}'

echo -e "${GREEN}▶${NC} Adding S3 access policy..."
aws iam put-role-policy \
    --role-name "${LAMBDA_ROLE_NAME}" \
    --policy-name "cv-lambda-s3-access" \
    --policy-document "${S3_POLICY}"
echo -e "${GREEN}✔${NC} S3 policy attached"

# ─── 2. Add lambda:InvokeFunction to ECS task role ────────────

INVOKE_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "lambda:InvokeFunction",
    "Resource": "arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT}:function:${LAMBDA_FUNCTION_NAME}"
  }]
}
EOF
)

echo -e "\n${GREEN}▶${NC} Adding lambda:InvokeFunction to ECS task role ${BOLD}${ECS_TASK_ROLE}${NC}..."
aws iam put-role-policy \
    --role-name "${ECS_TASK_ROLE}" \
    --policy-name "cv-lambda-invoke" \
    --policy-document "${INVOKE_POLICY}"
echo -e "${GREEN}✔${NC} ECS task role updated"

# ─── Done ─────────────────────────────────────────────────────

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✔${NC} ${BOLD}IAM setup complete!${NC}"
echo ""
echo -e "  Lambda role ARN: ${CYAN}${LAMBDA_ROLE_ARN}${NC}"
echo -e "  Add this to .deploy.env:"
echo -e "  ${CYAN}LAMBDA_ROLE_ARN=${LAMBDA_ROLE_ARN}${NC}"
echo ""
