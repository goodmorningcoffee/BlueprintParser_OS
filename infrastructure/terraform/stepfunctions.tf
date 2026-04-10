###############################################################################
# Beaver Infrastructure - Step Functions State Machine
###############################################################################

###############################################################################
# CloudWatch Log Group for Step Functions
###############################################################################

resource "aws_cloudwatch_log_group" "beaver_sfn" {
  name              = "/aws/states/blueprintparser-process-blueprint"
  retention_in_days = 30
}

###############################################################################
# State Machine - blueprintparser-process-blueprint
###############################################################################

resource "aws_sfn_state_machine" "beaver_process_blueprint" {
  name     = "blueprintparser-process-blueprint"
  role_arn = aws_iam_role.beaver_step_functions_role.arn

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.beaver_sfn.arn}:*"
    include_execution_data = true
    level                  = "ERROR"
  }

  definition = jsonencode({
    Comment = "Beaver blueprint processing pipeline"
    StartAt = "ValidateInput"
    States = {

      ValidateInput = {
        Type = "Pass"
        Parameters = {
          "projectId.$"      = "$.projectId"
          "dataUrl.$"        = "$.dataUrl"
          "s3Bucket.$"       = "$.s3Bucket"
          "webhookUrl.$"     = "$.webhookUrl"
          "webhookSecret.$"  = "$.webhookSecret"
          "status"           = "PROCESSING"
        }
        Next = "CPUProcessing"
      }

      CPUProcessing = {
        Type     = "Task"
        Resource = "arn:aws:states:::ecs:runTask.sync"
        Parameters = {
          LaunchType = "FARGATE"
          Cluster    = aws_ecs_cluster.beaver.arn
          TaskDefinition = "blueprintparser-cpu-pipeline"
          NetworkConfiguration = {
            AwsvpcConfiguration = {
              Subnets        = aws_subnet.private[*].id
              SecurityGroups = [aws_security_group.beaver_ecs.id]
              AssignPublicIp = "DISABLED"
            }
          }
          Overrides = {
            ContainerOverrides = [
              {
                Name = "blueprintparser-cpu-pipeline"
                Environment = [
                  { Name = "PROJECT_ID", "Value.$" = "States.Format('{}', $.projectId)" },
                  { Name = "DATA_URL", "Value.$" = "$.dataUrl" },
                  { Name = "S3_BUCKET", "Value.$" = "$.s3Bucket" },
                  { Name = "WEBHOOK_URL", "Value.$" = "$.webhookUrl" },
                  { Name = "WEBHOOK_SECRET", "Value.$" = "$.webhookSecret" },
                ]
              }
            ]
          }
        }
        ResultPath = "$.cpuResult"
        Retry = [
          {
            ErrorEquals     = ["States.TaskFailed"]
            IntervalSeconds = 30
            MaxAttempts     = 2
            BackoffRate     = 2.0
          }
        ]
        Catch = [
          {
            ErrorEquals = ["States.ALL"]
            Next        = "ProcessingFailed"
            ResultPath  = "$.error"
          }
        ]
        Next = "ProcessingComplete"
      }

      ProcessingComplete = {
        Type = "Succeed"
      }

      ProcessingFailed = {
        Type  = "Fail"
        Error = "ProcessingFailed"
        Cause = "Blueprint processing pipeline failed. Check CloudWatch logs for details."
      }
    }
  })

  tags = {
    Name = "blueprintparser-process-blueprint"
  }
}
