mock_provider "aws" {}

variables {
  name_prefix        = "neptune-test"
  vpc_id             = "vpc-12345678"
  vpc_cidr           = "10.0.0.0/16"
  private_subnet_ids = ["subnet-11111111", "subnet-22222222"]
}

run "default_keeps_the_existing_class" {
  command = plan
  module {
    source = "./modules/data/neptune"
  }

  assert {
    condition     = aws_neptune_cluster_instance.main.instance_class == "db.t3.medium"
    error_message = "The default must stay db.t3.medium so existing instances are not restarted."
  }

  assert {
    condition     = aws_neptune_cluster_instance.main.apply_immediately == false
    error_message = "Instance class changes must wait for the maintenance window by default."
  }
}

run "explicit_class_is_applied" {
  command = plan
  module {
    source = "./modules/data/neptune"
  }

  variables {
    instance_class    = "db.r7g.large"
    apply_immediately = true
  }

  assert {
    condition     = aws_neptune_cluster_instance.main.instance_class == "db.r7g.large"
    error_message = "An explicit instance_class must be applied."
  }

  assert {
    condition     = aws_neptune_cluster_instance.main.apply_immediately == true
    error_message = "apply_immediately must reach the instance."
  }
}

run "rejects_invalid_class" {
  command = plan
  module {
    source = "./modules/data/neptune"
  }

  variables {
    instance_class = "t4g.medium"
  }

  expect_failures = [var.instance_class]
}
