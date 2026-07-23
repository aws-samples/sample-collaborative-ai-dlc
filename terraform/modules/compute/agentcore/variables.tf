variable "project_name" {
  description = "Project name for resource naming"
  type        = string
}

variable "environment" {
  description = "Environment (dev/prod)"
  type        = string
}

variable "aws_region" {
  description = "AWS region"
  type        = string
}

variable "neptune_endpoint" {
  description = "Neptune cluster endpoint"
  type        = string
}

variable "neptune_cluster_resource_id" {
  description = "Neptune cluster resource ID for IAM DB authentication"
  type        = string
}

variable "artifacts_bucket_name" {
  description = "S3 bucket holding block bodies + the commit-pinned runtime snapshot"
  type        = string
}

variable "artifacts_bucket_arn" {
  description = "ARN of the artifacts bucket"
  type        = string
}

variable "blocks_table_name" {
  description = "DynamoDB blocks table (workflow + block definitions) name"
  type        = string
}

variable "blocks_table_arn" {
  description = "ARN of the blocks table"
  type        = string
  default     = ""
}

variable "connections_table_name" {
  description = "WebSocket connections table name (for realtime fan-out)"
  type        = string
  default     = ""
}

variable "connections_table_arn" {
  description = "ARN of the connections table"
  type        = string
  default     = ""
}

variable "websocket_endpoint" {
  description = "API Gateway Management API endpoint for the realtime websocket"
  type        = string
  default     = ""
}

variable "websocket_execution_arn" {
  description = "Execution ARN of the websocket API (for execute-api:ManageConnections)"
  type        = string
  default     = ""
}

variable "aidlc_repo_ref" {
  description = "Pinned awslabs/aidlc-workflows ref the runtime snapshot was seeded from"
  type        = string
}

variable "bedrock_model" {
  description = "Default Bedrock inference profile id for stage agents"
  type        = string
}

variable "kiro_model" {
  description = "Default Kiro-native model id seeded into the cli-models SSM parameter (empty = none)"
  type        = string
  default     = ""
}

variable "codex_model" {
  description = "Default Codex-on-Bedrock model id (exact openai.* id, e.g. openai.gpt-5.5) seeded into the cli-models SSM parameter (empty = none)"
  type        = string
  default     = ""

  validation {
    condition     = var.codex_model == "" || can(regex("^openai\\.", var.codex_model))
    error_message = "codex_model must be an exact Bedrock OpenAI model id starting with \"openai.\" (e.g. openai.gpt-5.5)."
  }
}

# AgentCore Runtime network mode. Neptune lives in a private VPC, so VPC mode is
# the default — the runtime's ENIs are placed in dedicated subnets in this VPC
# (in AgentCore-supported AZs) and reach Neptune over the VPC. Set to PUBLIC only
# if you have no private dependency.
variable "network_mode" {
  description = "AgentCore Runtime network mode (VPC or PUBLIC)"
  type        = string
  default     = "VPC"

  validation {
    condition     = contains(["VPC", "PUBLIC"], var.network_mode)
    error_message = "network_mode must be \"VPC\" or \"PUBLIC\"."
  }
}

variable "vpc_id" {
  description = "VPC the runtime ENIs join (must be the VPC Neptune lives in). Required when network_mode = VPC."
  type        = string
  default     = ""
}

variable "vpc_cidr" {
  description = "CIDR of the VPC, used to carve dedicated AgentCore subnets. Required when network_mode = VPC."
  type        = string
  default     = ""
}

variable "private_route_table_ids" {
  description = "NAT-routed private route table IDs to associate the AgentCore subnets with (for egress). Required when network_mode = VPC."
  type        = list(string)
  default     = []
}

# AgentCore Runtime VPC mode is only available in a subset of AZs per region,
# published as stable AZ IDs (e.g. use1-az1). Leave empty to use the module's
# built-in per-region defaults (or every available AZ in an unlisted region);
# set explicitly to pin/override the supported AZ IDs for your region.
variable "agentcore_supported_az_ids" {
  description = "AgentCore-supported AZ IDs for this region (e.g. [\"use1-az1\",\"use1-az2\"]). Empty = module default."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
