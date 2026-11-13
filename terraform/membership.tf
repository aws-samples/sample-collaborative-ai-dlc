# Report drift after application cutover, retaining graph grants for rollback.
# Edge cleanup is deferred to a later release.
resource "aws_lambda_invocation" "membership_report" {
  function_name   = module.lambda.membership_migration_lambda_name
  input           = jsonencode({ action = "report", version = 1 })
  lifecycle_scope = "CREATE_ONLY"
  depends_on      = [module.lambda, module.api]
}
