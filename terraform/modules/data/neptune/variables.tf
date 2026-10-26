variable "name_prefix" {
  description = "Prefix for resource names"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID where Neptune will be deployed"
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR block for security group rules"
  type        = string
}

variable "private_subnet_ids" {
  description = "List of private subnet IDs for Neptune subnet group"
  type        = list(string)
}

variable "instance_class" {
  description = "Neptune instance class"
  type        = string
  default     = "db.t3.medium"
}

variable "skip_final_snapshot" {
  description = "Skip final snapshot when destroying cluster"
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Protect the Neptune cluster from deletion"
  type        = bool
  default     = true
}

variable "backup_retention_period" {
  description = "Number of days to retain automated Neptune backups"
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_period >= 7 && var.backup_retention_period <= 35
    error_message = "backup_retention_period must be between 7 and 35 days."
  }
}

variable "streams_enabled" {
  description = "Enable Neptune Streams in the cluster parameter group"
  type        = bool
  default     = false
}

variable "streams_expiry_days" {
  description = "Days Neptune keeps stream records (1-90)"
  type        = number
  default     = 7

  validation {
    condition     = var.streams_expiry_days >= 1 && var.streams_expiry_days <= 90 && floor(var.streams_expiry_days) == var.streams_expiry_days
    error_message = "streams_expiry_days must be a whole number of days between 1 and 90."
  }
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
