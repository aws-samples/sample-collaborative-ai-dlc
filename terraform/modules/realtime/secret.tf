# =============================================================================
# Realtime doc-token secret
#
# Shared HMAC secret for the short-lived realtime scope tokens. Consumed by:
#   - lambda/discussions  (issuer — via module.lambda, REALTIME_SECRET_PARAM)
#   - lambda/ws-connection (verifier at app-WS $connect)
#   - the Yjs ECS task     (verifier at Yjs upgrade — injected as ECS secret)
#
# Rotation runbook: update the SSM value, recycle the Yjs ECS task,
# and force a cold start of the ws-connection + discussions lambdas.
# =============================================================================

resource "random_password" "realtime_doc_secret" {
  length  = 48
  special = false
}

resource "aws_ssm_parameter" "realtime_doc_secret" {
  name  = "/${var.project_name}/${var.environment}/realtime-doc-secret"
  type  = "SecureString"
  value = random_password.realtime_doc_secret.result
}
