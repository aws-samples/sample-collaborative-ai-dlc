mock_provider "aws" {}
mock_provider "random" {}

variables {
  name_prefix        = "neptune-test"
  vpc_id             = "vpc-12345678"
  vpc_cidr           = "10.0.0.0/16"
  private_subnet_ids = ["subnet-11111111", "subnet-22222222"]
}

run "streams_disabled_by_default" {
  command = plan
  module {
    source = "./modules/data/neptune"
  }

  assert {
    condition = toset([
      for p in aws_neptune_cluster_parameter_group.main.parameter : p.name
    ]) == toset(["neptune_enable_audit_log"])
    error_message = "Without streams the parameter group must keep only the audit log parameter."
  }
}

run "streams_enabled" {
  command = plan
  module {
    source = "./modules/data/neptune"
  }

  variables {
    streams_enabled     = true
    streams_expiry_days = 14
  }

  assert {
    condition = {
      for p in aws_neptune_cluster_parameter_group.main.parameter : p.name => p.value
      } == {
      neptune_enable_audit_log    = "1"
      neptune_streams             = "1"
      neptune_streams_expiry_days = "14"
    }
    error_message = "Streams must add neptune_streams and its expiry next to the audit log parameter."
  }

  assert {
    condition = alltrue([
      for p in aws_neptune_cluster_parameter_group.main.parameter :
      p.apply_method == "pending-reboot" if startswith(p.name, "neptune_streams")
    ])
    error_message = "Stream parameters are static and must apply on the next reboot."
  }
}

run "expiry_out_of_range" {
  command = plan
  module {
    source = "./modules/data/neptune"
  }

  variables {
    streams_enabled     = true
    streams_expiry_days = 91
  }

  expect_failures = [var.streams_expiry_days]
}
