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

locals {
  ecr_registry_address = format("%v.dkr.ecr.%v.%v", data.aws_caller_identity.current.account_id, data.aws_region.current.region, data.aws_partition.current.dns_suffix)
}

provider "docker" {
  # Support for Podman via DOCKER_HOST environment variable (e.g., unix:///path/to/podman.sock)
  # If DOCKER_HOST is not set, defaults to the standard Docker socket
  # Compatibility shim for destroying orphaned v1 agent image-build state.
  registry_auth {
    address = local.ecr_registry_address
    # Suppress DOCKER_REGISTRY_USER/PASS defaults, which otherwise take priority.
    username = ""
    password = ""
    config_file_content = jsonencode({
      credHelpers = { (local.ecr_registry_address) = "ecr-login" }
    })
  }
}
