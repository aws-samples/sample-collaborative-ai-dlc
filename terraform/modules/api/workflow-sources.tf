# Native workflow-source administration has its own Lambda/IAM boundary. These
# routes never enter the mixed HTTP/internal, agent-callable source-control API.
variable "workflow_sources_lambda_invoke_arn" {
  description = "Invoke ARN for the dedicated workflow-source administration Lambda"
  type        = string
}

variable "workflow_sources_lambda_name" {
  description = "Name of the dedicated workflow-source administration Lambda"
  type        = string
}

resource "aws_api_gateway_resource" "workflow_sources" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project.id
  path_part   = "workflow-sources"
}

resource "aws_api_gateway_resource" "workflow_source" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.workflow_sources.id
  path_part   = "{sourceId}"
}

resource "aws_api_gateway_resource" "workflow_source_packages" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.workflow_source.id
  path_part   = "packages"
}

resource "aws_api_gateway_resource" "workflow_source_package_job" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.workflow_source_packages.id
  path_part   = "{jobId}"
}

locals {
  workflow_source_routes = {
    list = {
      method      = "GET"
      resource_id = aws_api_gateway_resource.workflow_sources.id
      path        = "api/projects/*/workflow-sources"
      item        = false
      job         = false
    }
    configure = {
      method      = "POST"
      resource_id = aws_api_gateway_resource.workflow_sources.id
      path        = "api/projects/*/workflow-sources"
      item        = false
      job         = false
    }
    remove = {
      method      = "DELETE"
      resource_id = aws_api_gateway_resource.workflow_source.id
      path        = "api/projects/*/workflow-sources/*"
      item        = true
      job         = false
    }
    import_package = {
      method      = "POST"
      resource_id = aws_api_gateway_resource.workflow_source_packages.id
      path        = "api/projects/*/workflow-sources/*/packages"
      item        = true
      job         = false
    }
    package_status = {
      method      = "GET"
      resource_id = aws_api_gateway_resource.workflow_source_package_job.id
      path        = "api/projects/*/workflow-sources/*/packages/*"
      item        = true
      job         = true
    }
  }
}

resource "aws_api_gateway_method" "workflow_sources" {
  for_each      = local.workflow_source_routes
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = each.value.resource_id
  http_method   = each.value.method
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = merge(
    { "method.request.path.projectId" = true },
    each.value.item ? { "method.request.path.sourceId" = true } : {},
    each.value.job ? { "method.request.path.jobId" = true } : {},
  )
}

resource "aws_api_gateway_integration" "workflow_sources" {
  for_each                = local.workflow_source_routes
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = each.value.resource_id
  http_method             = aws_api_gateway_method.workflow_sources[each.key].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.workflow_sources_lambda_invoke_arn
}

resource "aws_lambda_permission" "workflow_sources_api_gateway" {
  for_each      = local.workflow_source_routes
  statement_id  = "WorkflowSources-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = var.workflow_sources_lambda_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/${each.value.method}/${each.value.path}"
}

module "cors_workflow_sources" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.workflow_sources.id
}

module "cors_workflow_source" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.workflow_source.id
}

module "cors_workflow_source_packages" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.workflow_source_packages.id
}

module "cors_workflow_source_package_job" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.workflow_source_package_job.id
}
