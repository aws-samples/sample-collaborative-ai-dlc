mock_provider "docker" {
  mock_data "docker_image" {
    defaults = { id = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  }
  mock_resource "docker_image" {
    defaults = { image_id = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  }
  mock_resource "docker_registry_image" {
    defaults = { sha256_digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  }
}

variables {
  name        = "registry.example/agentcore:0123456789abcdef"
  qualified   = { tag = "qualified:0123456789abcdef", index = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  source_path = "../lambda"
  build_args  = { ENABLE_NATIVE_INTERACTION_PROBE = "true" }
  triggers    = { dir_sha = "source", native_interaction_probe = "true" }
}

run "qualified_publisher" {
  module { source = "./modules/compute/agentcore/image-build" }
  assert {
    condition = (
      length(docker_image.this.build) == 0 && docker_image.this.name == var.qualified.index && docker_image.this.keep_locally &&
      docker_tag.qualified[0].source_image == var.qualified.index && docker_tag.qualified[0].target_image == var.name &&
      docker_registry_image.this.name == var.name && docker_registry_image.this.keep_remotely
    )
    error_message = "Publish exactly the retained local index at the derived release name."
  }
}

run "ordinary_source_build" {
  module { source = "./modules/compute/agentcore/image-build" }
  variables { qualified = null }
  assert {
    condition = (
      one(docker_image.this.build).platform == "linux/arm64" && one(docker_image.this.build).builder == "default" &&
      one(docker_image.this.build).dockerfile == "../lambda/agentcore/Dockerfile" &&
      one(docker_image.this.build).build_args == var.build_args && length(docker_tag.qualified) == 0 &&
      docker_registry_image.this.name == var.name && docker_registry_image.this.keep_remotely
    )
    error_message = "An unqualified installation must build and publish the configured ARM64 image."
  }
}

run "refuse_moved_qualification_tag" {
  command = plan
  module { source = "./modules/compute/agentcore/image-build" }
  override_data {
    target = data.docker_image.qualified[0]
    values = { id = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
  }
  expect_failures = [data.docker_image.qualified[0]]
}

run "refuse_moved_local_target" {
  module { source = "./modules/compute/agentcore/image-build" }
  override_data {
    target = data.docker_image.publisher[0]
    values = { id = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
  }
  expect_failures = [data.docker_image.publisher[0]]
}

run "refuse_moved_registry_tag" {
  module { source = "./modules/compute/agentcore/image-build" }
  override_resource {
    target = docker_registry_image.this
    values = { sha256_digest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
  }
  expect_failures = [docker_registry_image.this]
}
