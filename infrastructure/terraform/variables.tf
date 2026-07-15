###############################################################################
# Beaver Infrastructure - Variables
###############################################################################

###############################################################################
# General
###############################################################################

variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

variable "acknowledge_beaver_data_notification_takeover" {
  description = "Owner acknowledgement that the complete existing beaver data-bucket notification configuration was inventoried and Terraform may replace it with the declared EventBridge-only configuration."
  type        = bool
  default     = false
}

variable "alert_email" {
  description = "Email address for CloudWatch alarm + AWS Budget notifications. Required for pre-Reddit-launch alerting."
  type        = string
  default     = ""
}

variable "monthly_budget_usd" {
  description = "AWS Budget monthly cap in USD. Triggers SNS alerts at 50/80/100%. Set to 0 to disable."
  type        = number
  default     = 500
}

variable "environment" {
  description = "Deployment environment (staging, production)"
  type        = string
  default     = "production"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Environment must be 'staging' or 'production'."
  }
}

variable "account_id" {
  description = "AWS account ID (used for resource naming)"
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "AWS account ID must contain exactly 12 digits."
  }
}

###############################################################################
# Networking
###############################################################################

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "domain_name" {
  description = "Primary domain name for the application"
  type        = string
  default     = ""
}

variable "acm_certificate_arn" {
  description = "ARN of ACM certificate for HTTPS on ALB"
  type        = string
}

###############################################################################
# ECS
###############################################################################

variable "ecs_desired_count" {
  description = "Desired number of ECS tasks"
  type        = number
  # [refactor jun16 P0-review G7-1] dropped 2 -> 1 to match ecs_min/max_count
  # (also 1 since G7). A defaults-only apply previously requested desired_count=2
  # while max_capacity=1 — an invalid desired>max state. Must stay <= ecs_max_count.
  default = 1
}

variable "ecs_min_count" {
  description = "Minimum number of ECS tasks for auto-scaling"
  type        = number
  # [refactor jun13 P0.5-G7] held at 1 alongside ecs_max_count — see below.
  default = 1
}

variable "ecs_max_count" {
  description = "Maximum number of ECS tasks for auto-scaling"
  type        = number
  # [refactor jun13 P0.5-G7] capped at 1 until P5 moves rate-limit/abuse/
  # failed-login state out of process memory (PG-backed). Each extra task is
  # an independent in-memory store: limits multiply by task count and
  # lockouts stop being consistent. Raise ONLY after P5 lands.
  default = 1
}

variable "ecs_autoscaling_enabled" {
  description = "Whether ECS dynamic/scheduled autoscaling may change desired count; disable for schema/provider writer outages"
  type        = bool
  default     = true
}

variable "maintenance_worker_schedule_enabled" {
  description = "Whether the five-minute maintenance worker schedule may launch tasks; disable during Label Studio logical-instance replacement"
  type        = bool
  default     = true
}

variable "beaver_app_image_digest" {
  description = "Exact ECR digest shared by the app, CPU worker, maintenance worker, and singleton schema migrator; tags such as latest are forbidden"
  type        = string

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.beaver_app_image_digest))
    error_message = "beaver_app_image_digest must be an exact sha256 ECR image digest."
  }
}

variable "beaver_yolo_image_digest" {
  description = "Exact immutable ECR digest for the SageMaker YOLO processing image; tags such as latest are forbidden"
  type        = string

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.beaver_yolo_image_digest))
    error_message = "beaver_yolo_image_digest must be an exact sha256 ECR image digest."
  }
}

variable "ecs_cpu" {
  description = "CPU units for ECS task (1024 = 1 vCPU)"
  type        = number
  default     = 1024
}

variable "ecs_memory" {
  description = "Memory in MB for ECS task"
  type        = number
  default     = 2048
}

###############################################################################
# RDS
###############################################################################

variable "db_username" {
  description = "Master username for RDS PostgreSQL"
  type        = string
  default     = "beaver_admin"
  sensitive   = true
}

variable "db_password" {
  description = "Master password for RDS PostgreSQL"
  type        = string
  sensitive   = true
}

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t4g.medium"
}

###############################################################################
# Secrets (passed via tfvars or environment, never committed)
###############################################################################

variable "nextauth_secret" {
  description = "NextAuth.js session signing secret"
  type        = string
  sensitive   = true
}

variable "processing_webhook_secret" {
  description = "Secret for authenticating processing pipeline webhook calls"
  type        = string
  sensitive   = true
}

variable "anthropic_api_key" {
  description = "Anthropic API key for Claude integration"
  type        = string
  sensitive   = true
}

variable "groq_api_key" {
  description = "Groq API key for LLM chat"
  type        = string
  sensitive   = true
}

###############################################################################
# S3 / CloudFront
###############################################################################

variable "cors_allowed_origins" {
  description = "Allowed origins for S3 CORS"
  type        = list(string)
  default     = ["https://*"]
}

###############################################################################
# Label Studio
###############################################################################

variable "label_studio_image" {
  description = "Immutable upstream Label Studio image reference; obtain and review the registry digest before apply"
  type        = string

  validation {
    condition     = can(regex("^heartexlabs/label-studio@sha256:[0-9a-f]{64}$", var.label_studio_image))
    error_message = "label_studio_image must be heartexlabs/label-studio@sha256:<64 lowercase hex characters>."
  }
}

variable "root_admin_email" {
  description = "BlueprintParser root-admin bootstrap email; deliberately independent from the Label Studio administrator"
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition = (
      var.root_admin_email == "" ||
      can(regex("^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$", var.root_admin_email))
    )
    error_message = "root_admin_email must be empty or a valid email address."
  }
}

variable "label_studio_instance_generation" {
  description = "Operator-controlled Label Studio database generation; increment whenever the provider database is reinitialized or replaced, even if its EFS filesystem survives"
  type        = string
  default     = "generation-1"

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", var.label_studio_instance_generation))
    error_message = "label_studio_instance_generation must be a non-empty 1-64 character identifier containing only letters, digits, dot, underscore, or hyphen."
  }
}

variable "label_studio_admin_email" {
  description = "Label Studio admin account email"
  type        = string
  sensitive   = true
  default     = ""
}

variable "label_studio_admin_password" {
  description = "Label Studio admin account password"
  type        = string
  sensitive   = true
}

variable "label_studio_api_key" {
  description = "Label Studio API token for BP integration"
  type        = string
  sensitive   = true
}
