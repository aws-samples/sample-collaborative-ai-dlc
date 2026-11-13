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
    condition = {
      for p in aws_neptune_cluster_parameter_group.main.parameter : p.name => p.value
      } == {
      neptune_enable_audit_log = "1"
      neptune_streams          = "0"
    }
    error_message = "Without streams the parameter group must set neptune_streams to 0 next to the audit log parameter."
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

# Enabled then disabled: the provider only sends added or changed parameters,
# so disabling must change neptune_streams to "0" rather than drop it.
run "enable_then_apply" {
  module {
    source = "./modules/data/neptune"
  }

  variables {
    streams_enabled = true
  }

  assert {
    condition = one([
      for p in aws_neptune_cluster_parameter_group.main.parameter : p.value if p.name == "neptune_streams"
    ]) == "1"
    error_message = "Enabling must set neptune_streams to 1."
  }
}

run "disable_after_enable" {
  module {
    source = "./modules/data/neptune"
  }

  variables {
    streams_enabled = false
  }

  assert {
    condition = one([
      for p in aws_neptune_cluster_parameter_group.main.parameter : p
      if p.name == "neptune_streams"
    ]) == { name = "neptune_streams", value = "0", apply_method = "pending-reboot" }
    error_message = "Disabling must send neptune_streams = 0, not drop the parameter."
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
