###############################################################################
# Beaver Infrastructure - IAM Roles & Policies
###############################################################################

###############################################################################
# ECS Execution Role (pulls images, writes logs, reads secrets)
###############################################################################

resource "aws_iam_role" "beaver_ecs_execution_role" {
  name = "beaver-ecs-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "beaver_ecs_execution_base" {
  role       = aws_iam_role.beaver_ecs_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "beaver_ecs_execution_secrets" {
  name = "beaver-ecs-secrets-access"
  role = aws_iam_role.beaver_ecs_execution_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = [
          aws_secretsmanager_secret.database_url.arn,
          aws_secretsmanager_secret.nextauth_secret.arn,
          aws_secretsmanager_secret.processing_webhook_secret.arn,
          aws_secretsmanager_secret.anthropic_api_key.arn,
          aws_secretsmanager_secret.groq_api_key.arn,
          aws_secretsmanager_secret.ls_admin_email.arn,
          aws_secretsmanager_secret.ls_admin_password.arn,
          aws_secretsmanager_secret.ls_api_key.arn,
        ]
      }
    ]
  })
}

###############################################################################
# ECS Task Role (app runtime permissions)
###############################################################################

resource "aws_iam_role" "beaver_ecs_task_role" {
  name = "beaver-ecs-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "beaver_ecs_task_s3" {
  name = "beaver-ecs-task-s3"
  role = aws_iam_role.beaver_ecs_task_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.beaver_data.arn,
          "${aws_s3_bucket.beaver_data.arn}/*"
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy" "beaver_ecs_task_stepfunctions" {
  name = "beaver-ecs-task-stepfunctions"
  role = aws_iam_role.beaver_ecs_task_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "states:StartExecution"
        ]
        Resource = [
          aws_sfn_state_machine.beaver_process_blueprint.arn
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy" "beaver_ecs_task_ssm" {
  name = "beaver-ecs-task-ssm"
  role = aws_iam_role.beaver_ecs_task_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_role_policy" "beaver_ecs_task_textract" {
  name = "beaver-ecs-task-textract"
  role = aws_iam_role.beaver_ecs_task_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "textract:AnalyzeDocument",
          "textract:DetectDocumentText"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_role_policy" "beaver_ecs_task_sagemaker" {
  name = "beaver-ecs-task-sagemaker"
  role = aws_iam_role.beaver_ecs_task_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sagemaker:CreateProcessingJob",
          "sagemaker:DescribeProcessingJob",
          "sagemaker:StopProcessingJob"
        ]
        Resource = "arn:aws:sagemaker:${var.aws_region}:${data.aws_caller_identity.current.account_id}:processing-job/*"
      },
      {
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = aws_iam_role.beaver_sagemaker_role.arn
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "sagemaker.amazonaws.com"
          }
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "beaver_ecs_task_lambda" {
  name = "beaver-ecs-task-lambda-invoke"
  role = aws_iam_role.beaver_ecs_task_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = aws_lambda_function.beaver_cv_pipeline.arn
      }
    ]
  })
}

###############################################################################
# SageMaker Role
###############################################################################

resource "aws_iam_role" "beaver_sagemaker_role" {
  name = "beaver-sagemaker-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "sagemaker.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "beaver_sagemaker_full" {
  role       = aws_iam_role.beaver_sagemaker_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSageMakerFullAccess"
}

resource "aws_iam_role_policy" "beaver_sagemaker_s3" {
  name = "beaver-sagemaker-s3"
  role = aws_iam_role.beaver_sagemaker_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.beaver_data.arn,
          "${aws_s3_bucket.beaver_data.arn}/*"
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy" "beaver_sagemaker_ecr" {
  name = "beaver-sagemaker-ecr"
  role = aws_iam_role.beaver_sagemaker_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:GetAuthorizationToken"
        ]
        Resource = "*"
      }
    ]
  })
}

###############################################################################
# Step Functions Role
###############################################################################

resource "aws_iam_role" "beaver_step_functions_role" {
  name = "beaver-step-functions-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "states.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "beaver_sfn_ecs" {
  name = "beaver-sfn-ecs"
  role = aws_iam_role.beaver_step_functions_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecs:RunTask",
          "ecs:StopTask",
          "ecs:DescribeTasks"
        ]
        Resource = "*"
        Condition = {
          ArnEquals = {
            "ecs:cluster" = aws_ecs_cluster.beaver.arn
          }
        }
      },
      {
        Effect = "Allow"
        Action = [
          "iam:PassRole"
        ]
        Resource = [
          aws_iam_role.beaver_ecs_execution_role.arn,
          aws_iam_role.beaver_ecs_task_role.arn,
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "events:PutTargets",
          "events:PutRule",
          "events:DescribeRule"
        ]
        Resource = "arn:aws:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:rule/StepFunctions*"
      }
    ]
  })
}

resource "aws_iam_role_policy" "beaver_sfn_sagemaker" {
  name = "beaver-sfn-sagemaker"
  role = aws_iam_role.beaver_step_functions_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sagemaker:CreateProcessingJob",
          "sagemaker:DescribeProcessingJob",
          "sagemaker:StopProcessingJob",
          "sagemaker:CreateTransformJob",
          "sagemaker:DescribeTransformJob"
        ]
        Resource = "arn:aws:sagemaker:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*"
      },
      {
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = aws_iam_role.beaver_sagemaker_role.arn
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "sagemaker.amazonaws.com"
          }
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "beaver_sfn_s3" {
  name = "beaver-sfn-s3"
  role = aws_iam_role.beaver_step_functions_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject"
        ]
        Resource = [
          "${aws_s3_bucket.beaver_data.arn}/*"
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy" "beaver_sfn_logs" {
  name = "beaver-sfn-logs"
  role = aws_iam_role.beaver_step_functions_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogDelivery",
          "logs:GetLogDelivery",
          "logs:UpdateLogDelivery",
          "logs:DeleteLogDelivery",
          "logs:ListLogDeliveries",
          "logs:PutResourcePolicy",
          "logs:DescribeResourcePolicies",
          "logs:DescribeLogGroups"
        ]
        Resource = "*"
      }
    ]
  })
}
