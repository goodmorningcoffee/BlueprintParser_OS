###############################################################################
# Beaver Infrastructure - CV Lambda Pipeline
#
# Container-based Lambda function for parallel OpenCV template matching
# (symbol search) and shape parsing (keynote detection). Invoked by the
# ECS web server via fan-out for processing 100+ blueprint pages in parallel.
###############################################################################

###############################################################################
# Lambda Function
###############################################################################

resource "aws_lambda_function" "beaver_cv_pipeline" {
  function_name = "blueprintparser-cv-pipeline"
  role          = aws_iam_role.beaver_lambda_cv_role.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.beaver_cv_lambda.repository_url}:latest"
  timeout       = 120
  memory_size   = 2048
  architectures = ["x86_64"]

  ephemeral_storage {
    size = 1024
  }

  environment {
    variables = {
      PYTHONUNBUFFERED = "1"
    }
  }

  tags = {
    Name = "blueprintparser-cv-pipeline"
  }

  depends_on = [aws_cloudwatch_log_group.cv_lambda]
}

###############################################################################
# CloudWatch Log Group
###############################################################################

resource "aws_cloudwatch_log_group" "cv_lambda" {
  name              = "/aws/lambda/blueprintparser-cv-pipeline"
  retention_in_days = 30
}

###############################################################################
# Lambda Execution Role
###############################################################################

resource "aws_iam_role" "beaver_lambda_cv_role" {
  name = "blueprintparser-cv-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "beaver_lambda_cv_logs" {
  role       = aws_iam_role.beaver_lambda_cv_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "beaver_lambda_cv_s3" {
  name = "blueprintparser-cv-lambda-s3"
  role = aws_iam_role.beaver_lambda_cv_role.id

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
