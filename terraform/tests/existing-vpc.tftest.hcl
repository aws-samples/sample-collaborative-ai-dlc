# Deploying into an existing VPC: the networking module creates no network of
# its own, and AgentCore uses the given private subnets in its supported AZs
# instead of carving dedicated ones.
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
    defaults = { names = ["us-east-1a", "us-east-1b", "us-east-1c"], zone_ids = ["use1-az1", "use1-az2", "use1-az3"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_data "aws_vpc" {
    defaults = { cidr_block = "10.20.0.0/22" }
  }
  mock_data "aws_route_table" {
    defaults = { id = "rtb-0f0f0f0f0f0f0f0f0" }
  }
  mock_data "aws_nat_gateways" {
    defaults = { ids = ["nat-01010101010101010"] }
  }
  mock_data "aws_nat_gateway" {
    defaults = { public_ip = "203.0.113.10" }
  }
  mock_data "aws_internet_gateway" {
    defaults = { internet_gateway_id = "igw-0d0d0d0d0d0d0d0d0", attachments = [{ vpc_id = "vpc-0e0e0e0e0e0e0e0e0", state = "available" }] }
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

override_module {
  target  = module.engine_data_lambda
  outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-engine-data-test", lambda_function_name = "test-engine-data-test" }
}

override_module {
  target  = module.mcp_tools_lambda
  outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-mcp-tools-test", lambda_function_name = "test-mcp-tools-test" }
}

override_module {
  target  = module.mcp_interceptor_lambda
  outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-mcp-interceptor-test", lambda_function_name = "test-mcp-interceptor-test" }
}

variables {
  project_name = "test"
  environment  = "test"
}

run "networking_creates_vpc_by_default" {
  command = plan

  module {
    source = "./modules/networking"
  }

  assert {
    condition     = length(aws_vpc.main) == 1 && length(aws_subnet.private) == 2 && length(aws_subnet.public) == 2
    error_message = "Without existing_vpc_id the module must create its VPC and subnets."
  }

  assert {
    condition     = length(aws_internet_gateway.main) == 1 && length(aws_nat_gateway.main) == 1 && length(aws_route_table.private) == 1
    error_message = "Without existing_vpc_id the module must create its gateways and route tables."
  }

  assert {
    condition     = length(data.aws_vpc.existing) == 0 && length(data.aws_nat_gateways.existing) == 0 && length(data.aws_internet_gateway.existing) == 0
    error_message = "Without existing_vpc_id the module must not look up an existing VPC or its internet gateway."
  }

  assert {
    condition     = length(output.vpc_cidr_blocks) == 1 && output.vpc_cidr_blocks[0] == "10.0.0.0/16"
    error_message = "A created VPC has only its primary CIDR."
  }
}

run "networking_uses_existing_vpc" {
  command = plan

  module {
    source = "./modules/networking"
  }

  variables {
    existing_vpc_id             = "vpc-0e0e0e0e0e0e0e0e0"
    existing_private_subnet_ids = ["subnet-0a0a0a0a0a0a0a0a0", "subnet-0b0b0b0b0b0b0b0b0", "subnet-0c0c0c0c0c0c0c0c0"]
  }

  assert {
    condition = alltrue([
      length(aws_vpc.main) == 0,
      length(aws_subnet.public) == 0,
      length(aws_subnet.private) == 0,
      length(aws_internet_gateway.main) == 0,
      length(aws_eip.nat) == 0,
      length(aws_nat_gateway.main) == 0,
      length(aws_route_table.public) == 0,
      length(aws_route_table.private) == 0,
      length(aws_route_table_association.public) == 0,
      length(aws_route_table_association.private) == 0,
    ])
    error_message = "With existing_vpc_id the module must create no network resources."
  }

  assert {
    condition     = aws_security_group.default.vpc_id == "vpc-0e0e0e0e0e0e0e0e0"
    error_message = "The default security group must be created in the existing VPC."
  }

  assert {
    condition     = output.vpc_id == "vpc-0e0e0e0e0e0e0e0e0" && output.vpc_cidr_block == "10.20.0.0/22"
    error_message = "The VPC outputs must describe the existing VPC."
  }

  assert {
    condition     = output.private_subnet_ids == tolist(["subnet-0a0a0a0a0a0a0a0a0", "subnet-0b0b0b0b0b0b0b0b0", "subnet-0c0c0c0c0c0c0c0c0"]) && output.vpc_origin_subnet_ids == tolist(["subnet-0a0a0a0a0a0a0a0a0", "subnet-0b0b0b0b0b0b0b0b0", "subnet-0c0c0c0c0c0c0c0c0"])
    error_message = "The subnet outputs must be the given private subnets."
  }

  assert {
    condition     = output.private_route_table_ids == tolist(["rtb-0f0f0f0f0f0f0f0f0"])
    error_message = "Private route tables must be those of the given subnets, without duplicates."
  }

  assert {
    condition     = output.nat_gateway_ids == tolist(["nat-01010101010101010"])
    error_message = "NAT gateway IDs must be the existing VPC's."
  }

  assert {
    condition     = output.nat_public_ips == tolist(["203.0.113.10"])
    error_message = "NAT public IPs must be those of the existing VPC's NAT gateways."
  }

  assert {
    condition     = length(output.public_subnet_ids) == 0 && output.internet_gateway_id == null
    error_message = "No public subnets or internet gateway are managed for an existing VPC."
  }

  assert {
    condition     = one(data.aws_internet_gateway.existing[0].filter).name == "attachment.vpc-id" && one(data.aws_internet_gateway.existing[0].filter).values == toset(["vpc-0e0e0e0e0e0e0e0e0"])
    error_message = "The internet gateway lookup must be filtered on attachment to the existing VPC."
  }
}

# CloudFront VPC origins need an internet gateway attached to the VPC. With no
# gateway at all the provider lookup fails; a gateway whose attachment is not
# available fails the postcondition.
run "networking_existing_vpc_requires_internet_gateway" {
  command = plan

  module {
    source = "./modules/networking"
  }

  variables {
    existing_vpc_id             = "vpc-0e0e0e0e0e0e0e0e0"
    existing_private_subnet_ids = ["subnet-0a0a0a0a0a0a0a0a0", "subnet-0b0b0b0b0b0b0b0b0"]
  }

  override_data {
    target = data.aws_internet_gateway.existing[0]
    values = { attachments = [{ vpc_id = "vpc-0e0e0e0e0e0e0e0e0", state = "detaching" }] }
  }

  expect_failures = [data.aws_internet_gateway.existing]
}

run "networking_existing_vpc_secondary_cidrs" {
  command = plan

  module {
    source = "./modules/networking"
  }

  variables {
    existing_vpc_id             = "vpc-0e0e0e0e0e0e0e0e0"
    existing_private_subnet_ids = ["subnet-0a0a0a0a0a0a0a0a0"]
  }

  override_data {
    target = data.aws_vpc.existing[0]
    values = {
      cidr_block = "10.20.0.0/22"
      cidr_block_associations = [
        { association_id = "vpc-cidr-assoc-01", cidr_block = "10.20.0.0/22", state = "associated" },
        { association_id = "vpc-cidr-assoc-02", cidr_block = "100.64.0.0/16", state = "associated" },
        { association_id = "vpc-cidr-assoc-03", cidr_block = "10.30.0.0/24", state = "disassociated" },
      ]
    }
  }

  assert {
    condition     = output.vpc_cidr_block == "10.20.0.0/22"
    error_message = "vpc_cidr_block must stay the primary CIDR."
  }

  assert {
    condition     = output.vpc_cidr_blocks == tolist(["10.20.0.0/22", "100.64.0.0/16"])
    error_message = "vpc_cidr_blocks must hold every associated CIDR and no disassociated one."
  }
}

run "neptune_admits_vpc_cidr_by_default" {
  command = plan

  module {
    source = "./modules/data/neptune"
  }

  variables {
    name_prefix        = "test-test"
    vpc_id             = "vpc-0e0e0e0e0e0e0e0e0"
    vpc_cidr           = "10.0.0.0/16"
    private_subnet_ids = ["subnet-0a0a0a0a0a0a0a0a0"]
  }

  assert {
    condition     = one([for rule in aws_security_group.neptune.ingress : rule.cidr_blocks if rule.from_port == 8182]) == tolist(["10.0.0.0/16"])
    error_message = "Without vpc_cidr_blocks, Neptune must admit vpc_cidr only."
  }
}

run "neptune_admits_secondary_vpc_cidrs" {
  command = plan

  module {
    source = "./modules/data/neptune"
  }

  variables {
    name_prefix        = "test-test"
    vpc_id             = "vpc-0e0e0e0e0e0e0e0e0"
    vpc_cidr           = "10.20.0.0/22"
    vpc_cidr_blocks    = ["10.20.0.0/22", "100.64.0.0/16"]
    private_subnet_ids = ["subnet-0a0a0a0a0a0a0a0a0"]
  }

  assert {
    condition     = one([for rule in aws_security_group.neptune.ingress : rule.cidr_blocks if rule.from_port == 8182]) == tolist(["10.20.0.0/22", "100.64.0.0/16"])
    error_message = "Neptune must admit every VPC CIDR, including secondary ones."
  }
}

run "networking_existing_vpc_block_public_access_exclusions" {
  command = plan

  module {
    source = "./modules/networking"
  }

  variables {
    existing_vpc_id                   = "vpc-0e0e0e0e0e0e0e0e0"
    existing_private_subnet_ids       = ["subnet-0a0a0a0a0a0a0a0a0", "subnet-0b0b0b0b0b0b0b0b0", "subnet-0c0c0c0c0c0c0c0c0"]
    vpc_block_public_access_exclusion = true
  }

  assert {
    condition     = length(aws_vpc_block_public_access_exclusion.private) == 3 && length(aws_vpc_block_public_access_exclusion.nat) == 0
    error_message = "Exclusions cover the given private subnets only; NAT subnets of an existing VPC are its owner's."
  }
}

run "networking_existing_vpc_requires_subnets" {
  command = plan

  module {
    source = "./modules/networking"
  }

  variables {
    existing_vpc_id = "vpc-0e0e0e0e0e0e0e0e0"
  }

  expect_failures = [aws_security_group.default]
}

run "agentcore_uses_supported_existing_subnets" {
  command = plan

  module {
    source = "./modules/compute/agentcore"
  }

  variables {
    aws_sdk_ua_app_id           = "Collaborative_AI-DLC-test"
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
    kms_key_arn                 = "arn:aws:kms:us-east-1:123456789012:key/test"
    network_mode                = "VPC"
    vpc_id                      = "vpc-0e0e0e0e0e0e0e0e0"
    vpc_cidr                    = "10.20.0.0/22"
    private_route_table_ids     = ["rtb-0f0f0f0f0f0f0f0f0"]
    # use1-az3 is not an AgentCore-supported AZ in us-east-1.
    subnet_ids = ["subnet-0a0a0a0a0a0a0a0a0", "subnet-0d0d0d0d0d0d0d0d0", "subnet-0b0b0b0b0b0b0b0b0", "subnet-0c0c0c0c0c0c0c0c0"]
  }

  override_data {
    target = data.aws_subnet.provided["subnet-0a0a0a0a0a0a0a0a0"]
    values = { availability_zone_id = "use1-az1" }
  }

  override_data {
    target = data.aws_subnet.provided["subnet-0d0d0d0d0d0d0d0d0"]
    values = { availability_zone_id = "use1-az3" }
  }

  override_data {
    target = data.aws_subnet.provided["subnet-0b0b0b0b0b0b0b0b0"]
    values = { availability_zone_id = "use1-az2" }
  }

  override_data {
    target = data.aws_subnet.provided["subnet-0c0c0c0c0c0c0c0c0"]
    values = { availability_zone_id = "use1-az1" }
  }

  assert {
    condition     = length(aws_subnet.agentcore) == 0 && length(aws_route_table_association.agentcore) == 0
    error_message = "With subnet_ids the module must not carve its own subnets."
  }

  assert {
    condition     = output.runtime_subnet_ids == tolist(["subnet-0a0a0a0a0a0a0a0a0", "subnet-0b0b0b0b0b0b0b0b0"])
    error_message = "The runtime must use up to two of the given subnets in supported AZs."
  }
}

run "agentcore_rejects_only_unsupported_subnets" {
  command = plan

  module {
    source = "./modules/compute/agentcore"
  }

  variables {
    aws_sdk_ua_app_id           = "Collaborative_AI-DLC-test"
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
    kms_key_arn                 = "arn:aws:kms:us-east-1:123456789012:key/test"
    network_mode                = "VPC"
    vpc_id                      = "vpc-0e0e0e0e0e0e0e0e0"
    vpc_cidr                    = "10.20.0.0/22"
    private_route_table_ids     = ["rtb-0f0f0f0f0f0f0f0f0"]
    subnet_ids                  = ["subnet-0d0d0d0d0d0d0d0d0"]
  }

  override_data {
    target = data.aws_subnet.provided["subnet-0d0d0d0d0d0d0d0d0"]
    values = { availability_zone_id = "use1-az3" }
  }

  expect_failures = [aws_security_group.agentcore]
}

run "agentcore_ignores_subnets_without_vpc_mode" {
  command = plan

  module {
    source = "./modules/compute/agentcore"
  }

  variables {
    aws_sdk_ua_app_id           = "Collaborative_AI-DLC-test"
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
    kms_key_arn                 = "arn:aws:kms:us-east-1:123456789012:key/test"
    network_mode                = "PUBLIC"
    subnet_ids                  = ["subnet-0a0a0a0a0a0a0a0a0"]
  }

  assert {
    condition     = length(data.aws_subnet.provided) == 0 && length(aws_subnet.agentcore) == 0
    error_message = "Outside VPC mode, subnet_ids must not be looked up or used."
  }
}

run "agentcore_mcp_lambdas_reach_secondary_vpc_cidrs" {
  command = plan

  module {
    source = "./modules/compute/agentcore"
  }

  variables {
    aws_sdk_ua_app_id           = "Collaborative_AI-DLC-test"
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
    kms_key_arn                 = "arn:aws:kms:us-east-1:123456789012:key/test"
    network_mode                = "VPC"
    vpc_id                      = "vpc-0e0e0e0e0e0e0e0e0"
    vpc_cidr                    = "10.20.0.0/22"
    vpc_cidr_blocks             = ["10.20.0.0/22", "100.64.0.0/16"]
    private_route_table_ids     = ["rtb-0f0f0f0f0f0f0f0f0"]
    subnet_ids                  = ["subnet-0a0a0a0a0a0a0a0a0"]
    enable_mcp_gateway          = true
  }

  override_data {
    target = data.aws_subnet.provided["subnet-0a0a0a0a0a0a0a0a0"]
    values = { availability_zone_id = "use1-az1" }
  }

  assert {
    condition     = one([for rule in aws_security_group.mcp_tools[0].egress : rule.cidr_blocks if rule.from_port == 8182]) == tolist(["10.20.0.0/22", "100.64.0.0/16"])
    error_message = "The MCP tools Lambda must reach Neptune in every VPC CIDR."
  }

  assert {
    condition     = one([for rule in aws_security_group.mcp_interceptor[0].egress : rule.cidr_blocks if rule.from_port == 8182]) == tolist(["10.20.0.0/22", "100.64.0.0/16"])
    error_message = "The MCP interceptor Lambda must reach Neptune in every VPC CIDR."
  }
}
