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
  backend "s3" {
    bucket         = "CHANGEME-terraform-state"
    key            = "infrastructure/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "CHANGEME-terraform-locks"
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
