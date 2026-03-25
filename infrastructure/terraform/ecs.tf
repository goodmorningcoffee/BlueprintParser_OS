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

###############################################################################
# CloudWatch Log Group
###############################################################################

resource "aws_cloudwatch_log_group" "beaver_app" {
  name              = "/ecs/beaver-app"
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

  container_definitions = jsonencode([
    {
      name      = "beaver-app"
      image     = "${aws_ecr_repository.beaver_app.repository_url}:latest"
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
        { name = "CLOUDFRONT_DOMAIN", value = "assets.blueprintparser.com" },
        { name = "NEXTAUTH_URL", value = "https://app.blueprintparser.com" },
        { name = "STEP_FUNCTION_ARN", value = aws_sfn_state_machine.beaver_process_blueprint.arn },
        { name = "LABEL_STUDIO_URL", value = "https://labelstudio.blueprintparser.com" },
      ]

      secrets = [
        {
          name      = "DATABASE_URL"
          valueFrom = aws_secretsmanager_secret.database_url.arn
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

  enable_deletion_protection = true

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
  name            = "beaver-app"
  cluster         = aws_ecs_cluster.beaver.id
  task_definition = aws_ecs_task_definition.beaver_app.arn
  desired_count   = var.ecs_desired_count
  launch_type     = "FARGATE"

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

  depends_on = [aws_lb_listener.beaver_https]
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
    scale_out_cooldown = 60
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
    scale_out_cooldown = 60
  }
}

###############################################################################
# CPU Pipeline - CloudWatch Log Group
###############################################################################

resource "aws_cloudwatch_log_group" "beaver_cpu_pipeline" {
  name              = "/ecs/beaver-cpu-pipeline"
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

  container_definitions = jsonencode([
    {
      name      = "beaver-cpu-pipeline"
      image     = "${aws_ecr_repository.beaver_app.repository_url}:latest"
      essential = true
      command   = ["node", "scripts/process-worker.js"]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "S3_BUCKET", value = aws_s3_bucket.beaver_data.id },
        { name = "CLOUDFRONT_DOMAIN", value = "assets.blueprintparser.com" },
      ]

      secrets = [
        {
          name      = "DATABASE_URL"
          valueFrom = aws_secretsmanager_secret.database_url.arn
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

###############################################################################
# Label Studio - CloudWatch Log Group
###############################################################################

resource "aws_cloudwatch_log_group" "beaver_label_studio" {
  name              = "/ecs/beaver-label-studio"
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
      file_system_id = aws_efs_file_system.label_studio.id
    }
  }

  container_definitions = jsonencode([
    {
      name      = "label-studio"
      image     = "heartexlabs/label-studio:latest"
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
        command     = ["CMD-SHELL", "curl -f http://localhost:8080/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 90
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
    unhealthy_threshold = 3
    timeout             = 5
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
      values = ["labelstudio.blueprintparser.com"]
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
  desired_count    = 1
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
