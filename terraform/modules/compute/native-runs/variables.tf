variable "project_name" { type = string }
variable "environment" { type = string }
variable "project_ids" { type = list(string) }
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
variable "tags" { type = map(string) }

variable "execution_enabled" {
  description = "Opt in to the connected native execution pilot; preparation remains separately available"
  type        = bool
  default     = false
}
variable "native_packages_bucket_name" { type = string }
variable "native_packages_bucket_arn" { type = string }
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
variable "native_operations" {
  type = object({
    alarm_actions           = optional(list(string), [])
    incident_owner          = optional(string, "")
    full_scan_alarm_seconds = optional(number, 1800)
  })
  default = {}
}
