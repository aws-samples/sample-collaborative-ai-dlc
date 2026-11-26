# Temporary, operator-invoked diagnostics. This is not an import entry point.
# It deliberately uses the deployed worker role and network without changing
# any permission or bucket policy. Remove it after collecting live evidence.
variable "enable_native_package_storage_probe" {
  description = "Deploy a temporary dev-only storage probe; does not invoke it or enable package imports"
  type        = bool
  default     = false
  nullable    = false
}

variable "native_package_storage_probe_run_id" {
  description = "Fixed UUID for tiny synthetic storage fixtures; invocation cannot choose arbitrary keys"
  type        = string
  default     = ""
  nullable    = false
  validation {
    condition     = var.native_package_storage_probe_run_id == "" || can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", var.native_package_storage_probe_run_id))
    error_message = "The storage probe run ID must be empty or a lowercase UUID v4."
  }
}

resource "terraform_data" "native_package_storage_probe_configuration" {
  count = var.enable_native_package_storage_probe ? 1 : 0

  input = var.native_package_storage_probe_run_id
  lifecycle {
    precondition {
      condition     = var.environment == "dev" && !var.enable_native_package_jobs && !var.native_package_jobs_host_qualified
      error_message = "The temporary storage probe is restricted to dev with package imports and host qualification disabled."
    }
    precondition {
      condition     = var.native_package_storage_probe_run_id != ""
      error_message = "Choose and retain one explicit probe run UUID before deployment."
    }
  }
}

module "native_package_storage_probe_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"
  count   = var.enable_native_package_storage_probe ? 1 : 0

  function_name                  = "${var.project_name}-native-storage-probe-${var.environment}"
  handler                        = "index.handler"
  runtime                        = "nodejs24.x"
  architectures                  = ["arm64"]
  memory_size                    = var.native_package_worker_memory_size
  ephemeral_storage_size         = var.native_package_worker_ephemeral_storage_size
  timeout                        = var.native_package_worker_timeout_seconds
  reserved_concurrent_executions = 1

  source_path = [
    {
      path = "${path.module}/../../../../lambda/native-package-worker"
      patterns = [
        "!.build/.*",
        "!.probe-build/.*",
      ]
      commands = [
        "cd ../.. && npm run build:storage-probe -w native-package-worker",
        ":zip lambda/native-package-worker/.probe-build",
      ]
    }
  ]
  hash_extra = filesha256("${path.module}/../../../../package-lock.json")

  create_role = false
  lambda_role = aws_iam_role.native_package_worker.arn

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.lambda.id]

  cloudwatch_logs_retention_in_days = 7
  environment_variables = {
    NATIVE_PACKAGE_STORAGE_PROBE_ENABLED  = "true"
    NATIVE_PACKAGE_STORAGE_PROBE_RUN_ID   = var.native_package_storage_probe_run_id
    NATIVE_PACKAGE_JOBS_ENABLED           = "false"
    NATIVE_PACKAGES_BUCKET                = var.native_packages_bucket_name
    NATIVE_PACKAGES_EXPECTED_BUCKET_OWNER = data.aws_caller_identity.current.account_id
  }

  # No public URL, API route, event source, asynchronous invocation, or new
  # InvokeFunction/PassRole grants. Only an authorized AWS operator invokes it.
  depends_on = [
    terraform_data.native_package_storage_probe_configuration,
    aws_iam_role_policy.native_package_worker,
    aws_iam_role_policy.native_package_publisher,
    aws_iam_role_policy_attachment.native_package_worker_basic,
    aws_iam_role_policy_attachment.native_package_worker_vpc,
  ]
}

output "native_package_storage_probe_function_name" {
  description = "Temporary storage probe, or null when absent; deployment does not run it"
  value       = try(module.native_package_storage_probe_lambda[0].lambda_function_name, null)
}
