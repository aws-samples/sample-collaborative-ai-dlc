# Reporting lake module (mock providers). The Lambda packages are built by the
# upstream module, so the three functions are overridden here; the assertions
# concern the feed, the partition projection, the views invocation and IAM.
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_region" {
    defaults = { region = "us-east-1" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws", dns_suffix = "amazonaws.com" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::test-reporting-test-0000" }
  }
  mock_resource "aws_kinesis_stream" {
    defaults = { arn = "arn:aws:kinesis:us-east-1:123456789012:stream/test-reporting-test-executions" }
  }
  mock_resource "aws_glue_catalog_database" {
    defaults = { arn = "arn:aws:glue:us-east-1:123456789012:database/test_reporting_test" }
  }
  mock_resource "aws_athena_workgroup" {
    defaults = { arn = "arn:aws:athena:us-east-1:123456789012:workgroup/test-reporting-test" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/kinesisfirehose/test-reporting-test" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/test" }
  }
}

mock_provider "random" {}

override_module {
  target  = module.transform_lambda
  outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:transform", lambda_function_name = "transform" }
}
override_module {
  target  = module.backfill_lambda
  outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:backfill", lambda_function_name = "backfill" }
}
override_module {
  target  = module.views_lambda
  outputs = { lambda_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:views", lambda_function_name = "views" }
}

variables {
  project_name                 = "test"
  environment                  = "test"
  aws_sdk_ua_app_id            = "Collaborative_AI-DLC-test"
  powertools_service_name      = "test"
  powertools_log_level         = "INFO"
  iam_role_path                = "/"
  iam_permissions_boundary_arn = ""
  kms_key_arn                  = ""
  v2_executions_table_name     = "test-v2-executions-test"
  v2_executions_table_arn      = "arn:aws:dynamodb:us-east-1:123456789012:table/test-v2-executions-test"
  deletion_protection          = true
  buffer_seconds               = 60
  kinesis_shard_count          = 1
  athena_bytes_scanned_cutoff  = 10737418240
  lake_start_date              = "2026-10-01"
  alarm_actions                = []
}

run "feed_and_tables" {
  command = apply

  module {
    source = "./modules/reporting"
  }

  assert {
    condition     = aws_dynamodb_kinesis_streaming_destination.executions.table_name == "test-v2-executions-test"
    error_message = "The change stream must be attached to the v2-executions table."
  }
  assert {
    condition     = aws_dynamodb_kinesis_streaming_destination.executions.approximate_creation_date_time_precision == "MICROSECOND"
    error_message = "Changes need microsecond timestamps to order changes to one row."
  }
  assert {
    condition     = aws_kinesis_stream.executions.stream_mode_details[0].stream_mode == "PROVISIONED" && aws_kinesis_stream.executions.shard_count == 1
    error_message = "A positive shard count must provision the stream."
  }
  assert {
    condition     = aws_s3_bucket.lake.force_destroy == false
    error_message = "With deletion protection on, the lake bucket must not be force-destroyed."
  }
  assert {
    condition     = aws_glue_catalog_table.changes.parameters["projection.dt.range"] == "2026-10-01,NOW"
    error_message = "An explicit start date must set the partition projection range."
  }
  assert {
    condition = alltrue([
      for t in ["meta", "stage", "human", "receipt", "steer", "unit", "unitpr", "other"] :
      contains(split(",", aws_glue_catalog_table.changes.parameters["projection.record_type.values"]), t)
    ])
    error_message = "The record_type projection must list the transform's record types plus other."
  }
  assert {
    condition     = !contains(split(",", aws_glue_catalog_table.changes.parameters["projection.record_type.values"]), "output")
    error_message = "Transcripts are never written, so they have no partition."
  }
  assert {
    condition     = startswith(jsondecode(aws_lambda_invocation.views.input).files[0].name, "010-") && length(jsondecode(aws_lambda_invocation.views.input).files) == length(fileset("./modules/reporting/views", "*.sql"))
    error_message = "Every view file must be sent to the views Lambda, in file-name order."
  }
}

run "on_demand_and_unprotected" {
  command = plan

  module {
    source = "./modules/reporting"
  }

  variables {
    kinesis_shard_count = 0
    deletion_protection = false
  }

  assert {
    condition     = aws_kinesis_stream.executions.stream_mode_details[0].stream_mode == "ON_DEMAND" && aws_kinesis_stream.executions.shard_count == null
    error_message = "A shard count of 0 must switch the stream to on-demand."
  }
  assert {
    condition     = aws_s3_bucket.lake.force_destroy == true
    error_message = "Without deletion protection the lake bucket can be destroyed with its contents."
  }
}

run "default_start_date" {
  command = apply

  module {
    source = "./modules/reporting"
  }

  variables {
    lake_start_date = ""
  }

  assert {
    condition     = can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2},NOW$", aws_glue_catalog_table.changes.parameters["projection.dt.range"]))
    error_message = "Without a start date the projection must start on the day the lake was created."
  }
}
