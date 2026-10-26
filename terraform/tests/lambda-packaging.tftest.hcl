# No AWS calls: only the upstream module's local package builder runs.
# Keep TF_RECREATE_MISSING_LAMBDA_PACKAGE unset, as in the deployment workflow.
mock_provider "aws" {
  mock_data "aws_partition" { defaults = { partition = "aws", dns_suffix = "amazonaws.com" } }
  mock_data "aws_region" { defaults = { region = "eu-central-1", name = "eu-central-1" } }
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
  mock_resource "aws_lambda_function" { defaults = { arn = "arn:aws:lambda:eu-central-1:123456789012:function:inert-lookup" } }
}
run "initial_module_owned_build" {
  module {
    source = "./tests/fixtures/lambda-packaging"
  }
  command = apply
  assert {
    condition     = fileexists(output.lookup_zip) && fileexists(output.workflows_zip)
    error_message = "Module must build both local archives before completing mocked Lambda creation."
  }
}
run "configuration_change_plan" {
  module {
    source = "./tests/fixtures/lambda-packaging"
  }
  command = plan
  variables { app_id = "after" }
}
run "configuration_change_apply" {
  module {
    source = "./tests/fixtures/lambda-packaging"
  }
  command = apply
  variables { app_id = "after" }
  assert {
    condition     = fileexists(output.lookup_zip) && fileexists(output.workflows_zip)
    error_message = "Apply-time package preparation must complete without a CI prebuild."
  }
}
run "unchanged_plan" {
  module {
    source = "./tests/fixtures/lambda-packaging"
  }
  command = plan
  variables { app_id = "after" }
}
run "clean_runner_unchanged" {
  module {
    source = "./tests/fixtures/lambda-packaging"
  }
  command = apply
  variables {
    app_id        = "after"
    fixture_epoch = "clean-unchanged"
    clean_runner  = true
  }
  assert {
    condition     = fileexists(output.lookup_zip) && fileexists(output.workflows_zip)
    error_message = "Unchanged source must still have archives recreated on a clean runner."
  }
}
run "clean_runner_configuration_change" {
  module {
    source = "./tests/fixtures/lambda-packaging"
  }
  command = apply
  variables {
    app_id        = "after-clean"
    fixture_epoch = "clean"
    clean_runner  = true
  }
  assert {
    condition     = fileexists(output.lookup_zip) && fileexists(output.workflows_zip)
    error_message = "Default module behavior must recreate missing clean-runner artifacts."
  }
}
run "clean_runner_code_change" {
  module {
    source = "./tests/fixtures/lambda-packaging"
  }
  command = apply
  variables {
    app_id        = "after-code"
    hash_extra    = "source-two"
    fixture_epoch = "clean-code"
    clean_runner  = true
  }
  assert {
    condition     = fileexists(output.lookup_zip) && fileexists(output.workflows_zip)
    error_message = "New source hashes must be built by the module."
  }
}
