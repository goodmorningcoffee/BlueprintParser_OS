#!/usr/bin/env bash
# SageMaker Kill Switch
# Instantly enable/disable SageMaker access for the web app.
# Uses an IAM deny policy that overrides all other permissions.
#
# Usage:
#   ./scripts/sagemaker-killswitch.sh off    # Block SageMaker (deny all)
#   ./scripts/sagemaker-killswitch.sh on     # Restore SageMaker access
#   ./scripts/sagemaker-killswitch.sh status # Check current state

ROLE_NAME="beaver-ecs-task-role"
POLICY_NAME="sagemaker-kill-switch"
REGION="us-east-1"

case "$1" in
  off|disable|kill)
    echo "Blocking SageMaker access..."
    aws iam put-role-policy \
      --role-name "$ROLE_NAME" \
      --policy-name "$POLICY_NAME" \
      --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"sagemaker:*","Resource":"*"}]}'
    echo "SageMaker BLOCKED. No YOLO jobs can run."
    ;;

  on|enable|restore)
    echo "Restoring SageMaker access..."
    aws iam delete-role-policy \
      --role-name "$ROLE_NAME" \
      --policy-name "$POLICY_NAME" 2>/dev/null
    echo "SageMaker ENABLED. YOLO jobs can run."
    ;;

  status)
    if aws iam get-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY_NAME" 2>/dev/null | grep -q "Deny"; then
      echo "SageMaker: BLOCKED (kill switch active)"
    else
      echo "SageMaker: ENABLED"
    fi
    ;;

  *)
    echo "Usage: $0 {off|on|status}"
    echo "  off    - Block all SageMaker access (instant)"
    echo "  on     - Restore SageMaker access"
    echo "  status - Check if kill switch is active"
    exit 1
    ;;
esac
