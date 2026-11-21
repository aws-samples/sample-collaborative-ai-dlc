variable "source_path" { type = string }

locals {
  inventory = ["node", "${var.source_path}/../scripts/agentcore-source-inventory.mjs"]
}

data "external" "planned" {
  program = local.inventory
  query   = { source_path = var.source_path }
}

# A saved plan carries the first read. Read the working tree again before any
# consumer can build or publish under the planned tag. Only this read is deferred.
data "external" "at_apply" {
  program = local.inventory
  query   = { source_path = var.source_path, verify_at = timestamp() }
}

output "sha1" {
  value = data.external.planned.result.source_sha1
  precondition {
    condition     = data.external.planned.result.inventory_sha256 == data.external.at_apply.result.inventory_sha256
    error_message = "AgentCore image inputs changed after planning. Create and review a fresh plan."
  }
}
