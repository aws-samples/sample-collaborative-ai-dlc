# Keep the deployed docker_image.this and docker_registry_image.this addresses.
# The upstream docker-build module always emits a build, including on clean init.
terraform {
  required_providers {
    docker = { source = "kreuzwerker/docker", version = "~> 3.0" }
  }
}

variable "name" { type = string }
variable "source_path" { type = string }
variable "triggers" { type = map(string) }
variable "build_args" {
  type      = map(string)
  sensitive = true
}
variable "qualified" { type = object({ tag = string, index = string }) }

# Verify the retained qualification tag before any existing local publisher
# tag can be removed. The copy to the repository tag always uses the index ID.
data "docker_image" "qualified" {
  count = var.qualified == null ? 0 : 1
  name  = var.qualified.tag
  lifecycle {
    postcondition {
      condition     = self.id == var.qualified.index && self.name != var.name
      error_message = "Retain the qualified index under its separate local qualification tag."
    }
  }
}

resource "docker_image" "this" {
  name         = var.qualified == null ? var.name : data.docker_image.qualified[0].id
  keep_locally = var.qualified != null
  force_remove = false
  triggers     = var.triggers

  dynamic "build" {
    for_each = var.qualified == null ? [1] : []
    content {
      context    = var.source_path
      dockerfile = "${var.source_path}/agentcore/Dockerfile"
      build_args = var.build_args
      builder    = "default"
      platform   = "linux/arm64"
      cache_from = []
    }
  }
  lifecycle {
    postcondition {
      condition     = var.qualified == null ? true : self.image_id == var.qualified.index
      error_message = "Docker did not resolve the qualified local index."
    }
  }
}

resource "docker_tag" "qualified" {
  count        = var.qualified == null ? 0 : 1
  source_image = docker_image.this.image_id
  target_image = var.name
}

# docker_tag has a no-op Read in provider 3.9.0. Check the actual target
# before the publisher consumes its mutable name (also on later repairs).
data "docker_image" "publisher" {
  count = var.qualified == null ? 0 : 1
  name  = docker_tag.qualified[0].target_image
  lifecycle {
    postcondition {
      condition     = self.id == var.qualified.index
      error_message = "The local publication tag does not name the qualified index."
    }
  }
}

# A change in build mode or effective arguments must publish the new bytes.
# Keep the repository trigger independent of the local checkout directory.
resource "terraform_data" "publication_configuration" {
  input = {
    build_from_source = var.qualified == null
    build_args_sha256 = sha256(jsonencode(var.build_args))
  }
}

resource "docker_registry_image" "this" {
  depends_on    = [data.docker_image.publisher]
  name          = var.qualified == null ? docker_image.this.name : docker_tag.qualified[0].target_image
  keep_remotely = true
  triggers      = var.triggers
  lifecycle {
    replace_triggered_by = [terraform_data.publication_configuration.input]
    postcondition {
      condition     = var.qualified == null ? true : self.sha256_digest == var.qualified.index
      error_message = "The published source tag does not resolve to the qualified index."
    }
  }
}

output "image_uri" { value = docker_registry_image.this.name }
