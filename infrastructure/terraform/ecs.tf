###############################################################################
# Beaver Infrastructure - ECS Fargate
###############################################################################

###############################################################################
# ECS Cluster
###############################################################################

resource "aws_ecs_cluster" "beaver" {
  name = "beaver-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "beaver" {
  cluster_name = aws_ecs_cluster.beaver.name

  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    base              = 1
    weight            = 100
    capacity_provider = "FARGATE"
  }
}

locals {
  # A digest is immutable even though historical deploys used the mutable
  # `latest` tag. Every PostgreSQL writer and the migrator share this identity.
  beaver_app_image               = "${aws_ecr_repository.beaver_app.repository_url}@${var.beaver_app_image_digest}"
  database_url_secret_value_from = "${aws_secretsmanager_secret.database_url.arn}:::${aws_secretsmanager_secret_version.database_url.version_id}"

  # P2/P5 safety freeze: there are exactly two admissible operational states.
  # Keeping each tuple explicit prevents a partial outage from leaving one
  # launcher live or an autoscaler able to repopulate a drained service.
  beaver_writer_outage_tuple           = var.ecs_desired_count == 0 && var.ecs_min_count == 0 && var.ecs_max_count == 1 && !var.ecs_autoscaling_enabled && !var.maintenance_worker_schedule_enabled
  beaver_writer_live_tuple             = var.ecs_desired_count == 1 && var.ecs_min_count == 1 && var.ecs_max_count == 1 && var.ecs_autoscaling_enabled && var.maintenance_worker_schedule_enabled
  beaver_writer_operational_tuple_valid = local.beaver_writer_outage_tuple || local.beaver_writer_live_tuple
}

resource "terraform_data" "beaver_writer_operational_tuple" {
  input = {
    desired_count                = var.ecs_desired_count
    min_count                    = var.ecs_min_count
    max_count                    = var.ecs_max_count
    autoscaling_enabled          = var.ecs_autoscaling_enabled
    maintenance_schedule_enabled = var.maintenance_worker_schedule_enabled
  }

  lifecycle {
    precondition {
      condition     = local.beaver_writer_operational_tuple_valid
      error_message = "Writer controls must be exactly live (desired/min/max 1, autoscaling and maintenance enabled) or outage (desired/min 0, max 1, autoscaling and maintenance disabled)."
    }
  }
}

# A remote replay boundary for cutover witnesses. This identifier rotates on
# every exact live <-> outage transition, but intentionally remains stable when
# an outage apply changes only the immutable application candidate digest.
resource "terraform_data" "beaver_writer_mode_epoch" {
  input            = local.beaver_writer_outage_tuple ? "outage" : "live"
  triggers_replace = [local.beaver_writer_outage_tuple ? "outage" : "live"]

  lifecycle {
    precondition {
      condition     = local.beaver_writer_operational_tuple_valid
      error_message = "A writer-mode epoch exists only for the exact live or outage tuple."
    }
  }
}

###############################################################################
# CloudWatch Log Group
###############################################################################

resource "aws_cloudwatch_log_group" "beaver_app" {
  name              = "/ecs/blueprintparser-app"
  retention_in_days = 30
}

###############################################################################
# Task Definition
###############################################################################

resource "aws_ecs_task_definition" "beaver_app" {
  family                   = "beaver-app"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 2048
  memory                   = 4096
  execution_role_arn       = aws_iam_role.beaver_ecs_execution_role.arn
  task_role_arn            = aws_iam_role.beaver_ecs_task_role.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "beaver-app"
      image     = local.beaver_app_image
      essential = true

      portMappings = [
        {
          containerPort = 3000
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = "3000" },
        { name = "S3_BUCKET", value = aws_s3_bucket.beaver_data.id },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "CLOUDFRONT_DOMAIN", value = "assets.${var.domain_name}" },
        { name = "CLOUDFRONT_DISTRIBUTION_ID", value = aws_cloudfront_distribution.beaver.id },
        { name = "NEXTAUTH_URL", value = "https://app.${var.domain_name}" },
        { name = "STEP_FUNCTION_ARN", value = aws_sfn_state_machine.beaver_process_blueprint.arn },
        { name = "LABEL_STUDIO_URL", value = "https://labelstudio.${var.domain_name}" },
        { name = "LABEL_STUDIO_INSTANCE_ID", value = "${aws_efs_file_system.label_studio.id}:${var.label_studio_instance_generation}" },
        { name = "AWS_ACCOUNT", value = data.aws_caller_identity.current.account_id },
        { name = "ROOT_ADMIN_EMAIL", value = var.root_admin_email },
        { name = "YOLO_ECR_IMAGE", value = "${aws_ecr_repository.beaver_yolo_pipeline.repository_url}@${var.beaver_yolo_image_digest}" },
        { name = "SAGEMAKER_ROLE_ARN", value = aws_iam_role.beaver_sagemaker_role.arn },
        { name = "LAMBDA_CV_ENABLED", value = "true" },
        { name = "LAMBDA_CV_FUNCTION_NAME", value = aws_lambda_function.beaver_cv_pipeline.function_name },
      ]

      secrets = [
        {
          name      = "DATABASE_URL"
          valueFrom = local.database_url_secret_value_from
        },
        {
          name      = "NEXTAUTH_SECRET"
          valueFrom = aws_secretsmanager_secret.nextauth_secret.arn
        },
        {
          name      = "PROCESSING_WEBHOOK_SECRET"
          valueFrom = aws_secretsmanager_secret.processing_webhook_secret.arn
        },
        {
          name      = "ANTHROPIC_API_KEY"
          valueFrom = aws_secretsmanager_secret.anthropic_api_key.arn
        },
        {
          name      = "GROQ_API_KEY"
          valueFrom = aws_secretsmanager_secret.groq_api_key.arn
        },
        {
          name      = "LABEL_STUDIO_API_KEY"
          valueFrom = aws_secretsmanager_secret.ls_api_key.arn
        },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.beaver_app.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "beaver"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "curl -f http://localhost:3000/api/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
    }
  ])
}

###############################################################################
# Singleton schema migrator — invoked only by scripts/p2-schema-cutover.sh
###############################################################################

resource "aws_cloudwatch_log_group" "beaver_schema_migrator" {
  name              = "/ecs/blueprintparser-schema-migrator"
  retention_in_days = 30
}

resource "aws_ecs_task_definition" "beaver_schema_migrator" {
  family                   = "beaver-schema-migrator"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.beaver_ecs_execution_role.arn
  task_role_arn            = aws_iam_role.beaver_schema_migrator_task_role.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "beaver-schema-migrator"
    image     = local.beaver_app_image
    essential = true
    command   = ["./entrypoint.sh", "migrate"]
    environment = [
      { name = "NODE_ENV", value = "production" },
    ]
    secrets = [{
      name      = "DATABASE_URL"
      valueFrom = local.database_url_secret_value_from
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.beaver_schema_migrator.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "schema-migrator"
      }
    }
  }])
}

###############################################################################
# ALB Security Group
###############################################################################

resource "aws_security_group" "beaver_alb" {
  name        = "beaver-alb-sg"
  description = "Security group for Beaver ALB"
  vpc_id      = aws_vpc.beaver.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "beaver-alb-sg"
  }
}

###############################################################################
# ECS Service Security Group
###############################################################################

resource "aws_security_group" "beaver_ecs" {
  name        = "beaver-ecs-sg"
  description = "Security group for Beaver ECS tasks"
  vpc_id      = aws_vpc.beaver.id

  ingress {
    description     = "From ALB"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.beaver_alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "beaver-ecs-sg"
  }
}

###############################################################################
# Application Load Balancer
###############################################################################

resource "aws_lb" "beaver" {
  name               = "beaver-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.beaver_alb.id]
  subnets            = aws_subnet.public[*].id
  idle_timeout       = 300

  # middleware trusts only the rightmost X-Forwarded-For hop, which is
  # authoritative precisely because the ALB appends the socket client address.
  # Keep ports disabled so that hop remains a canonical bare IP literal.
  xff_header_processing_mode = "append"
  enable_xff_client_port     = false

  enable_deletion_protection = true

  # Request targets can contain Label Studio's opaque asset bearer. The
  # dedicated destination is private, SSE-S3 encrypted, and expires after the
  # shortest S3 lifecycle interval while retaining a bounded diagnostic trail.
  access_logs {
    bucket  = aws_s3_bucket.beaver_alb_access_logs.id
    prefix  = "alb-logs"
    enabled = true
  }

  depends_on = [
    aws_s3_bucket_ownership_controls.beaver_alb_access_logs,
    aws_s3_bucket_server_side_encryption_configuration.beaver_alb_access_logs,
    aws_s3_bucket_public_access_block.beaver_alb_access_logs,
    aws_s3_bucket_lifecycle_configuration.beaver_alb_access_logs,
    aws_s3_bucket_policy.beaver_alb_access_logs,
  ]

  tags = {
    Name = "beaver-alb"
  }
}

resource "aws_lb_target_group" "beaver_app" {
  name        = "beaver-app-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.beaver.id
  target_type = "ip"

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    path                = "/api/health"
    matcher             = "200"
  }

  deregistration_delay = 30
}

resource "aws_lb_listener" "beaver_http" {
  load_balancer_arn = aws_lb.beaver.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "beaver_https" {
  load_balancer_arn = aws_lb.beaver.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.beaver_app.arn
  }
}

###############################################################################
# ECS Service
###############################################################################

resource "aws_ecs_service" "beaver_app" {
  name                   = "beaver-app"
  cluster                = aws_ecs_cluster.beaver.id
  task_definition        = aws_ecs_task_definition.beaver_app.arn
  desired_count          = var.ecs_desired_count
  launch_type            = "FARGATE"
  platform_version       = "1.4.0"
  enable_execute_command = true

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.beaver_ecs.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.beaver_app.arn
    container_name   = "beaver-app"
    container_port   = 3000
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100

  tags = {
    BlueprintParserWriterMode      = local.beaver_writer_outage_tuple ? "outage" : "live"
    BlueprintParserWriterModeEpoch = sha256(terraform_data.beaver_writer_mode_epoch.id)
  }

  depends_on = [
    aws_lb_listener.beaver_https,
    terraform_data.beaver_writer_operational_tuple,
    terraform_data.beaver_writer_mode_epoch,
  ]

  # Terraform registers one digest-pinned definition for every process role, but
  # it must never bind a new app revision as a side effect of `terraform apply`.
  # deploy.sh performs a remote schema equality check before ordinary activation;
  # p2-schema-cutover.sh binds the compatibility-boundary revision only at desired
  # count zero. This ignore is therefore a safety boundary, not drift tolerance.
  lifecycle {
    ignore_changes = [task_definition]
  }
}

###############################################################################
# Auto Scaling
###############################################################################

resource "aws_appautoscaling_target" "beaver_ecs" {
  max_capacity       = var.ecs_max_count
  min_capacity       = var.ecs_min_count
  resource_id        = "service/${aws_ecs_cluster.beaver.name}/${aws_ecs_service.beaver_app.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"

  depends_on = [terraform_data.beaver_writer_operational_tuple]

  suspended_state {
    dynamic_scaling_in_suspended  = !var.ecs_autoscaling_enabled
    dynamic_scaling_out_suspended = !var.ecs_autoscaling_enabled
    scheduled_scaling_suspended   = !var.ecs_autoscaling_enabled
  }
}

resource "aws_appautoscaling_policy" "beaver_cpu" {
  name               = "beaver-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.beaver_ecs.resource_id
  scalable_dimension = aws_appautoscaling_target.beaver_ecs.scalable_dimension
  service_namespace  = aws_appautoscaling_target.beaver_ecs.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 70.0
    scale_in_cooldown  = 300
    scale_out_cooldown = 20
  }
}

resource "aws_appautoscaling_policy" "beaver_memory" {
  name               = "beaver-memory-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.beaver_ecs.resource_id
  scalable_dimension = aws_appautoscaling_target.beaver_ecs.scalable_dimension
  service_namespace  = aws_appautoscaling_target.beaver_ecs.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageMemoryUtilization"
    }
    target_value       = 80.0
    scale_in_cooldown  = 300
    scale_out_cooldown = 20
  }
}

###############################################################################
# CPU Pipeline - CloudWatch Log Group
###############################################################################

resource "aws_cloudwatch_log_group" "beaver_cpu_pipeline" {
  name              = "/ecs/blueprintparser-cpu-pipeline"
  retention_in_days = 30
}

###############################################################################
# CPU Pipeline - Task Definition
###############################################################################

resource "aws_ecs_task_definition" "beaver_cpu_pipeline" {
  family                   = "beaver-cpu-pipeline"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 8192
  memory                   = 16384
  execution_role_arn       = aws_iam_role.beaver_ecs_execution_role.arn
  task_role_arn            = aws_iam_role.beaver_ecs_task_role.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "beaver-cpu-pipeline"
      image     = local.beaver_app_image
      essential = true
      command   = ["./entrypoint.sh", "worker", "node", "scripts/process-worker.js"]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "S3_BUCKET", value = aws_s3_bucket.beaver_data.id },
        { name = "CLOUDFRONT_DOMAIN", value = "assets.${var.domain_name}" },
      ]

      secrets = [
        {
          name      = "DATABASE_URL"
          valueFrom = local.database_url_secret_value_from
        },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.beaver_cpu_pipeline.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "cpu-pipeline"
        }
      }
    }
  ])
}

###############################################################################
# Label Studio - Security Group (must be defined before EFS SG that refs it)
###############################################################################

resource "aws_security_group" "beaver_label_studio" {
  name        = "beaver-label-studio-sg"
  description = "Security group for Label Studio ECS tasks"
  vpc_id      = aws_vpc.beaver.id

  ingress {
    description     = "From ALB"
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.beaver_alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "beaver-label-studio-sg"
  }
}

###############################################################################
# Label Studio - EFS Persistent Storage
###############################################################################

resource "aws_efs_file_system" "label_studio" {
  creation_token = "beaver-label-studio"
  encrypted      = true

  tags = {
    Name = "beaver-label-studio-efs"
  }
}

resource "aws_security_group" "beaver_efs" {
  name        = "beaver-efs-sg"
  description = "Security group for Label Studio EFS mount targets"
  vpc_id      = aws_vpc.beaver.id

  ingress {
    description     = "NFS from Label Studio ECS tasks"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.beaver_label_studio.id]
  }

  tags = {
    Name = "beaver-efs-sg"
  }
}

resource "aws_efs_mount_target" "label_studio" {
  count           = 2
  file_system_id  = aws_efs_file_system.label_studio.id
  subnet_id       = aws_subnet.private[count.index].id
  security_groups = [aws_security_group.beaver_efs.id]
}

resource "aws_efs_access_point" "label_studio" {
  file_system_id = aws_efs_file_system.label_studio.id

  posix_user {
    uid = 1001
    gid = 0
  }

  root_directory {
    path = "/label-studio"

    creation_info {
      owner_uid   = 1001
      owner_gid   = 0
      permissions = "700"
    }
  }

  tags = {
    Name = "beaver-label-studio-ap"
  }
}

###############################################################################
# Label Studio - CloudWatch Log Group
###############################################################################

resource "aws_cloudwatch_log_group" "beaver_label_studio" {
  name              = "/ecs/blueprintparser-label-studio"
  retention_in_days = 30
}

###############################################################################
# Label Studio - Task Definition
###############################################################################

resource "aws_ecs_task_definition" "beaver_label_studio" {
  family                   = "beaver-label-studio"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.beaver_ecs_execution_role.arn

  volume {
    name = "label-studio-data"

    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.label_studio.id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.label_studio.id
        iam             = "DISABLED"
      }
    }
  }

  container_definitions = jsonencode([
    {
      name      = "label-studio"
      image     = var.label_studio_image
      essential = true

      portMappings = [
        {
          containerPort = 8080
          protocol      = "tcp"
        }
      ]

      mountPoints = [
        {
          sourceVolume  = "label-studio-data"
          containerPath = "/label-studio/data"
        }
      ]

      environment = [
        { name = "LABEL_STUDIO_DISABLE_SIGNUP_WITHOUT_LINK", value = "true" },
        { name = "LABEL_STUDIO_ENABLE_LEGACY_API_TOKEN", value = "true" },
        { name = "LABEL_STUDIO_HOST", value = "https://labelstudio.${var.domain_name}" },
        { name = "CSRF_TRUSTED_ORIGINS", value = "https://labelstudio.${var.domain_name},https://app.${var.domain_name}" },
        { name = "USE_X_FORWARDED_HOST", value = "True" },
        { name = "SECURE_PROXY_SSL_HEADER", value = "HTTP_X_FORWARDED_PROTO,https" },
        { name = "SESSION_COOKIE_SECURE", value = "1" },
        { name = "CSRF_COOKIE_SECURE", value = "1" },
      ]

      secrets = [
        {
          name      = "LABEL_STUDIO_USERNAME"
          valueFrom = aws_secretsmanager_secret.ls_admin_email.arn
        },
        {
          name      = "LABEL_STUDIO_PASSWORD"
          valueFrom = aws_secretsmanager_secret.ls_admin_password.arn
        },
        {
          name      = "LABEL_STUDIO_USER_TOKEN"
          valueFrom = aws_secretsmanager_secret.ls_api_key.arn
        },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.beaver_label_studio.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "label-studio"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "python3 -c \"import urllib.request; urllib.request.urlopen('http://localhost:8080/health')\" || exit 1"]
        interval    = 30
        timeout     = 10
        retries     = 5
        startPeriod = 120
      }
    }
  ])
}

###############################################################################
# Label Studio - Target Group + Listener Rule
###############################################################################

resource "aws_lb_target_group" "beaver_label_studio" {
  name        = "beaver-ls-tg"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = aws_vpc.beaver.id
  target_type = "ip"

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 5
    timeout             = 10
    interval            = 30
    path                = "/health"
    matcher             = "200"
  }

  deregistration_delay = 30
}

resource "aws_lb_listener_rule" "label_studio" {
  listener_arn = aws_lb_listener.beaver_https.arn
  priority     = 10

  condition {
    host_header {
      values = ["labelstudio.${var.domain_name}"]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.beaver_label_studio.arn
  }
}

###############################################################################
# Label Studio - ECS Service
###############################################################################

resource "aws_ecs_service" "beaver_label_studio" {
  name             = "beaver-label-studio"
  cluster          = aws_ecs_cluster.beaver.id
  task_definition  = aws_ecs_task_definition.beaver_label_studio.arn
  desired_count    = 0
  launch_type      = "FARGATE"
  platform_version = "1.4.0" # Required for EFS support

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.beaver_label_studio.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.beaver_label_studio.arn
    container_name   = "label-studio"
    container_port   = 8080
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener_rule.label_studio, aws_efs_mount_target.label_studio]
}
