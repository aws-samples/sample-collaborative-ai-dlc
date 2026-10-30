variable "project_name" {
  description = "Name of the project"
  type        = string
}

variable "environment" {
  description = "Environment name (dev, prod)"
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "vpc_block_public_access_exclusion" {
  description = "Exclude the private subnets (bidirectional) and the NAT gateway subnets (egress-only) from account-level VPC Block Public Access so CloudFront VPC origins can reach the internal ALB and the private subnets keep NAT egress"
  type        = bool
  default     = false
}
