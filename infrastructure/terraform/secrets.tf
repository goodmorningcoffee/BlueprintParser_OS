###############################################################################
# Beaver Infrastructure - Secrets Manager
###############################################################################

resource "aws_secretsmanager_secret" "database_url" {
  name                    = "beaver/DATABASE_URL"
  description             = "PostgreSQL connection string for Beaver app"
  recovery_window_in_days = 7

  tags = {
    Name = "beaver-database-url"
  }
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id = aws_secretsmanager_secret.database_url.id
  secret_string = "postgresql://${var.db_username}:${var.db_password}@${aws_db_instance.beaver.endpoint}/${aws_db_instance.beaver.db_name}"
}

resource "aws_secretsmanager_secret" "nextauth_secret" {
  name                    = "beaver/NEXTAUTH_SECRET"
  description             = "NextAuth.js session signing secret"
  recovery_window_in_days = 7

  tags = {
    Name = "beaver-nextauth-secret"
  }
}

resource "aws_secretsmanager_secret_version" "nextauth_secret" {
  secret_id     = aws_secretsmanager_secret.nextauth_secret.id
  secret_string = var.nextauth_secret
}

resource "aws_secretsmanager_secret" "processing_webhook_secret" {
  name                    = "beaver/PROCESSING_WEBHOOK_SECRET"
  description             = "Secret for authenticating processing pipeline webhook calls"
  recovery_window_in_days = 7

  tags = {
    Name = "beaver-processing-webhook-secret"
  }
}

resource "aws_secretsmanager_secret_version" "processing_webhook_secret" {
  secret_id     = aws_secretsmanager_secret.processing_webhook_secret.id
  secret_string = var.processing_webhook_secret
}

resource "aws_secretsmanager_secret" "anthropic_api_key" {
  name                    = "beaver/ANTHROPIC_API_KEY"
  description             = "Anthropic API key for Claude integration"
  recovery_window_in_days = 7

  tags = {
    Name = "beaver-anthropic-api-key"
  }
}

resource "aws_secretsmanager_secret_version" "anthropic_api_key" {
  secret_id     = aws_secretsmanager_secret.anthropic_api_key.id
  secret_string = var.anthropic_api_key
}

resource "aws_secretsmanager_secret" "groq_api_key" {
  name                    = "beaver/GROQ_API_KEY"
  description             = "Groq API key for LLM chat"
  recovery_window_in_days = 7

  tags = {
    Name = "beaver-groq-api-key"
  }
}

resource "aws_secretsmanager_secret_version" "groq_api_key" {
  secret_id     = aws_secretsmanager_secret.groq_api_key.id
  secret_string = var.groq_api_key
}
