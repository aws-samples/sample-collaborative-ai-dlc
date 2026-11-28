# Workspace storage for native intents (enable_native_workspace_storage): off
# by default and then absent. When on, NFS is open to the runtime's security
# group only, and the runtime role is the only principal that may mount it.
# Managed environment runtimes share that group and that role.
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_region" {
    defaults = { region = "us-east-1" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws", dns_suffix = "amazonaws.com" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-1a", "us-east-1b"], zone_ids = ["use1-az1", "use1-az2"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_resource "aws_ecr_repository" {
    override_during = plan
    defaults        = { arn = "arn:aws:ecr:us-east-1:123456789012:repository/test" }
  }
  mock_resource "aws_dynamodb_table" {
    override_during = plan
    defaults        = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/test-v2-executions" }
  }
  mock_resource "aws_ssm_parameter" {
    override_during = plan
    defaults        = { arn = "arn:aws:ssm:us-east-1:123456789012:parameter/test/test/models" }
  }
}

mock_provider "awscc" {}

override_module {
  target  = module.agentcore_docker_build
  outputs = { image_uri = "123456789012.dkr.ecr.us-east-1.amazonaws.com/test:tag" }
}

# The ids and ARNs the assertions compare. Without them a plan leaves them
# unknown.
override_resource {
  target          = aws_security_group.agentcore
  override_during = plan
  values          = { id = "sg-0aaaaaaaaaaaaaaaa" }
}
override_resource {
  target          = aws_security_group.native_workspace
  override_during = plan
  values          = { id = "sg-0bbbbbbbbbbbbbbbb" }
}
override_resource {
  target          = aws_efs_file_system.native_workspace
  override_during = plan
  values = {
    id  = "fs-0123456789abcdef0"
    arn = "arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-0123456789abcdef0"
  }
}
override_resource {
  target          = aws_efs_access_point.native_workspace
  override_during = plan
  values = {
    id  = "fsap-0123456789abcdef0"
    arn = "arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0"
  }
}

variables {
  aws_sdk_ua_app_id           = "Collaborative_AI-DLC-test"
  project_name                = "test"
  environment                 = "test"
  powertools_service_name     = "test"
  powertools_log_level        = "INFO"
  aws_region                  = "us-east-1"
  neptune_endpoint            = "neptune.example"
  neptune_cluster_resource_id = "cluster-TEST"
  artifacts_bucket_name       = "test-artifacts"
  artifacts_bucket_arn        = "arn:aws:s3:::test-artifacts"
  blocks_table_name           = "test-blocks"
  blocks_table_arn            = "arn:aws:dynamodb:us-east-1:123456789012:table/test-blocks"
  connections_table_name      = "test-connections"
  connections_table_arn       = "arn:aws:dynamodb:us-east-1:123456789012:table/test-connections"
  websocket_endpoint          = "https://ws.example"
  websocket_execution_arn     = "arn:aws:execute-api:us-east-1:123456789012:ws1/test"
  aidlc_repo_ref              = "main"
  bedrock_model               = "test-model"
  bedrock_region              = "us-east-1"
  network_mode                = "VPC"
  vpc_id                      = "vpc-1"
  vpc_cidr                    = "10.0.0.0/16"
  private_route_table_ids     = ["rtb-1"]
}

run "storage_off_adds_nothing" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }

  assert {
    condition = alltrue([
      length(aws_efs_file_system.native_workspace) == 0,
      length(aws_efs_access_point.native_workspace) == 0,
      length(aws_efs_mount_target.native_workspace) == 0,
      length(aws_efs_file_system_policy.native_workspace) == 0,
      length(aws_security_group.native_workspace) == 0,
      length(aws_iam_role_policy.agentcore_native_workspace) == 0,
      length(terraform_data.native_workspace_storage_requires_vpc) == 0,
    ])
    error_message = "Without enable_native_workspace_storage the deployment must hold no workspace storage resource."
  }
  assert {
    condition     = length(awscc_bedrockagentcore_runtime.stage_executor.filesystem_configurations) == 1
    error_message = "Without the storage the runtime must keep its single filesystem entry."
  }
  assert {
    condition     = awscc_bedrockagentcore_runtime.stage_executor.filesystem_configurations[0].session_storage.mount_path == "/mnt/workspace"
    error_message = "Without the storage the runtime's only filesystem entry is the session storage at /mnt/workspace."
  }
}

run "storage_on_adds_the_file_system_and_the_mount" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    enable_native_workspace_storage = true
  }

  assert {
    condition     = length(aws_efs_file_system.native_workspace) == 1 && aws_efs_file_system.native_workspace[0].encrypted
    error_message = "The storage is one encrypted file system."
  }
  assert {
    condition     = length(aws_efs_mount_target.native_workspace) == length(aws_subnet.agentcore) && length(aws_subnet.agentcore) == 2
    error_message = "Every runtime subnet needs a mount target: a session placed in a zone without one cannot mount."
  }
  assert {
    condition     = alltrue([for target in aws_efs_mount_target.native_workspace : target.security_groups == toset(["sg-0bbbbbbbbbbbbbbbb"])])
    error_message = "The mount targets must sit behind the storage security group only."
  }
  assert {
    condition = alltrue(concat(
      [for target in aws_efs_mount_target.native_workspace : target.file_system_id == "fs-0123456789abcdef0"],
      [aws_efs_access_point.native_workspace[0].file_system_id == "fs-0123456789abcdef0"],
      [aws_efs_file_system_policy.native_workspace[0].file_system_id == "fs-0123456789abcdef0"],
    ))
    error_message = "The mount targets, the access point and the policy must belong to the workspace file system."
  }
  assert {
    condition = alltrue([
      length(aws_efs_access_point.native_workspace) == 1,
      aws_efs_access_point.native_workspace[0].posix_user[0].uid == 1000,
      aws_efs_access_point.native_workspace[0].posix_user[0].gid == 1000,
      aws_efs_access_point.native_workspace[0].root_directory[0].path == "/aidlc",
      aws_efs_access_point.native_workspace[0].root_directory[0].creation_info[0].owner_uid == 1000,
      aws_efs_access_point.native_workspace[0].root_directory[0].creation_info[0].permissions == "0700",
    ])
    error_message = "The one access point runs every file operation as the image's node user (1000) below its own root directory."
  }
  assert {
    condition     = length(awscc_bedrockagentcore_runtime.stage_executor.filesystem_configurations) == 2
    error_message = "With the storage the runtime has two filesystem entries."
  }
  assert {
    condition     = awscc_bedrockagentcore_runtime.stage_executor.filesystem_configurations[0].session_storage.mount_path == "/mnt/workspace"
    error_message = "The session storage entry must stay as it is."
  }
  assert {
    condition = awscc_bedrockagentcore_runtime.stage_executor.filesystem_configurations[1].efs_access_point == {
      access_point_arn = "arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0"
      mount_path       = "/mnt/aidlc"
    }
    error_message = "The second entry mounts the workspace access point at /mnt/aidlc."
  }
}

run "kms_key_encrypts_the_file_system" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    enable_native_workspace_storage = true
    kms_key_arn                     = "arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab"
  }

  assert {
    condition     = aws_efs_file_system.native_workspace[0].kms_key_id == "arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab"
    error_message = "A deployment with a customer-managed key encrypts the file system with it."
  }
}

run "nfs_is_reachable_from_the_runtime_only" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    enable_native_workspace_storage = true
  }

  assert {
    condition     = length(aws_security_group.native_workspace[0].ingress) == 1
    error_message = "The storage security group has exactly one ingress rule."
  }
  assert {
    condition = alltrue([
      for rule in aws_security_group.native_workspace[0].ingress : alltrue([
        rule.from_port == 2049,
        rule.to_port == 2049,
        rule.protocol == "tcp",
        rule.security_groups == toset(["sg-0aaaaaaaaaaaaaaaa"]),
        length(coalesce(rule.cidr_blocks, [])) == 0,
        length(coalesce(rule.ipv6_cidr_blocks, [])) == 0,
        length(coalesce(rule.prefix_list_ids, [])) == 0,
        coalesce(rule.self, false) == false,
      ])
    ])
    error_message = "NFS (2049/tcp) must be open to the runtime's security group and to nothing else."
  }
  assert {
    condition     = length(aws_security_group.native_workspace[0].egress) == 0
    error_message = "A mount target needs no egress."
  }
}

run "runtime_role_mounts_that_access_point_only" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    enable_native_workspace_storage = true
  }

  # Every EFS action the role holds, and nothing wider.
  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.agentcore_native_workspace[0].policy).Statement : s.Action
      ])) == toset([
      "elasticfilesystem:ClientMount",
      "elasticfilesystem:ClientWrite",
      "elasticfilesystem:DescribeAccessPoints",
      "elasticfilesystem:DescribeMountTargets",
    ])
    error_message = "The runtime role may look up, mount and write the storage; it gets no root access and no other EFS action."
  }
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.agentcore_native_workspace[0].policy).Statement :
      s.Resource == "arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-0123456789abcdef0" &&
      s.Condition == { ArnEquals = { "elasticfilesystem:AccessPointArn" = "arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0" } }
      if length(setintersection(s.Action, ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"])) > 0
    ])
    error_message = "Mounting and writing must be bound to this file system through its one access point."
  }
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.agentcore_native_workspace[0].policy).Statement :
      alltrue([for resource in flatten([s.Resource]) : contains([
        "arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-0123456789abcdef0",
        "arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0",
      ], resource)])
    ])
    error_message = "The storage policy must name this file system and its access point, never a wildcard."
  }
  # The base policy of the role holds no EFS action; the grant above is all.
  assert {
    condition = length([
      for s in jsondecode(aws_iam_role_policy.agentcore.policy).Statement : s
      if anytrue([for a in flatten([s.Action]) : startswith(a, "elasticfilesystem:") || a == "*"])
    ]) == 0
    error_message = "The runtime role's base policy must not grant EFS access."
  }
}

run "file_system_policy_denies_every_other_way_in" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    enable_native_workspace_storage = true
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_efs_file_system_policy.native_workspace[0].policy).Statement : s.Effect == "Deny"])
    error_message = "The file system policy must allow nobody; the runtime role's own policy is the only grant."
  }
  assert {
    condition = length([
      for s in jsondecode(aws_efs_file_system_policy.native_workspace[0].policy).Statement : s
      if s.Principal == { AWS = "*" } && s.Action == "elasticfilesystem:ClientRootAccess" && !can(s.Condition)
    ]) == 1
    error_message = "Root access must be denied to everyone, unconditionally."
  }
  assert {
    condition = length([
      for s in jsondecode(aws_efs_file_system_policy.native_workspace[0].policy).Statement : s
      if s.Principal == { AWS = "*" } &&
      try(s.Condition.ArnNotEquals["elasticfilesystem:AccessPointArn"], "") == "arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0" &&
      toset(flatten([s.Action])) == toset(["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"])
    ]) == 1
    error_message = "A mount that does not use the workspace access point must be denied."
  }
  assert {
    condition = length([
      for s in jsondecode(aws_efs_file_system_policy.native_workspace[0].policy).Statement : s
      if s.Principal == { AWS = "*" } && s.Action == "*" && try(s.Condition.Bool["aws:SecureTransport"], "") == "false"
    ]) == 1
    error_message = "Access without TLS must be denied."
  }
}

run "storage_needs_vpc_mode" {
  command = plan
  module {
    source = "./modules/compute/agentcore"
  }
  variables {
    enable_native_workspace_storage = true
    network_mode                    = "PUBLIC"
  }

  expect_failures = [terraform_data.native_workspace_storage_requires_vpc]
}
