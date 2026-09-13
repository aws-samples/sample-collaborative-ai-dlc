variable "name_prefix" {
  description = "Prefix used for the shared data key alias and description"
  type        = string
}

variable "tags" {
  description = "Tags to apply to the KMS key"
  type        = map(string)
  default     = {}
}
