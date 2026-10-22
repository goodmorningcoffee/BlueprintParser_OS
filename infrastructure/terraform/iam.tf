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

# The migrator receives DATABASE_URL through the ECS execution role and reaches
# RDS through the VPC. It does not need application AWS API permissions. Keep a
# dedicated, deliberately policy-free role so task-definition admission can
# distinguish it from the broad web/worker runtime role.
resource "aws_iam_role" "beaver_schema_migrator_task_role" {
  name = "beaver-schema-migrator-task-role"

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
          "s3:GetObjectVersion",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:DeleteObjectVersion",
          "s3:ListBucket",
          "s3:ListBucketVersions"
        ]
        Resource = [
          aws_s3_bucket.beaver_data.arn,
          "${aws_s3_bucket.beaver_data.arn}/*"
        ]
      },
      {
        # WEIGHTS-2 backstop: the web tier never READS weights — it only writes
        # models/<slug>/{config.yaml,classes.txt} (PutObject, not denied); only
        # beaver-sagemaker-role reads model.pt to RUN. A presigned GET is signed
        # by THIS role, so the CloudFront-principal bucket Deny does not cover it;
        # this holds the invariant at the IAM layer even if the app is ever
        # compromised or a future endpoint regresses. (weights-leak audit 1 + 5.)
        Sid    = "DenyWebTierReadingModelWeights"
        Effect = "Deny"
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion"
        ]
        Resource = "${aws_s3_bucket.beaver_data.arn}/models/*"
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
      },
      {
        # [refactor jun13 P0.5-G8] project deletion stops the project's
        # running execution (project-delete.ts StopExecutionCommand). Without
        # this the call was AccessDenied since launch — swallowed by its
        # catch-warn, so deleted projects kept processing and burning compute.
        # Execution ARNs use :execution: in place of :stateMachine:.
        Effect = "Allow"
        Action = [
          "states:StopExecution",
          "states:DescribeExecution"
        ]
        Resource = [
          "${replace(aws_sfn_state_machine.beaver_process_blueprint.arn, ":stateMachine:", ":execution:")}:*"
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

# [2026-10-22] Admin › AI Models › Inference instance shows LIVE SageMaker processing-job quotas and
# on-demand prices (src/server/services/yolo-instance-catalog.ts). Read-only; these actions support no
# resource-level scoping, hence "*". Never on the YOLO run path: without this grant the picker falls
# back to the code allowlist + approximate prices.
resource "aws_iam_role_policy" "beaver_ecs_task_sagemaker_catalog" {
  name = "beaver-ecs-task-sagemaker-catalog"
  role = aws_iam_role.beaver_ecs_task_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadSageMakerQuotasAndPrices"
        Effect = "Allow"
        Action = [
          "servicequotas:ListServiceQuotas",
          "servicequotas:ListAWSDefaultServiceQuotas",
          "servicequotas:GetServiceQuota",
          "pricing:GetProducts"
        ]
        Resource = "*"
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

# Read-only observability perms used by the Root_Admin Logs tab backend
# routes (engagement/visitors/monitor). Queries CloudWatch Logs Insights
# over the ECS app log group, plus metric + alarm + budget reads.
resource "aws_iam_role_policy" "beaver_ecs_task_observability" {
  name = "beaver-ecs-task-observability"
  role = aws_iam_role.beaver_ecs_task_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:StartQuery",
          "logs:StopQuery",
          "logs:GetQueryResults",
          "logs:DescribeLogStreams",
          "logs:DescribeLogGroups",
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "cloudwatch:GetMetricData",
          "cloudwatch:DescribeAlarms",
          "cloudwatch:ListMetrics",
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "budgets:DescribeBudgets",
          "budgets:ViewBudget",
        ]
        Resource = "*"
      },
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

resource "aws_iam_role_policy" "beaver_sagemaker_s3" {
  name = "beaver-sagemaker-s3"
  role = aws_iam_role.beaver_sagemaker_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadOnlyCanonicalInputs"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion",
        ]
        Resource = [
          "${aws_s3_bucket.beaver_data.arn}/models/*",
          "${aws_s3_bucket.beaver_data.arn}/*/*/pages/*",
        ]
      },
      {
        Sid    = "WriteOnlyCanonicalOutputs"
        Effect = "Allow"
        Action = [
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts",
          "s3:PutObject",
        ]
        Resource = "${aws_s3_bucket.beaver_data.arn}/*/*/yolo-output/*"
      },
      {
        Sid      = "ResolveCanonicalDataBucket"
        Effect   = "Allow"
        Action   = "s3:GetBucketLocation"
        Resource = aws_s3_bucket.beaver_data.arn
      },
      {
        Sid    = "ListOnlyCanonicalPrefixes"
        Effect = "Allow"
        Action = [
          "s3:ListBucket",
          "s3:ListBucketMultipartUploads",
        ]
        Resource = aws_s3_bucket.beaver_data.arn
        Condition = {
          StringLike = {
            "s3:prefix" = [
              "models/*",
              "*/*/pages/*",
              "*/*/yolo-output/*",
            ]
          }
        }
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
        Sid      = "ResolvePrivateRegistryToken"
        Effect = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid    = "PullOnlyCanonicalYoloRepository"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
        ]
        Resource = aws_ecr_repository.beaver_yolo_pipeline.arn
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
        Action = "ecs:RunTask"
        # Preserve in-flight Step Functions executions across ordinary CPU task
        # revisions while excluding every non-CPU family (especially migrator).
        Resource = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${aws_ecs_task_definition.beaver_cpu_pipeline.family}:*"
        Condition = {
          ArnEquals = {
            "ecs:cluster" = aws_ecs_cluster.beaver.arn
          }
        }
      },
      {
        Effect = "Allow"
        Action = [
          "ecs:StopTask",
          "ecs:DescribeTasks"
        ]
        Resource = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task/${aws_ecs_cluster.beaver.name}/*"
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
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "ecs-tasks.amazonaws.com"
          }
        }
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
