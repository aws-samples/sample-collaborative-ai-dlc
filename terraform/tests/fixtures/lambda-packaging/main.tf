# Minimal reproduction of workflows_lambda -> invoke policy -> lookup Lambda.
# AWS is mocked by lambda-packaging.tftest.hcl; external/local/null really build ZIPs.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}
variable "app_id" { default = "before" }
variable "hash_extra" { default = "source-one" }
variable "fixture_epoch" { default = "initial" }
variable "clean_runner" { default = false }
# Changing epoch simulates another runner. The path dependency ensures cleanup
# happens before archive_prepare checks whether the local packages exist.
data "external" "workspace" {
  program = ["python3", "${path.module}/workspace.py"]
  query   = { epoch = var.fixture_epoch, clean = tostring(var.clean_runner) }
}
module "lookup" {
  source        = "terraform-aws-modules/lambda/aws"
  version       = "~> 8.0"
  function_name = "inert-lookup"
  artifacts_dir = "builds/lambda-packaging/lookup"
  runtime       = "nodejs24.x"
  handler       = "index.handler"
  create_role   = false
  lambda_role   = "arn:aws:iam::123456789012:role/inert"
  source_path = [{
    path     = "${path.module}/src/lookup${substr(data.external.workspace.result.epoch, 0, 0)}"
    commands = [":zip ."]
  }]
  hash_extra            = var.hash_extra
  environment_variables = { AWS_SDK_UA_APP_ID = var.app_id }
}
resource "aws_iam_role_policy" "invoke_lookup" {
  name   = "inert-invoke-lookup"
  role   = "inert-role"
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = module.lookup.lambda_function_arn }] })
}
module "workflows" {
  source        = "terraform-aws-modules/lambda/aws"
  version       = "~> 8.0"
  function_name = "inert-workflows"
  artifacts_dir = "builds/lambda-packaging/workflows"
  runtime       = "nodejs24.x"
  handler       = "index.handler"
  create_role   = false
  lambda_role   = "arn:aws:iam::123456789012:role/inert"
  source_path = [{
    path     = "${path.module}/src/workflows${substr(data.external.workspace.result.epoch, 0, 0)}"
    commands = [":zip ."]
  }]
  hash_extra            = var.hash_extra
  environment_variables = { AWS_SDK_UA_APP_ID = var.app_id, INTENT_PIN_LOOKUP_FUNCTION = module.lookup.lambda_function_name }
  depends_on            = [aws_iam_role_policy.invoke_lookup]
}
output "lookup_zip" { value = module.lookup.local_filename }
output "workflows_zip" { value = module.workflows.local_filename }
