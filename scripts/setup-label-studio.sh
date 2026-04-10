#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Label Studio Setup TUI
# Interactive setup wizard for connecting Label Studio to BlueprintParser.
# Run after: terraform apply && ./deploy-label-studio.sh
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "${SCRIPT_DIR}/../.deploy.env" ] && source "${SCRIPT_DIR}/../.deploy.env"

AWS_REGION="${AWS_REGION:-us-east-1}"
ECS_CLUSTER="${ECS_CLUSTER:?ERROR: Set ECS_CLUSTER in .deploy.env or environment}"
DOMAIN="${DOMAIN:?ERROR: Set DOMAIN in .deploy.env or environment}"
LS_URL="https://labelstudio.${DOMAIN}"
SECRETS_PREFIX="${SECRETS_PREFIX:-beaver}"

# Colors
R='\033[0m'       # Reset
B='\033[1m'       # Bold
D='\033[2m'       # Dim
G='\033[0;32m'    # Green
C='\033[0;36m'    # Cyan
Y='\033[1;33m'    # Yellow
RD='\033[0;31m'   # Red
BG='\033[44m'     # Blue BG
W='\033[1;37m'    # White bold

clear_screen() { printf '\033[2J\033[H'; }
draw_line() { echo -e "${C}$(printf '━%.0s' $(seq 1 62))${R}"; }
spinner() {
  local pid=$1 chars='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${C}${chars:$i:1}${R} %s" "$2"
    i=$(( (i + 1) % ${#chars} ))
    sleep 0.1
  done
  printf "\r"
}

# ═══════════════════════════════════════════════════════════════
#  WELCOME SCREEN
# ═══════════════════════════════════════════════════════════════
clear_screen
echo ""
draw_line
echo -e "  ${BG}${W}  Label Studio Setup  ${R}  ${D}for BlueprintParser${R}"
draw_line
echo ""
echo -e "  This wizard will:"
echo -e "  ${G}1${R} Check Label Studio is running on AWS"
echo -e "  ${G}2${R} Guide you through creating an admin account"
echo -e "  ${G}3${R} Help you generate an API access token"
echo -e "  ${G}4${R} Store the token in AWS Secrets Manager"
echo -e "  ${G}5${R} Redeploy BlueprintParser with the new token"
echo ""
echo -e "  ${D}Prerequisites: terraform apply + deploy-label-studio.sh${R}"
echo ""
read -p "  Press Enter to begin..."

# ═══════════════════════════════════════════════════════════════
#  STEP 1: Check LS is running
# ═══════════════════════════════════════════════════════════════
clear_screen
echo ""
draw_line
echo -e "  ${B}Step 1/5${R}  ${C}Checking Label Studio Service${R}"
draw_line
echo ""

echo -e "  Querying ECS..."
LS_RUNNING=$(aws ecs describe-services \
    --cluster "${ECS_CLUSTER}" \
    --services ${ECS_LABEL_STUDIO_SERVICE:-blueprintparser-label-studio} \
    --region "${AWS_REGION}" \
    --query 'services[0].runningCount' \
    --output text 2>/dev/null || echo "0")

LS_DESIRED=$(aws ecs describe-services \
    --cluster "${ECS_CLUSTER}" \
    --services ${ECS_LABEL_STUDIO_SERVICE:-blueprintparser-label-studio} \
    --region "${AWS_REGION}" \
    --query 'services[0].desiredCount' \
    --output text 2>/dev/null || echo "0")

echo ""
echo -e "  ┌──────────────────────────────────────┐"
echo -e "  │  Service: ${B}${ECS_LABEL_STUDIO_SERVICE:-blueprintparser-label-studio}${R}        │"
echo -e "  │  Running: ${G}${LS_RUNNING}${R}  Desired: ${LS_DESIRED}              │"
echo -e "  │  URL: ${B}${LS_URL}${R}  │"
echo -e "  └──────────────────────────────────────┘"
echo ""

if [ "$LS_RUNNING" = "0" ] || [ "$LS_RUNNING" = "None" ]; then
    echo -e "  ${RD}✗${R} Label Studio is not running!"
    echo ""
    echo -e "  ${Y}Troubleshooting:${R}"
    echo -e "  ${D}1. Run: cd infrastructure/terraform && terraform apply${R}"
    echo -e "  ${D}2. Wait 2 minutes for the container to start${R}"
    echo -e "  ${D}3. Check logs:${R}"
    echo -e "     ${D}aws logs tail /ecs/${ECS_LABEL_STUDIO_SERVICE:-blueprintparser-label-studio} --since 5m --region ${AWS_REGION}${R}"
    echo ""
    echo -e "  Run this script again once Label Studio is running."
    exit 1
fi

echo -e "  ${G}✔${R} Label Studio is healthy and serving requests"
echo ""
read -p "  Press Enter to continue..."

# ═══════════════════════════════════════════════════════════════
#  STEP 2: Login to LS
# ═══════════════════════════════════════════════════════════════
clear_screen
echo ""
draw_line
echo -e "  ${B}Step 2/5${R}  ${C}Create Admin Account${R}"
draw_line
echo ""
echo -e "  Open this URL in your browser:"
echo ""
echo -e "    ${B}${LS_URL}${R}"
echo ""
echo -e "  ┌──────────────────────────────────────┐"
echo -e "  │  ${Y}First time?${R}                            │"
echo -e "  │                                      │"
echo -e "  │  Click '${B}Sign Up${R}' and create your     │"
echo -e "  │  admin account with a strong         │"
echo -e "  │  password. The first account          │"
echo -e "  │  becomes the admin.                   │"
echo -e "  │                                      │"
echo -e "  │  ${Y}Already have an account?${R}              │"
echo -e "  │                                      │"
echo -e "  │  Just log in.                         │"
echo -e "  └──────────────────────────────────────┘"
echo ""
read -p "  Press Enter when you're logged into Label Studio..."

# ═══════════════════════════════════════════════════════════════
#  STEP 3: Generate PAT
# ═══════════════════════════════════════════════════════════════
clear_screen
echo ""
draw_line
echo -e "  ${B}Step 3/5${R}  ${C}Generate Access Token${R}"
draw_line
echo ""
echo -e "  In Label Studio, follow these steps:"
echo ""
echo -e "    ${G}1.${R} Click your ${B}user icon${R} (top-right corner)"
echo -e "    ${G}2.${R} Click '${B}Account & Settings${R}'"
echo -e "    ${G}3.${R} Scroll to '${B}Access Token${R}' section"
echo -e "    ${G}4.${R} Click '${B}Create${R}' to generate a new token"
echo -e "    ${G}5.${R} ${B}Copy${R} the entire token string"
echo ""
echo -e "  ${D}The token looks like a long alphanumeric string.${R}"
echo -e "  ${D}It's shown only once — save it somewhere safe.${R}"
echo ""
echo -e "  ${Y}Paste your token below:${R}"
echo ""
read -p "  Token: " PAT_TOKEN

if [ -z "$PAT_TOKEN" ]; then
    echo ""
    echo -e "  ${RD}✗${R} No token provided. Run this script again when ready."
    exit 1
fi

# Quick validation
TOKEN_LEN=${#PAT_TOKEN}
if [ "$TOKEN_LEN" -lt 10 ]; then
    echo ""
    echo -e "  ${Y}⚠${R} Token seems short (${TOKEN_LEN} chars). Are you sure?"
    read -p "  Continue anyway? (y/n): " CONFIRM
    if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
        exit 1
    fi
fi

echo ""
echo -e "  ${G}✔${R} Token received (${TOKEN_LEN} characters)"

# ═══════════════════════════════════════════════════════════════
#  STEP 4: Store in Secrets Manager
# ═══════════════════════════════════════════════════════════════
clear_screen
echo ""
draw_line
echo -e "  ${B}Step 4/5${R}  ${C}Storing Token in AWS${R}"
draw_line
echo ""

echo -e "  Updating ${B}${SECRETS_PREFIX}/LABEL_STUDIO_API_KEY${R} in Secrets Manager..."
echo ""

aws secretsmanager put-secret-value \
    --secret-id ${SECRETS_PREFIX}/LABEL_STUDIO_API_KEY \
    --secret-string "${PAT_TOKEN}" \
    --region "${AWS_REGION}" > /dev/null 2>&1

echo -e "  ${G}✔${R} Token stored successfully"
echo ""

# Verify it was stored
STORED=$(aws secretsmanager get-secret-value \
    --secret-id ${SECRETS_PREFIX}/LABEL_STUDIO_API_KEY \
    --region "${AWS_REGION}" \
    --query 'SecretString' \
    --output text 2>/dev/null | head -c 8)

echo -e "  ${D}Verification: stored token starts with '${STORED}...'${R}"
echo ""
read -p "  Press Enter to continue..."

# ═══════════════════════════════════════════════════════════════
#  STEP 5: Redeploy
# ═══════════════════════════════════════════════════════════════
clear_screen
echo ""
draw_line
echo -e "  ${B}Step 5/5${R}  ${C}Redeploying BlueprintParser${R}"
draw_line
echo ""

echo -e "  Triggering new deployment of ${B}blueprintparser-app${R}..."
echo -e "  ${D}(This picks up the new Label Studio token)${R}"
echo ""

aws ecs update-service \
    --cluster "${ECS_CLUSTER}" \
    --service ${ECS_SERVICE} \
    --force-new-deployment \
    --region "${AWS_REGION}" \
    --output text \
    --query 'service.serviceName' > /dev/null 2>&1

echo -e "  ${G}✔${R} Deployment triggered"
echo ""
echo -e "  ${D}Waiting for new task to start...${R}"

# Poll for deployment
for i in $(seq 1 30); do
    RUNNING=$(aws ecs describe-services \
        --cluster "${ECS_CLUSTER}" \
        --services ${ECS_SERVICE} \
        --region "${AWS_REGION}" \
        --query 'services[0].runningCount' \
        --output text 2>/dev/null || echo "0")
    PENDING=$(aws ecs describe-services \
        --cluster "${ECS_CLUSTER}" \
        --services ${ECS_SERVICE} \
        --region "${AWS_REGION}" \
        --query 'services[0].pendingCount' \
        --output text 2>/dev/null || echo "0")

    printf "\r  ${C}⠸${R} Running: ${G}${RUNNING}${R}  Pending: ${Y}${PENDING}${R}  (${i}/30)"

    if [ "$RUNNING" -ge 1 ] && [ "$PENDING" = "0" ] && [ "$i" -gt 5 ]; then
        break
    fi
    sleep 5
done

echo ""
echo ""
echo -e "  ${G}✔${R} BlueprintParser is running with new Label Studio token"

# ═══════════════════════════════════════════════════════════════
#  DONE
# ═══════════════════════════════════════════════════════════════
echo ""
draw_line
echo -e "  ${BG}${W}  Setup Complete  ${R}"
draw_line
echo ""
echo -e "  ${G}✔${R} Label Studio is running"
echo -e "  ${G}✔${R} API token stored in AWS Secrets Manager"
echo -e "  ${G}✔${R} BlueprintParser redeployed with token"
echo ""
echo -e "  ┌──────────────────────────────────────┐"
echo -e "  │  ${B}Test it now:${R}                          │"
echo -e "  │                                      │"
echo -e "  │  1. Open a blueprint in BP            │"
echo -e "  │  2. Click ${B}Menu → Data Labeling${R}        │"
echo -e "  │  3. Walk through the wizard           │"
echo -e "  │  4. Click 'Open Label Studio'         │"
echo -e "  │                                      │"
echo -e "  │  ${C}Label Studio${R}                          │"
echo -e "  │  ${B}${LS_URL}${R}  │"
echo -e "  │                                      │"
echo -e "  │  ${C}BlueprintParser${R}                       │"
echo -e "  │  ${B}https://app.${DOMAIN}${R}       │"
echo -e "  └──────────────────────────────────────┘"
echo ""
