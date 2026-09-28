resource "aws_neptune_subnet_group" "main" {
  name       = "${var.name_prefix}-neptune-subnet-group"
  subnet_ids = var.private_subnet_ids

  tags = var.tags
}

resource "aws_security_group" "neptune" {
  name_prefix = "${var.name_prefix}-neptune-"
  description = "Security group for the Neptune graph database cluster"
  vpc_id      = var.vpc_id

  ingress {
    description = "Allow Gremlin/Bolt/SPARQL access from within the VPC only (no public access)"
    from_port   = 8182
    to_port     = 8182
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    description = "Allow all egress for Neptune internal operations (SNS, CloudWatch)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = var.tags
}

resource "aws_neptune_cluster_parameter_group" "main" {
  name   = "${var.name_prefix}-neptune-cluster-params"
  family = "neptune1.4"

  parameter {
    name  = "neptune_enable_audit_log"
    value = "1"
  }

  tags = var.tags
}

resource "random_id" "final_snapshot_suffix" {
  count       = var.skip_final_snapshot ? 0 : 1
  byte_length = 4
}

resource "aws_neptune_cluster" "main" {
  cluster_identifier                   = "${var.name_prefix}-neptune-cluster"
  engine                               = "neptune"
  neptune_subnet_group_name            = aws_neptune_subnet_group.main.name
  neptune_cluster_parameter_group_name = aws_neptune_cluster_parameter_group.main.name
  vpc_security_group_ids               = [aws_security_group.neptune.id]
  iam_database_authentication_enabled  = true
  deletion_protection                  = var.deletion_protection
  backup_retention_period              = var.backup_retention_period
  skip_final_snapshot                  = var.skip_final_snapshot
  final_snapshot_identifier            = var.skip_final_snapshot ? null : "${trim(substr(var.name_prefix, 0, 39), "-")}-neptune-final-${random_id.final_snapshot_suffix[0].hex}"

  tags = var.tags
}

resource "aws_neptune_cluster_instance" "main" {
  identifier         = "${var.name_prefix}-neptune-instance"
  cluster_identifier = aws_neptune_cluster.main.id
  engine             = "neptune"
  instance_class     = var.instance_class

  tags = var.tags
}
