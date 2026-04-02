#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# BlueprintParser 2 — Interactive Setup Wizard
#
# Walks you through configuring BlueprintParser from zero to running.
# Re-run anytime to update your configuration.
#
# Target: construction estimators/PMs who are tech-savvy but not developers.
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.local"
DEPLOY_ENV_FILE="${SCRIPT_DIR}/.deploy.env"

# ─── Colors (matches root_admin.sh / setup-label-studio.sh) ─────────────────
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'
BG='\033[44m'
W='\033[1;37m'

# ─── Collected config (populated by phases) ──────────────────────────────────
CFG_DATABASE_URL=""
CFG_NEXTAUTH_SECRET=""
CFG_NEXTAUTH_URL="http://localhost:3000"
CFG_PROCESSING_WEBHOOK_SECRET=""
CFG_LLM_KEY_SECRET=""
CFG_DEV_PROCESSING_ENABLED=""
CFG_GROQ_API_KEY=""
CFG_ANTHROPIC_API_KEY=""
CFG_OPENAI_API_KEY=""
CFG_LLM_PROVIDER=""
CFG_LLM_MODEL=""
CFG_LLM_BASE_URL=""
CFG_AWS_REGION=""
CFG_AWS_ACCESS_KEY_ID=""
CFG_AWS_SECRET_ACCESS_KEY=""
CFG_S3_BUCKET=""
CFG_NEXT_PUBLIC_S3_BUCKET=""
CFG_CLOUDFRONT_DOMAIN=""
CFG_STEP_FUNCTION_ARN=""
CFG_YOLO_ECR_IMAGE=""
CFG_SAGEMAKER_ROLE_ARN=""
CFG_SES_FROM_EMAIL=""
CFG_ROOT_ADMIN_EMAIL=""
CFG_GOOGLE_CLIENT_ID=""
CFG_GOOGLE_CLIENT_SECRET=""
CFG_LABEL_STUDIO_URL=""
CFG_LABEL_STUDIO_API_KEY=""
CFG_LABEL_STUDIO_ADMIN_EMAIL=""
CFG_LABEL_STUDIO_ADMIN_PASSWORD=""

# ─── UI Primitives ──────────────────────────────────────────────────────────

clear_screen() { printf '\033[2J\033[H'; }

draw_line() {
  echo -e "${CYAN}$(printf '━%.0s' $(seq 1 62))${NC}"
}

header() {
  local step="$1" title="$2"
  echo ""
  draw_line
  echo -e "  ${BG}${W}  Step ${step}  ${NC}  ${BOLD}${title}${NC}"
  draw_line
  echo ""
}

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
info() { echo -e "  ${DIM}$1${NC}"; }

prompt_default() {
  local prompt="$1" default="$2" var_name="$3"
  if [ -n "$default" ]; then
    read -rp "  ${prompt} [${default}]: " input
    eval "${var_name}=\"\${input:-${default}}\""
  else
    read -rp "  ${prompt}: " input
    eval "${var_name}=\"\${input}\""
  fi
}

prompt_yes_no() {
  local prompt="$1" default="${2:-y}"
  local hint
  if [ "$default" = "y" ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  read -rp "  ${prompt} ${hint}: " answer
  answer="${answer:-$default}"
  [[ "$answer" =~ ^[Yy] ]]
}

prompt_secret() {
  local prompt="$1" var_name="$2"
  read -rp "  ${prompt}: " input
  eval "${var_name}=\"\${input}\""
}

mask_key() {
  local key="$1"
  if [ ${#key} -le 8 ]; then
    echo "****"
  else
    echo "${key:0:4}...${key: -4}"
  fi
}

spinner() {
  local pid=$1 chars='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${CYAN}${chars:$i:1}${NC} %s" "$2"
    i=$(( (i + 1) % ${#chars} ))
    sleep 0.1
  done
  printf "\r  %-60s\r" " "
}

# ─── Existing config loader ─────────────────────────────────────────────────

load_existing_env() {
  if [ ! -f "$ENV_FILE" ]; then return 1; fi
  while IFS='=' read -r key value; do
    # Skip comments and blank lines
    [[ "$key" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$key" ]] && continue
    key=$(echo "$key" | xargs)
    value=$(echo "$value" | sed 's/^["'"'"']//;s/["'"'"']$//')
    case "$key" in
      DATABASE_URL)               CFG_DATABASE_URL="$value" ;;
      NEXTAUTH_SECRET)            CFG_NEXTAUTH_SECRET="$value" ;;
      NEXTAUTH_URL)               CFG_NEXTAUTH_URL="$value" ;;
      PROCESSING_WEBHOOK_SECRET)  CFG_PROCESSING_WEBHOOK_SECRET="$value" ;;
      LLM_KEY_SECRET)             CFG_LLM_KEY_SECRET="$value" ;;
      DEV_PROCESSING_ENABLED)     CFG_DEV_PROCESSING_ENABLED="$value" ;;
      GROQ_API_KEY)               CFG_GROQ_API_KEY="$value" ;;
      ANTHROPIC_API_KEY)          CFG_ANTHROPIC_API_KEY="$value" ;;
      OPENAI_API_KEY)             CFG_OPENAI_API_KEY="$value" ;;
      LLM_PROVIDER)               CFG_LLM_PROVIDER="$value" ;;
      LLM_MODEL)                  CFG_LLM_MODEL="$value" ;;
      LLM_BASE_URL)               CFG_LLM_BASE_URL="$value" ;;
      AWS_REGION)                 CFG_AWS_REGION="$value" ;;
      AWS_ACCESS_KEY_ID)          CFG_AWS_ACCESS_KEY_ID="$value" ;;
      AWS_SECRET_ACCESS_KEY)      CFG_AWS_SECRET_ACCESS_KEY="$value" ;;
      S3_BUCKET)                  CFG_S3_BUCKET="$value" ;;
      NEXT_PUBLIC_S3_BUCKET)      CFG_NEXT_PUBLIC_S3_BUCKET="$value" ;;
      CLOUDFRONT_DOMAIN)          CFG_CLOUDFRONT_DOMAIN="$value" ;;
      STEP_FUNCTION_ARN)          CFG_STEP_FUNCTION_ARN="$value" ;;
      YOLO_ECR_IMAGE)             CFG_YOLO_ECR_IMAGE="$value" ;;
      SAGEMAKER_ROLE_ARN)         CFG_SAGEMAKER_ROLE_ARN="$value" ;;
      SES_FROM_EMAIL)             CFG_SES_FROM_EMAIL="$value" ;;
      ROOT_ADMIN_EMAIL)           CFG_ROOT_ADMIN_EMAIL="$value" ;;
      GOOGLE_CLIENT_ID)           CFG_GOOGLE_CLIENT_ID="$value" ;;
      GOOGLE_CLIENT_SECRET)       CFG_GOOGLE_CLIENT_SECRET="$value" ;;
      LABEL_STUDIO_URL)           CFG_LABEL_STUDIO_URL="$value" ;;
      LABEL_STUDIO_API_KEY)       CFG_LABEL_STUDIO_API_KEY="$value" ;;
      LABEL_STUDIO_ADMIN_EMAIL)   CFG_LABEL_STUDIO_ADMIN_EMAIL="$value" ;;
      LABEL_STUDIO_ADMIN_PASSWORD) CFG_LABEL_STUDIO_ADMIN_PASSWORD="$value" ;;
    esac
  done < "$ENV_FILE"
  return 0
}

# ─── Cleanup handler ────────────────────────────────────────────────────────

cleanup() {
  local exit_code=$?
  if [ $exit_code -ne 0 ] && [ $exit_code -ne 130 ]; then
    echo ""
    echo -e "  ${YELLOW}Setup interrupted.${NC}"
  fi
  if [ $exit_code -eq 130 ]; then
    echo ""
    echo -e "  ${DIM}Cancelled. Re-run ./install_setup.sh to continue.${NC}"
  fi
}
trap cleanup EXIT

# ═══════════════════════════════════════════════════════════════════════════════
#  PHASE 0 — WELCOME
# ═══════════════════════════════════════════════════════════════════════════════

phase_welcome() {
  clear_screen
  echo ""
  draw_line
  echo -e "  ${BG}${W}  BlueprintParser 2  ${NC}  ${BOLD}Setup Wizard${NC}"
  draw_line
  echo ""
  echo -e "  ${BOLD}Let's set up your blueprint analysis server!${NC}"
  echo ""
  echo -e "  This wizard will walk you through:"
  echo -e "  ${GREEN}1${NC} Check prerequisites (Node.js, Docker, etc.)"
  echo -e "  ${GREEN}2${NC} Set up the database"
  echo -e "  ${GREEN}3${NC} Generate security keys"
  echo -e "  ${GREEN}4${NC} Configure your AI provider"
  echo -e "  ${GREEN}5${NC} Set up cloud storage (optional)"
  echo -e "  ${GREEN}6${NC} Create your admin account"
  echo -e "  ${GREEN}7${NC} Install and start everything"
  echo -e "  ${GREEN}8${NC} Run health checks"
  echo ""
  echo -e "  ${DIM}Takes about 5-10 minutes. You can re-run anytime to update.${NC}"
  echo ""

  # Check for existing config
  if [ -f "$ENV_FILE" ]; then
    load_existing_env
    echo -e "  ${YELLOW}Found existing configuration (.env.local)${NC}"
    echo ""
    echo -e "  ${GREEN}1${NC}  Update configuration (keeps existing values as defaults)"
    echo -e "  ${GREEN}2${NC}  Start fresh"
    echo -e "  ${GREEN}3${NC}  View current config"
    echo -e "  ${GREEN}4${NC}  Run health checks only"
    echo -e "  ${GREEN}5${NC}  Quit"
    echo ""
    read -rp "  Choose [1-5]: " choice
    case "$choice" in
      1) echo ""; info "Updating -- existing values shown as defaults."; echo "" ;;
      2)
        cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%s)"
        ok "Backed up to .env.local.bak.*"
        # Clear all loaded values
        CFG_DATABASE_URL="" ; CFG_NEXTAUTH_SECRET="" ; CFG_PROCESSING_WEBHOOK_SECRET=""
        CFG_LLM_KEY_SECRET="" ; CFG_GROQ_API_KEY="" ; CFG_ANTHROPIC_API_KEY=""
        CFG_OPENAI_API_KEY="" ; CFG_LLM_PROVIDER="" ; CFG_LLM_MODEL="" ; CFG_LLM_BASE_URL=""
        CFG_AWS_REGION="" ; CFG_AWS_ACCESS_KEY_ID="" ; CFG_AWS_SECRET_ACCESS_KEY=""
        CFG_S3_BUCKET="" ; CFG_NEXT_PUBLIC_S3_BUCKET="" ; CFG_CLOUDFRONT_DOMAIN=""
        CFG_ROOT_ADMIN_EMAIL="" ; CFG_GOOGLE_CLIENT_ID="" ; CFG_GOOGLE_CLIENT_SECRET=""
        ;;
      3)
        echo ""
        echo -e "  ${BOLD}Current Configuration:${NC}"
        echo ""
        [ -n "$CFG_DATABASE_URL" ]      && ok "DATABASE_URL: $(mask_key "$CFG_DATABASE_URL")"
        [ -n "$CFG_NEXTAUTH_SECRET" ]   && ok "NEXTAUTH_SECRET: $(mask_key "$CFG_NEXTAUTH_SECRET")"
        [ -n "$CFG_NEXTAUTH_URL" ]      && ok "NEXTAUTH_URL: $CFG_NEXTAUTH_URL"
        [ -n "$CFG_GROQ_API_KEY" ]      && ok "GROQ_API_KEY: $(mask_key "$CFG_GROQ_API_KEY")"
        [ -n "$CFG_ANTHROPIC_API_KEY" ] && ok "ANTHROPIC_API_KEY: $(mask_key "$CFG_ANTHROPIC_API_KEY")"
        [ -n "$CFG_OPENAI_API_KEY" ]    && ok "OPENAI_API_KEY: $(mask_key "$CFG_OPENAI_API_KEY")"
        [ -n "$CFG_AWS_ACCESS_KEY_ID" ] && ok "AWS_ACCESS_KEY_ID: $(mask_key "$CFG_AWS_ACCESS_KEY_ID")"
        [ -n "$CFG_S3_BUCKET" ]         && ok "S3_BUCKET: $CFG_S3_BUCKET"
        [ -n "$CFG_ROOT_ADMIN_EMAIL" ]  && ok "ROOT_ADMIN_EMAIL: $CFG_ROOT_ADMIN_EMAIL"
        [ -n "$CFG_LLM_PROVIDER" ]      && ok "LLM_PROVIDER: $CFG_LLM_PROVIDER"
        [ -n "$CFG_LLM_MODEL" ]         && ok "LLM_MODEL: $CFG_LLM_MODEL"
        echo ""
        read -p "  Press Enter to continue with setup, or Ctrl+C to quit..."
        ;;
      4)
        phase_health_checks
        exit 0
        ;;
      5) echo -e "  ${DIM}Bye!${NC}"; exit 0 ;;
      *) echo ""; info "Updating -- existing values shown as defaults." ;;
    esac
  else
    read -p "  Press Enter to begin..."
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
#  PHASE 1 — PREREQUISITES
# ═══════════════════════════════════════════════════════════════════════════════

phase_prerequisites() {
  header "1/8" "Checking Prerequisites"

  local failed=0

  # git
  if command -v git &>/dev/null; then
    ok "git $(git --version 2>/dev/null | sed 's/git version //')"
  else
    fail "git not found"
    info "Install: https://git-scm.com/downloads"
    failed=1
  fi

  # Node.js
  if command -v node &>/dev/null; then
    local node_version
    node_version=$(node --version 2>/dev/null)
    local node_major
    node_major=$(echo "$node_version" | sed 's/v//' | cut -d. -f1)
    if [ "$node_major" -ge 20 ] 2>/dev/null; then
      ok "Node.js ${node_version}"
    else
      fail "Node.js ${node_version} (need v20 or later)"
      info "Install: https://nodejs.org/en/download"
      failed=1
    fi
  else
    fail "Node.js not found"
    info "Install v20+: https://nodejs.org/en/download"
    failed=1
  fi

  # npm
  if command -v npm &>/dev/null; then
    ok "npm $(npm --version 2>/dev/null)"
  else
    fail "npm not found (usually comes with Node.js)"
    failed=1
  fi

  # Docker
  if command -v docker &>/dev/null; then
    if docker info &>/dev/null; then
      ok "Docker $(docker --version 2>/dev/null | sed 's/Docker version //' | cut -d, -f1) (daemon running)"
    else
      fail "Docker installed but daemon not running"
      info "Start Docker Desktop, then re-run this script."
      failed=1
    fi
  else
    fail "Docker not found"
    info "Install: https://docs.docker.com/get-docker/"
    failed=1
  fi

  # Docker Compose
  if docker compose version &>/dev/null; then
    ok "Docker Compose $(docker compose version 2>/dev/null | sed 's/Docker Compose version //')"
  elif command -v docker-compose &>/dev/null; then
    ok "docker-compose $(docker-compose --version 2>/dev/null | sed 's/.*version //' | cut -d, -f1)"
  else
    fail "Docker Compose not found (included with Docker Desktop)"
    failed=1
  fi

  # openssl
  if command -v openssl &>/dev/null; then
    ok "openssl $(openssl version 2>/dev/null | cut -d' ' -f2)"
  else
    fail "openssl not found (needed to generate security keys)"
    failed=1
  fi

  # AWS CLI (optional)
  echo ""
  if command -v aws &>/dev/null; then
    ok "AWS CLI $(aws --version 2>/dev/null | cut -d' ' -f1 | sed 's|aws-cli/||')"
  else
    warn "AWS CLI not found (optional -- needed for cloud storage and advanced features)"
    info "Install later: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  fi

  # Python 3 (optional)
  if command -v python3 &>/dev/null; then
    ok "Python $(python3 --version 2>/dev/null | sed 's/Python //')"
  else
    warn "Python 3 not found (optional -- used for local OCR fallback)"
  fi

  if [ $failed -ne 0 ]; then
    echo ""
    fail "Some required tools are missing. Install them and re-run this script."
    exit 1
  fi

  echo ""
  ok "All required prerequisites found!"
  echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
#  PHASE 2 — DATABASE
# ═══════════════════════════════════════════════════════════════════════════════

phase_database() {
  header "2/8" "Database Setup"

  echo -e "  BlueprintParser uses ${BOLD}PostgreSQL 16${NC} to store your projects,"
  echo -e "  user accounts, and analysis results."
  echo ""
  echo -e "  We'll run it in a Docker container -- ${BOLD}no database install needed.${NC}"
  echo ""
  echo -e "  ${DIM}Default: postgresql://beaver:beaver@localhost:5433/beaverdb${NC}"
  echo -e "  ${DIM}(Port 5433 is used to avoid conflicts with local PostgreSQL on 5432)${NC}"
  echo ""

  if [ -n "$CFG_DATABASE_URL" ]; then
    info "Current: $(mask_key "$CFG_DATABASE_URL")"
    echo ""
  fi

  if prompt_yes_no "Use the default Docker database?" "y"; then
    CFG_DATABASE_URL="postgresql://beaver:beaver@localhost:5433/beaverdb"

    # Check port availability
    if command -v lsof &>/dev/null && lsof -i :5433 &>/dev/null; then
      # Check if it's our postgres container
      if docker compose -f "${SCRIPT_DIR}/docker-compose.yml" ps db 2>/dev/null | grep -q "running"; then
        ok "Database container already running on port 5433"
      else
        warn "Port 5433 is already in use by another process."
        info "Stop the other process, or choose a custom DATABASE_URL below."
        if ! prompt_yes_no "Continue anyway?" "y"; then
          prompt_secret "Enter a custom DATABASE_URL" "CFG_DATABASE_URL"
        fi
      fi
    fi
  else
    echo ""
    echo -e "  ${DIM}Format: postgresql://user:password@host:port/database${NC}"
    prompt_secret "Enter your DATABASE_URL" "CFG_DATABASE_URL"
  fi

  echo ""
  ok "Database: $(mask_key "$CFG_DATABASE_URL")"
  echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
#  PHASE 3 — SECRETS
# ═══════════════════════════════════════════════════════════════════════════════

phase_secrets() {
  header "3/8" "Security Keys"

  echo -e "  BlueprintParser needs several secret keys for security."
  echo -e "  We'll ${BOLD}generate them automatically${NC} -- no action needed from you."
  echo ""
  echo -e "  ${DIM}NEXTAUTH_SECRET${NC}            Encrypts login sessions"
  echo -e "  ${DIM}PROCESSING_WEBHOOK_SECRET${NC}  Authenticates the processing pipeline"
  echo -e "  ${DIM}LLM_KEY_SECRET${NC}             Encrypts AI provider keys in the database"
  echo ""

  if [ -n "$CFG_NEXTAUTH_SECRET" ] && [ -n "$CFG_LLM_KEY_SECRET" ]; then
    warn "Security keys already exist in your config."
    echo ""
    echo -e "  ${YELLOW}Regenerating LLM_KEY_SECRET will invalidate any AI provider${NC}"
    echo -e "  ${YELLOW}API keys saved through the admin dashboard.${NC}"
    echo ""
    if prompt_yes_no "Keep existing keys?" "y"; then
      ok "Keeping existing security keys"
      echo ""
      return
    fi
  fi

  if prompt_yes_no "Auto-generate security keys?" "y"; then
    CFG_NEXTAUTH_SECRET=$(openssl rand -base64 32)
    CFG_PROCESSING_WEBHOOK_SECRET=$(openssl rand -base64 32)
    CFG_LLM_KEY_SECRET=$(openssl rand -hex 16)
    ok "Generated NEXTAUTH_SECRET"
    ok "Generated PROCESSING_WEBHOOK_SECRET"
    ok "Generated LLM_KEY_SECRET (32 hex characters)"
  else
    echo ""
    info "Enter custom values (for migrating from an existing deployment):"
    prompt_secret "NEXTAUTH_SECRET" "CFG_NEXTAUTH_SECRET"
    prompt_secret "PROCESSING_WEBHOOK_SECRET" "CFG_PROCESSING_WEBHOOK_SECRET"
    prompt_secret "LLM_KEY_SECRET (32 characters)" "CFG_LLM_KEY_SECRET"
  fi

  echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
#  PHASE 4 — AI PROVIDER
# ═══════════════════════════════════════════════════════════════════════════════

test_groq_key() {
  local key="$1"
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    -H "Authorization: Bearer $key" \
    -H "Content-Type: application/json" \
    -d '{"model":"llama-3.3-70b-versatile","messages":[{"role":"user","content":"hi"}],"max_tokens":1}' \
    "https://api.groq.com/openai/v1/chat/completions" 2>/dev/null) || true
  [ "$http_code" = "200" ]
}

test_anthropic_key() {
  local key="$1"
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    -H "x-api-key: $key" \
    -H "anthropic-version: 2023-06-01" \
    -H "Content-Type: application/json" \
    -d '{"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' \
    "https://api.anthropic.com/v1/messages" 2>/dev/null) || true
  [ "$http_code" = "200" ]
}

test_openai_key() {
  local key="$1"
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    -H "Authorization: Bearer $key" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"max_tokens":1}' \
    "https://api.openai.com/v1/chat/completions" 2>/dev/null) || true
  [ "$http_code" = "200" ]
}

configure_provider() {
  local provider="$1"

  case "$provider" in
    groq)
      echo ""
      echo -e "  ${BOLD}Groq Setup${NC}"
      echo -e "  ${DIM}Groq offers free API access to Llama 3.3 70B.${NC}"
      echo -e "  ${DIM}No credit card required to get started.${NC}"
      echo ""
      echo -e "  Get your API key:"
      echo -e "  ${CYAN}https://console.groq.com/keys${NC}"
      echo ""
      echo -e "  ${DIM}1. Sign up or log in at the link above${NC}"
      echo -e "  ${DIM}2. Click 'Create API Key'${NC}"
      echo -e "  ${DIM}3. Copy the key (starts with gsk_)${NC}"
      echo ""

      if [ -n "$CFG_GROQ_API_KEY" ]; then
        info "Current: $(mask_key "$CFG_GROQ_API_KEY")"
        if prompt_yes_no "Keep existing key?" "y"; then return; fi
      fi

      while true; do
        prompt_secret "Paste your Groq API key" "CFG_GROQ_API_KEY"
        if [ -z "$CFG_GROQ_API_KEY" ]; then
          warn "Skipped Groq."
          return
        fi
        if [[ ! "$CFG_GROQ_API_KEY" =~ ^gsk_ ]]; then
          warn "Key doesn't start with 'gsk_' -- are you sure this is a Groq key?"
        fi
        echo -ne "  Testing key... "
        if test_groq_key "$CFG_GROQ_API_KEY"; then
          echo ""
          ok "Groq API key is valid!"
          return
        else
          echo ""
          fail "Could not verify key. The API returned an error."
          echo -e "  ${GREEN}1${NC} Try again  ${GREEN}2${NC} Keep anyway  ${GREEN}3${NC} Skip Groq"
          read -rp "  Choose [1-3]: " retry
          case "$retry" in
            2) return ;;
            3) CFG_GROQ_API_KEY=""; return ;;
            *) ;;
          esac
        fi
      done
      ;;

    anthropic)
      echo ""
      echo -e "  ${BOLD}Anthropic (Claude) Setup${NC}"
      echo -e "  ${DIM}Claude provides the highest quality analysis for construction blueprints.${NC}"
      echo -e "  ${DIM}Requires an API key with billing enabled.${NC}"
      echo ""
      echo -e "  Get your API key:"
      echo -e "  ${CYAN}https://console.anthropic.com/settings/keys${NC}"
      echo ""
      echo -e "  ${DIM}1. Sign up at console.anthropic.com${NC}"
      echo -e "  ${DIM}2. Add a payment method in Settings > Billing${NC}"
      echo -e "  ${DIM}3. Go to Settings > API Keys and create one${NC}"
      echo -e "  ${DIM}4. Copy the key (starts with sk-ant-)${NC}"
      echo ""

      if [ -n "$CFG_ANTHROPIC_API_KEY" ]; then
        info "Current: $(mask_key "$CFG_ANTHROPIC_API_KEY")"
        if prompt_yes_no "Keep existing key?" "y"; then return; fi
      fi

      while true; do
        prompt_secret "Paste your Anthropic API key" "CFG_ANTHROPIC_API_KEY"
        if [ -z "$CFG_ANTHROPIC_API_KEY" ]; then
          warn "Skipped Anthropic."
          return
        fi
        if [[ ! "$CFG_ANTHROPIC_API_KEY" =~ ^sk-ant- ]]; then
          warn "Key doesn't start with 'sk-ant-' -- are you sure this is an Anthropic key?"
        fi
        echo -ne "  Testing key... "
        if test_anthropic_key "$CFG_ANTHROPIC_API_KEY"; then
          echo ""
          ok "Anthropic API key is valid!"
          return
        else
          echo ""
          fail "Could not verify key."
          echo -e "  ${GREEN}1${NC} Try again  ${GREEN}2${NC} Keep anyway  ${GREEN}3${NC} Skip"
          read -rp "  Choose [1-3]: " retry
          case "$retry" in
            2) return ;;
            3) CFG_ANTHROPIC_API_KEY=""; return ;;
            *) ;;
          esac
        fi
      done
      ;;

    openai)
      echo ""
      echo -e "  ${BOLD}OpenAI (GPT) Setup${NC}"
      echo -e "  ${DIM}GPT-4o provides good quality analysis.${NC}"
      echo -e "  ${DIM}Requires an API key with billing enabled.${NC}"
      echo ""
      echo -e "  Get your API key:"
      echo -e "  ${CYAN}https://platform.openai.com/api-keys${NC}"
      echo ""
      echo -e "  ${DIM}1. Sign up at platform.openai.com${NC}"
      echo -e "  ${DIM}2. Add a payment method in Settings > Billing${NC}"
      echo -e "  ${DIM}3. Go to API Keys and create one${NC}"
      echo -e "  ${DIM}4. Copy the key (starts with sk-)${NC}"
      echo ""

      if [ -n "$CFG_OPENAI_API_KEY" ]; then
        info "Current: $(mask_key "$CFG_OPENAI_API_KEY")"
        if prompt_yes_no "Keep existing key?" "y"; then return; fi
      fi

      while true; do
        prompt_secret "Paste your OpenAI API key" "CFG_OPENAI_API_KEY"
        if [ -z "$CFG_OPENAI_API_KEY" ]; then
          warn "Skipped OpenAI."
          return
        fi
        echo -ne "  Testing key... "
        if test_openai_key "$CFG_OPENAI_API_KEY"; then
          echo ""
          ok "OpenAI API key is valid!"
          return
        else
          echo ""
          fail "Could not verify key."
          echo -e "  ${GREEN}1${NC} Try again  ${GREEN}2${NC} Keep anyway  ${GREEN}3${NC} Skip"
          read -rp "  Choose [1-3]: " retry
          case "$retry" in
            2) return ;;
            3) CFG_OPENAI_API_KEY=""; return ;;
            *) ;;
          esac
        fi
      done
      ;;

    ollama)
      echo ""
      echo -e "  ${BOLD}Local AI (Ollama) Setup${NC}"
      echo -e "  ${DIM}Run AI models on your own machine. Free and private.${NC}"
      echo -e "  ${DIM}Requires Ollama installed: https://ollama.com${NC}"
      echo ""

      CFG_LLM_PROVIDER="custom"
      local default_url="http://localhost:11434/v1"
      local default_model="llama3.1"

      # Check if Ollama is running
      if curl -s --max-time 3 "http://localhost:11434/api/tags" &>/dev/null; then
        ok "Ollama is running!"
        echo ""
        echo -e "  ${DIM}Available models:${NC}"
        local models
        models=$(curl -s --max-time 5 "http://localhost:11434/api/tags" 2>/dev/null | \
          python3 -c "import sys,json; [print('    ' + m['name']) for m in json.loads(sys.stdin.read()).get('models',[])]" 2>/dev/null) || true
        if [ -n "$models" ]; then
          echo "$models"
          echo ""
          default_model=$(curl -s --max-time 5 "http://localhost:11434/api/tags" 2>/dev/null | \
            python3 -c "import sys,json; m=json.loads(sys.stdin.read()).get('models',[]); print(m[0]['name'] if m else 'llama3.1')" 2>/dev/null) || true
        fi
      else
        warn "Ollama doesn't appear to be running on localhost:11434"
        info "Install from https://ollama.com, then run: ollama pull llama3.1"
        echo ""
      fi

      read -rp "  Base URL [${default_url}]: " input_url
      CFG_LLM_BASE_URL="${input_url:-$default_url}"
      read -rp "  Model name [${default_model}]: " input_model
      CFG_LLM_MODEL="${input_model:-$default_model}"
      echo ""
      ok "Configured Ollama: ${CFG_LLM_MODEL} at ${CFG_LLM_BASE_URL}"
      ;;
  esac
}

phase_ai_provider() {
  header "4/8" "AI Provider"

  echo -e "  BlueprintParser uses AI to analyze blueprints, detect building"
  echo -e "  components (CSI codes), and answer questions about your drawings."
  echo ""
  echo -e "  You need ${BOLD}at least one AI provider${NC}. Here are your options:"
  echo ""
  echo -e "  ${GREEN}1${NC}  ${BOLD}Groq${NC} (Recommended for getting started)"
  echo -e "     ${DIM}Free tier available. Uses Llama 3.3 70B. No credit card needed.${NC}"
  echo ""
  echo -e "  ${GREEN}2${NC}  ${BOLD}Anthropic (Claude)${NC}"
  echo -e "     ${DIM}Best quality for construction analysis. Requires billing.${NC}"
  echo ""
  echo -e "  ${GREEN}3${NC}  ${BOLD}OpenAI (GPT)${NC}"
  echo -e "     ${DIM}Good quality. Requires billing.${NC}"
  echo ""
  echo -e "  ${GREEN}4${NC}  ${BOLD}Local (Ollama)${NC}"
  echo -e "     ${DIM}Run on your machine. Free, private, works offline.${NC}"
  echo ""
  echo -e "  ${GREEN}5${NC}  ${BOLD}Multiple providers${NC}"
  echo -e "     ${DIM}Configure more than one (recommended for production).${NC}"
  echo ""
  echo -e "  ${GREEN}6${NC}  ${BOLD}Skip for now${NC}"
  echo -e "     ${DIM}AI chat and analysis features will be disabled.${NC}"
  echo ""

  # Show existing config
  local has_provider=0
  if [ -n "$CFG_GROQ_API_KEY" ]; then
    ok "Groq: configured ($(mask_key "$CFG_GROQ_API_KEY"))"
    has_provider=1
  fi
  if [ -n "$CFG_ANTHROPIC_API_KEY" ]; then
    ok "Anthropic: configured ($(mask_key "$CFG_ANTHROPIC_API_KEY"))"
    has_provider=1
  fi
  if [ -n "$CFG_OPENAI_API_KEY" ]; then
    ok "OpenAI: configured ($(mask_key "$CFG_OPENAI_API_KEY"))"
    has_provider=1
  fi
  if [ -n "$CFG_LLM_BASE_URL" ]; then
    ok "Custom/Ollama: configured (${CFG_LLM_BASE_URL})"
    has_provider=1
  fi
  if [ $has_provider -eq 1 ]; then
    echo ""
    if prompt_yes_no "Keep existing AI config?" "y"; then return; fi
    echo ""
  fi

  read -rp "  Choose [1-6]: " choice
  case "$choice" in
    1) configure_provider "groq" ;;
    2) configure_provider "anthropic" ;;
    3) configure_provider "openai" ;;
    4) configure_provider "ollama" ;;
    5)
      echo ""
      info "Configure each provider you want to use:"
      for p in groq anthropic openai ollama; do
        echo ""
        if prompt_yes_no "Configure ${p}?" "n"; then
          configure_provider "$p"
        fi
      done
      ;;
    6)
      warn "Skipping AI provider. Chat and analysis features will be disabled."
      warn "Re-run this script later to add one."
      ;;
    *)
      warn "Invalid choice, skipping AI provider."
      ;;
  esac

  echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
#  PHASE 5 — AWS (Optional)
# ═══════════════════════════════════════════════════════════════════════════════

phase_aws() {
  header "5/8" "Cloud Storage (AWS)"

  echo -e "  ${BOLD}AWS Cloud Services${NC} (optional)"
  echo ""
  echo -e "  AWS provides:"
  echo -e "  - ${BOLD}S3${NC}: Cloud storage for PDFs and processed images"
  echo -e "  - ${BOLD}Textract${NC}: Advanced text extraction from blueprints (better than local OCR)"
  echo -e "  - ${BOLD}SageMaker${NC}: GPU-powered object detection (finds symbols on drawings)"
  echo ""
  echo -e "  ${DIM}Without AWS, BlueprintParser works locally with basic features.${NC}"
  echo -e "  ${DIM}You can always add AWS later by re-running this script.${NC}"
  echo ""

  if [ -n "$CFG_AWS_ACCESS_KEY_ID" ] && [ -n "$CFG_S3_BUCKET" ]; then
    ok "AWS: configured ($(mask_key "$CFG_AWS_ACCESS_KEY_ID"), bucket: $CFG_S3_BUCKET)"
    echo ""
    if prompt_yes_no "Keep existing AWS config?" "y"; then return; fi
  fi

  if ! prompt_yes_no "Configure AWS services?" "n"; then
    CFG_DEV_PROCESSING_ENABLED="true"
    ok "Local-only mode enabled. Processing uses local tools."
    echo ""
    return
  fi

  # ─── 5a. AWS Credentials ───
  echo ""
  echo -e "  ${BOLD}AWS Credentials${NC}"
  echo ""

  # Check if AWS CLI is configured
  local aws_configured=0
  if command -v aws &>/dev/null; then
    local caller_identity
    caller_identity=$(aws sts get-caller-identity 2>/dev/null) || true
    if [ -n "$caller_identity" ]; then
      local account_id
      account_id=$(echo "$caller_identity" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['Account'])" 2>/dev/null) || true
      if [ -n "$account_id" ]; then
        ok "AWS CLI configured (Account: ${account_id})"
        aws_configured=1
      fi
    fi
  fi

  if [ $aws_configured -eq 0 ]; then
    echo -e "  ${DIM}To get AWS credentials:${NC}"
    echo -e "  ${DIM}1. Log into AWS Console: https://console.aws.amazon.com${NC}"
    echo -e "  ${DIM}2. Click your name (top-right) > 'Security credentials'${NC}"
    echo -e "  ${DIM}3. Under 'Access keys', click 'Create access key'${NC}"
    echo -e "  ${DIM}4. Copy the Access Key ID and Secret Access Key${NC}"
    echo ""
    prompt_secret "AWS Access Key ID" "CFG_AWS_ACCESS_KEY_ID"
    if [ -z "$CFG_AWS_ACCESS_KEY_ID" ]; then
      warn "Skipping AWS setup."
      CFG_DEV_PROCESSING_ENABLED="true"
      return
    fi
    prompt_secret "AWS Secret Access Key" "CFG_AWS_SECRET_ACCESS_KEY"
  fi

  # ─── 5b. Region ───
  echo ""
  local default_region="${CFG_AWS_REGION:-us-east-1}"
  read -rp "  AWS Region [${default_region}]: " input_region
  CFG_AWS_REGION="${input_region:-$default_region}"

  # ─── 5c. S3 Bucket ───
  echo ""
  echo -e "  ${BOLD}S3 Bucket${NC} (cloud storage for PDFs and images)"
  echo ""
  echo -e "  ${GREEN}1${NC}  Create a new S3 bucket automatically"
  echo -e "  ${GREEN}2${NC}  Use an existing S3 bucket"
  echo -e "  ${GREEN}3${NC}  Skip S3 (files stored locally only)"
  echo ""

  read -rp "  Choose [1-3]: " s3_choice
  case "$s3_choice" in
    1)
      local bucket_name
      if [ -n "${account_id:-}" ]; then
        bucket_name="blueprintparser-data-${account_id}"
      else
        bucket_name="blueprintparser-data-$(openssl rand -hex 4)"
      fi
      read -rp "  Bucket name [${bucket_name}]: " input_bucket
      bucket_name="${input_bucket:-$bucket_name}"

      echo -ne "  Creating bucket... "
      if aws s3 mb "s3://${bucket_name}" --region "$CFG_AWS_REGION" &>/dev/null; then
        echo ""
        ok "Created S3 bucket: ${bucket_name}"

        # Enable CORS for browser uploads
        aws s3api put-bucket-cors --bucket "$bucket_name" --cors-configuration '{
          "CORSRules": [{
            "AllowedHeaders": ["*"],
            "AllowedMethods": ["GET", "PUT", "POST"],
            "AllowedOrigins": ["*"],
            "ExposeHeaders": ["ETag"],
            "MaxAgeSeconds": 3600
          }]
        }' --region "$CFG_AWS_REGION" &>/dev/null && ok "CORS configured" || warn "Could not set CORS (set it manually in AWS Console)"
      else
        fail "Could not create bucket. Check your AWS permissions."
        info "You may need s3:CreateBucket permission."
        prompt_secret "Enter an existing bucket name instead" "bucket_name"
      fi

      CFG_S3_BUCKET="$bucket_name"
      CFG_NEXT_PUBLIC_S3_BUCKET="$bucket_name"
      ;;
    2)
      prompt_secret "Enter your S3 bucket name" "CFG_S3_BUCKET"
      CFG_NEXT_PUBLIC_S3_BUCKET="$CFG_S3_BUCKET"
      # Validate
      if command -v aws &>/dev/null && [ -n "$CFG_S3_BUCKET" ]; then
        if aws s3 ls "s3://${CFG_S3_BUCKET}" --max-items 0 --region "$CFG_AWS_REGION" &>/dev/null; then
          ok "Bucket '${CFG_S3_BUCKET}' exists and is accessible"
        else
          warn "Could not access bucket. Check the name and permissions."
        fi
      fi
      ;;
    3)
      info "Skipping S3."
      ;;
  esac

  # ─── 5d. CloudFront (Optional) ───
  echo ""
  if [ -n "$CFG_S3_BUCKET" ]; then
    echo -e "  ${BOLD}CloudFront CDN${NC} (optional)"
    echo -e "  ${DIM}Speeds up image loading by caching them closer to your users.${NC}"
    echo -e "  ${DIM}Skip this if you're just getting started -- easy to add later.${NC}"
    echo ""
    if prompt_yes_no "Configure CloudFront?" "n"; then
      prompt_secret "CloudFront domain (e.g., d1234abcde.cloudfront.net)" "CFG_CLOUDFRONT_DOMAIN"
    fi
  fi

  # ─── 5e. Advanced AWS ───
  echo ""
  echo -e "  ${BOLD}Advanced AWS Features${NC} (all optional, add anytime)"
  echo ""
  echo -e "  ${GREEN}1${NC}  Step Functions (automated processing pipeline)"
  echo -e "  ${GREEN}2${NC}  SageMaker/YOLO (GPU object detection on blueprints)"
  echo -e "  ${GREEN}3${NC}  SES Email (password recovery)"
  echo -e "  ${GREEN}4${NC}  Configure all"
  echo -e "  ${GREEN}5${NC}  Skip all advanced features"
  echo ""

  read -rp "  Choose [1-5]: " adv_choice
  case "$adv_choice" in
    1|4)
      echo ""
      prompt_secret "Step Function ARN (from terraform output)" "CFG_STEP_FUNCTION_ARN"
      ;;&
    2|4)
      echo ""
      echo -e "  ${DIM}YOLO GPU detection requires an ECR image and SageMaker IAM role.${NC}"
      echo -e "  ${DIM}These are created by terraform -- check terraform output.${NC}"
      prompt_secret "YOLO ECR Image URI" "CFG_YOLO_ECR_IMAGE"
      prompt_secret "SageMaker Role ARN" "CFG_SAGEMAKER_ROLE_ARN"
      ;;&
    3|4)
      echo ""
      echo -e "  ${DIM}SES enables password recovery emails.${NC}"
      echo -e "  ${DIM}You must verify your sending domain in the AWS SES console.${NC}"
      prompt_secret "SES From Email (e.g., noreply@yourdomain.com)" "CFG_SES_FROM_EMAIL"
      ;;&
    5|*) ;;
  esac

  # Set DEV_PROCESSING_ENABLED based on Step Functions
  if [ -z "$CFG_STEP_FUNCTION_ARN" ]; then
    CFG_DEV_PROCESSING_ENABLED="true"
  fi

  echo ""
  ok "AWS configuration complete!"
  echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
#  PHASE 6 — AUTH & ADMIN
# ═══════════════════════════════════════════════════════════════════════════════

phase_auth() {
  header "6/8" "Admin Account"

  echo -e "  Set up the first admin account. This user gets full access to"
  echo -e "  all settings, user management, and the admin dashboard."
  echo ""

  # Root admin email
  local default_email="${CFG_ROOT_ADMIN_EMAIL:-}"
  if [ -n "$default_email" ]; then
    read -rp "  Admin email [${default_email}]: " input_email
    CFG_ROOT_ADMIN_EMAIL="${input_email:-$default_email}"
  else
    read -rp "  Admin email: " CFG_ROOT_ADMIN_EMAIL
  fi

  if [ -n "$CFG_ROOT_ADMIN_EMAIL" ]; then
    ok "Root admin: ${CFG_ROOT_ADMIN_EMAIL}"
  else
    warn "No admin email set. You can set it later in .env.local"
  fi

  # NEXTAUTH_URL
  echo ""
  local default_url="${CFG_NEXTAUTH_URL:-http://localhost:3000}"
  echo -e "  ${DIM}What URL will you access BlueprintParser at?${NC}"
  read -rp "  URL [${default_url}]: " input_url
  CFG_NEXTAUTH_URL="${input_url:-$default_url}"

  # Google OAuth (optional)
  echo ""
  echo -e "  ${BOLD}Google Sign-In${NC} (optional)"
  echo -e "  ${DIM}Allow users to log in with their Google accounts.${NC}"
  echo ""
  if [ -n "$CFG_GOOGLE_CLIENT_ID" ]; then
    ok "Google OAuth: configured"
    if prompt_yes_no "Keep existing Google OAuth config?" "y"; then
      echo ""; return
    fi
  fi

  if prompt_yes_no "Configure Google Sign-In?" "n"; then
    echo ""
    echo -e "  ${DIM}Set up at: https://console.cloud.google.com/apis/credentials${NC}"
    echo -e "  ${DIM}1. Create a new OAuth 2.0 Client ID${NC}"
    echo -e "  ${DIM}2. Set Authorized redirect URI to: ${CFG_NEXTAUTH_URL}/api/auth/callback/google${NC}"
    echo ""
    prompt_secret "Google Client ID" "CFG_GOOGLE_CLIENT_ID"
    prompt_secret "Google Client Secret" "CFG_GOOGLE_CLIENT_SECRET"
  fi

  echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
#  PHASE 7 — BUILD & LAUNCH
# ═══════════════════════════════════════════════════════════════════════════════

write_env_file() {
  # Backup existing
  if [ -f "$ENV_FILE" ]; then
    cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%s)"
  fi

  cat > "$ENV_FILE" << ENVEOF
# Generated by install_setup.sh on $(date)
# Re-run ./install_setup.sh to update

DATABASE_URL=${CFG_DATABASE_URL}
NEXTAUTH_SECRET=${CFG_NEXTAUTH_SECRET}
NEXTAUTH_URL=${CFG_NEXTAUTH_URL}
AWS_REGION=${CFG_AWS_REGION:-us-east-1}
PROCESSING_WEBHOOK_SECRET=${CFG_PROCESSING_WEBHOOK_SECRET}
LLM_KEY_SECRET=${CFG_LLM_KEY_SECRET}
ENVEOF

  # AWS credentials
  if [ -n "$CFG_AWS_ACCESS_KEY_ID" ]; then
    cat >> "$ENV_FILE" << ENVEOF

# AWS Credentials
AWS_ACCESS_KEY_ID=${CFG_AWS_ACCESS_KEY_ID}
AWS_SECRET_ACCESS_KEY=${CFG_AWS_SECRET_ACCESS_KEY}
ENVEOF
  fi

  # S3
  if [ -n "$CFG_S3_BUCKET" ]; then
    cat >> "$ENV_FILE" << ENVEOF

# S3 Storage
S3_BUCKET=${CFG_S3_BUCKET}
NEXT_PUBLIC_S3_BUCKET=${CFG_NEXT_PUBLIC_S3_BUCKET}
ENVEOF
    [ -n "$CFG_CLOUDFRONT_DOMAIN" ] && echo "CLOUDFRONT_DOMAIN=${CFG_CLOUDFRONT_DOMAIN}" >> "$ENV_FILE"
  fi

  # Step Functions
  [ -n "$CFG_STEP_FUNCTION_ARN" ] && echo -e "\nSTEP_FUNCTION_ARN=${CFG_STEP_FUNCTION_ARN}" >> "$ENV_FILE"

  # Dev processing mode
  [ -n "$CFG_DEV_PROCESSING_ENABLED" ] && echo -e "\n# Local processing mode (no Step Functions)\nDEV_PROCESSING_ENABLED=${CFG_DEV_PROCESSING_ENABLED}" >> "$ENV_FILE"

  # LLM Provider keys
  {
    echo ""
    echo "# AI Provider Keys"
    [ -n "$CFG_ANTHROPIC_API_KEY" ] && echo "ANTHROPIC_API_KEY=${CFG_ANTHROPIC_API_KEY}"
    [ -n "$CFG_GROQ_API_KEY" ] && echo "GROQ_API_KEY=${CFG_GROQ_API_KEY}"
    [ -n "$CFG_OPENAI_API_KEY" ] && echo "OPENAI_API_KEY=${CFG_OPENAI_API_KEY}"
  } >> "$ENV_FILE"

  # Custom LLM config
  if [ -n "$CFG_LLM_PROVIDER" ]; then
    cat >> "$ENV_FILE" << ENVEOF

# Custom LLM Provider
LLM_PROVIDER=${CFG_LLM_PROVIDER}
LLM_MODEL=${CFG_LLM_MODEL}
LLM_BASE_URL=${CFG_LLM_BASE_URL}
ENVEOF
  fi

  # YOLO/SageMaker
  if [ -n "$CFG_YOLO_ECR_IMAGE" ] || [ -n "$CFG_SAGEMAKER_ROLE_ARN" ]; then
    {
      echo ""
      echo "# YOLO/SageMaker"
      [ -n "$CFG_YOLO_ECR_IMAGE" ] && echo "YOLO_ECR_IMAGE=${CFG_YOLO_ECR_IMAGE}"
      [ -n "$CFG_SAGEMAKER_ROLE_ARN" ] && echo "SAGEMAKER_ROLE_ARN=${CFG_SAGEMAKER_ROLE_ARN}"
    } >> "$ENV_FILE"
  fi

  # SES
  [ -n "$CFG_SES_FROM_EMAIL" ] && echo -e "\nSES_FROM_EMAIL=${CFG_SES_FROM_EMAIL}" >> "$ENV_FILE"

  # Google OAuth
  if [ -n "$CFG_GOOGLE_CLIENT_ID" ]; then
    cat >> "$ENV_FILE" << ENVEOF

# Google OAuth
GOOGLE_CLIENT_ID=${CFG_GOOGLE_CLIENT_ID}
GOOGLE_CLIENT_SECRET=${CFG_GOOGLE_CLIENT_SECRET}
ENVEOF
  fi

  # Root Admin
  [ -n "$CFG_ROOT_ADMIN_EMAIL" ] && echo -e "\n# Root admin (gets full access on first login)\nROOT_ADMIN_EMAIL=${CFG_ROOT_ADMIN_EMAIL}" >> "$ENV_FILE"

  # Label Studio (preserve existing)
  if [ -n "$CFG_LABEL_STUDIO_URL" ]; then
    cat >> "$ENV_FILE" << ENVEOF

# Label Studio
LABEL_STUDIO_URL=${CFG_LABEL_STUDIO_URL}
LABEL_STUDIO_API_KEY=${CFG_LABEL_STUDIO_API_KEY}
LABEL_STUDIO_ADMIN_EMAIL=${CFG_LABEL_STUDIO_ADMIN_EMAIL}
LABEL_STUDIO_ADMIN_PASSWORD=${CFG_LABEL_STUDIO_ADMIN_PASSWORD}
ENVEOF
  fi
}

phase_build() {
  header "7/8" "Install & Launch"

  local step_num=1

  # ── Step 1: Write .env.local ──
  echo -e "  ${BOLD}[${step_num}/5]${NC} Writing configuration..."
  write_env_file
  ok "Wrote .env.local"
  step_num=$((step_num + 1))

  # ── Step 2: Start database ──
  echo ""
  echo -e "  ${BOLD}[${step_num}/5]${NC} Starting database..."
  if [[ "$CFG_DATABASE_URL" == *"localhost:5433"* ]]; then
    cd "$SCRIPT_DIR"
    docker compose up -d db &>/dev/null &
    local docker_pid=$!
    spinner $docker_pid "Starting PostgreSQL container..."
    wait $docker_pid 2>/dev/null || true

    # Wait for database to be ready
    local retries=30
    while [ $retries -gt 0 ]; do
      if docker compose exec -T db pg_isready -U beaver &>/dev/null; then
        break
      fi
      retries=$((retries - 1))
      sleep 1
    done

    if [ $retries -gt 0 ]; then
      ok "PostgreSQL is ready"
    else
      fail "Database didn't start in time."
      info "Check: docker compose logs db"
      info "Then re-run this script."
      exit 1
    fi
  else
    info "Using external database -- skipping Docker."
  fi
  step_num=$((step_num + 1))

  # ── Step 3: Install dependencies ──
  echo ""
  echo -e "  ${BOLD}[${step_num}/5]${NC} Installing dependencies..."
  info "This usually takes 1-2 minutes..."
  cd "$SCRIPT_DIR"
  npm install --loglevel=error &>/dev/null &
  local npm_pid=$!
  spinner $npm_pid "Running npm install..."
  if wait $npm_pid 2>/dev/null; then
    ok "Dependencies installed"
  else
    fail "npm install failed."
    info "Try: rm -rf node_modules && npm install"
    echo ""
    if prompt_yes_no "Continue anyway?" "n"; then
      :
    else
      exit 1
    fi
  fi
  step_num=$((step_num + 1))

  # ── Step 4: Run migrations ──
  echo ""
  echo -e "  ${BOLD}[${step_num}/5]${NC} Setting up database tables..."
  cd "$SCRIPT_DIR"
  npx drizzle-kit migrate &>/dev/null &
  local migrate_pid=$!
  spinner $migrate_pid "Running database migrations..."
  if wait $migrate_pid 2>/dev/null; then
    ok "Database schema is up to date"
  else
    fail "Migration failed."
    info "Check your DATABASE_URL in .env.local"
    info "Check database logs: docker compose logs db"
    echo ""
    if ! prompt_yes_no "Continue anyway?" "n"; then
      exit 1
    fi
  fi
  step_num=$((step_num + 1))

  # ── Step 5: Seed demo data ──
  echo ""
  echo -e "  ${BOLD}[${step_num}/5]${NC} Demo data"
  echo ""
  echo -e "  ${DIM}Create a demo company with a sample account?${NC}"
  echo -e "  ${DIM}This gives you a working login to test with immediately.${NC}"
  echo ""
  if prompt_yes_no "Seed demo data?" "y"; then
    cd "$SCRIPT_DIR"
    if npx tsx src/lib/db/seed.ts &>/dev/null; then
      ok "Demo data created!"
      echo ""
      echo -e "  ${BOLD}Demo Login:${NC}"
      echo -e "  Email:    ${GREEN}demo@demo.com${NC}"
      echo -e "  Password: ${GREEN}password123${NC}"
    else
      warn "Could not seed demo data (may already exist)."
      info "This is normal if you've run setup before."
    fi
  else
    info "Skipped demo data."
  fi

  echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
#  PHASE 8 — HEALTH CHECKS & SUMMARY
# ═══════════════════════════════════════════════════════════════════════════════

phase_health_checks() {
  header "8/8" "Health Checks"

  # Re-load config if running standalone
  if [ -z "$CFG_DATABASE_URL" ] && [ -f "$ENV_FILE" ]; then
    load_existing_env
  fi

  echo -e "  ${BOLD}Connectivity Tests${NC}"
  echo ""

  # Database
  if [ -n "$CFG_DATABASE_URL" ]; then
    local db_result
    db_result=$(cd "$SCRIPT_DIR" && node -e "
const{Pool}=require('pg');
const p=new Pool({connectionString:'${CFG_DATABASE_URL}'});
p.query('SELECT count(*) as c FROM information_schema.tables WHERE table_schema=\\'public\\'')
.then(r=>{console.log('OK:'+r.rows[0].c);p.end()})
.catch(e=>{console.error('FAIL:'+e.message);p.end();process.exit(1)});
" 2>&1) || true
    if [[ "$db_result" == OK:* ]]; then
      local table_count="${db_result#OK:}"
      ok "Database: connected (${table_count} tables)"
    else
      fail "Database: connection failed"
      info "${db_result}"
    fi
  else
    fail "Database: not configured"
  fi

  # LLM Providers
  if [ -n "$CFG_GROQ_API_KEY" ]; then
    if test_groq_key "$CFG_GROQ_API_KEY"; then
      ok "Groq: responding (llama-3.3-70b-versatile)"
    else
      fail "Groq: not responding"
    fi
  else
    echo -e "  ${DIM}-${NC} Groq: not configured"
  fi

  if [ -n "$CFG_ANTHROPIC_API_KEY" ]; then
    if test_anthropic_key "$CFG_ANTHROPIC_API_KEY"; then
      ok "Anthropic: responding"
    else
      fail "Anthropic: not responding"
    fi
  else
    echo -e "  ${DIM}-${NC} Anthropic: not configured"
  fi

  if [ -n "$CFG_OPENAI_API_KEY" ]; then
    if test_openai_key "$CFG_OPENAI_API_KEY"; then
      ok "OpenAI: responding"
    else
      fail "OpenAI: not responding"
    fi
  else
    echo -e "  ${DIM}-${NC} OpenAI: not configured"
  fi

  # S3
  if [ -n "$CFG_S3_BUCKET" ] && command -v aws &>/dev/null; then
    if aws s3 ls "s3://${CFG_S3_BUCKET}" --max-items 0 --region "${CFG_AWS_REGION:-us-east-1}" &>/dev/null; then
      ok "S3: bucket '${CFG_S3_BUCKET}' accessible"
    else
      fail "S3: cannot access bucket '${CFG_S3_BUCKET}'"
    fi
  elif [ -n "$CFG_S3_BUCKET" ]; then
    warn "S3: configured but AWS CLI not available to verify"
  else
    echo -e "  ${DIM}-${NC} S3: not configured (local-only mode)"
  fi

  # ─── Feature Matrix ───
  echo ""
  draw_line
  echo -e "  ${BOLD}Feature Status${NC}"
  draw_line
  echo ""

  local has_llm=0
  [ -n "$CFG_GROQ_API_KEY" ] || [ -n "$CFG_ANTHROPIC_API_KEY" ] || [ -n "$CFG_OPENAI_API_KEY" ] || [ -n "$CFG_LLM_BASE_URL" ] && has_llm=1

  echo -e "  ${BOLD}CORE${NC}"
  ok "Upload and view PDF blueprints"
  ok "User accounts and multi-tenant companies"
  ok "Local PDF processing (Ghostscript + Python OCR)"
  echo ""

  echo -e "  ${BOLD}AI FEATURES${NC}"
  if [ $has_llm -eq 1 ]; then
    ok "AI chat about blueprints"
    ok "CSI code detection and spatial mapping"
    ok "Page intelligence analysis"
  else
    fail "AI chat (needs an AI provider key)"
    fail "CSI code detection (needs an AI provider key)"
    fail "Page intelligence (needs an AI provider key)"
  fi
  echo ""

  echo -e "  ${BOLD}CLOUD FEATURES${NC}"
  if [ -n "$CFG_S3_BUCKET" ]; then
    ok "Cloud file storage (S3)"
  else
    fail "Cloud file storage (needs AWS S3)"
  fi
  if [ -n "$CFG_CLOUDFRONT_DOMAIN" ]; then
    ok "CDN for fast image loading"
  else
    fail "CDN (needs CloudFront)"
  fi
  if [ -n "$CFG_AWS_ACCESS_KEY_ID" ]; then
    ok "Advanced OCR (AWS Textract)"
  else
    fail "Advanced OCR (needs AWS credentials)"
  fi
  if [ -n "$CFG_YOLO_ECR_IMAGE" ]; then
    ok "GPU object detection (YOLO/SageMaker)"
  else
    fail "GPU object detection (needs SageMaker setup)"
  fi
  if [ -n "$CFG_STEP_FUNCTION_ARN" ]; then
    ok "Automated processing pipeline"
  else
    fail "Automated pipeline (needs Step Functions)"
  fi
  if [ -n "$CFG_SES_FROM_EMAIL" ]; then
    ok "Password recovery emails"
  else
    fail "Password recovery (needs AWS SES)"
  fi
  echo ""

  echo -e "  ${BOLD}INTEGRATIONS${NC}"
  if [ -n "$CFG_GOOGLE_CLIENT_ID" ]; then
    ok "Google Sign-In"
  else
    fail "Google Sign-In (needs OAuth credentials)"
  fi
  if [ -n "$CFG_LABEL_STUDIO_URL" ] && [ -n "$CFG_LABEL_STUDIO_API_KEY" ]; then
    ok "Label Studio data labeling"
  else
    fail "Label Studio (run: docker compose up label-studio)"
  fi

  echo ""
  info "To enable more features, re-run: ./install_setup.sh"
  echo ""

  # ─── Launch instructions ───
  draw_line
  echo -e "  ${BG}${W}  Setup Complete!  ${NC}"
  draw_line
  echo ""
  echo -e "  Start BlueprintParser:"
  echo ""
  echo -e "    ${GREEN}npm run dev${NC}"
  echo ""
  echo -e "  Then open: ${CYAN}${CFG_NEXTAUTH_URL:-http://localhost:3000}${NC}"
  echo ""
  echo -e "  ${BOLD}Login:${NC}"
  echo -e "    Email:    ${GREEN}demo@demo.com${NC}"
  echo -e "    Password: ${GREEN}password123${NC}"
  echo ""
  echo -e "  ${BOLD}Useful commands:${NC}"
  echo -e "    ${DIM}npm run dev${NC}          Start development server"
  echo -e "    ${DIM}npm run build${NC}        Build for production"
  echo -e "    ${DIM}docker compose up -d${NC} Start database + Label Studio"
  echo -e "    ${DIM}./install_setup.sh${NC}   Re-run this setup wizard"
  echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════════════════════

main() {
  phase_welcome
  phase_prerequisites
  phase_database
  phase_secrets
  phase_ai_provider
  phase_aws
  phase_auth
  phase_build
  phase_health_checks
}

main "$@"
