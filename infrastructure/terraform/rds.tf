###############################################################################
# Beaver Infrastructure - RDS PostgreSQL
###############################################################################

###############################################################################
# DB Subnet Group
###############################################################################

resource "aws_db_subnet_group" "beaver" {
  name       = "beaver-db-subnet-group"
  subnet_ids = aws_subnet.private[*].id

  tags = {
    Name = "beaver-db-subnet-group"
  }
}

###############################################################################
# RDS Security Group
###############################################################################

resource "aws_security_group" "beaver_rds" {
  name        = "beaver-rds-sg"
  description = "Security group for Beaver RDS PostgreSQL"
  vpc_id      = aws_vpc.beaver.id

  ingress {
    description     = "PostgreSQL from ECS"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.beaver_ecs.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "beaver-rds-sg"
  }
}

###############################################################################
# RDS Instance
###############################################################################

resource "aws_db_instance" "beaver" {
  identifier = "beaver-db"

  engine         = "postgres"
  engine_version = "16"
  instance_class = "db.t4g.medium"

  allocated_storage     = 50
  max_allocated_storage = 200
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "beaver"
  username = var.db_username
  password = var.db_password

  multi_az               = var.environment == "production" ? true : false
  db_subnet_group_name   = aws_db_subnet_group.beaver.name
  vpc_security_group_ids = [aws_security_group.beaver_rds.id]

  backup_retention_period = 7
  backup_window           = "03:00-04:00"
  maintenance_window      = "sun:04:00-sun:05:00"

  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "beaver-db-final-snapshot"

  performance_insights_enabled          = true
  performance_insights_retention_period = 7

  parameter_group_name = aws_db_parameter_group.beaver.name

  tags = {
    Name = "beaver-db"
  }
}

###############################################################################
# Parameter Group
###############################################################################

resource "aws_db_parameter_group" "beaver" {
  name   = "beaver-pg16-params"
  family = "postgres16"

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }

  tags = {
    Name = "beaver-pg16-params"
  }
}
