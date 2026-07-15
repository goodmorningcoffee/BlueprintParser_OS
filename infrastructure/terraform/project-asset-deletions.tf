###############################################################################
# Durable project asset-deletion reconciler
###############################################################################

resource "aws_cloudwatch_log_group" "beaver_project_asset_deletions" {
  name              = "/ecs/blueprintparser-project-asset-deletions"
  retention_in_days = 30
}

resource "aws_iam_role" "beaver_project_asset_deletion_task" {
  name = "beaver-project-asset-deletion-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "beaver_project_asset_deletion_task" {
  name = "beaver-project-asset-deletion"
  role = aws_iam_role.beaver_project_asset_deletion_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListProjectObjectVersions"
        Effect   = "Allow"
        Action   = ["s3:ListBucketVersions"]
        Resource = aws_s3_bucket.beaver_data.arn
      },
      {
        Sid      = "DeleteProjectObjectVersions"
        Effect   = "Allow"
        Action   = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
        Resource = "${aws_s3_bucket.beaver_data.arn}/*"
      },
      {
        Sid      = "InvalidateDeletedProjectAssets"
        Effect   = "Allow"
        Action   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
        Resource = aws_cloudfront_distribution.beaver.arn
      },
      {
        Sid    = "ConsumeLateProjectObjectEvents"
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = aws_sqs_queue.beaver_project_asset_events.arn
      }
    ]
  })
}

# The web task performs the first post-commit attempt; the scheduled task owns retries.
resource "aws_iam_role_policy" "beaver_ecs_task_cloudfront_invalidation" {
  name = "beaver-ecs-task-cloudfront-invalidation"
  role = aws_iam_role.beaver_ecs_task_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
      Resource = aws_cloudfront_distribution.beaver.arn
    }]
  })
}

resource "aws_ecs_task_definition" "beaver_project_asset_deletions" {
  family                   = "beaver-project-asset-deletions"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.beaver_ecs_execution_role.arn
  task_role_arn            = aws_iam_role.beaver_project_asset_deletion_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "beaver-project-asset-deletions"
    image     = local.beaver_app_image
    essential = true
    command   = ["./entrypoint.sh", "worker", "node", "scripts/project-asset-deletion-worker.js"]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "S3_BUCKET", value = aws_s3_bucket.beaver_data.id },
      { name = "CLOUDFRONT_DOMAIN", value = "assets.${var.domain_name}" },
      { name = "CLOUDFRONT_DISTRIBUTION_ID", value = aws_cloudfront_distribution.beaver.id },
      { name = "LABEL_STUDIO_URL", value = "https://labelstudio.${var.domain_name}" },
      { name = "LABEL_STUDIO_INSTANCE_ID", value = "${aws_efs_file_system.label_studio.id}:${var.label_studio_instance_generation}" },
      { name = "PROJECT_ASSET_EVENT_QUEUE_URL", value = aws_sqs_queue.beaver_project_asset_events.url }
    ]
    secrets = [
      {
        name      = "DATABASE_URL"
        valueFrom = local.database_url_secret_value_from
      },
      {
        name      = "LABEL_STUDIO_API_KEY"
        valueFrom = aws_secretsmanager_secret.ls_api_key.arn
      }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.beaver_project_asset_deletions.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "project-asset-deletions"
      }
    }
  }])
}

resource "aws_sqs_queue" "beaver_project_asset_deletion_scheduler_dlq" {
  name                      = "beaver-project-asset-deletion-scheduler-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "beaver_project_asset_event_delivery_dlq" {
  name                      = "beaver-project-asset-event-delivery-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "beaver_project_asset_event_dlq" {
  name                      = "beaver-project-asset-event-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "beaver_project_asset_events" {
  name                       = "beaver-project-asset-events"
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = 300
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.beaver_project_asset_event_dlq.arn
    maxReceiveCount     = 5
  })
}

# EventBridge delivery is enabled before terminalizing seven-day watches. A final or staging write
# may arrive after an erasure pass; its durable event reopens the permanent tombstone.
resource "aws_s3_bucket_notification" "beaver_data_eventbridge" {
  bucket      = aws_s3_bucket.beaver_data.id
  eventbridge = true

  # This resource owns the bucket's complete notification subresource. The
  # false-by-default acknowledgement prevents an ordinary/default apply from
  # replacing unmanaged Lambda/SQS/SNS notifications before owner inventory.
  lifecycle {
    precondition {
      condition     = var.acknowledge_beaver_data_notification_takeover
      error_message = "Inventory the complete beaver data-bucket notification configuration, reconcile every unmanaged notification, then explicitly set acknowledge_beaver_data_notification_takeover=true."
    }
  }

  # Enable EventBridge only after its durable target and both delivery policies
  # are authorized; the acknowledgement alone cannot bypass this graph fence.
  depends_on = [
    aws_cloudwatch_event_target.beaver_project_staging_object_created,
    aws_sqs_queue_policy.beaver_project_asset_events,
    aws_sqs_queue_policy.beaver_project_asset_event_delivery_dlq
  ]
}

resource "aws_cloudwatch_event_rule" "beaver_project_staging_object_created" {
  # Keep the legacy Terraform address and AWS rule name to avoid a destructive rollout rename.
  # The rule is intentionally bucket-wide: the worker fail-closes on canonical final/staging roots,
  # while this broad delivery prevents a terminal tombstone from going blind to a late final write.
  name = "beaver-project-staging-object-created"
  event_pattern = jsonencode({
    source      = ["aws.s3"]
    detail-type = ["Object Created"]
    detail = {
      bucket = { name = [aws_s3_bucket.beaver_data.id] }
    }
  })
}

resource "aws_cloudwatch_event_target" "beaver_project_staging_object_created" {
  rule = aws_cloudwatch_event_rule.beaver_project_staging_object_created.name
  arn  = aws_sqs_queue.beaver_project_asset_events.arn

  dead_letter_config {
    arn = aws_sqs_queue.beaver_project_asset_event_delivery_dlq.arn
  }

  retry_policy {
    maximum_event_age_in_seconds = 86400
    maximum_retry_attempts       = 185
  }

  depends_on = [
    aws_sqs_queue_policy.beaver_project_asset_events,
    aws_sqs_queue_policy.beaver_project_asset_event_delivery_dlq
  ]
}

resource "aws_sqs_queue_policy" "beaver_project_asset_events" {
  queue_url = aws_sqs_queue.beaver_project_asset_events.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.beaver_project_asset_events.arn
      Condition = {
        StringEquals = {
          "aws:SourceAccount" = data.aws_caller_identity.current.account_id
        }
        ArnEquals = {
          "aws:SourceArn" = aws_cloudwatch_event_rule.beaver_project_staging_object_created.arn
        }
      }
    }]
  })
}

resource "aws_sqs_queue_policy" "beaver_project_asset_event_delivery_dlq" {
  queue_url = aws_sqs_queue.beaver_project_asset_event_delivery_dlq.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.beaver_project_asset_event_delivery_dlq.arn
      Condition = {
        StringEquals = {
          "aws:SourceAccount" = data.aws_caller_identity.current.account_id
        }
        ArnEquals = {
          "aws:SourceArn" = aws_cloudwatch_event_rule.beaver_project_staging_object_created.arn
        }
      }
    }]
  })
}

resource "aws_scheduler_schedule_group" "beaver_maintenance" {
  name = "beaver-maintenance"
}

resource "aws_iam_role" "beaver_project_asset_deletion_scheduler" {
  name = "beaver-project-asset-deletion-scheduler-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
        ArnLike = {
          "aws:SourceArn" = "arn:aws:scheduler:${var.aws_region}:${data.aws_caller_identity.current.account_id}:schedule/${aws_scheduler_schedule_group.beaver_maintenance.name}/*"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "beaver_project_asset_deletion_scheduler" {
  name = "beaver-project-asset-deletion-scheduler"
  role = aws_iam_role.beaver_project_asset_deletion_scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "ecs:RunTask"
        Resource = aws_ecs_task_definition.beaver_project_asset_deletions.arn
        Condition = {
          ArnEquals = { "ecs:cluster" = aws_ecs_cluster.beaver.arn }
        }
      },
      {
        Effect = "Allow"
        Action = "iam:PassRole"
        Resource = [
          aws_iam_role.beaver_ecs_execution_role.arn,
          aws_iam_role.beaver_project_asset_deletion_task.arn
        ]
        Condition = {
          StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" }
        }
      },
      {
        Effect   = "Allow"
        Action   = "sqs:SendMessage"
        Resource = aws_sqs_queue.beaver_project_asset_deletion_scheduler_dlq.arn
      }
    ]
  })
}

resource "aws_scheduler_schedule" "beaver_project_asset_deletions" {
  name       = "beaver-project-asset-deletions"
  group_name = aws_scheduler_schedule_group.beaver_maintenance.name
  state      = var.maintenance_worker_schedule_enabled ? "ENABLED" : "DISABLED"

  # The queue URL enables terminal seven-day watches in application code. Do not let the first
  # scheduled worker observe that configuration until S3 can durably deliver every late upload.
  depends_on = [
    aws_s3_bucket_notification.beaver_data_eventbridge,
    terraform_data.beaver_writer_operational_tuple,
  ]

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression = "rate(5 minutes)"

  target {
    arn      = aws_ecs_cluster.beaver.arn
    role_arn = aws_iam_role.beaver_project_asset_deletion_scheduler.arn

    dead_letter_config {
      arn = aws_sqs_queue.beaver_project_asset_deletion_scheduler_dlq.arn
    }

    retry_policy {
      maximum_event_age_in_seconds = 600
      maximum_retry_attempts       = 2
    }

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.beaver_project_asset_deletions.arn
      launch_type         = "FARGATE"
      platform_version    = "1.4.0"
      task_count          = 1

      network_configuration {
        assign_public_ip = false
        security_groups  = [aws_security_group.beaver_ecs.id]
        subnets          = aws_subnet.private[*].id
      }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "beaver_project_asset_deletion_scheduler_dlq" {
  alarm_name          = "blueprintparser-project-asset-deletion-scheduler-dlq"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "The scheduled project asset-deletion ECS task could not be invoked. The database outbox remains durable, but cleanup is delayed."
  alarm_actions       = [aws_sns_topic.beaver_alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.beaver_project_asset_deletion_scheduler_dlq.name
  }
}

resource "aws_cloudwatch_log_metric_filter" "beaver_project_asset_deletion_failures" {
  name           = "blueprintparser-project-asset-deletion-failures"
  log_group_name = aws_cloudwatch_log_group.beaver_project_asset_deletions.name
  pattern        = "\"reconciliation attempt failed\""

  metric_transformation {
    name      = "ProjectAssetDeletionFailures"
    namespace = "BlueprintParser/Security"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "beaver_project_asset_event_dlq" {
  alarm_name          = "blueprintparser-project-asset-event-dlq"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "A late project-object event could not wake its permanent deletion tombstone after five deliveries."
  alarm_actions       = [aws_sns_topic.beaver_alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.beaver_project_asset_event_dlq.name
  }
}

resource "aws_cloudwatch_metric_alarm" "beaver_project_asset_event_delivery_dlq" {
  alarm_name          = "blueprintparser-project-asset-event-delivery-dlq"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "EventBridge exhausted delivery retries before a late project-object event reached the durable worker queue."
  alarm_actions       = [aws_sns_topic.beaver_alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.beaver_project_asset_event_delivery_dlq.name
  }
}

resource "aws_cloudwatch_metric_alarm" "beaver_project_asset_event_delivery_failures" {
  alarm_name          = "blueprintparser-project-asset-event-delivery-failures"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "FailedInvocations"
  namespace           = "AWS/Events"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "EventBridge permanently failed to deliver a late project-object event."
  alarm_actions       = [aws_sns_topic.beaver_alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    RuleName = aws_cloudwatch_event_rule.beaver_project_staging_object_created.name
  }
}

resource "aws_cloudwatch_metric_alarm" "beaver_project_asset_event_delivery_dlq_failures" {
  alarm_name          = "blueprintparser-project-asset-event-delivery-dlq-failures"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "InvocationsFailedToBeSentToDlq"
  namespace           = "AWS/Events"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "EventBridge could not write a failed late project-object event to its delivery DLQ."
  alarm_actions       = [aws_sns_topic.beaver_alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    RuleName = aws_cloudwatch_event_rule.beaver_project_staging_object_created.name
  }
}

resource "aws_cloudwatch_metric_alarm" "beaver_project_asset_event_age" {
  alarm_name          = "blueprintparser-project-asset-event-age"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ApproximateAgeOfOldestMessage"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 600
  alarm_description   = "Late project-object events have waited over ten minutes without waking their permanent deletion tombstones."
  alarm_actions       = [aws_sns_topic.beaver_alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.beaver_project_asset_events.name
  }
}

resource "aws_cloudwatch_log_metric_filter" "beaver_project_asset_worker_fatal" {
  name           = "blueprintparser-project-asset-worker-fatal"
  log_group_name = aws_cloudwatch_log_group.beaver_project_asset_deletions.name
  pattern        = "\"project-asset-deletion-worker] fatal\""

  metric_transformation {
    name      = "ProjectAssetDeletionFailures"
    namespace = "BlueprintParser/Security"
    value     = "1"
  }
}

resource "aws_cloudwatch_log_metric_filter" "beaver_project_asset_worker_heartbeat" {
  name           = "blueprintparser-project-asset-worker-heartbeat"
  log_group_name = aws_cloudwatch_log_group.beaver_project_asset_deletions.name
  pattern        = "\"project-asset-deletion-worker] complete\""

  metric_transformation {
    name      = "ProjectAssetDeletionWorkerHeartbeats"
    namespace = "BlueprintParser/Security"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "beaver_project_asset_deletion_failures" {
  alarm_name          = "blueprintparser-project-asset-deletion-failures"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ProjectAssetDeletionFailures"
  namespace           = "BlueprintParser/Security"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "A durable project asset-deletion reconciliation attempt failed and will be retried from the database outbox."
  alarm_actions       = [aws_sns_topic.beaver_alerts.arn]
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "beaver_project_asset_worker_heartbeat" {
  alarm_name          = "blueprintparser-project-asset-worker-heartbeat-missing"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = "ProjectAssetDeletionWorkerHeartbeats"
  namespace           = "BlueprintParser/Security"
  period              = 900
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "The scheduled deletion worker has not logged a completed run for at least two consecutive fifteen-minute periods."
  alarm_actions       = [aws_sns_topic.beaver_alerts.arn]
  treat_missing_data  = "breaching"
}

resource "aws_cloudwatch_event_rule" "beaver_project_asset_worker_nonzero_exit" {
  name = "beaver-project-asset-worker-nonzero-exit"
  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["ECS Task State Change"]
    detail = {
      clusterArn = [aws_ecs_cluster.beaver.arn]
      group      = ["family:${aws_ecs_task_definition.beaver_project_asset_deletions.family}"]
      lastStatus = ["STOPPED"]
      containers = {
        name     = ["beaver-project-asset-deletions"]
        exitCode = [{ "anything-but" = 0 }]
      }
    }
  })
}

resource "aws_cloudwatch_event_rule" "beaver_project_asset_worker_failed_to_start" {
  name = "beaver-project-asset-worker-failed-to-start"
  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["ECS Task State Change"]
    detail = {
      clusterArn = [aws_ecs_cluster.beaver.arn]
      group      = ["family:${aws_ecs_task_definition.beaver_project_asset_deletions.family}"]
      lastStatus = ["STOPPED"]
      stopCode   = ["TaskFailedToStart"]
    }
  })
}

resource "aws_cloudwatch_event_target" "beaver_project_asset_worker_nonzero_exit" {
  rule      = aws_cloudwatch_event_rule.beaver_project_asset_worker_nonzero_exit.name
  arn       = aws_sns_topic.beaver_alerts.arn
  target_id = "project-asset-worker-nonzero-exit"

  depends_on = [aws_sns_topic_policy.beaver_alerts]
}

resource "aws_cloudwatch_event_target" "beaver_project_asset_worker_failed_to_start" {
  rule      = aws_cloudwatch_event_rule.beaver_project_asset_worker_failed_to_start.name
  arn       = aws_sns_topic.beaver_alerts.arn
  target_id = "project-asset-worker-failed-to-start"

  depends_on = [aws_sns_topic_policy.beaver_alerts]
}
