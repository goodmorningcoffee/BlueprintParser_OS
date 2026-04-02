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
  default     = 1
}

variable "ecs_min_count" {
  description = "Minimum number of ECS tasks for auto-scaling"
  type        = number
  default     = 1
}

variable "ecs_max_count" {
  description = "Maximum number of ECS tasks for auto-scaling"
  type        = number
  default     = 4
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
