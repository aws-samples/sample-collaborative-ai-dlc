# =============================================================================
# Agent credential broker grants
#
# Trusted API/orchestrator Lambdas sign a short-lived authorization containing
# the exact agent credential binding(s) for one AgentCore invocation. The
# AgentCore role does not receive this secret and therefore cannot mint grants
# for arbitrary user or space credentials discovered in execution metadata.
# =============================================================================

resource "random_password" "agent_credential_grant_secret" {
  length  = 48
  special = false
}

resource "aws_ssm_parameter" "agent_credential_grant_secret" {
  name  = "/${var.project_name}/${var.environment}/agent-credential-grant-secret"
  type  = "SecureString"
  value = random_password.agent_credential_grant_secret.result
}
