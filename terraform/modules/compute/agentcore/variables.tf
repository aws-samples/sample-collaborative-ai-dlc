variable "aws_sdk_ua_app_id" {
  description = "Application identifier appended by AWS SDKs to the User-Agent header"
  type        = string
}

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
}

variable "environment" {
  description = "Environment (dev/prod)"
  type        = string
}

variable "powertools_service_name" {
  description = "Service name included in Powertools structured logs"
  type        = string
}

variable "powertools_log_level" {
  description = "Log level for Powertools structured logging"
  type        = string
}

variable "kms_key_arn" {
  description = "Customer-managed KMS key ARN for the v2 execution table. Empty uses the AWS-owned service default."
  type        = string
  default     = ""
}

variable "deletion_protection" {
  description = "Protect the durable v2 execution table from deletion"
  type        = bool
  default     = true
}

variable "aws_region" {
  description = "AWS region"
  type        = string
}

variable "docker_build_args" {
  description = "Optional arguments passed to the AgentCore Docker build"
  type        = map(string)
  default     = {}
  sensitive   = true
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

variable "bedrock_region" {
  description = "AWS region the agent CLIs send Bedrock inference to (BEDROCK_REGION)"
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
    condition     = var.codex_model == "" || can(regex("^openai\\.[A-Za-z0-9][A-Za-z0-9._-]*$", var.codex_model))
    error_message = "codex_model must be a full Bedrock OpenAI model id: \"openai.\" followed by a model name (e.g. openai.gpt-5.5)."
  }
}

variable "disabled_clis" {
  description = "Agent CLIs that cannot be selected for new intents, seeded into the disabled-clis SSM parameter (empty = all enabled; Admin UI managed afterwards)"
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for cli in var.disabled_clis : contains(["kiro", "claude", "opencode", "codex"], cli)])
    error_message = "disabled_clis may only contain kiro, claude, opencode, or codex."
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

variable "image_tag" {
  description = "Tag of a pre-built image in the AgentCore ECR repository (plus <tag>-amd64 when build_amd64_image is true). When set, the image is not built here."
  type        = string
  default     = null
}

variable "build_amd64_image" {
  description = "Also build an amd64 variant of the core image (required for x86_64 managed environments on the Instances compute type)"
  type        = bool
  default     = false
}

variable "iam_role_path" {
  description = "Path for the IAM roles this module creates"
  type        = string
  default     = "/"
}

variable "iam_permissions_boundary_arn" {
  description = "Permissions boundary for the IAM roles this module creates; empty sets none"
  type        = string
  default     = ""
}

variable "enable_mcp_gateway" {
  description = "Serve the built-in aidlc MCP tools through AgentCore Gateway and a grant-verifying Lambda instead of the in-runtime MCP server"
  type        = bool
  default     = false
}

variable "enable_engine_data" {
  description = "Route the engine's process state, knowledge graph, catalog, blob and realtime calls through the grant-verifying engine-data Lambda, and its credential/secret and source-control review calls through the credential broker and the source-control runtime alias (requires enable_mcp_gateway)"
  type        = bool
  default     = false
}

variable "mcp_gateway_custom_targets" {
  description = <<-EOT
    Customer MCP servers served behind the AgentCore Gateway as remote MCP targets (requires enable_mcp_gateway). The map key is the Gateway target name: agents see its tools as <name>___<tool>, and the allow rules below refer to it, so treat it as immutable; renaming creates a new target. The outbound credential comes from an AgentCore Identity credential provider created out of band (no secret in Terraform state) and is injected by the Gateway; the agent runtime never holds it.
      endpoint                       Streamable HTTP MCP endpoint (https://).
      description                    Optional target description.
      auth.type                      "oauth" (client credentials) or "api_key".
      auth.credential_provider_arn   AgentCore Identity OAuth2 or API-key credential provider ARN.
      auth.secret_arn                The Secrets Manager secret ARN the provider returned (the Gateway role reads it).
      auth.scopes                    OAuth scopes to request (oauth only; at most 100, each 1-64 characters).
      auth.custom_parameters         Extra token request parameters, e.g. audience or resource (oauth only; at most 10).
      auth.credential_location       "HEADER" or "QUERY_PARAMETER" (api_key only).
      auth.parameter_name            Header or query parameter carrying the key (api_key only).
      auth.prefix                    Value prefix, e.g. "Bearer" (api_key only).
      private_endpoint               Optional VPC Lattice egress: managed_vpc_resource or self_managed_lattice_resource, as on aws_bedrockagentcore_gateway_target.
      allow.project_ids              Spaces whose stage sessions may call the target (exact match, required).
      allow.stage_ids                Stages that may call it; null allows every stage.
      allow.tools                    Tool names (without the target prefix) that may be called; null allows every tool.
    Only stage sessions are ever allowed; discussion and conflict sessions are denied. Changes to allow rules, endpoints and providers apply live, including to stages that are already running.
  EOT
  type = map(object({
    endpoint    = string
    description = optional(string)
    auth = object({
      type                    = string
      credential_provider_arn = string
      secret_arn              = string
      scopes                  = optional(list(string), [])
      custom_parameters       = optional(map(string))
      credential_location     = optional(string)
      parameter_name          = optional(string)
      prefix                  = optional(string)
    })
    private_endpoint = optional(object({
      managed_vpc_resource = optional(object({
        vpc_identifier           = string
        subnet_ids               = list(string)
        endpoint_ip_address_type = string
        security_group_ids       = optional(list(string))
        routing_domain           = optional(string)
      }))
      self_managed_lattice_resource = optional(object({
        resource_configuration_identifier = string
      }))
    }))
    allow = object({
      project_ids = list(string)
      stage_ids   = optional(list(string))
      tools       = optional(list(string))
    })
  }))
  default  = {}
  nullable = false

  validation {
    # Lowercase Gateway target names: never `___`, never the built-in target.
    condition = alltrue([
      for name in keys(var.mcp_gateway_custom_targets) :
      can(regex("^[a-z0-9](-?[a-z0-9]){0,31}$", name)) && name != "aidlc"
    ])
    error_message = "mcp_gateway_custom_targets names must be up to 32 lowercase letters and digits with single hyphens between them, and must not be \"aidlc\"."
  }
  validation {
    condition = alltrue([
      for t in values(var.mcp_gateway_custom_targets) : can(regex("^https://[^\\s]+$", t.endpoint))
    ])
    error_message = "mcp_gateway_custom_targets endpoints must be https:// URLs."
  }
  validation {
    # The ARN as returned by Create*CredentialProvider (`bedrock-agentcore`). It
    # is also the IAM resource of the Gateway role, so the `acps` form some API
    # reference examples show is refused: IAM would never match it.
    condition = alltrue([
      for t in values(var.mcp_gateway_custom_targets) :
      (t.auth.type == "oauth" && can(regex("^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:[0-9]{12}:token-vault/[^/]+/oauth2credentialprovider/[^/]+$", t.auth.credential_provider_arn))) ||
      (t.auth.type == "api_key" && can(regex("^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:[0-9]{12}:token-vault/[^/]+/apikeycredentialprovider/[^/]+$", t.auth.credential_provider_arn)))
    ])
    error_message = "mcp_gateway_custom_targets auth.type must be \"oauth\" or \"api_key\" with a matching AgentCore Identity credential provider ARN in the arn:<partition>:bedrock-agentcore:... form returned by create-oauth2-credential-provider or create-api-key-credential-provider (not acps)."
  }
  validation {
    condition = alltrue([
      for t in values(var.mcp_gateway_custom_targets) :
      can(regex("^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:.+$", t.auth.secret_arn))
    ])
    error_message = "mcp_gateway_custom_targets auth.secret_arn must be the Secrets Manager secret ARN of the credential provider."
  }
  validation {
    condition = alltrue([
      for t in values(var.mcp_gateway_custom_targets) :
      t.auth.type == "oauth" ? (
        t.auth.credential_location == null && t.auth.parameter_name == null && t.auth.prefix == null
        ) : (
        length(t.auth.scopes) == 0 && t.auth.custom_parameters == null &&
        contains(["HEADER", "QUERY_PARAMETER", "-"], t.auth.credential_location == null ? "-" : t.auth.credential_location)
      )
    ])
    error_message = "mcp_gateway_custom_targets: scopes and custom_parameters apply to oauth only; credential_location (HEADER or QUERY_PARAMETER), parameter_name and prefix apply to api_key only."
  }
  validation {
    # AgentCore Gateway limits for an OAuth credential provider configuration.
    condition = alltrue([
      for t in values(var.mcp_gateway_custom_targets) :
      length(t.auth.scopes) <= 100 &&
      alltrue([for scope in t.auth.scopes : length(scope) >= 1 && length(scope) <= 64]) &&
      (t.auth.custom_parameters == null || try(
        length(t.auth.custom_parameters) <= 10 &&
        alltrue([for k, v in t.auth.custom_parameters : trimspace(k) != "" && length(k) <= 256 && v != null && length(v) >= 1 && length(v) <= 2048]),
        false
      ))
    ])
    error_message = "mcp_gateway_custom_targets auth.scopes holds at most 100 scopes of 1-64 characters each; auth.custom_parameters holds at most 10 entries with keys of 1-256 characters and values of 1-2048 characters."
  }
  validation {
    condition = alltrue([
      for t in values(var.mcp_gateway_custom_targets) :
      length(t.allow.project_ids) > 0 &&
      alltrue([for p in t.allow.project_ids : trimspace(p) != ""]) &&
      (t.allow.stage_ids == null || try(length(t.allow.stage_ids) > 0, false)) &&
      alltrue([for s in(t.allow.stage_ids == null ? [] : t.allow.stage_ids) : trimspace(s) != ""]) &&
      (t.allow.tools == null || try(length(t.allow.tools) > 0, false)) &&
      alltrue([for tool in(t.allow.tools == null ? [] : t.allow.tools) : trimspace(tool) != "" && !strcontains(tool, "___")])
    ])
    error_message = "mcp_gateway_custom_targets allow.project_ids must list at least one space; stage_ids and tools are null (all) or non-empty lists, and tool names carry no target prefix."
  }
  validation {
    condition = alltrue([
      for t in values(var.mcp_gateway_custom_targets) :
      t.private_endpoint == null || (
        (try(t.private_endpoint.managed_vpc_resource, null) == null) != (try(t.private_endpoint.self_managed_lattice_resource, null) == null)
      )
    ])
    error_message = "mcp_gateway_custom_targets private_endpoint sets exactly one of managed_vpc_resource or self_managed_lattice_resource."
  }
}

variable "runtime_mcp_credentials" {
  description = "Custom MCP credential profile: \"allow\" (default) or \"gateway_only\", in which the runtime refuses direct custom MCP servers and its role can read no MCP secret and fetch no AgentCore Identity credential (requires enable_mcp_gateway and enable_engine_data)"
  type        = string
  default     = "allow"

  validation {
    condition     = contains(["allow", "gateway_only"], var.runtime_mcp_credentials)
    error_message = "runtime_mcp_credentials must be \"allow\" or \"gateway_only\"."
  }
}
