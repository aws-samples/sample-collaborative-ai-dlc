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

variable "existing_vpc_id" {
  description = "ID of an existing VPC to deploy into instead of creating one. When set, no VPC, subnets, internet or NAT gateways or route tables are created; only the default security group is created in this VPC"
  type        = string
  default     = null
}

variable "existing_private_subnet_ids" {
  description = "Private subnet IDs in existing_vpc_id, each with an explicit route table association that provides internet egress (for example through a NAT gateway). Required when existing_vpc_id is set"
  type        = list(string)
  default     = []
}
