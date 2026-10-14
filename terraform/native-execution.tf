# Source configuration can be qualified independently of native execution.
# Turning this on does not expose a native start route or enable a backend.
variable "enable_native_workflow_sources" {
  description = "Enable the dedicated workflow-source configuration API for staged qualification"
  type        = bool
  default     = false
}

output "native_workflow_source_api_enabled" {
  description = "Whether workflow-source configuration is enabled; native execution has a separate qualification gate"
  value       = var.enable_native_workflow_sources
}

# A disposable operator experiment, not a project execution backend or UI route.
variable "enable_native_interaction_probe" {
  description = "Enable the fixed public-package interaction experiment in dev only"
  type        = bool
  default     = false
}

variable "enable_native_efs_probe" {
  description = "Opt in to synthetic EFS storage for the dev native interaction experiment"
  type        = bool
  default     = false
}

output "native_packages_bucket_name" {
  description = "Private versioned bucket reserved for native package intake; no runtime-wide read grant"
  value       = module.s3.native_packages_bucket_name
}

# These settings describe a disabled package-import prototype. The values below
# have not been accepted as live resource limits. They never limit agent turns.
variable "enable_native_package_jobs" {
  description = "Enable package-import submission/dispatch after the host qualification gate"
  type        = bool
  default     = false
}

variable "native_package_jobs_host_qualified" {
  description = "Technical qualification gate for package imports; see docs/concepts/native-execution.md#package-integrity before changing"
  type        = bool
  default     = false
}

variable "native_package_worker_memory_size" {
  description = "Package-import worker memory in MiB; provisional while disabled"
  type        = number
  default     = 2048
}

variable "native_package_worker_ephemeral_storage_size" {
  description = "Package-import temporary disk in MiB; provisional while disabled"
  type        = number
  default     = 4096
}

variable "native_package_worker_timeout_seconds" {
  description = "Maximum Lambda invocation duration for package imports"
  type        = number
  default     = 600
}

variable "native_package_worker_reserved_concurrency" {
  description = "Package workers allowed to execute concurrently"
  type        = number
  default     = 1
}

variable "native_package_worker_max_attempts" {
  description = "Maximum leased attempts for the same immutable import job"
  type        = number
  default     = 3
}

variable "native_package_worker_lease_seconds" {
  description = "Worker lease duration; null derives a duration longer than the Lambda timeout"
  type        = number
  default     = null
}

variable "native_package_jobs_max_receive_count" {
  description = "SQS deliveries before dead-letter routing, distinct from actual worker attempts"
  type        = number
  default     = 10
}

variable "enable_native_package_storage_probe" {
  description = "Deploy the temporary dev storage probe without invoking it or enabling imports"
  type        = bool
  default     = false
}

variable "native_package_storage_probe_run_id" {
  description = "Fixed UUID v4 for synthetic live storage fixtures; required only while the probe is deployed"
  type        = string
  default     = ""
}

output "native_package_storage_probe_function_name" {
  description = "Temporary operator-only diagnostic function, or null when absent"
  value       = module.lambda.native_package_storage_probe_function_name
}

output "native_package_jobs_table_name" {
  value       = module.dynamodb.native_package_jobs_table_name
  description = "Protected import job table for operator inspection and recovery"
}

output "native_package_jobs_queue_url" {
  value       = module.lambda.native_package_jobs_queue_url
  description = "Protected queue for package import pointers"
}

output "native_package_worker_lambda_name" {
  value       = module.lambda.native_package_worker_lambda_name
  description = "Dedicated package import worker"
}

output "native_package_jobs_dead_letter_queue_arn" {
  value       = module.lambda.native_package_jobs_dead_letter_queue_arn
  description = "Worker dead-letter queue; requires operator recovery"
}

output "native_package_jobs_dispatch_dead_letter_queue_arn" {
  value       = module.lambda.native_package_jobs_dispatch_dead_letter_queue_arn
  description = "Dispatch dead-letter queue; raw records must not be replayed as job authority"
}

variable "native_operations" {
  description = "Native alarm routing. Empty actions/owner leave notifications/ownership unconfigured; scan alarm window is a diagnostic threshold, not an agreed repair SLO."
  type = object({
    alarm_actions           = optional(list(string), [])
    incident_owner          = optional(string, "")
    full_scan_alarm_seconds = optional(number, 1800)
  })
  default = {}
  validation {
    condition     = var.native_operations.full_scan_alarm_seconds >= 300 && var.native_operations.full_scan_alarm_seconds <= 86400 && var.native_operations.full_scan_alarm_seconds % 60 == 0
    error_message = "Full scan alarm window must be a multiple of 60 seconds between 300 and 86400."
  }
}

output "native_operations_configuration" {
  value = {
    alarm_actions            = var.native_operations.alarm_actions
    incident_owner           = var.native_operations.incident_owner
    notifications_configured = length(var.native_operations.alarm_actions) > 0
    ownership_configured     = trimspace(var.native_operations.incident_owner) != ""
    full_scan_alarm_seconds  = var.native_operations.full_scan_alarm_seconds
  }
}
