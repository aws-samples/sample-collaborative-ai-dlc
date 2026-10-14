variable "native_preparation_enabled" {
  type    = bool
  default = false
}
variable "native_execution_enabled" {
  type    = bool
  default = false
}
variable "native_intents_lambda_invoke_arn" {
  type    = string
  default = ""
}
variable "native_intents_lambda_name" {
  type    = string
  default = ""
}

resource "aws_api_gateway_resource" "native_intents" {
  count       = var.native_preparation_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project.id
  path_part   = "native-intents"
}
resource "aws_api_gateway_resource" "native_intent" {
  count       = var.native_preparation_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.native_intents[0].id
  path_part   = "{intentId}"
}
resource "aws_api_gateway_resource" "native_intent_prepare" {
  count       = var.native_preparation_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.native_intent[0].id
  path_part   = "prepare"
}
resource "aws_api_gateway_resource" "native_intent_prompt" {
  count       = var.native_preparation_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.native_intent[0].id
  path_part   = "prompt"
}

resource "aws_api_gateway_resource" "native_execution_action" {
  for_each    = var.native_preparation_enabled && var.native_execution_enabled ? toset(["start", "cancel", "recover", "publication", "files", "graph", "interaction", "response", "outputs", "results"]) : toset([])
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.native_intent[0].id
  path_part   = each.value
}
resource "aws_api_gateway_resource" "native_execution_file" {
  count       = var.native_preparation_enabled && var.native_execution_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.native_execution_action["files"].id
  path_part   = "{fileId}"
}

locals {
  native_execution_routes = var.native_preparation_enabled && var.native_execution_enabled ? {
    result_request = {
      method = "POST", resource_id = aws_api_gateway_resource.native_execution_action["results"].id,
      path   = "api/projects/*/native-intents/*/results", item = true
    }
    result_read = {
      method = "GET", resource_id = aws_api_gateway_resource.native_execution_action["results"].id,
      path   = "api/projects/*/native-intents/*/results", item = true
    }
    start = {
      method = "POST", resource_id = aws_api_gateway_resource.native_execution_action["start"].id,
      path   = "api/projects/*/native-intents/*/start", item = true
    }
    cancel = {
      method = "POST", resource_id = aws_api_gateway_resource.native_execution_action["cancel"].id,
      path   = "api/projects/*/native-intents/*/cancel", item = true
    }
    recover = {
      method = "POST", resource_id = aws_api_gateway_resource.native_execution_action["recover"].id,
      path   = "api/projects/*/native-intents/*/recover", item = true
    }
    outputs = {
      method = "GET", resource_id = aws_api_gateway_resource.native_execution_action["outputs"].id,
      path   = "api/projects/*/native-intents/*/outputs", item = true
    }
    publication = {
      method = "GET", resource_id = aws_api_gateway_resource.native_execution_action["publication"].id,
      path   = "api/projects/*/native-intents/*/publication", item = true
    }
    file = {
      method = "GET", resource_id = aws_api_gateway_resource.native_execution_file[0].id,
      path   = "api/projects/*/native-intents/*/files/*", item = true
    }
    graph = {
      method = "GET", resource_id = aws_api_gateway_resource.native_execution_action["graph"].id,
      path   = "api/projects/*/native-intents/*/graph", item = true
    }
    interaction = {
      method = "GET", resource_id = aws_api_gateway_resource.native_execution_action["interaction"].id,
      path   = "api/projects/*/native-intents/*/interaction", item = true
    }
    response = {
      method = "POST", resource_id = aws_api_gateway_resource.native_execution_action["response"].id,
      path   = "api/projects/*/native-intents/*/response", item = true
    }
  } : {}
  # Keep the existing resource addresses and deployment trigger: main.tf hashes
  # every method/integration in this map, including these execution routes.
  native_intent_routes = merge(var.native_preparation_enabled ? {
    capabilities = {
      method = "GET", resource_id = aws_api_gateway_resource.native_intents[0].id,
      path   = "api/projects/*/native-intents", item = false
    }
    create = {
      method = "POST", resource_id = aws_api_gateway_resource.native_intents[0].id,
      path   = "api/projects/*/native-intents", item = false
    }
    status = {
      method = "GET", resource_id = aws_api_gateway_resource.native_intent[0].id,
      path   = "api/projects/*/native-intents/*", item = true
    }
    prepare = {
      method = "POST", resource_id = aws_api_gateway_resource.native_intent_prepare[0].id,
      path   = "api/projects/*/native-intents/*/prepare", item = true
    }
    prompt = {
      method = "POST", resource_id = aws_api_gateway_resource.native_intent_prompt[0].id,
      path   = "api/projects/*/native-intents/*/prompt", item = true
    }
  } : {}, local.native_execution_routes)
}

resource "aws_api_gateway_method" "native_intents" {
  for_each      = local.native_intent_routes
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = each.value.resource_id
  http_method   = each.value.method
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = merge(
    { "method.request.path.projectId" = true },
    each.value.item ? { "method.request.path.intentId" = true } : {},
    each.key == "file" ? { "method.request.path.fileId" = true } : {}
  )
}
resource "aws_api_gateway_integration" "native_intents" {
  for_each                = local.native_intent_routes
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = each.value.resource_id
  http_method             = aws_api_gateway_method.native_intents[each.key].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.native_intents_lambda_invoke_arn
  # The existing deployment already depends on this integration collection.
  # Include execution preflight completion transitively to prevent a deployment
  # snapshot from racing the new OPTIONS integrations/responses.
  depends_on = [module.cors_native_execution_action, module.cors_native_execution_file, module.cors_native_intent_prompt]
}
resource "aws_lambda_permission" "native_intents_gateway" {
  for_each      = local.native_intent_routes
  statement_id  = "NativeIntents-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = var.native_intents_lambda_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/${each.value.method}/${each.value.path}"
}
module "cors_native_intents" {
  source      = "./cors"
  count       = var.native_preparation_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.native_intents[0].id
}
module "cors_native_intent" {
  source      = "./cors"
  count       = var.native_preparation_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.native_intent[0].id
}
module "cors_native_intent_prepare" {
  source      = "./cors"
  count       = var.native_preparation_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.native_intent_prepare[0].id
}
module "cors_native_intent_prompt" {
  source      = "./cors"
  count       = var.native_preparation_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.native_intent_prompt[0].id
}
module "cors_native_execution_action" {
  source      = "./cors"
  for_each    = aws_api_gateway_resource.native_execution_action
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = each.value.id
}
module "cors_native_execution_file" {
  source      = "./cors"
  count       = var.native_preparation_enabled && var.native_execution_enabled ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.native_execution_file[0].id
}
