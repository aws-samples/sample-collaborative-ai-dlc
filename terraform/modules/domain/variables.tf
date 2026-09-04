variable "project_name" {
  description = "Name of the project"
  type        = string
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "enabled" {
  description = "Whether a custom domain is configured. When false the module creates nothing and returns an empty certificate ARN, so CloudFront falls back to its default certificate."
  type        = bool
  default     = false
}

variable "domain_name" {
  description = "Canonical hostname the certificate is issued for."
  type        = string
  default     = ""
}

variable "aliases" {
  description = "Additional hostnames added to the certificate as subject alternative names."
  type        = list(string)
  default     = []
}

variable "certificate_arn" {
  description = "ARN of an existing us-east-1 ACM certificate. When set the module issues nothing and simply passes the ARN through, which is the bring-your-own-certificate path for centrally managed, imported or private-CA certificates."
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "Route53 hosted zone ID used to publish the DNS validation records. Required when the module issues the certificate itself."
  type        = string
  default     = ""
}

variable "validation_record_ttl" {
  description = "TTL for the ACM DNS validation records."
  type        = number
  default     = 60
}

variable "certificate_release_delay" {
  description = "Internal safety delay after CloudFront stops using a Terraform-managed certificate. The root deployment uses the 5m default because CloudFront releases certificates asynchronously and deleting immediately can fail with ResourceInUseException. Only applies when Terraform owns the certificate, and only on the way out — removing or renaming a domain takes this much longer."
  type        = string
  default     = "5m"
}
