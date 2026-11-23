variable "project_name" { type = string }
variable "environment" { type = string }
variable "vpc_id" { type = string }
variable "runtime_subnet_ids" { type = list(string) }
variable "api_subnet_ids" { type = list(string) }
variable "api_security_group_ids" { type = list(string) }
variable "neptune_endpoint" { type = string }
variable "neptune_cluster_resource_id" { type = string }
variable "workflow_source_bindings_table_name" { type = string }
variable "workflow_source_bindings_table_arn" { type = string }
variable "package_jobs_table_name" { type = string }
variable "package_jobs_table_arn" { type = string }
variable "image_repository_url" { type = string }
variable "image_repository_arn" { type = string }
variable "image_digest" { type = string }
variable "image_arm64_manifest_digest" {
  type        = string
  description = "Qualified ARM64 child manifest of image_digest, used by the protected engine Lambda"
  validation {
    condition     = can(regex("^sha256:[a-f0-9]{64}$", var.image_arm64_manifest_digest))
    error_message = "The protected workflow engine requires an immutable ARM64 image manifest."
  }
}
variable "tags" { type = map(string) }

variable "execution_enabled" {
  description = "Admit new native executions; preparation remains separately available"
  type        = bool
  default     = false
}
variable "native_packages_bucket_name" { type = string }
variable "native_packages_bucket_arn" { type = string }
variable "artifacts_bucket_name" { type = string }
variable "artifacts_bucket_arn" { type = string }
variable "source_control_function_arn" { type = string }
variable "trackers_function_arn" { type = string }
variable "source_control_bindings_table_name" { type = string }
variable "source_control_bindings_table_arn" { type = string }
variable "git_connections_table_name" { type = string }
variable "git_connections_table_arn" { type = string }
variable "git_provider_connections_table_name" { type = string }
variable "git_provider_connections_table_arn" { type = string }
variable "github_app_config_param_name" { type = string }
variable "github_app_config_param_arn" { type = string }
variable "github_app_private_key_secret_name" { type = string }
variable "github_app_private_key_secret_arn" { type = string }
variable "gitlab_oauth_secret_name" { type = string }
variable "gitlab_oauth_secret_arn" { type = string }
variable "gitlab_redirect_uri" { type = string }
variable "bitbucket_oauth_secret_name" { type = string }
variable "bitbucket_oauth_secret_arn" { type = string }
variable "agent_credential_metadata_function_arn" { type = string }

variable "connections_table_name" { type = string }
variable "connections_table_arn" { type = string }
variable "websocket_endpoint" { type = string }
variable "websocket_execution_arn" { type = string }

variable "preparation_admission_enabled" {
  type    = bool
  default = false
}
variable "cognito_user_pool_id" { type = string }
variable "cognito_client_id" { type = string }

variable "native_repair_table_name" { type = string }
variable "native_repair_table_arn" { type = string }
variable "yjs_documents_table_name" { type = string }
variable "yjs_documents_table_arn" { type = string }
variable "kms_key_arn" { type = string }
variable "native_operations" {
  type = object({
    alarm_actions           = optional(list(string), [])
    incident_owner          = optional(string, "")
    full_scan_alarm_seconds = optional(number, 1800)
  })
  default = {}
}

# Deployment-owned controller roles follow the platform IAM settings. Dynamically
# provisioned runtime roles keep /native-runs/ and the native maximum boundary.
variable "iam_role_path" {
  description = "Path for native controller roles; dynamic runtime roles remain under /native-runs/"
  type        = string
  default     = "/"
}
variable "iam_permissions_boundary_arn" {
  description = "Optional boundary for native controller roles; does not replace native runtime isolation"
  type        = string
  default     = ""
}
