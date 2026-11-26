variable "enable_native_preparation" {
  description = "Enable the dev native draft/workspace preparation pilot; does not enable model dispatch"
  type        = bool
  default     = false
}

variable "enable_native_execution" {
  description = "Opt in to connected native execution in dev for the preparation project allowlist"
  type        = bool
  default     = false
}

resource "terraform_data" "native_execution_configuration" {
  count = var.enable_native_execution ? 1 : 0
  lifecycle {
    precondition {
      condition = (
        var.environment == "dev" && var.enable_native_preparation &&
        var.enable_native_workflow_sources && var.enable_native_package_jobs &&
        length(var.native_preparation_project_ids) > 0
      )
      error_message = "Native execution requires dev, native preparation/workflow sources/package jobs, and the explicit preparation project allowlist."
    }
  }
}

variable "native_preparation_project_ids" {
  description = "Explicit project IDs allowed to prepare native runs in the dev pilot"
  type        = list(string)
  default     = []
}

variable "native_preparation_existing_https_rule_id" {
  description = "One-time adoption of an existing inline runtime HTTPS rule; pass only when planning the rule ownership migration"
  type        = string
  default     = null
  validation {
    condition     = var.native_preparation_existing_https_rule_id == null ? true : can(regex("^sgr-[0-9a-f]+$", var.native_preparation_existing_https_rule_id))
    error_message = "Use an existing security-group rule ID (sgr-...), or omit this migration input."
  }
}

# Existing deployments keep the same rule and connectivity during migration.
# New installations create the standalone rule normally.
import {
  for_each = var.enable_native_preparation && var.native_preparation_existing_https_rule_id != null ? { existing = var.native_preparation_existing_https_rule_id } : {}
  to       = module.native_runs[0].aws_vpc_security_group_egress_rule.runtime_https
  id       = each.value
}

module "native_runs" {
  source = "./modules/compute/native-runs"
  count  = var.enable_native_preparation ? 1 : 0

  project_name                        = var.project_name
  environment                         = var.environment
  project_ids                         = var.native_preparation_project_ids
  vpc_id                              = module.networking.vpc_id
  runtime_subnet_ids                  = module.agentcore.runtime_subnet_ids
  api_subnet_ids                      = module.networking.private_subnet_ids
  api_security_group_ids              = [module.lambda.lambda_security_group_id]
  neptune_endpoint                    = module.neptune.cluster_endpoint
  neptune_cluster_resource_id         = module.neptune.cluster_resource_id
  workflow_source_bindings_table_name = module.dynamodb.workflow_source_bindings_table_name
  workflow_source_bindings_table_arn  = module.dynamodb.workflow_source_bindings_table_arn
  package_jobs_table_name             = module.dynamodb.native_package_jobs_table_name
  package_jobs_table_arn              = module.dynamodb.native_package_jobs_table_arn
  image_repository_url                = module.agentcore.ecr_repository_url
  image_repository_arn                = module.agentcore.ecr_repository_arn
  image_digest                        = module.agentcore.image_digest
  execution_enabled                   = var.enable_native_execution
  native_packages_bucket_name         = module.s3.native_packages_bucket_name
  native_packages_bucket_arn          = module.s3.native_packages_bucket_arn
  source_control_bindings_table_name  = module.git.source_control_bindings_table_name
  source_control_bindings_table_arn   = module.git.source_control_bindings_table_arn
  git_connections_table_name          = module.git.git_connections_table_name
  git_connections_table_arn           = module.git.git_connections_table_arn
  git_provider_connections_table_name = module.git.git_provider_connections_table_name
  git_provider_connections_table_arn  = module.git.git_provider_connections_table_arn
  github_app_config_param_name        = module.git.github_app_config_param_name
  github_app_config_param_arn         = module.git.github_app_config_param_arn
  github_app_private_key_secret_name  = module.git.github_app_private_key_secret_name
  github_app_private_key_secret_arn   = module.git.github_app_private_key_secret_arn
  gitlab_oauth_secret_name            = module.git.gitlab_oauth_secret_name
  gitlab_oauth_secret_arn             = module.git.gitlab_oauth_secret_arn
  gitlab_redirect_uri                 = "${local.app_url}/gitlab/callback"
  bitbucket_oauth_secret_name         = module.git.bitbucket_oauth_secret_name
  bitbucket_oauth_secret_arn          = module.git.bitbucket_oauth_secret_arn
  # Existing metadata-only function. Naming matches module.lambda's local ARN;
  # avoid a dependency on the legacy runtime-callable broker role or module.
  agent_credential_metadata_function_arn = "arn:${data.aws_partition.current.partition}:lambda:${var.aws_region}:${split(":", module.agentcore.ecr_repository_arn)[4]}:function:${var.project_name}-credential-metadata-${var.environment}"
  tags                                   = { Environment = var.environment, Project = var.project_name }
}

output "native_runtime_bindings_table_name" {
  value = try(module.native_runs[0].bindings_table_name, null)
}
output "native_runtime_file_system_id" {
  value = try(module.native_runs[0].file_system_id, null)
}
output "native_runtime_provisioning_queue_url" {
  value = try(module.native_runs[0].provisioning_queue_url, null)
}
output "native_execution_publication_bucket_name" {
  value = try(module.native_runs[0].publication_bucket_name, null)
}
output "native_execution_queue_url" {
  value = try(module.native_runs[0].execution_queue_url, null)
}
output "native_execution_worker_function_name" {
  value = try(module.native_runs[0].execution_worker_function_name, null)
}
