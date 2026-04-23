###############################################################################
# CloudWatch Alarms + SNS
#
# Pre-Reddit-launch safety net. Routes critical signals (ECS CPU pressure,
# Lambda runaway fanout) to a single SNS topic that the operator subscribes
# to via email. No alarm fires in steady state; any page here is a cue to
# check the demo load or flip demo-feature toggles in the admin panel.
#
# Alarms are conditional on var.alert_email being set so `terraform apply`
# stays usable in bare dev environments. If alert_email == "", the SNS topic
# still exists (downstream resources may depend on it) but has no subscribers.
###############################################################################

resource "aws_sns_topic" "beaver_alerts" {
  name = "blueprintparser-alerts"
}

resource "aws_sns_topic_subscription" "beaver_alerts_email" {
  count     = var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.beaver_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# SNS topic policy — allows AWS services (CloudWatch, Budgets) to publish
# notifications to this topic. Without this, AWS Budgets cannot deliver the
# cost-cap alerts configured in budgets.tf.
resource "aws_sns_topic_policy" "beaver_alerts" {
  arn    = aws_sns_topic.beaver_alerts.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowAwsServicesPublish"
        Effect    = "Allow"
        Principal = { Service = ["cloudwatch.amazonaws.com", "budgets.amazonaws.com"] }
        Action    = "SNS:Publish"
        Resource  = aws_sns_topic.beaver_alerts.arn
        Condition = {
          StringEquals = { "AWS:SourceAccount" = var.account_id }
        }
      }
    ]
  })
}

###############################################################################
# ECS CPU pressure — trips when a scaled-up cluster is still hot
###############################################################################

resource "aws_cloudwatch_metric_alarm" "beaver_ecs_cpu_high" {
  alarm_name          = "blueprintparser-ecs-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "ECS service CPU > 80% for 2 min. Autoscaler should have added tasks by now; if this fires, parser load is saturating even the expanded cluster."
  alarm_actions       = [aws_sns_topic.beaver_alerts.arn]
  ok_actions          = [aws_sns_topic.beaver_alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = aws_ecs_cluster.beaver.name
    ServiceName = aws_ecs_service.beaver_app.name
  }
}

###############################################################################
# Lambda CV fanout — trips on cost-abuse or accidental runaway
###############################################################################

resource "aws_cloudwatch_metric_alarm" "beaver_lambda_cv_high_invocations" {
  alarm_name          = "blueprintparser-lambda-cv-high-invocations"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Invocations"
  namespace           = "AWS/Lambda"
  period              = 3600
  statistic           = "Sum"
  threshold           = 1000
  alarm_description   = "Lambda CV invocations > 1000 in 1 hour. Legit demo traffic should not trigger this; if it fires, either someone's abusing the parsers or one user is uploading many large PDFs back-to-back."
  alarm_actions       = [aws_sns_topic.beaver_alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.beaver_cv_pipeline.function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "beaver_lambda_cv_throttles" {
  alarm_name          = "blueprintparser-lambda-cv-throttles"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Throttles"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "Lambda CV throttled > 10 times in 5 min. Reserved concurrency cap (200) is being hit — throttle pauses legit users; if this fires, bump the cap or throttle downstream."
  alarm_actions       = [aws_sns_topic.beaver_alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.beaver_cv_pipeline.function_name
  }
}

###############################################################################
# RDS — connection count pressure
###############################################################################

resource "aws_cloudwatch_metric_alarm" "beaver_rds_connections_high" {
  alarm_name          = "blueprintparser-rds-connections-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Average"
  threshold           = 90
  alarm_description   = "RDS connection count > 90 for 2 min. db.t4g.medium defaults to ~100 max; nearing exhaustion. Pool size trim is in place but sustained pressure means parser queue + RDS Proxy are overdue."
  alarm_actions       = [aws_sns_topic.beaver_alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.beaver.id
  }
}
