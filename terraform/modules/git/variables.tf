variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "kms_key_arn" {
  description = "Customer-managed KMS key ARN for DynamoDB encryption. Empty uses the AWS-owned service default."
  type        = string
  default     = ""
}

variable "deletion_protection" {
  description = "Protect durable integration tables from deletion"
  type        = bool
  default     = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
