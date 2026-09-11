variable "project_name" {
  description = "Name of the project"
  type        = string
}

variable "documents_table_name" {
  type = string
}

variable "documents_table_arn" {
  type = string
}

variable "snapshots_bucket_name" {
  type = string
}

variable "snapshots_bucket_arn" {
  type = string
}

variable "scaling" {
  description = "Worker sizing and optional sharding/autoscaling; CPU units and memory in MiB."
  type = object({
    cluster_enabled          = optional(bool, false)
    cpu                      = optional(number)
    memory                   = optional(number)
    desired_count            = optional(number, 1)
    max_connections          = optional(number, 2000)
    max_documents            = optional(number, 256)
    max_document_bytes       = optional(number, 8388608)
    max_total_document_bytes = optional(number, 67108864)
    max_buffered_bytes       = optional(number, 16777216)
    alarm_actions            = optional(list(string), [])
    autoscaling = optional(object({
      min_capacity = optional(number, 2)
      max_capacity = optional(number, 8)
    }))
  })
  default = {}

  validation {
    condition = (
      var.scaling.desired_count >= 1 && var.scaling.desired_count <= 64 &&
      floor(var.scaling.desired_count) == var.scaling.desired_count &&
      (var.scaling.cluster_enabled || (var.scaling.desired_count == 1 && var.scaling.autoscaling == null))
    )
    error_message = "Use 1–64 workers. Multiple workers and autoscaling require cluster_enabled."
  }

  validation {
    condition = var.scaling.autoscaling == null ? true : (
      var.scaling.autoscaling.min_capacity >= 2 &&
      var.scaling.autoscaling.max_capacity >= var.scaling.autoscaling.min_capacity &&
      var.scaling.autoscaling.max_capacity <= 64 &&
      floor(var.scaling.autoscaling.min_capacity) == var.scaling.autoscaling.min_capacity &&
      floor(var.scaling.autoscaling.max_capacity) == var.scaling.autoscaling.max_capacity
    )
    error_message = "Autoscaling requires integer bounds with 2 <= min_capacity <= max_capacity <= 64."
  }

  validation {
    condition = alltrue([
      for value in [
        var.scaling.max_connections, var.scaling.max_documents, var.scaling.max_document_bytes,
        var.scaling.max_total_document_bytes, var.scaling.max_buffered_bytes,
      ] : value > 0 && floor(value) == value
      ]) && (
      var.scaling.max_document_bytes + 1024 <= var.scaling.max_buffered_bytes &&
      var.scaling.max_document_bytes <= var.scaling.max_total_document_bytes
    )
    error_message = "Limits must be positive integers; the buffer must fit a document plus framing, and the total budget must fit a document."
  }
}

variable "environment" {
  description = "Environment (dev/prod)"
  type        = string
}

variable "aws_region" {
  description = "AWS region"
  type        = string
}

variable "docker_build_args" {
  description = "Optional arguments passed to the Yjs server Docker build"
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "vpc_id" {
  description = "VPC ID"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for ECS tasks and ALB"
  type        = list(string)
}

variable "cognito_user_pool_id" {
  description = "Cognito User Pool ID used to verify JWTs on WebSocket upgrade"
  type        = string
}

variable "cognito_client_id" {
  description = "Cognito User Pool Client ID used to verify JWTs on WebSocket upgrade"
  type        = string
}


variable "realtime_doc_secret_param_arn" {
  description = "SSM parameter ARN of the realtime doc-token secret (injected as ECS secret)"
  type        = string
}

variable "doc_token_enforce" {
  description = "Enforce realtime scope tokens on the Yjs upgrade path (operational kill switch)"
  type        = bool
  default     = true
}

variable "build_after" {
  description = <<-EOT
    Opaque value used ONLY to serialize this module's docker build after
    another image build (pass that build's image URI). Concurrent builds
    from separate kreuzwerker/docker provider instances deadlock at build
    context transfer (both hang at 0/0 steps). The value never influences
    the image content or tag.
  EOT
  type        = string
  default     = ""
}
