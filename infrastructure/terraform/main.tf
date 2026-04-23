###############################################################################
# Beaver Infrastructure - Main Configuration
###############################################################################

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # NOTE: Terraform backend config doesn't support variables.
  # Update these values to match your AWS setup before running terraform init.
  # DO NOT COMMIT these real bucket/table names to a public repo. Before a
  # public push, revert to CHANGEME- placeholders and use a partial-config
  # overlay or -backend-config= flags to inject real values.
  backend "s3" {
    bucket         = "beaver-terraform-state-100328509916"
    key            = "infrastructure/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "beaver-terraform-locks"
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "beaver"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

###############################################################################
# Data Sources
###############################################################################

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ecr_authorization_token" "token" {}
