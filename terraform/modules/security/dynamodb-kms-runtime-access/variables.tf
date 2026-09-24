variable "kms_key_arn" {
  description = "Customer-managed KMS key used by the DynamoDB tables. Empty disables these policies."
  type        = string
}

variable "dns_suffix" {
  description = "AWS partition DNS suffix used to restrict KMS access to DynamoDB."
  type        = string
}

variable "role_names" {
  description = "Stable caller identifiers mapped to IAM role names that access the encrypted DynamoDB tables."
  type        = map(string)
}
