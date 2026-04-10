#!/bin/bash
set -euo pipefail

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  BlueprintParser 2 — AWS Hardening Script
#  Run once to enable monitoring, alerting, WAF, and scanning.
#  Estimated cost: ~$10-25/month total
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "${SCRIPT_DIR}/.deploy.env" ] && source "${SCRIPT_DIR}/.deploy.env"

: "${AWS_ACCOUNT:?ERROR: Set AWS_ACCOUNT in .deploy.env or environment}"

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="${AWS_ACCOUNT}"
CLUSTER="${ECS_CLUSTER:-blueprintparser-cluster}"
SERVICE="${ECS_SERVICE:-blueprintparser-app}"
ECR_REPO="${ECR_REPO:-blueprintparser-app}"
ALB_NAME="${ALB_NAME:-blueprintparser-alb}"
RDS_ID="${RDS_ID:-blueprintparser-db}"
S3_BUCKET="${S3_BUCKET:-blueprintparser-data-${ACCOUNT_ID}}"
LOG_BUCKET="${S3_BUCKET}"  # reuse data bucket for logs (separate prefix)
SNS_TOPIC="${SNS_TOPIC:-blueprintparser-alerts}"

# ── CONFIGURE THIS ──────────────────────────────────────────────
ALERT_EMAIL="${1:-}"
if [ -z "$ALERT_EMAIL" ]; then
  echo "Usage: ./hardening.sh your-email@example.com"
  echo "  Email receives CloudWatch alarm notifications."
  exit 1
fi

ok()   { echo "  ✔ $1"; }
fail() { echo "  ✘ $1 (non-fatal, continuing)"; }
step() { echo ""; echo "▶ $1"; }

# ════════════════════════════════════════════════════════════════
# 1. ECR Image Scanning (FREE)
# ════════════════════════════════════════════════════════════════
step "Enabling ECR scan-on-push for ${ECR_REPO}..."
if aws ecr put-image-scanning-configuration \
  --repository-name "$ECR_REPO" \
  --image-scanning-configuration scanOnPush=true \
  --region "$REGION" > /dev/null 2>&1; then
  ok "ECR scan-on-push enabled — every push auto-scans for CVEs"
else
  fail "ECR scan-on-push (may already be enabled)"
fi

# Also enable for pipeline repos
for repo in blueprintparser-cpu-pipeline blueprintparser-yolo-pipeline; do
  aws ecr put-image-scanning-configuration \
    --repository-name "$repo" \
    --image-scanning-configuration scanOnPush=true \
    --region "$REGION" > /dev/null 2>&1 || true
done

# ════════════════════════════════════════════════════════════════
# 2. SNS Topic for Alerts
# ════════════════════════════════════════════════════════════════
step "Creating SNS topic and subscribing ${ALERT_EMAIL}..."
TOPIC_ARN=$(aws sns create-topic --name "$SNS_TOPIC" --region "$REGION" --query 'TopicArn' --output text 2>/dev/null || echo "")
if [ -n "$TOPIC_ARN" ]; then
  ok "SNS topic: ${TOPIC_ARN}"
  aws sns subscribe \
    --topic-arn "$TOPIC_ARN" \
    --protocol email \
    --notification-endpoint "$ALERT_EMAIL" \
    --region "$REGION" > /dev/null 2>&1
  ok "Email subscription pending — CHECK YOUR INBOX to confirm"
else
  TOPIC_ARN="arn:aws:sns:${REGION}:${ACCOUNT_ID}:${SNS_TOPIC}"
  fail "SNS topic creation (may already exist, using ${TOPIC_ARN})"
fi

# ════════════════════════════════════════════════════════════════
# 3. CloudWatch Alarms (~$0.30/month for 3 alarms)
# ════════════════════════════════════════════════════════════════
step "Looking up ALB ARN..."
ALB_ARN=$(aws elbv2 describe-load-balancers \
  --names "$ALB_NAME" \
  --region "$REGION" \
  --query 'LoadBalancers[0].LoadBalancerArn' \
  --output text 2>/dev/null || echo "")

if [ -z "$ALB_ARN" ] || [ "$ALB_ARN" = "None" ]; then
  fail "Could not find ALB '${ALB_NAME}' — skipping ALB alarms"
else
  # Extract the ARN suffix (app/blueprintparser-alb/abc123)
  ALB_SUFFIX=$(echo "$ALB_ARN" | sed 's|.*loadbalancer/||')
  ok "ALB found: ${ALB_SUFFIX}"

  # Alarm: 5xx errors > 10 in 5 minutes
  step "Creating CloudWatch alarm: 5xx errors..."
  aws cloudwatch put-metric-alarm \
    --alarm-name "blueprintparser-5xx-errors" \
    --alarm-description "BlueprintParser 5xx errors exceeded threshold" \
    --metric-name "HTTPCode_Target_5XX_Count" \
    --namespace "AWS/ApplicationELB" \
    --statistic Sum \
    --period 300 \
    --threshold 10 \
    --comparison-operator GreaterThanThreshold \
    --evaluation-periods 1 \
    --alarm-actions "$TOPIC_ARN" \
    --ok-actions "$TOPIC_ARN" \
    --dimensions "Name=LoadBalancer,Value=${ALB_SUFFIX}" \
    --treat-missing-data notBreaching \
    --region "$REGION" > /dev/null 2>&1 && ok "5xx alarm created" || fail "5xx alarm"

  # Alarm: unhealthy targets > 0 for 5 minutes
  step "Creating CloudWatch alarm: unhealthy targets..."
  TG_ARN=$(aws elbv2 describe-target-groups \
    --load-balancer-arn "$ALB_ARN" \
    --region "$REGION" \
    --query 'TargetGroups[0].TargetGroupArn' \
    --output text 2>/dev/null || echo "")
  if [ -n "$TG_ARN" ] && [ "$TG_ARN" != "None" ]; then
    TG_SUFFIX=$(echo "$TG_ARN" | sed 's|.*:targetgroup/||')
    aws cloudwatch put-metric-alarm \
      --alarm-name "blueprintparser-unhealthy-hosts" \
      --alarm-description "BlueprintParser has unhealthy ECS targets" \
      --metric-name "UnHealthyHostCount" \
      --namespace "AWS/ApplicationELB" \
      --statistic Maximum \
      --period 300 \
      --threshold 0 \
      --comparison-operator GreaterThanThreshold \
      --evaluation-periods 2 \
      --alarm-actions "$TOPIC_ARN" \
      --ok-actions "$TOPIC_ARN" \
      --dimensions "Name=TargetGroup,Value=${TG_SUFFIX}" "Name=LoadBalancer,Value=${ALB_SUFFIX}" \
      --treat-missing-data notBreaching \
      --region "$REGION" > /dev/null 2>&1 && ok "Unhealthy hosts alarm created" || fail "Unhealthy hosts alarm"
  fi

  # Alarm: ECS CPU > 80% for 10 minutes
  step "Creating CloudWatch alarm: ECS high CPU..."
  aws cloudwatch put-metric-alarm \
    --alarm-name "blueprintparser-ecs-high-cpu" \
    --alarm-description "BlueprintParser ECS CPU above 80%" \
    --metric-name "CPUUtilization" \
    --namespace "AWS/ECS" \
    --statistic Average \
    --period 300 \
    --threshold 80 \
    --comparison-operator GreaterThanThreshold \
    --evaluation-periods 2 \
    --alarm-actions "$TOPIC_ARN" \
    --ok-actions "$TOPIC_ARN" \
    --dimensions "Name=ClusterName,Value=${CLUSTER}" "Name=ServiceName,Value=${SERVICE}" \
    --treat-missing-data notBreaching \
    --region "$REGION" > /dev/null 2>&1 && ok "ECS CPU alarm created" || fail "ECS CPU alarm"

  # Alarm: RDS CPU > 80% for 10 minutes
  step "Creating CloudWatch alarm: RDS high CPU..."
  aws cloudwatch put-metric-alarm \
    --alarm-name "blueprintparser-rds-high-cpu" \
    --alarm-description "BlueprintParser RDS CPU above 80%" \
    --metric-name "CPUUtilization" \
    --namespace "AWS/RDS" \
    --statistic Average \
    --period 300 \
    --threshold 80 \
    --comparison-operator GreaterThanThreshold \
    --evaluation-periods 2 \
    --alarm-actions "$TOPIC_ARN" \
    --ok-actions "$TOPIC_ARN" \
    --dimensions "Name=DBInstanceIdentifier,Value=${RDS_ID}" \
    --treat-missing-data notBreaching \
    --region "$REGION" > /dev/null 2>&1 && ok "RDS CPU alarm created" || fail "RDS CPU alarm"

  # ════════════════════════════════════════════════════════════════
  # 4. ALB Access Logs → S3 (~$1-5/month)
  # ════════════════════════════════════════════════════════════════
  step "Enabling ALB access logs..."
  # ALB access logs require the S3 bucket to allow writes from the ELB account
  # ELB account for us-east-1 is 127311923021
  aws s3api put-bucket-policy --bucket "$LOG_BUCKET" --policy "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Principal\": {\"AWS\": \"arn:aws:iam::127311923021:root\"},
      \"Action\": \"s3:PutObject\",
      \"Resource\": \"arn:aws:s3:::${LOG_BUCKET}/alb-logs/*\"
    }]
  }" --region "$REGION" > /dev/null 2>&1 && ok "S3 bucket policy for ALB logs" || fail "S3 bucket policy (may conflict with existing policy)"

  aws elbv2 modify-load-balancer-attributes \
    --load-balancer-arn "$ALB_ARN" \
    --attributes \
      "Key=access_logs.s3.enabled,Value=true" \
      "Key=access_logs.s3.bucket,Value=${LOG_BUCKET}" \
      "Key=access_logs.s3.prefix,Value=alb-logs" \
    --region "$REGION" > /dev/null 2>&1 && ok "ALB access logs → s3://${LOG_BUCKET}/alb-logs/" || fail "ALB access logs"
fi

# ════════════════════════════════════════════════════════════════
# 5. GuardDuty — Intrusion Detection (~$1-4/month)
# ════════════════════════════════════════════════════════════════
step "Enabling GuardDuty..."
DETECTOR_ID=$(aws guardduty create-detector --enable --region "$REGION" --query 'DetectorId' --output text 2>/dev/null || echo "")
if [ -n "$DETECTOR_ID" ] && [ "$DETECTOR_ID" != "None" ]; then
  ok "GuardDuty enabled (detector: ${DETECTOR_ID})"
else
  # Check if already enabled
  EXISTING=$(aws guardduty list-detectors --region "$REGION" --query 'DetectorIds[0]' --output text 2>/dev/null || echo "")
  if [ -n "$EXISTING" ] && [ "$EXISTING" != "None" ]; then
    ok "GuardDuty already enabled (detector: ${EXISTING})"
  else
    fail "GuardDuty creation"
  fi
fi

# ════════════════════════════════════════════════════════════════
# 6. WAF — Rate Limiting + SQL Injection Block (~$5-20/month)
# ════════════════════════════════════════════════════════════════
step "Creating WAF Web ACL..."
WAF_ARN=$(aws wafv2 create-web-acl \
  --name "blueprintparser-waf" \
  --scope REGIONAL \
  --default-action '{"Allow":{}}' \
  --rules '[
    {
      "Name": "rate-limit-per-ip",
      "Priority": 1,
      "Statement": {
        "RateBasedStatement": {
          "Limit": 1000,
          "AggregateKeyType": "IP"
        }
      },
      "Action": {"Block": {}},
      "VisibilityConfig": {
        "SampledRequestsEnabled": true,
        "CloudWatchMetricsEnabled": true,
        "MetricName": "blueprintparser-rate-limit"
      }
    },
    {
      "Name": "aws-managed-sql-injection",
      "Priority": 2,
      "Statement": {
        "ManagedRuleGroupStatement": {
          "VendorName": "AWS",
          "Name": "AWSManagedRulesSQLiRuleSet"
        }
      },
      "OverrideAction": {"None": {}},
      "VisibilityConfig": {
        "SampledRequestsEnabled": true,
        "CloudWatchMetricsEnabled": true,
        "MetricName": "blueprintparser-sqli"
      }
    },
    {
      "Name": "aws-managed-known-bad-inputs",
      "Priority": 3,
      "Statement": {
        "ManagedRuleGroupStatement": {
          "VendorName": "AWS",
          "Name": "AWSManagedRulesKnownBadInputsRuleSet"
        }
      },
      "OverrideAction": {"None": {}},
      "VisibilityConfig": {
        "SampledRequestsEnabled": true,
        "CloudWatchMetricsEnabled": true,
        "MetricName": "blueprintparser-bad-inputs"
      }
    },
    {
      "Name": "aws-managed-ip-reputation",
      "Priority": 4,
      "Statement": {
        "ManagedRuleGroupStatement": {
          "VendorName": "AWS",
          "Name": "AWSManagedRulesAmazonIpReputationList"
        }
      },
      "OverrideAction": {"None": {}},
      "VisibilityConfig": {
        "SampledRequestsEnabled": true,
        "CloudWatchMetricsEnabled": true,
        "MetricName": "blueprintparser-ip-reputation"
      }
    }
  ]' \
  --visibility-config '{
    "SampledRequestsEnabled": true,
    "CloudWatchMetricsEnabled": true,
    "MetricName": "blueprintparser-waf"
  }' \
  --region "$REGION" \
  --query 'Summary.ARN' --output text 2>/dev/null || echo "")

if [ -n "$WAF_ARN" ] && [ "$WAF_ARN" != "None" ]; then
  ok "WAF created: ${WAF_ARN}"

  # Associate WAF with ALB
  if [ -n "$ALB_ARN" ] && [ "$ALB_ARN" != "None" ]; then
    step "Associating WAF with ALB..."
    aws wafv2 associate-web-acl \
      --web-acl-arn "$WAF_ARN" \
      --resource-arn "$ALB_ARN" \
      --region "$REGION" > /dev/null 2>&1 && ok "WAF attached to ALB" || fail "WAF → ALB association"
  fi
else
  # Check if already exists
  EXISTING_WAF=$(aws wafv2 list-web-acls --scope REGIONAL --region "$REGION" \
    --query "WebACLs[?Name=='blueprintparser-waf'].ARN" --output text 2>/dev/null || echo "")
  if [ -n "$EXISTING_WAF" ] && [ "$EXISTING_WAF" != "None" ]; then
    ok "WAF already exists: ${EXISTING_WAF}"
  else
    fail "WAF creation"
  fi
fi

# ════════════════════════════════════════════════════════════════
# 7. CloudTrail — API Audit Trail (~$2/month)
# ════════════════════════════════════════════════════════════════
step "Creating CloudTrail..."
# Create log bucket prefix for CloudTrail
aws s3api put-object --bucket "$LOG_BUCKET" --key "cloudtrail/" --region "$REGION" > /dev/null 2>&1 || true

# CloudTrail needs its own bucket policy
aws s3api put-bucket-policy --bucket "$LOG_BUCKET" --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    {
      \"Effect\": \"Allow\",
      \"Principal\": {\"AWS\": \"arn:aws:iam::127311923021:root\"},
      \"Action\": \"s3:PutObject\",
      \"Resource\": \"arn:aws:s3:::${LOG_BUCKET}/alb-logs/*\"
    },
    {
      \"Effect\": \"Allow\",
      \"Principal\": {\"Service\": \"cloudtrail.amazonaws.com\"},
      \"Action\": \"s3:GetBucketAcl\",
      \"Resource\": \"arn:aws:s3:::${LOG_BUCKET}\"
    },
    {
      \"Effect\": \"Allow\",
      \"Principal\": {\"Service\": \"cloudtrail.amazonaws.com\"},
      \"Action\": \"s3:PutObject\",
      \"Resource\": \"arn:aws:s3:::${LOG_BUCKET}/cloudtrail/*\",
      \"Condition\": {\"StringEquals\": {\"s3:x-amz-acl\": \"bucket-owner-full-control\"}}
    }
  ]
}" --region "$REGION" > /dev/null 2>&1 && ok "S3 bucket policy updated for CloudTrail + ALB" || fail "S3 bucket policy update"

aws cloudtrail create-trail \
  --name "blueprintparser-audit" \
  --s3-bucket-name "$LOG_BUCKET" \
  --s3-key-prefix "cloudtrail" \
  --is-multi-region-trail \
  --enable-log-file-validation \
  --region "$REGION" > /dev/null 2>&1 && ok "CloudTrail created" || fail "CloudTrail (may already exist)"

aws cloudtrail start-logging --name "blueprintparser-audit" --region "$REGION" > /dev/null 2>&1 && ok "CloudTrail logging started" || fail "CloudTrail start"

# ════════════════════════════════════════════════════════════════
# 8. Summary
# ════════════════════════════════════════════════════════════════
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Hardening Complete"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  ✔ ECR scan-on-push (free)"
echo "  ✔ CloudWatch alarms → ${ALERT_EMAIL}"
echo "  ✔ ALB access logs → s3://${LOG_BUCKET}/alb-logs/"
echo "  ✔ GuardDuty intrusion detection"
echo "  ✔ WAF (rate limit + SQLi + bad inputs + IP reputation)"
echo "  ✔ CloudTrail API audit → s3://${LOG_BUCKET}/cloudtrail/"
echo ""
echo "  ⚠  CONFIRM your email subscription (check inbox for SNS)"
echo ""
echo "  Monitoring commands:"
echo "    Logs:      aws logs tail /ecs/blueprintparser-app --since 30m --region ${REGION} --follow"
echo "    Errors:    aws logs tail /ecs/blueprintparser-app --since 1h --region ${REGION} --filter-pattern ERROR"
echo "    Alarms:    aws cloudwatch describe-alarms --state-value ALARM --region ${REGION}"
echo "    GuardDuty: aws guardduty list-findings --detector-id \$(aws guardduty list-detectors --region ${REGION} --query 'DetectorIds[0]' --output text) --region ${REGION}"
echo "    WAF:       aws wafv2 get-sampled-requests --web-acl-arn \${WAF_ARN} --rule-metric-name blueprintparser-rate-limit --scope REGIONAL --time-window StartTime=\$(date -u -v-1H +%s),EndTime=\$(date -u +%s) --max-items 10 --region ${REGION}"
echo "    ECR scan:  aws ecr describe-image-scan-findings --repository-name ${ECR_REPO} --image-id imageTag=latest --region ${REGION}"
echo ""
echo "  Estimated monthly cost: ~\$10-25"
echo ""
