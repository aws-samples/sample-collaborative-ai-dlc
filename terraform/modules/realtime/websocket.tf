# =============================================================================
# Partition-Aware Data Sources
# =============================================================================
data "aws_partition" "current" {}

locals {
  dns_suffix = data.aws_partition.current.dns_suffix
}

# WebSocket API Gateway
resource "aws_apigatewayv2_api" "websocket" {
  name                       = "${var.project_name}-ws-${var.environment}"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
}

# Cognito Authorizer for WebSocket
resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.websocket.id
  authorizer_type  = "REQUEST"
  authorizer_uri   = module.authorizer_lambda.lambda_function_invoke_arn
  identity_sources = ["route.request.querystring.token"]
  name             = "${var.project_name}-ws-authorizer"
}

# $connect route
resource "aws_apigatewayv2_route" "connect" {
  api_id             = aws_apigatewayv2_api.websocket.id
  route_key          = "$connect"
  authorization_type = "CUSTOM"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
  target             = "integrations/${aws_apigatewayv2_integration.connect.id}"
}

resource "aws_apigatewayv2_integration" "connect" {
  api_id             = aws_apigatewayv2_api.websocket.id
  integration_type   = "AWS_PROXY"
  integration_uri    = module.connection_lambda.lambda_function_invoke_arn
  integration_method = "POST"
}

# $disconnect route
resource "aws_apigatewayv2_route" "disconnect" {
  api_id    = aws_apigatewayv2_api.websocket.id
  route_key = "$disconnect"
  target    = "integrations/${aws_apigatewayv2_integration.disconnect.id}"
}

resource "aws_apigatewayv2_integration" "disconnect" {
  api_id             = aws_apigatewayv2_api.websocket.id
  integration_type   = "AWS_PROXY"
  integration_uri    = module.connection_lambda.lambda_function_invoke_arn
  integration_method = "POST"
}

# $default route
resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.websocket.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.default.id}"
}

resource "aws_apigatewayv2_integration" "default" {
  api_id             = aws_apigatewayv2_api.websocket.id
  integration_type   = "AWS_PROXY"
  integration_uri    = module.message_lambda.lambda_function_invoke_arn
  integration_method = "POST"
}

# sync route
resource "aws_apigatewayv2_route" "sync" {
  api_id    = aws_apigatewayv2_api.websocket.id
  route_key = "sync"
  target    = "integrations/${aws_apigatewayv2_integration.default.id}"
}

# notification route
resource "aws_apigatewayv2_route" "notification" {
  api_id    = aws_apigatewayv2_api.websocket.id
  route_key = "notification"
  target    = "integrations/${aws_apigatewayv2_integration.default.id}"
}

# CloudWatch Log Group for WebSocket API access logs
resource "aws_cloudwatch_log_group" "websocket_access_logs" {
  name              = "/aws/apigateway/${var.project_name}-websocket-${var.environment}"
  retention_in_days = var.environment == "prod" ? 30 : 7
}

# Stage
resource "aws_apigatewayv2_stage" "main" {
  api_id      = aws_apigatewayv2_api.websocket.id
  name        = var.websocket_stage_name
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.websocket_access_logs.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      connectionId   = "$context.connectionId"
      eventType      = "$context.eventType"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      requestTime    = "$context.requestTime"
      integrationErr = "$context.integrationErrorMessage"
    })
  }
}

# Lambda permissions for API Gateway
resource "aws_lambda_permission" "connect" {
  statement_id  = "AllowAPIGatewayConnect"
  action        = "lambda:InvokeFunction"
  function_name = module.connection_lambda.lambda_function_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_apigatewayv2_api.websocket.execution_arn}/*/*"
}

resource "aws_lambda_permission" "message" {
  statement_id  = "AllowAPIGatewayMessage"
  action        = "lambda:InvokeFunction"
  function_name = module.message_lambda.lambda_function_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_apigatewayv2_api.websocket.execution_arn}/*/*"
}

resource "aws_lambda_permission" "authorizer" {
  statement_id  = "AllowAPIGatewayAuthorizer"
  action        = "lambda:InvokeFunction"
  function_name = module.authorizer_lambda.lambda_function_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_apigatewayv2_api.websocket.execution_arn}/*/*"
}
