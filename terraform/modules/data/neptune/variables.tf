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
  default     = true
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}