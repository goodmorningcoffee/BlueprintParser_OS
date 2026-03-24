###############################################################################
# Beaver Infrastructure - Outputs
###############################################################################

###############################################################################
# VPC
###############################################################################

output "vpc_id" {
  description = "ID of the Beaver VPC"
  value       = aws_vpc.beaver.id
}

output "public_subnet_ids" {
  description = "IDs of public subnets"
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "IDs of private subnets"
  value       = aws_subnet.private[*].id
}

###############################################################################
# ECS
###############################################################################

output "ecs_cluster_arn" {
  description = "ARN of the ECS cluster"
  value       = aws_ecs_cluster.beaver.arn
}

output "ecs_cluster_name" {
  description = "Name of the ECS cluster"
  value       = aws_ecs_cluster.beaver.name
}

output "ecs_service_name" {
  description = "Name of the ECS service"
  value       = aws_ecs_service.beaver_app.name
}

output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer"
  value       = aws_lb.beaver.dns_name
}

output "alb_arn" {
  description = "ARN of the Application Load Balancer"
  value       = aws_lb.beaver.arn
}

output "app_url" {
  description = "Application URL via ALB"
  value       = "https://${aws_lb.beaver.dns_name}"
}

###############################################################################
# RDS
###############################################################################

output "rds_endpoint" {
  description = "RDS instance endpoint (host:port)"
  value       = aws_db_instance.beaver.endpoint
}

output "rds_arn" {
  description = "ARN of the RDS instance"
  value       = aws_db_instance.beaver.arn
}

output "rds_db_name" {
  description = "Name of the database"
  value       = aws_db_instance.beaver.db_name
}

###############################################################################
# S3
###############################################################################

output "s3_bucket_name" {
  description = "Name of the Beaver data S3 bucket"
  value       = aws_s3_bucket.beaver_data.id
}

output "s3_bucket_arn" {
  description = "ARN of the Beaver data S3 bucket"
  value       = aws_s3_bucket.beaver_data.arn
}

###############################################################################
# CloudFront
###############################################################################

output "cloudfront_distribution_id" {
  description = "ID of the CloudFront distribution"
  value       = aws_cloudfront_distribution.beaver.id
}

output "cloudfront_domain_name" {
  description = "Domain name of the CloudFront distribution"
  value       = aws_cloudfront_distribution.beaver.domain_name
}

output "cloudfront_url" {
  description = "CloudFront URL for serving S3 content"
  value       = "https://${aws_cloudfront_distribution.beaver.domain_name}"
}

###############################################################################
# ECR
###############################################################################

output "ecr_beaver_app_url" {
  description = "ECR repository URL for beaver-app"
  value       = aws_ecr_repository.beaver_app.repository_url
}

output "ecr_beaver_cpu_pipeline_url" {
  description = "ECR repository URL for beaver-cpu-pipeline"
  value       = aws_ecr_repository.beaver_cpu_pipeline.repository_url
}

output "ecr_beaver_yolo_pipeline_url" {
  description = "ECR repository URL for beaver-yolo-pipeline"
  value       = aws_ecr_repository.beaver_yolo_pipeline.repository_url
}

###############################################################################
# IAM
###############################################################################

output "ecs_task_role_arn" {
  description = "ARN of the ECS task role"
  value       = aws_iam_role.beaver_ecs_task_role.arn
}

output "ecs_execution_role_arn" {
  description = "ARN of the ECS execution role"
  value       = aws_iam_role.beaver_ecs_execution_role.arn
}

output "sagemaker_role_arn" {
  description = "ARN of the SageMaker role"
  value       = aws_iam_role.beaver_sagemaker_role.arn
}

output "step_functions_role_arn" {
  description = "ARN of the Step Functions role"
  value       = aws_iam_role.beaver_step_functions_role.arn
}

###############################################################################
# Step Functions
###############################################################################

output "step_functions_state_machine_arn" {
  description = "ARN of the Step Functions state machine"
  value       = aws_sfn_state_machine.beaver_process_blueprint.arn
}

output "step_functions_state_machine_name" {
  description = "Name of the Step Functions state machine"
  value       = aws_sfn_state_machine.beaver_process_blueprint.name
}

###############################################################################
# Secrets Manager
###############################################################################

output "secret_database_url_arn" {
  description = "ARN of the DATABASE_URL secret"
  value       = aws_secretsmanager_secret.database_url.arn
}

output "secret_nextauth_arn" {
  description = "ARN of the NEXTAUTH_SECRET secret"
  value       = aws_secretsmanager_secret.nextauth_secret.arn
}

output "secret_webhook_arn" {
  description = "ARN of the PROCESSING_WEBHOOK_SECRET secret"
  value       = aws_secretsmanager_secret.processing_webhook_secret.arn
}

output "secret_anthropic_arn" {
  description = "ARN of the ANTHROPIC_API_KEY secret"
  value       = aws_secretsmanager_secret.anthropic_api_key.arn
}

output "secret_groq_arn" {
  description = "ARN of the GROQ_API_KEY secret"
  value       = aws_secretsmanager_secret.groq_api_key.arn
}
