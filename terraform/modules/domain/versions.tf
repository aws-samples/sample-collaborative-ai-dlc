# CloudFront only accepts viewer certificates from us-east-1, while the rest of
# the stack is deployed to var.aws_region. This module is the single place that
# needs the cross-region provider, so the alias is declared here instead of
# being threaded through modules/frontend.
terraform {
  required_version = ">= 1.4"

  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = "~> 6.0"
      configuration_aliases = [aws.us_east_1]
    }
  }
}
