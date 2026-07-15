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

  # Backend coordinates are deployment authority, not source code. Initialize
  # with an owner-maintained copy of backend.hcl.example kept outside the repo:
  #   terraform init -backend-config=/owner/private/beaver-backend.hcl
  # An empty partial backend prevents account/state identities from being
  # committed and makes a fresh init fail until the owner supplies them.
  backend "s3" {}
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.account_id]

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
