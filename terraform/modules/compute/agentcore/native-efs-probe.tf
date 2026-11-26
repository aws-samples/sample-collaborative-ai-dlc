# Synthetic operator experiment only. Every session of this runtime sees this
# access point, so it must never hold project data or harness credential stores.
locals {
  native_efs_probe_enabled = var.enable_native_efs_probe && var.enable_native_interaction_probe && var.environment == "dev" && local.vpc_enabled
  native_efs_probe_actions = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
  native_efs_probe_conditions = {
    ArnEquals = {
      "elasticfilesystem:AccessPointArn" = one(aws_efs_access_point.native_probe[*].arn)
    }
    Bool = {
      "aws:SecureTransport"                      = "true"
      "elasticfilesystem:AccessedViaMountTarget" = "true"
    }
  }
}

resource "terraform_data" "native_efs_probe_configuration" {
  count = var.enable_native_efs_probe ? 1 : 0

  lifecycle {
    precondition {
      condition     = var.environment == "dev" && var.enable_native_interaction_probe
      error_message = "The synthetic EFS probe requires dev and enable_native_interaction_probe."
    }
    precondition {
      condition     = local.vpc_enabled
      error_message = "The synthetic EFS probe requires AgentCore VPC mode."
    }
    precondition {
      condition     = length(local.agentcore_subnet_azs) > 0
      error_message = "The synthetic EFS probe requires at least one AgentCore subnet Availability Zone."
    }
  }
}

resource "aws_efs_file_system" "native_probe" {
  count      = local.native_efs_probe_enabled ? 1 : 0
  depends_on = [terraform_data.native_efs_probe_configuration]

  creation_token   = "${var.project_name}-native-efs-probe-${var.environment}"
  encrypted        = true
  performance_mode = "generalPurpose"
  # A small synthetic filesystem should not depend on accumulated burst credits.
  throughput_mode = "elastic"

  tags = merge(var.tags, { Name = "${var.project_name}-native-efs-probe", SyntheticProbe = "true" })
}

resource "aws_efs_access_point" "native_probe" {
  count = local.native_efs_probe_enabled ? 1 : 0

  file_system_id = aws_efs_file_system.native_probe[0].id
  # Dockerfile runs as node (1000:1000); native inspection requires a private
  # root owned by the process. AI-DLC's machine install and project live on EFS;
  # coding-harness binaries, homes and active databases stay on local disk.
  posix_user {
    uid = 1000
    gid = 1000
  }
  root_directory {
    path = "/native-interaction"
    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "0700"
    }
  }

  tags = merge(var.tags, { Name = "${var.project_name}-native-efs-probe", SyntheticProbe = "true" })
}

resource "aws_security_group" "native_efs_probe" {
  count      = local.native_efs_probe_enabled ? 1 : 0
  depends_on = [terraform_data.native_efs_probe_configuration]

  name_prefix = "${var.project_name}-native-efs-probe-"
  description = "Synthetic EFS probe; NFS only from the AgentCore runtime security group"
  vpc_id      = var.vpc_id

  ingress {
    description     = "AgentCore runtime NFS"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.agentcore[0].id]
  }

  tags = merge(var.tags, { Name = "${var.project_name}-native-efs-probe", SyntheticProbe = "true" })
}

resource "aws_efs_mount_target" "native_probe" {
  count = local.native_efs_probe_enabled ? length(aws_subnet.agentcore) : 0

  file_system_id  = aws_efs_file_system.native_probe[0].id
  subnet_id       = aws_subnet.agentcore[count.index].id
  security_groups = [aws_security_group.native_efs_probe[0].id]
}

resource "aws_iam_role_policy" "native_efs_probe" {
  count = local.native_efs_probe_enabled ? 1 : 0

  name = "native-efs-probe"
  role = aws_iam_role.agentcore.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DiscoverNativeEfsWorkspace"
        Effect = "Allow"
        Action = [
          "elasticfilesystem:DescribeAccessPoints",
          "elasticfilesystem:DescribeMountTargets",
        ]
        Resource = [
          aws_efs_file_system.native_probe[0].arn,
          aws_efs_access_point.native_probe[0].arn,
        ]
        # These are control-plane lookups. NFS-only condition keys such as
        # AccessPointArn and AccessedViaMountTarget are not present on them.
      },
      {
        Effect    = "Allow"
        Action    = local.native_efs_probe_actions
        Resource  = aws_efs_file_system.native_probe[0].arn
        Condition = local.native_efs_probe_conditions
      },
    ]
  })
}

resource "aws_efs_file_system_policy" "native_probe" {
  count = local.native_efs_probe_enabled ? 1 : 0

  file_system_id = aws_efs_file_system.native_probe[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid       = "AllowSyntheticRuntime"
        Effect    = "Allow"
        Principal = { AWS = aws_iam_role.agentcore.arn }
        Action    = local.native_efs_probe_actions
        Resource  = aws_efs_file_system.native_probe[0].arn
        Condition = local.native_efs_probe_conditions
      },
      {
        Sid       = "DenyRootAccess"
        Effect    = "Deny"
        Principal = "*"
        Action    = "elasticfilesystem:ClientRootAccess"
        Resource  = aws_efs_file_system.native_probe[0].arn
      },
      ], [
      # EFS enforces only its documented NFS condition keys. Bind the runtime
      # through Principal above; deny bypasses of the access point and transport.
      for sid, condition in {
        DenyOtherAccessPoints = {
          ArnNotEquals = { "elasticfilesystem:AccessPointArn" = aws_efs_access_point.native_probe[0].arn }
        }
        DenyInsecureTransport = {
          BoolIfExists = { "aws:SecureTransport" = "false" }
        }
        DenyWithoutMountTargets = {
          BoolIfExists = { "elasticfilesystem:AccessedViaMountTarget" = "false" }
        }
        } : {
        Sid       = sid
        Effect    = "Deny"
        Principal = "*"
        Action    = local.native_efs_probe_actions
        Resource  = aws_efs_file_system.native_probe[0].arn
        Condition = condition
      }
    ])
  })
}
