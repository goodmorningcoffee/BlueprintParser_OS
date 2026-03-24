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
