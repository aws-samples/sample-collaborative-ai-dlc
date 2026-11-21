locals {
  # Build context is the repo `lambda/` dir so the image can COPY both the
  # agentcore package and the shared/ helpers it imports via ../shared.
  agentcore_source_path = abspath("${path.module}/../../../../lambda")

  agentcore_files_sha = module.runtime_source.sha1
  # The optional fixture changes image bytes independently of application code.
  agentcore_image_tag = substr(sha1("${local.agentcore_files_sha}:${var.enable_native_interaction_probe}"), 0, 16)

  agentcore_build_args = merge(var.docker_build_args, {
    ENABLE_NATIVE_INTERACTION_PROBE = tostring(var.enable_native_interaction_probe)
  })
}

module "runtime_source" {
  source      = "./runtime-source"
  source_path = local.agentcore_source_path
}

data "external" "qualified_arm64" {
  count   = var.native_image_qualification == null ? 0 : 1
  program = ["node", "${local.agentcore_source_path}/../scripts/qualified-arm64-image.mjs"]
  query = {
    receipt     = var.native_image_qualification.path
    sha256      = var.native_image_qualification.sha256
    source_path = local.agentcore_source_path
    source_sha  = local.agentcore_files_sha
    source_tag  = local.agentcore_image_tag
  }
  lifecycle {
    precondition {
      condition     = tomap(jsondecode(file(var.native_image_qualification.path)).build.args) == tomap(local.agentcore_build_args)
      error_message = "Effective Docker build arguments differ from the qualified ARM64 build."
    }
  }
}
