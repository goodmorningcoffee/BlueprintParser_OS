###############################################################################
# AWS Budget — monthly cost cap with tiered alerts
#
# Fires SNS notifications at 50%, 80%, and 100% of the configured monthly
# cap. Independent of CloudWatch alarms — this catches slow-burn cost drift
# (e.g. Textract pages, SageMaker hours, CloudFront egress) that per-service
# invocation alarms don't model.
#
# Budget is account-wide for the linked AWS account, not BP-scoped, so it
# catches infra-wide cost regardless of where the spend lives.
###############################################################################

resource "aws_budgets_budget" "beaver_monthly_cap" {
  count = var.monthly_budget_usd > 0 ? 1 : 0

  name              = "blueprintparser-monthly-cost-cap"
  budget_type       = "COST"
  limit_amount      = tostring(var.monthly_budget_usd)
  limit_unit        = "USD"
  time_unit         = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_sns_topic_arns  = [aws_sns_topic.beaver_alerts.arn]
    subscriber_email_addresses = var.alert_email != "" ? [var.alert_email] : []
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_sns_topic_arns  = [aws_sns_topic.beaver_alerts.arn]
    subscriber_email_addresses = var.alert_email != "" ? [var.alert_email] : []
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_sns_topic_arns  = [aws_sns_topic.beaver_alerts.arn]
    subscriber_email_addresses = var.alert_email != "" ? [var.alert_email] : []
  }

  # Forecast-based heads-up — fires when AWS projects we'll exceed 100%.
  # This is the "early warning" before actual spend catches up.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_sns_topic_arns  = [aws_sns_topic.beaver_alerts.arn]
    subscriber_email_addresses = var.alert_email != "" ? [var.alert_email] : []
  }
}
