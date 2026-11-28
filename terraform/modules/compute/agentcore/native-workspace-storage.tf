# Workspace storage for native intents (docs/development/native-execution-plan.md,
# PR 3): one encrypted EFS file system that the core runtime mounts at
# /mnt/aidlc, beside the session storage at /mnt/workspace.
#
# Three properties of an EFS entry on an AgentCore runtime shape what is here:
#   - The runtime must be in VPC mode, and a mount target must exist in the
#     Availability Zone of every runtime subnet.
#   - Every session of the runtime gets the same mount. Nothing in this file
#     separates one workspace from another; that is the sandbox scope of the
#     native runtime commands.
#   - A mount that fails makes every invocation of the runtime fail (HTTP 424),
#     so the runtime waits for the mount targets, the file system policy and
#     the role policy below.
# https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html

locals {
  native_workspace_storage_enabled = var.enable_native_workspace_storage && local.vpc_enabled
  native_workspace_storage_name    = "${var.project_name}-native-workspace-${var.environment}"
  native_workspace_mount_path      = "/mnt/aidlc"
  # The image runs as `node` (lambda/agentcore/Dockerfile). The access point
  # makes every file operation run as that user.
  native_workspace_posix_id = 1000
}

resource "terraform_data" "native_workspace_storage_requires_vpc" {
  count = var.enable_native_workspace_storage ? 1 : 0

  lifecycle {
    precondition {
      condition     = local.vpc_enabled
      error_message = "enable_native_workspace_storage requires network_mode = \"VPC\": AgentCore mounts an EFS access point only into a runtime that runs in a VPC."
    }
  }
}

resource "aws_efs_file_system" "native_workspace" {
  count = local.native_workspace_storage_enabled ? 1 : 0

  creation_token   = local.native_workspace_storage_name
  encrypted        = true
  kms_key_id       = var.kms_key_arn != "" ? var.kms_key_arn : null
  performance_mode = "generalPurpose"
  # Workspaces are small and idle most of the time; elastic throughput bills
  # what a turn reads and writes and needs no burst credits.
  throughput_mode = "elastic"

  tags = merge(var.tags, { Name = local.native_workspace_storage_name })
}

resource "aws_efs_access_point" "native_workspace" {
  count = local.native_workspace_storage_enabled ? 1 : 0

  file_system_id = aws_efs_file_system.native_workspace[0].id

  posix_user {
    uid = local.native_workspace_posix_id
    gid = local.native_workspace_posix_id
  }

  root_directory {
    path = "/aidlc"
    creation_info {
      owner_uid   = local.native_workspace_posix_id
      owner_gid   = local.native_workspace_posix_id
      permissions = "0700"
    }
  }

  tags = merge(var.tags, { Name = local.native_workspace_storage_name })
}

# No egress rule: a mount target only answers.
resource "aws_security_group" "native_workspace" {
  count = local.native_workspace_storage_enabled ? 1 : 0

  name_prefix = "${local.native_workspace_storage_name}-"
  description = "Native workspace file system; NFS only from the AgentCore runtime"
  vpc_id      = var.vpc_id

  ingress {
    description     = "NFS from the AgentCore runtime"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.agentcore[0].id]
  }

  tags = merge(var.tags, { Name = local.native_workspace_storage_name })
}

resource "aws_efs_mount_target" "native_workspace" {
  count = local.native_workspace_storage_enabled ? length(aws_subnet.agentcore) : 0

  file_system_id  = aws_efs_file_system.native_workspace[0].id
  subnet_id       = aws_subnet.agentcore[count.index].id
  security_groups = [aws_security_group.native_workspace[0].id]
}

# A file system without a policy lets any client that reaches a mount target
# mount it as any user, without IAM. This policy allows nobody; it only denies.
# The one grant is the runtime role's policy below.
resource "aws_efs_file_system_policy" "native_workspace" {
  count = local.native_workspace_storage_enabled ? 1 : 0

  file_system_id = aws_efs_file_system.native_workspace[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyRootAccess"
        Effect    = "Deny"
        Principal = { AWS = "*" }
        Action    = "elasticfilesystem:ClientRootAccess"
        Resource  = aws_efs_file_system.native_workspace[0].arn
      },
      {
        # Also true for a client that names no access point at all.
        Sid       = "DenyOtherAccessPoints"
        Effect    = "Deny"
        Principal = { AWS = "*" }
        Action    = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
        Resource  = aws_efs_file_system.native_workspace[0].arn
        Condition = {
          ArnNotEquals = { "elasticfilesystem:AccessPointArn" = aws_efs_access_point.native_workspace[0].arn }
        }
      },
      {
        Sid       = "DenyUnencryptedTransport"
        Effect    = "Deny"
        Principal = { AWS = "*" }
        Action    = "*"
        Resource  = aws_efs_file_system.native_workspace[0].arn
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      },
    ]
  })
}

# Managed environment runtimes use this role too (module.managed_environments).
# They get the permission, not the mount.
resource "aws_iam_role_policy" "agentcore_native_workspace" {
  count = local.native_workspace_storage_enabled ? 1 : 0

  name = "native-workspace-storage"
  role = aws_iam_role.agentcore.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # AgentCore refuses a runtime whose role cannot look up the access
        # point and its mount targets ("Execution role is missing required
        # filesystem permissions"). These are control-plane reads, so the NFS
        # condition keys do not apply to them.
        Sid      = "FindNativeWorkspaceStorage"
        Effect   = "Allow"
        Action   = ["elasticfilesystem:DescribeAccessPoints", "elasticfilesystem:DescribeMountTargets"]
        Resource = [aws_efs_file_system.native_workspace[0].arn, aws_efs_access_point.native_workspace[0].arn]
      },
      {
        Sid      = "MountNativeWorkspaceStorage"
        Effect   = "Allow"
        Action   = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
        Resource = aws_efs_file_system.native_workspace[0].arn
        Condition = {
          ArnEquals = { "elasticfilesystem:AccessPointArn" = aws_efs_access_point.native_workspace[0].arn }
        }
      },
    ]
  })
}
