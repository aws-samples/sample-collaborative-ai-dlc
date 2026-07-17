terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0"
    }
  }
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_ecr_authorization_token" "token" {}

provider "docker" {
  # Compatibility shim for destroying orphaned v1 agent image-build state.
  registry_auth {
    address  = format("%v.dkr.ecr.%v.%v", data.aws_caller_identity.current.account_id, data.aws_region.current.region, data.aws_partition.current.dns_suffix)
    username = data.aws_ecr_authorization_token.token.user_name
    password = data.aws_ecr_authorization_token.token.password
  }
}
