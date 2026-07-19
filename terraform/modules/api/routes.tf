# =============================================================================
# Partition-Aware Data Sources
# =============================================================================
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  dns_suffix = data.aws_partition.current.dns_suffix
}

# =============================================================================
# API Routes Configuration
# =============================================================================

# -----------------------------------------------------------------------------
# /users Resource (top-level - list Cognito users)
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "cognito_users" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "users"
}

# -----------------------------------------------------------------------------
# /projects Resource
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "projects" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "projects"
}

resource "aws_api_gateway_resource" "project" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.projects.id
  path_part   = "{projectId}"
}

# -----------------------------------------------------------------------------
# /projects/{projectId}/migrate-tracker Resource (issue #194)
# Per-project migration to the tracker provider abstraction. Owner/admin
# only. The bulk admin counterpart is the migrate-tracker-fields Lambda.
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "migrate_tracker" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project.id
  path_part   = "migrate-tracker"
}

# -----------------------------------------------------------------------------
# /admin Resource (issue #194 phase #198)
# Operator-facing routes. The migration counterpart of the per-project
# /projects/{id}/migrate-tracker route lives under /admin/tracker-migration
# so a bulk run is invokable from the Admin UI without shell access. Same
# Cognito posture as the surrounding admin-config endpoints.
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "admin" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "admin"
}

resource "aws_api_gateway_resource" "admin_tracker_migration" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.admin.id
  path_part   = "tracker-migration"
}

resource "aws_api_gateway_resource" "admin_tracker_migration_status" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.admin_tracker_migration.id
  path_part   = "status"
}

# /admin/users — platform-admin user management (cognito-users lambda):
# GET lists users with their platform-admin flag; PUT on
# /admin/users/{username}/platform-admin grants/revokes the Cognito group.
resource "aws_api_gateway_resource" "admin_users" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.admin.id
  path_part   = "users"
}

resource "aws_api_gateway_resource" "admin_users_username" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.admin_users.id
  path_part   = "{username}"
}

resource "aws_api_gateway_resource" "admin_users_platform_admin" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.admin_users_username.id
  path_part   = "platform-admin"
}

# -----------------------------------------------------------------------------
# /projects/{projectId}/members Resource
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "members" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project.id
  path_part   = "members"
}

resource "aws_api_gateway_resource" "member" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.members.id
  path_part   = "{userId}"
}

# -----------------------------------------------------------------------------
# /projects/{projectId}/sprints Resource
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "sprints" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project.id
  path_part   = "sprints"
}

resource "aws_api_gateway_resource" "sprint" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprints.id
  path_part   = "{sprintId}"
}

# -----------------------------------------------------------------------------
# /sprints Resource (top-level for sprint-scoped entities)
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "sprints_root" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "sprints"
}

resource "aws_api_gateway_resource" "sprint_root" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprints_root.id
  path_part   = "{sprintId}"
}

# /sprints/{sprintId}/requirements
resource "aws_api_gateway_resource" "requirements" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprint_root.id
  path_part   = "requirements"
}
resource "aws_api_gateway_resource" "requirement" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.requirements.id
  path_part   = "{requirementId}"
}

# /sprints/{sprintId}/user-stories
resource "aws_api_gateway_resource" "user_stories" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprint_root.id
  path_part   = "user-stories"
}
resource "aws_api_gateway_resource" "user_story" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.user_stories.id
  path_part   = "{storyId}"
}

# /sprints/{sprintId}/tasks
resource "aws_api_gateway_resource" "tasks" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprint_root.id
  path_part   = "tasks"
}
resource "aws_api_gateway_resource" "task" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.tasks.id
  path_part   = "{taskId}"
}

# /sprints/{sprintId}/general-info
resource "aws_api_gateway_resource" "general_info" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprint_root.id
  path_part   = "general-info"
}
resource "aws_api_gateway_resource" "general_info_item" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.general_info.id
  path_part   = "{infoId}"
}

# /sprints/{sprintId}/code-files
resource "aws_api_gateway_resource" "code_files" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprint_root.id
  path_part   = "code-files"
}
resource "aws_api_gateway_resource" "code_file" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.code_files.id
  path_part   = "{codeFileId}"
}

# /sprints/{sprintId}/review
resource "aws_api_gateway_resource" "review" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprint_root.id
  path_part   = "review"
}

# /sprints/{sprintId}/questions
resource "aws_api_gateway_resource" "questions" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprint_root.id
  path_part   = "questions"
}
resource "aws_api_gateway_resource" "question" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.questions.id
  path_part   = "{questionId}"
}

# /sprints/{sprintId}/graph
resource "aws_api_gateway_resource" "sprint_graph" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprint_root.id
  path_part   = "graph"
}

# =============================================================================
# Projects Methods (GET list, POST create)
# =============================================================================
resource "aws_api_gateway_method" "projects_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.projects.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_method" "projects_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.projects.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "projects_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.projects.id
  http_method             = aws_api_gateway_method.projects_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "projects_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.projects.id
  http_method             = aws_api_gateway_method.projects_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

# =============================================================================
# Project Methods (GET, PUT, DELETE single project)
# =============================================================================
resource "aws_api_gateway_method" "project_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_method" "project_put" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project.id
  http_method   = "PUT"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_method" "project_delete" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project.id
  http_method   = "DELETE"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_integration" "project_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project.id
  http_method             = aws_api_gateway_method.project_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "project_put" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project.id
  http_method             = aws_api_gateway_method.project_put.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "project_delete" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project.id
  http_method             = aws_api_gateway_method.project_delete.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

# =============================================================================
# Migrate-Tracker Method (POST — owner/admin only)
# =============================================================================
resource "aws_api_gateway_method" "migrate_tracker_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.migrate_tracker.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_integration" "migrate_tracker_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.migrate_tracker.id
  http_method             = aws_api_gateway_method.migrate_tracker_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

# =============================================================================
# Admin Tracker-Migration Methods (issue #194 phase #198)
# Bulk counterpart of /projects/{id}/migrate-tracker. Both bound to the
# projects lambda — the shared core in lambda/shared/tracker-migration.js
# already supports both per-project and whole-graph scopes.
# =============================================================================
resource "aws_api_gateway_method" "admin_tracker_migration_status_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.admin_tracker_migration_status.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "admin_tracker_migration_status_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.admin_tracker_migration_status.id
  http_method             = aws_api_gateway_method.admin_tracker_migration_status_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

resource "aws_api_gateway_method" "admin_tracker_migration_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.admin_tracker_migration.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "admin_tracker_migration_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.admin_tracker_migration.id
  http_method             = aws_api_gateway_method.admin_tracker_migration_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

# =============================================================================
# Members Methods (GET list, POST invite)
# =============================================================================
resource "aws_api_gateway_method" "members_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.members.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_method" "members_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.members.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_integration" "members_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.members.id
  http_method             = aws_api_gateway_method.members_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.users_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "members_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.members.id
  http_method             = aws_api_gateway_method.members_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.users_lambda_invoke_arn
}

# =============================================================================
# Member Methods (PUT update role, DELETE remove)
# =============================================================================
resource "aws_api_gateway_method" "member_put" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.member.id
  http_method   = "PUT"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
    "method.request.path.userId"    = true
  }
}

resource "aws_api_gateway_method" "member_delete" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.member.id
  http_method   = "DELETE"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
    "method.request.path.userId"    = true
  }
}

resource "aws_api_gateway_integration" "member_put" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.member.id
  http_method             = aws_api_gateway_method.member_put.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.users_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "member_delete" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.member.id
  http_method             = aws_api_gateway_method.member_delete.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.users_lambda_invoke_arn
}

# =============================================================================
# Sprints Methods (nested under project)
# =============================================================================
resource "aws_api_gateway_method" "sprints_get" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.sprints.id
  http_method        = "GET"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.projectId" = true }
}
resource "aws_api_gateway_method" "sprint_get" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.sprint.id
  http_method        = "GET"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.projectId" = true, "method.request.path.sprintId" = true }
}

resource "aws_api_gateway_integration" "sprints_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.sprints.id
  http_method             = aws_api_gateway_method.sprints_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.sprints_lambda_invoke_arn
}
resource "aws_api_gateway_integration" "sprint_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.sprint.id
  http_method             = aws_api_gateway_method.sprint_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.sprints_lambda_invoke_arn
}

# /sprints/{sprintId}/timeline-events
resource "aws_api_gateway_resource" "timeline_events" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprint_root.id
  path_part   = "timeline-events"
}

# /sprints/{sprintId}/realtime-token
resource "aws_api_gateway_resource" "sprint_realtime_token" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprint_root.id
  path_part   = "realtime-token"
}

# /projects/{projectId}/realtime-token
resource "aws_api_gateway_resource" "project_realtime_token" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project.id
  path_part   = "realtime-token"
}

# /sprints/{sprintId}/discussions
resource "aws_api_gateway_resource" "discussions" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.sprint_root.id
  path_part   = "discussions"
}
resource "aws_api_gateway_resource" "discussion" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.discussions.id
  path_part   = "{discussionId}"
}
resource "aws_api_gateway_resource" "discussion_messages" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.discussion.id
  path_part   = "messages"
}
resource "aws_api_gateway_resource" "discussion_read" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.discussion.id
  path_part   = "read"
}
# Static sibling of {discussionId} — API Gateway resolves static parts first.
resource "aws_api_gateway_resource" "discussions_search" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.discussions.id
  path_part   = "search"
}

# -----------------------------------------------------------------------------
# /blocks Resources (reusable-block library)
# Top-level shared library routes (SYSTEM imported baseline + default user-owned
# catalog; not project/sprint scoped). Generic over block type:
#   /blocks/{type}                 GET (list), POST (create)
#   /blocks/{type}/{id}            GET, PUT, DELETE
#   /blocks/{type}/{id}/body       GET (lazy-load the S3 markdown body)
#   /blocks/{type}/{id}/script     GET (lazy-load the S3 sensor script)
# All routes hit the single building-blocks Lambda, which routes by path+method.
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "blocks" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "blocks"
}

resource "aws_api_gateway_resource" "block_type" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.blocks.id
  path_part   = "{type}"
}

resource "aws_api_gateway_resource" "block_item" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.block_type.id
  path_part   = "{id}"
}

resource "aws_api_gateway_resource" "block_item_body" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.block_item.id
  path_part   = "body"
}

resource "aws_api_gateway_resource" "block_item_script" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.block_item.id
  path_part   = "script"
}

# Collection: GET (list), POST (create)
resource "aws_api_gateway_method" "block_collection_get" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.block_type.id
  http_method        = "GET"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.type" = true }
}

resource "aws_api_gateway_method" "block_collection_post" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.block_type.id
  http_method        = "POST"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.type" = true }
}

resource "aws_api_gateway_integration" "block_collection_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.block_type.id
  http_method             = aws_api_gateway_method.block_collection_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.building_blocks_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "block_collection_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.block_type.id
  http_method             = aws_api_gateway_method.block_collection_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.building_blocks_lambda_invoke_arn
}

# Item: GET, PUT, DELETE
resource "aws_api_gateway_method" "block_item_get" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.block_item.id
  http_method        = "GET"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.type" = true, "method.request.path.id" = true }
}

resource "aws_api_gateway_method" "block_item_put" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.block_item.id
  http_method        = "PUT"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.type" = true, "method.request.path.id" = true }
}

resource "aws_api_gateway_method" "block_item_delete" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.block_item.id
  http_method        = "DELETE"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.type" = true, "method.request.path.id" = true }
}

resource "aws_api_gateway_integration" "block_item_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.block_item.id
  http_method             = aws_api_gateway_method.block_item_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.building_blocks_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "block_item_put" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.block_item.id
  http_method             = aws_api_gateway_method.block_item_put.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.building_blocks_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "block_item_delete" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.block_item.id
  http_method             = aws_api_gateway_method.block_item_delete.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.building_blocks_lambda_invoke_arn
}

# Item body: GET (lazy-load the S3-stored body/script)
resource "aws_api_gateway_method" "block_item_body_get" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.block_item_body.id
  http_method        = "GET"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.type" = true, "method.request.path.id" = true }
}

resource "aws_api_gateway_integration" "block_item_body_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.block_item_body.id
  http_method             = aws_api_gateway_method.block_item_body_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.building_blocks_lambda_invoke_arn
}

# Item script: GET (lazy-load the S3-stored sensor script)
resource "aws_api_gateway_method" "block_item_script_get" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.block_item_script.id
  http_method        = "GET"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.type" = true, "method.request.path.id" = true }
}

resource "aws_api_gateway_integration" "block_item_script_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.block_item_script.id
  http_method             = aws_api_gateway_method.block_item_script_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.building_blocks_lambda_invoke_arn
}

module "cors_block_type" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.block_type.id
}

module "cors_block_item" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.block_item.id
}

module "cors_block_item_body" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.block_item_body.id
}

module "cors_block_item_script" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.block_item_script.id
}

resource "aws_lambda_permission" "building_blocks" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.building_blocks_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

# -----------------------------------------------------------------------------
# /workflows Resources (composition over the block library)
# Top-level shared library routes (SYSTEM imported baseline + default user-owned
# catalog). A workflow loads whole in one request:
#   /workflows                              GET (list), POST (create)
#   /workflows/{workflowId}                 GET (full composition), PUT, DELETE
#   /workflows/{workflowId}/groupings       PUT (replace the grouping tree)
#   /workflows/{workflowId}/placements      POST (add a skill placement)
#   /workflows/{workflowId}/placements/{skillId}   PUT, DELETE
# All routes hit the single workflows Lambda, which routes by path + method.
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "workflows" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "workflows"
}

resource "aws_api_gateway_resource" "workflow" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.workflows.id
  path_part   = "{workflowId}"
}

resource "aws_api_gateway_resource" "workflow_phases" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.workflow.id
  path_part   = "phases"
}

resource "aws_api_gateway_resource" "workflow_placements" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.workflow.id
  path_part   = "placements"
}

resource "aws_api_gateway_resource" "workflow_placement" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.workflow_placements.id
  path_part   = "{stageId}"
}

resource "aws_api_gateway_resource" "workflow_scopes" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.workflow.id
  path_part   = "scopes"
}

resource "aws_api_gateway_resource" "workflow_scope" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.workflow_scopes.id
  path_part   = "{scopeId}"
}

resource "aws_api_gateway_resource" "workflow_scope_membership" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.workflow_scope.id
  path_part   = "membership"
}

resource "aws_api_gateway_resource" "workflow_compiled" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.workflow.id
  path_part   = "compiled"
}

resource "aws_api_gateway_resource" "workflow_execution_preview" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.workflow.id
  path_part   = "execution-preview"
}

# Composed-grid dry run: POST because an EXECUTE/SKIP grid over 30+ stages
# does not fit a query string. Read-only despite the verb (pure plan
# resolution, nothing written) — the lambda exempts it from the admin guard.
resource "aws_api_gateway_resource" "workflow_validate_grid" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.workflow.id
  path_part   = "validate-grid"
}

# Rule refs layer a library rule into a workflow. The item path carries two
# params — the layer and the rule id — so the DELETE key is unambiguous.
resource "aws_api_gateway_resource" "workflow_rules" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.workflow.id
  path_part   = "rules"
}

resource "aws_api_gateway_resource" "workflow_rule_layer" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.workflow_rules.id
  path_part   = "{layer}"
}

resource "aws_api_gateway_resource" "workflow_rule" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.workflow_rule_layer.id
  path_part   = "{ruleId}"
}

# Method + AWS_PROXY integration for every (resource, verb) the workflows
# lambda serves. Driven by a map so the boilerplate stays in one place.
locals {
  workflow_routes = {
    collection_get   = { resource = aws_api_gateway_resource.workflows.id, method = "GET" }
    collection_post  = { resource = aws_api_gateway_resource.workflows.id, method = "POST" }
    item_get         = { resource = aws_api_gateway_resource.workflow.id, method = "GET" }
    item_put         = { resource = aws_api_gateway_resource.workflow.id, method = "PUT" }
    item_delete      = { resource = aws_api_gateway_resource.workflow.id, method = "DELETE" }
    phases_put       = { resource = aws_api_gateway_resource.workflow_phases.id, method = "PUT" }
    placements_post  = { resource = aws_api_gateway_resource.workflow_placements.id, method = "POST" }
    placement_put    = { resource = aws_api_gateway_resource.workflow_placement.id, method = "PUT" }
    placement_delete = { resource = aws_api_gateway_resource.workflow_placement.id, method = "DELETE" }
    scopes_post      = { resource = aws_api_gateway_resource.workflow_scopes.id, method = "POST" }
    scope_delete     = { resource = aws_api_gateway_resource.workflow_scope.id, method = "DELETE" }
    membership_put   = { resource = aws_api_gateway_resource.workflow_scope_membership.id, method = "PUT" }
    rules_post       = { resource = aws_api_gateway_resource.workflow_rules.id, method = "POST" }
    rule_delete      = { resource = aws_api_gateway_resource.workflow_rule.id, method = "DELETE" }
    compiled_get     = { resource = aws_api_gateway_resource.workflow_compiled.id, method = "GET" }
    preview_get      = { resource = aws_api_gateway_resource.workflow_execution_preview.id, method = "GET" }
    validate_grid    = { resource = aws_api_gateway_resource.workflow_validate_grid.id, method = "POST" }
  }
}

resource "aws_api_gateway_method" "workflow" {
  for_each      = local.workflow_routes
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = each.value.resource
  http_method   = each.value.method
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "workflow" {
  for_each                = local.workflow_routes
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = each.value.resource
  http_method             = aws_api_gateway_method.workflow[each.key].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.workflows_lambda_invoke_arn
}

module "cors_workflows" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.workflows.id
}

module "cors_workflow" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.workflow.id
}

module "cors_workflow_phases" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.workflow_phases.id
}

module "cors_workflow_placements" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.workflow_placements.id
}

module "cors_workflow_placement" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.workflow_placement.id
}

module "cors_workflow_scopes" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.workflow_scopes.id
}

module "cors_workflow_scope" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.workflow_scope.id
}

module "cors_workflow_scope_membership" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.workflow_scope_membership.id
}

module "cors_workflow_compiled" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.workflow_compiled.id
}

module "cors_workflow_execution_preview" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.workflow_execution_preview.id
}

module "cors_workflow_validate_grid" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.workflow_validate_grid.id
}

module "cors_workflow_rules" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.workflow_rules.id
}

module "cors_workflow_rule" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.workflow_rule.id
}

resource "aws_lambda_permission" "workflows" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.workflows_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

# =============================================================================
# /projects/{projectId}/intents Resources (AI-DLC v2 intents)
#
#   /projects/{projectId}/intents                                  GET, POST
#   /projects/{projectId}/intents/metrics                          GET
#   /projects/{projectId}/intents/{intentId}                       GET
#   /projects/{projectId}/intents/{intentId}/graph                 GET
#   /projects/{projectId}/intents/{intentId}/outputs               GET
#   /projects/{projectId}/intents/{intentId}/start                 POST
#   /projects/{projectId}/intents/{intentId}/cancel                POST
#   /projects/{projectId}/intents/{intentId}/rewind                POST
#   /projects/{projectId}/intents/{intentId}/repair                POST
#   /projects/{projectId}/intents/{intentId}/units/{sectionIndex}/{unitSlug}/feedback GET, POST
#   /projects/{projectId}/intents/{intentId}/realtime-token        POST
#   /projects/{projectId}/intents/{intentId}/gates/{humanTaskId}/answer  POST
#   /projects/{projectId}/intents/{intentId}/gates/{humanTaskId}/revise  POST
#   /projects/{projectId}/intents/{intentId}/artifacts/{artifactId}/impact       GET
#   /projects/{projectId}/intents/{intentId}/artifacts/{artifactId}/content      PUT
#   /projects/{projectId}/intents/{intentId}/artifacts/{artifactId}/verify       POST
#   /projects/{projectId}/intents/{intentId}/artifacts/{artifactId}/quorum-edit  POST
#   /projects/{projectId}/intents/{intentId}/quorum-edits/{editId}/decision      POST
# All routes hit the single intents Lambda, which routes by path + method.
# =============================================================================

resource "aws_api_gateway_resource" "intents" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project.id
  path_part   = "intents"
}

# Literal /intents/metrics — the project-wide usage+cost rollup. A literal path
# part outranks the sibling {intentId} greedy param in API Gateway routing, so
# this resolves to its own resource rather than an intent id named "metrics".
resource "aws_api_gateway_resource" "intents_metrics" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intents.id
  path_part   = "metrics"
}

resource "aws_api_gateway_resource" "intent" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intents.id
  path_part   = "{intentId}"
}

resource "aws_api_gateway_resource" "intent_graph" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent.id
  path_part   = "graph"
}

# Aggregated process/graph-read evidence (reads ledger, enrichment spend,
# sensor findings) — the intent Audit view.
resource "aws_api_gateway_resource" "intent_audit" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent.id
  path_part   = "audit"
}

# Manual graph-projection backfill (platform admin) — re-derive the intent's
# artifacts into the fine-grained graph.
resource "aws_api_gateway_resource" "intent_derive" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent.id
  path_part   = "derive"
}

# Lazy agent transcript: the detail DTO no longer carries OUTPUT rows (they
# dominate a long run's partition); the UI fetches them per activity pane.
resource "aws_api_gateway_resource" "intent_outputs" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent.id
  path_part   = "outputs"
}

resource "aws_api_gateway_resource" "intent_start" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent.id
  path_part   = "start"
}

# Steering (docs/v2-steering.md): cancel a parked/stranded/failed run; rewind
# the run to an earlier stage with corrective guidance.
resource "aws_api_gateway_resource" "intent_cancel" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent.id
  path_part   = "cancel"
}

resource "aws_api_gateway_resource" "intent_rewind" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent.id
  path_part   = "rewind"
}

resource "aws_api_gateway_resource" "intent_repair" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent.id
  path_part   = "repair"
}

# Composer sessions (Adaptive Workflows): start a compose (front/report),
# presign the report upload, and list this intent's sessions.
resource "aws_api_gateway_resource" "intent_compose" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent.id
  path_part   = "compose"
}

resource "aws_api_gateway_resource" "intent_compose_report_upload" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent.id
  path_part   = "compose-report-upload"
}

resource "aws_api_gateway_resource" "intent_composes" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent.id
  path_part   = "composes"
}

# In-flight reshape: replace the run's projection with a new composed grid and
# relaunch at the first not-yet-done stage (retire-and-relaunch, like rewind).
resource "aws_api_gateway_resource" "intent_recompose" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent.id
  path_part   = "recompose"
}

resource "aws_api_gateway_resource" "intent_realtime_token" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent.id
  path_part   = "realtime-token"
}

resource "aws_api_gateway_resource" "intent_units" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent.id
  path_part   = "units"
}

resource "aws_api_gateway_resource" "intent_unit_section" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent_units.id
  path_part   = "{sectionIndex}"
}

resource "aws_api_gateway_resource" "intent_unit" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent_unit_section.id
  path_part   = "{unitSlug}"
}

resource "aws_api_gateway_resource" "intent_unit_feedback" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent_unit.id
  path_part   = "feedback"
}

resource "aws_api_gateway_resource" "intent_gates" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent.id
  path_part   = "gates"
}

resource "aws_api_gateway_resource" "intent_gate" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent_gates.id
  path_part   = "{humanTaskId}"
}

resource "aws_api_gateway_resource" "intent_gate_answer" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent_gate.id
  path_part   = "answer"
}

# Steering: revise an already-answered gate (the correction is a STEER row
# delivered at the next deterministic injection point).
resource "aws_api_gateway_resource" "intent_gate_revise" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent_gate.id
  path_part   = "revise"
}

# Post-hoc artifact (document) editing:
#   /intents/{intentId}/artifacts/{artifactId}/impact       GET  — drift warning data
#   /intents/{intentId}/artifacts/{artifactId}/content      PUT  — human edit
#   /intents/{intentId}/artifacts/{artifactId}/verify       POST — clear stale marker
#   /intents/{intentId}/artifacts/{artifactId}/quorum-edit  POST — start a Quorum edit
#   /intents/{intentId}/artifacts/{artifactId}/versions     GET  — immutable history
#   /intents/{intentId}/artifacts/{artifactId}/versions/{versionId} GET — archived content
#   /intents/{intentId}/quorum-edits/{editId}/decision      POST — approve/reject the plan
resource "aws_api_gateway_resource" "intent_artifacts" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent.id
  path_part   = "artifacts"
}

resource "aws_api_gateway_resource" "intent_artifact" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent_artifacts.id
  path_part   = "{artifactId}"
}

resource "aws_api_gateway_resource" "intent_artifact_impact" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent_artifact.id
  path_part   = "impact"
}

resource "aws_api_gateway_resource" "intent_artifact_content" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent_artifact.id
  path_part   = "content"
}

resource "aws_api_gateway_resource" "intent_artifact_verify" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent_artifact.id
  path_part   = "verify"
}

resource "aws_api_gateway_resource" "intent_artifact_quorum_edit" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent_artifact.id
  path_part   = "quorum-edit"
}

resource "aws_api_gateway_resource" "intent_artifact_versions" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent_artifact.id
  path_part   = "versions"
}

resource "aws_api_gateway_resource" "intent_artifact_version" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent_artifact_versions.id
  path_part   = "{versionId}"
}

resource "aws_api_gateway_resource" "intent_quorum_edits" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent.id
  path_part   = "quorum-edits"
}

resource "aws_api_gateway_resource" "intent_quorum_edit" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent_quorum_edits.id
  path_part   = "{editId}"
}

resource "aws_api_gateway_resource" "intent_quorum_edit_decision" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent_quorum_edit.id
  path_part   = "decision"
}

locals {
  intent_routes = {
    collection_get  = { resource = aws_api_gateway_resource.intents.id, method = "GET" }
    collection_post = { resource = aws_api_gateway_resource.intents.id, method = "POST" }
    metrics_get     = { resource = aws_api_gateway_resource.intents_metrics.id, method = "GET" }
    item_get        = { resource = aws_api_gateway_resource.intent.id, method = "GET" }
    item_patch      = { resource = aws_api_gateway_resource.intent.id, method = "PATCH" }
    item_delete     = { resource = aws_api_gateway_resource.intent.id, method = "DELETE" }
    graph_get       = { resource = aws_api_gateway_resource.intent_graph.id, method = "GET" }
    audit_get       = { resource = aws_api_gateway_resource.intent_audit.id, method = "GET" }
    derive_post     = { resource = aws_api_gateway_resource.intent_derive.id, method = "POST" }
    outputs_get     = { resource = aws_api_gateway_resource.intent_outputs.id, method = "GET" }
    start_post      = { resource = aws_api_gateway_resource.intent_start.id, method = "POST" }
    cancel_post     = { resource = aws_api_gateway_resource.intent_cancel.id, method = "POST" }
    rewind_post     = { resource = aws_api_gateway_resource.intent_rewind.id, method = "POST" }
    repair_post     = { resource = aws_api_gateway_resource.intent_repair.id, method = "POST" }
    compose_post    = { resource = aws_api_gateway_resource.intent_compose.id, method = "POST" }
    compose_upload  = { resource = aws_api_gateway_resource.intent_compose_report_upload.id, method = "POST" }
    composes_get    = { resource = aws_api_gateway_resource.intent_composes.id, method = "GET" }
    recompose_post  = { resource = aws_api_gateway_resource.intent_recompose.id, method = "POST" }
    token_post      = { resource = aws_api_gateway_resource.intent_realtime_token.id, method = "POST" }
    feedback_get    = { resource = aws_api_gateway_resource.intent_unit_feedback.id, method = "GET" }
    feedback_post   = { resource = aws_api_gateway_resource.intent_unit_feedback.id, method = "POST" }
    answer_post     = { resource = aws_api_gateway_resource.intent_gate_answer.id, method = "POST" }
    revise_post     = { resource = aws_api_gateway_resource.intent_gate_revise.id, method = "POST" }
    # Post-hoc artifact editing (human + Quorum-supported).
    artifact_impact_get   = { resource = aws_api_gateway_resource.intent_artifact_impact.id, method = "GET" }
    artifact_content_put  = { resource = aws_api_gateway_resource.intent_artifact_content.id, method = "PUT" }
    artifact_verify_post  = { resource = aws_api_gateway_resource.intent_artifact_verify.id, method = "POST" }
    artifact_qedit_post   = { resource = aws_api_gateway_resource.intent_artifact_quorum_edit.id, method = "POST" }
    artifact_versions_get = { resource = aws_api_gateway_resource.intent_artifact_versions.id, method = "GET" }
    artifact_version_get  = { resource = aws_api_gateway_resource.intent_artifact_version.id, method = "GET" }
    qedit_decision_post   = { resource = aws_api_gateway_resource.intent_quorum_edit_decision.id, method = "POST" }
  }
}

resource "aws_api_gateway_method" "intent" {
  for_each      = local.intent_routes
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = each.value.resource
  http_method   = each.value.method
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "intent" {
  for_each                = local.intent_routes
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = each.value.resource
  http_method             = aws_api_gateway_method.intent[each.key].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.intents_lambda_invoke_arn
}

module "cors_intents" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intents.id
}

module "cors_intents_metrics" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intents_metrics.id
}

module "cors_intent" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent.id
}

module "cors_intent_graph" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_graph.id
}

module "cors_intent_audit" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_audit.id
}

module "cors_intent_derive" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_derive.id
}

module "cors_intent_outputs" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_outputs.id
}

module "cors_intent_start" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_start.id
}

module "cors_intent_cancel" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_cancel.id
}

module "cors_intent_rewind" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_rewind.id
}

module "cors_intent_repair" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_repair.id
}

module "cors_intent_compose" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_compose.id
}

module "cors_intent_compose_report_upload" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_compose_report_upload.id
}

module "cors_intent_composes" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_composes.id
}

module "cors_intent_recompose" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_recompose.id
}

module "cors_intent_realtime_token" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_realtime_token.id
}

module "cors_intent_unit_feedback" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_unit_feedback.id
}

module "cors_intent_gate_answer" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_gate_answer.id
}

module "cors_intent_gate_revise" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_gate_revise.id
}

module "cors_intent_artifact_impact" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_artifact_impact.id
}

module "cors_intent_artifact_content" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_artifact_content.id
}

module "cors_intent_artifact_verify" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_artifact_verify.id
}

module "cors_intent_artifact_quorum_edit" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_artifact_quorum_edit.id
}

module "cors_intent_artifact_versions" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_artifact_versions.id
}

module "cors_intent_artifact_version" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_artifact_version.id
}

module "cors_intent_quorum_edit_decision" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_quorum_edit_decision.id
}

resource "aws_lambda_permission" "intents" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.intents_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

# =============================================================================
# /projects/{projectId}/intents/{intentId}/discussions* — intent-scoped
# discussion threads, served by the (now scope-neutral) discussions Lambda.
# Mirrors the sprint discussion routes; the handler resolves the scope from the
# path params. Quorum assist is intent-only and lives under each discussion.
# =============================================================================

resource "aws_api_gateway_resource" "intent_discussions" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent.id
  path_part   = "discussions"
}

resource "aws_api_gateway_resource" "intent_discussions_search" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent_discussions.id
  path_part   = "search"
}

resource "aws_api_gateway_resource" "intent_discussion" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent_discussions.id
  path_part   = "{discussionId}"
}

resource "aws_api_gateway_resource" "intent_discussion_messages" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent_discussion.id
  path_part   = "messages"
}

resource "aws_api_gateway_resource" "intent_discussion_message" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent_discussion_messages.id
  path_part   = "{messageId}"
}

resource "aws_api_gateway_resource" "intent_discussion_message_redact" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent_discussion_message.id
  path_part   = "redact"
}

resource "aws_api_gateway_resource" "intent_discussion_read" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent_discussion.id
  path_part   = "read"
}

resource "aws_api_gateway_resource" "intent_discussion_assist" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.intent_discussion.id
  path_part   = "assist"
}

locals {
  intent_discussion_routes = {
    list_get      = { resource = aws_api_gateway_resource.intent_discussions.id, method = "GET" }
    create_post   = { resource = aws_api_gateway_resource.intent_discussions.id, method = "POST" }
    search_get    = { resource = aws_api_gateway_resource.intent_discussions_search.id, method = "GET" }
    item_put      = { resource = aws_api_gateway_resource.intent_discussion.id, method = "PUT" }
    read_put      = { resource = aws_api_gateway_resource.intent_discussion_read.id, method = "PUT" }
    messages_get  = { resource = aws_api_gateway_resource.intent_discussion_messages.id, method = "GET" }
    messages_post = { resource = aws_api_gateway_resource.intent_discussion_messages.id, method = "POST" }
    redact_post   = { resource = aws_api_gateway_resource.intent_discussion_message_redact.id, method = "POST" }
    assist_post   = { resource = aws_api_gateway_resource.intent_discussion_assist.id, method = "POST" }
  }
}

resource "aws_api_gateway_method" "intent_discussion" {
  for_each      = local.intent_discussion_routes
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = each.value.resource
  http_method   = each.value.method
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "intent_discussion" {
  for_each                = local.intent_discussion_routes
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = each.value.resource
  http_method             = aws_api_gateway_method.intent_discussion[each.key].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.discussions_lambda_invoke_arn
}

module "cors_intent_discussions" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_discussions.id
}

module "cors_intent_discussions_search" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_discussions_search.id
}

module "cors_intent_discussion" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_discussion.id
}

module "cors_intent_discussion_messages" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_discussion_messages.id
}

module "cors_intent_discussion_message_redact" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_discussion_message_redact.id
}

module "cors_intent_discussion_read" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_discussion_read.id
}

module "cors_intent_discussion_assist" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.intent_discussion_assist.id
}

# The discussions Lambda already holds a broad ($API/*/*) invoke permission for
# its sprint routes — it covers these intent routes too. No new permission.

# =============================================================================
# Helper locals for sprint-scoped CRUD pattern
# =============================================================================
locals {
  sprint_entities = {
    requirements = {
      collection_resource = aws_api_gateway_resource.requirements.id
      item_resource       = aws_api_gateway_resource.requirement.id
      invoke_arn          = var.requirements_lambda_invoke_arn
      lambda_name         = var.requirements_lambda_name
      item_param          = "requirementId"
    }
    user_stories = {
      collection_resource = aws_api_gateway_resource.user_stories.id
      item_resource       = aws_api_gateway_resource.user_story.id
      invoke_arn          = var.user_stories_lambda_invoke_arn
      lambda_name         = var.user_stories_lambda_name
      item_param          = "storyId"
    }
    tasks = {
      collection_resource = aws_api_gateway_resource.tasks.id
      item_resource       = aws_api_gateway_resource.task.id
      invoke_arn          = var.tasks_lambda_invoke_arn
      lambda_name         = var.tasks_lambda_name
      item_param          = "taskId"
    }
    general_info = {
      collection_resource = aws_api_gateway_resource.general_info.id
      item_resource       = aws_api_gateway_resource.general_info_item.id
      invoke_arn          = var.general_info_lambda_invoke_arn
      lambda_name         = var.general_info_lambda_name
      item_param          = "infoId"
    }
    code_files = {
      collection_resource = aws_api_gateway_resource.code_files.id
      item_resource       = aws_api_gateway_resource.code_file.id
      invoke_arn          = var.code_files_lambda_invoke_arn
      lambda_name         = var.code_files_lambda_name
      item_param          = "codeFileId"
    }
    questions = {
      collection_resource = aws_api_gateway_resource.questions.id
      item_resource       = aws_api_gateway_resource.question.id
      invoke_arn          = var.questions_lambda_invoke_arn
      lambda_name         = var.questions_lambda_name
      item_param          = "questionId"
    }
  }
}

# =============================================================================
# Sprint-scoped entity reads (collection: GET) — v1 is frozen read-only
# =============================================================================
resource "aws_api_gateway_method" "entity_collection_get" {
  for_each           = local.sprint_entities
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = each.value.collection_resource
  http_method        = "GET"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.sprintId" = true }
}

resource "aws_api_gateway_integration" "entity_collection_get" {
  for_each                = local.sprint_entities
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = each.value.collection_resource
  http_method             = aws_api_gateway_method.entity_collection_get[each.key].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = each.value.invoke_arn
}

# =============================================================================
# Sprint-scoped entity reads (item: GET)
# =============================================================================
resource "aws_api_gateway_method" "entity_item_get" {
  for_each           = local.sprint_entities
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = each.value.item_resource
  http_method        = "GET"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.sprintId" = true, "method.request.path.${each.value.item_param}" = true }
}

resource "aws_api_gateway_integration" "entity_item_get" {
  for_each                = local.sprint_entities
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = each.value.item_resource
  http_method             = aws_api_gateway_method.entity_item_get[each.key].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = each.value.invoke_arn
}

# =============================================================================
# Review Methods (singleton per sprint: GET) — v1 is frozen read-only
# =============================================================================
resource "aws_api_gateway_method" "review_get" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.review.id
  http_method        = "GET"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.sprintId" = true }
}

resource "aws_api_gateway_integration" "review_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.review.id
  http_method             = aws_api_gateway_method.review_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.reviews_lambda_invoke_arn
}

# =============================================================================
# Sprint Graph (GET only)
# =============================================================================
resource "aws_api_gateway_method" "sprint_graph_get" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.sprint_graph.id
  http_method        = "GET"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.sprintId" = true }
}
resource "aws_api_gateway_integration" "sprint_graph_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.sprint_graph.id
  http_method             = aws_api_gateway_method.sprint_graph_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.sprint_graph_lambda_invoke_arn
}

# =============================================================================
# Timeline Events Methods (GET list) — v1 is frozen read-only
# =============================================================================
resource "aws_api_gateway_method" "timeline_events_get" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.timeline_events.id
  http_method        = "GET"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.sprintId" = true }
}

resource "aws_api_gateway_integration" "timeline_events_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.timeline_events.id
  http_method             = aws_api_gateway_method.timeline_events_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.timeline_events_lambda_invoke_arn
}

# =============================================================================
# Realtime-token Methods (POST sprint + project variants)
# =============================================================================
resource "aws_api_gateway_method" "sprint_realtime_token_post" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.sprint_realtime_token.id
  http_method        = "POST"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.sprintId" = true }
}
resource "aws_api_gateway_method" "project_realtime_token_post" {
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = aws_api_gateway_resource.project_realtime_token.id
  http_method        = "POST"
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = { "method.request.path.projectId" = true }
}

resource "aws_api_gateway_integration" "sprint_realtime_token_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.sprint_realtime_token.id
  http_method             = aws_api_gateway_method.sprint_realtime_token_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.discussions_lambda_invoke_arn
}
resource "aws_api_gateway_integration" "project_realtime_token_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_realtime_token.id
  http_method             = aws_api_gateway_method.project_realtime_token_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.discussions_lambda_invoke_arn
}

# =============================================================================
# Discussions Methods (v1 sprint-scoped, frozen read-only; the user-scoped
# read-state PUT stays writable — it is not project content)
#   GET /sprints/{sprintId}/discussions
#   GET /sprints/{sprintId}/discussions/search
#   PUT /sprints/{sprintId}/discussions/{discussionId}/read
#   GET /sprints/{sprintId}/discussions/{discussionId}/messages
# =============================================================================
locals {
  discussion_routes = {
    discussions_get = {
      resource = "discussions"
      method   = "GET"
      params   = { "method.request.path.sprintId" = true }
    }
    discussions_search_get = {
      resource = "discussions_search"
      method   = "GET"
      params   = { "method.request.path.sprintId" = true }
    }
    discussion_read_put = {
      resource = "discussion_read"
      method   = "PUT"
      params   = { "method.request.path.sprintId" = true, "method.request.path.discussionId" = true }
    }
    discussion_messages_get = {
      resource = "discussion_messages"
      method   = "GET"
      params   = { "method.request.path.sprintId" = true, "method.request.path.discussionId" = true }
    }
  }
  discussion_resource_ids = {
    discussions         = aws_api_gateway_resource.discussions.id
    discussions_search  = aws_api_gateway_resource.discussions_search.id
    discussion          = aws_api_gateway_resource.discussion.id
    discussion_read     = aws_api_gateway_resource.discussion_read.id
    discussion_messages = aws_api_gateway_resource.discussion_messages.id
  }
}

resource "aws_api_gateway_method" "discussion_routes" {
  for_each           = local.discussion_routes
  rest_api_id        = aws_api_gateway_rest_api.main.id
  resource_id        = local.discussion_resource_ids[each.value.resource]
  http_method        = each.value.method
  authorization      = "COGNITO_USER_POOLS"
  authorizer_id      = aws_api_gateway_authorizer.cognito.id
  request_parameters = each.value.params
}

resource "aws_api_gateway_integration" "discussion_routes" {
  for_each                = local.discussion_routes
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = local.discussion_resource_ids[each.value.resource]
  http_method             = aws_api_gateway_method.discussion_routes[each.key].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.discussions_lambda_invoke_arn
}

# =============================================================================
# CORS OPTIONS Methods for all resources
# =============================================================================
module "cors_projects" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.projects.id
}

module "cors_project" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.project.id
}

module "cors_migrate_tracker" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.migrate_tracker.id
}

module "cors_admin_tracker_migration" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.admin_tracker_migration.id
}

module "cors_admin_tracker_migration_status" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.admin_tracker_migration_status.id
}

module "cors_members" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.members.id
}

module "cors_member" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.member.id
}

module "cors_sprints" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.sprints.id
}
module "cors_sprint" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.sprint.id
}
module "cors_requirements" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.requirements.id
}
module "cors_requirement" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.requirement.id
}
module "cors_user_stories" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.user_stories.id
}
module "cors_user_story" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.user_story.id
}
module "cors_tasks" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.tasks.id
}
module "cors_task" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.task.id
}
module "cors_general_info" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.general_info.id
}
module "cors_general_info_item" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.general_info_item.id
}
module "cors_code_files" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.code_files.id
}
module "cors_code_file" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.code_file.id
}
module "cors_review" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.review.id
}
module "cors_questions" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.questions.id
}
module "cors_question" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.question.id
}
module "cors_sprint_graph" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.sprint_graph.id
}
module "cors_timeline_events" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.timeline_events.id
}

module "cors_sprint_realtime_token" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.sprint_realtime_token.id
}

module "cors_project_realtime_token" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.project_realtime_token.id
}

module "cors_discussions" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.discussions.id
}

module "cors_discussion" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.discussion.id
}

module "cors_discussion_messages" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.discussion_messages.id
}

module "cors_discussion_read" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.discussion_read.id
}

module "cors_discussions_search" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.discussions_search.id
}

# =============================================================================
# Lambda Permissions
# =============================================================================
resource "aws_lambda_permission" "projects" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.projects_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "users" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.users_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "sprints" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.sprints_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "entity_lambdas" {
  for_each      = local.sprint_entities
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = each.value.lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "reviews" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.reviews_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "sprint_graph" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.sprint_graph_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "timeline_events" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.timeline_events_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "discussions" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.discussions_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}


# =============================================================================
# GitHub OAuth Routes
# =============================================================================

# -----------------------------------------------------------------------------
# /github Resource
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "github" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "github"
}

resource "aws_api_gateway_resource" "github_auth" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github.id
  path_part   = "auth"
}

resource "aws_api_gateway_resource" "github_callback" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github.id
  path_part   = "callback"
}

resource "aws_api_gateway_resource" "github_repos" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github.id
  path_part   = "repos"
}

resource "aws_api_gateway_resource" "github_status" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github.id
  path_part   = "status"
}

resource "aws_api_gateway_resource" "github_disconnect" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github.id
  path_part   = "disconnect"
}

# /github/repos/{owner}
resource "aws_api_gateway_resource" "github_repos_owner" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github_repos.id
  path_part   = "{owner}"
}

# /github/repos/{owner}/{repo}
resource "aws_api_gateway_resource" "github_repos_owner_repo" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github_repos_owner.id
  path_part   = "{repo}"
}

# /github/repos/{owner}/{repo}/branches
resource "aws_api_gateway_resource" "github_repos_branches" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github_repos_owner_repo.id
  path_part   = "branches"
}

# /github/repos/{owner}/{repo}/tree
resource "aws_api_gateway_resource" "github_repos_tree" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github_repos_owner_repo.id
  path_part   = "tree"
}

# /github/repos/{owner}/{repo}/contents
resource "aws_api_gateway_resource" "github_repos_contents" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github_repos_owner_repo.id
  path_part   = "contents"
}

# /github/admin — platform-admin GitHub configuration (auth mode + App config)
resource "aws_api_gateway_resource" "github_admin" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github.id
  path_part   = "admin"
}

# /github/admin/config
resource "aws_api_gateway_resource" "github_admin_config" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github_admin.id
  path_part   = "config"
}

# -----------------------------------------------------------------------------
# GitHub Methods
# -----------------------------------------------------------------------------

# GET /github/auth (authenticated)
resource "aws_api_gateway_method" "github_auth_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_auth.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_auth_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_auth.id
  http_method             = aws_api_gateway_method.github_auth_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_lambda_invoke_arn
}

# GET /github/callback (no auth - OAuth redirect)
resource "aws_api_gateway_method" "github_callback_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_callback.id
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "github_callback_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_callback.id
  http_method             = aws_api_gateway_method.github_callback_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_lambda_invoke_arn
}

# GET /github/repos (authenticated)
resource "aws_api_gateway_method" "github_repos_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_repos.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_repos_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_repos.id
  http_method             = aws_api_gateway_method.github_repos_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_lambda_invoke_arn
}

# GET /github/status (authenticated)
resource "aws_api_gateway_method" "github_status_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_status.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_status_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_status.id
  http_method             = aws_api_gateway_method.github_status_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_lambda_invoke_arn
}

# DELETE /github/disconnect (authenticated)
resource "aws_api_gateway_method" "github_disconnect_delete" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_disconnect.id
  http_method   = "DELETE"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_disconnect_delete" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_disconnect.id
  http_method             = aws_api_gateway_method.github_disconnect_delete.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_lambda_invoke_arn
}

# GET /github/admin/config (authenticated; the Lambda additionally enforces
# the Cognito platform-admin group — see lambda/shared/authz.js)
resource "aws_api_gateway_method" "github_admin_config_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_admin_config.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_admin_config_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_admin_config.id
  http_method             = aws_api_gateway_method.github_admin_config_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_lambda_invoke_arn
}

# PUT /github/admin/config (authenticated; platform-admin enforced in Lambda)
resource "aws_api_gateway_method" "github_admin_config_put" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_admin_config.id
  http_method   = "PUT"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_admin_config_put" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_admin_config.id
  http_method             = aws_api_gateway_method.github_admin_config_put.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_lambda_invoke_arn
}

# GET /github/repos/{owner}/{repo}/branches (authenticated)
resource "aws_api_gateway_method" "github_repos_branches_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_repos_branches.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_repos_branches_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_repos_branches.id
  http_method             = aws_api_gateway_method.github_repos_branches_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_lambda_invoke_arn
}

# GET /github/repos/{owner}/{repo}/tree (authenticated)
resource "aws_api_gateway_method" "github_repos_tree_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_repos_tree.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_repos_tree_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_repos_tree.id
  http_method             = aws_api_gateway_method.github_repos_tree_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_lambda_invoke_arn
}

# GET /github/repos/{owner}/{repo}/contents (authenticated)
resource "aws_api_gateway_method" "github_repos_contents_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_repos_contents.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_repos_contents_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_repos_contents.id
  http_method             = aws_api_gateway_method.github_repos_contents_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_lambda_invoke_arn
}

# -----------------------------------------------------------------------------
# GitHub CORS
# -----------------------------------------------------------------------------
module "cors_github_auth" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.github_auth.id
}

module "cors_github_callback" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.github_callback.id
}

module "cors_github_repos" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.github_repos.id
}

module "cors_github_status" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.github_status.id
}

module "cors_github_disconnect" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.github_disconnect.id
}

module "cors_github_repos_branches" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.github_repos_branches.id
}

module "cors_github_repos_tree" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.github_repos_tree.id
}

module "cors_github_repos_contents" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.github_repos_contents.id
}

module "cors_github_admin_config" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.github_admin_config.id
}

# /github/repos/{owner}/{repo}/pulls
resource "aws_api_gateway_resource" "github_repos_pulls" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github_repos_owner_repo.id
  path_part   = "pulls"
}

# /github/repos/{owner}/{repo}/pulls/{prNumber}
resource "aws_api_gateway_resource" "github_repos_pulls_number" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github_repos_pulls.id
  path_part   = "{prNumber}"
}

# /github/repos/{owner}/{repo}/pulls/{prNumber}/comments
resource "aws_api_gateway_resource" "github_repos_pulls_comments" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.github_repos_pulls_number.id
  path_part   = "comments"
}

# GET /github/repos/{owner}/{repo}/pulls/{prNumber}/comments (authenticated)
resource "aws_api_gateway_method" "github_pulls_comments_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_repos_pulls_comments.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_pulls_comments_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_repos_pulls_comments.id
  http_method             = aws_api_gateway_method.github_pulls_comments_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_lambda_invoke_arn
}

# POST /github/repos/{owner}/{repo}/pulls/{prNumber}/comments (authenticated)
resource "aws_api_gateway_method" "github_pulls_comments_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.github_repos_pulls_comments.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "github_pulls_comments_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.github_repos_pulls_comments.id
  http_method             = aws_api_gateway_method.github_pulls_comments_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.github_lambda_invoke_arn
}

module "cors_github_repos_pulls_comments" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.github_repos_pulls_comments.id
}

# -----------------------------------------------------------------------------
# GitHub Lambda Permission
# -----------------------------------------------------------------------------
resource "aws_lambda_permission" "github" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.github_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

# =============================================================================
# Bitbucket OAuth Routes
#
# Bitbucket Cloud addresses repositories by a two-segment "workspace/repo_slug"
# path — the same shape as GitHub's "owner/repo" — so these routes mirror the
# GitHub layout exactly (path segments, not GitLab's ?project= query string).
# The Bitbucket lambda's route descriptors match the same /repos/{a}/{b}/…
# shapes.
# =============================================================================

# -----------------------------------------------------------------------------
# /bitbucket Resource
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "bitbucket" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "bitbucket"
}

resource "aws_api_gateway_resource" "bitbucket_auth" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.bitbucket.id
  path_part   = "auth"
}

resource "aws_api_gateway_resource" "bitbucket_callback" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.bitbucket.id
  path_part   = "callback"
}

resource "aws_api_gateway_resource" "bitbucket_repos" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.bitbucket.id
  path_part   = "repos"
}

resource "aws_api_gateway_resource" "bitbucket_status" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.bitbucket.id
  path_part   = "status"
}

resource "aws_api_gateway_resource" "bitbucket_disconnect" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.bitbucket.id
  path_part   = "disconnect"
}

# /bitbucket/repos/{owner}
resource "aws_api_gateway_resource" "bitbucket_repos_owner" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.bitbucket_repos.id
  path_part   = "{owner}"
}

# /bitbucket/repos/{owner}/{repo}
resource "aws_api_gateway_resource" "bitbucket_repos_owner_repo" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.bitbucket_repos_owner.id
  path_part   = "{repo}"
}

# /bitbucket/repos/{owner}/{repo}/branches
resource "aws_api_gateway_resource" "bitbucket_repos_branches" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.bitbucket_repos_owner_repo.id
  path_part   = "branches"
}

# /bitbucket/repos/{owner}/{repo}/tree
resource "aws_api_gateway_resource" "bitbucket_repos_tree" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.bitbucket_repos_owner_repo.id
  path_part   = "tree"
}

# /bitbucket/repos/{owner}/{repo}/contents
resource "aws_api_gateway_resource" "bitbucket_repos_contents" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.bitbucket_repos_owner_repo.id
  path_part   = "contents"
}

# /bitbucket/repos/{owner}/{repo}/pulls
resource "aws_api_gateway_resource" "bitbucket_repos_pulls" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.bitbucket_repos_owner_repo.id
  path_part   = "pulls"
}

# /bitbucket/repos/{owner}/{repo}/pulls/{prNumber}
resource "aws_api_gateway_resource" "bitbucket_repos_pulls_number" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.bitbucket_repos_pulls.id
  path_part   = "{prNumber}"
}

# /bitbucket/repos/{owner}/{repo}/pulls/{prNumber}/comments
resource "aws_api_gateway_resource" "bitbucket_repos_pulls_comments" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.bitbucket_repos_pulls_number.id
  path_part   = "comments"
}

# -----------------------------------------------------------------------------
# Bitbucket Methods + Integrations
# -----------------------------------------------------------------------------

# GET /bitbucket/auth (authenticated)
resource "aws_api_gateway_method" "bitbucket_auth_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.bitbucket_auth.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "bitbucket_auth_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.bitbucket_auth.id
  http_method             = aws_api_gateway_method.bitbucket_auth_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.bitbucket_lambda_invoke_arn
}

# GET /bitbucket/callback (no auth - OAuth redirect)
resource "aws_api_gateway_method" "bitbucket_callback_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.bitbucket_callback.id
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "bitbucket_callback_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.bitbucket_callback.id
  http_method             = aws_api_gateway_method.bitbucket_callback_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.bitbucket_lambda_invoke_arn
}

# GET /bitbucket/repos (authenticated)
resource "aws_api_gateway_method" "bitbucket_repos_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.bitbucket_repos.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "bitbucket_repos_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.bitbucket_repos.id
  http_method             = aws_api_gateway_method.bitbucket_repos_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.bitbucket_lambda_invoke_arn
}

# GET /bitbucket/status (authenticated)
resource "aws_api_gateway_method" "bitbucket_status_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.bitbucket_status.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "bitbucket_status_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.bitbucket_status.id
  http_method             = aws_api_gateway_method.bitbucket_status_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.bitbucket_lambda_invoke_arn
}

# DELETE /bitbucket/disconnect (authenticated)
resource "aws_api_gateway_method" "bitbucket_disconnect_delete" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.bitbucket_disconnect.id
  http_method   = "DELETE"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "bitbucket_disconnect_delete" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.bitbucket_disconnect.id
  http_method             = aws_api_gateway_method.bitbucket_disconnect_delete.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.bitbucket_lambda_invoke_arn
}

# GET /bitbucket/repos/{owner}/{repo}/branches (authenticated)
resource "aws_api_gateway_method" "bitbucket_repos_branches_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.bitbucket_repos_branches.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "bitbucket_repos_branches_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.bitbucket_repos_branches.id
  http_method             = aws_api_gateway_method.bitbucket_repos_branches_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.bitbucket_lambda_invoke_arn
}

# GET /bitbucket/repos/{owner}/{repo}/tree (authenticated)
resource "aws_api_gateway_method" "bitbucket_repos_tree_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.bitbucket_repos_tree.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "bitbucket_repos_tree_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.bitbucket_repos_tree.id
  http_method             = aws_api_gateway_method.bitbucket_repos_tree_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.bitbucket_lambda_invoke_arn
}

# GET /bitbucket/repos/{owner}/{repo}/contents (authenticated)
resource "aws_api_gateway_method" "bitbucket_repos_contents_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.bitbucket_repos_contents.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "bitbucket_repos_contents_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.bitbucket_repos_contents.id
  http_method             = aws_api_gateway_method.bitbucket_repos_contents_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.bitbucket_lambda_invoke_arn
}

# GET /bitbucket/repos/{owner}/{repo}/pulls/{prNumber}/comments (authenticated)
resource "aws_api_gateway_method" "bitbucket_pulls_comments_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.bitbucket_repos_pulls_comments.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "bitbucket_pulls_comments_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.bitbucket_repos_pulls_comments.id
  http_method             = aws_api_gateway_method.bitbucket_pulls_comments_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.bitbucket_lambda_invoke_arn
}

# POST /bitbucket/repos/{owner}/{repo}/pulls/{prNumber}/comments (authenticated)
resource "aws_api_gateway_method" "bitbucket_pulls_comments_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.bitbucket_repos_pulls_comments.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "bitbucket_pulls_comments_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.bitbucket_repos_pulls_comments.id
  http_method             = aws_api_gateway_method.bitbucket_pulls_comments_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.bitbucket_lambda_invoke_arn
}

# -----------------------------------------------------------------------------
# Bitbucket CORS
# -----------------------------------------------------------------------------
module "cors_bitbucket_auth" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.bitbucket_auth.id
}

module "cors_bitbucket_callback" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.bitbucket_callback.id
}

module "cors_bitbucket_repos" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.bitbucket_repos.id
}

module "cors_bitbucket_status" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.bitbucket_status.id
}

module "cors_bitbucket_disconnect" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.bitbucket_disconnect.id
}

module "cors_bitbucket_repos_branches" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.bitbucket_repos_branches.id
}

module "cors_bitbucket_repos_tree" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.bitbucket_repos_tree.id
}

module "cors_bitbucket_repos_contents" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.bitbucket_repos_contents.id
}

module "cors_bitbucket_repos_pulls_comments" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.bitbucket_repos_pulls_comments.id
}

# -----------------------------------------------------------------------------
# Bitbucket Lambda Permission
# -----------------------------------------------------------------------------
resource "aws_lambda_permission" "bitbucket" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.bitbucket_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

# =============================================================================
# GitLab OAuth Routes
# =============================================================================

# -----------------------------------------------------------------------------
# /gitlab Resource
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "gitlab" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "gitlab"
}

resource "aws_api_gateway_resource" "gitlab_auth" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.gitlab.id
  path_part   = "auth"
}

resource "aws_api_gateway_resource" "gitlab_callback" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.gitlab.id
  path_part   = "callback"
}

resource "aws_api_gateway_resource" "gitlab_repos" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.gitlab.id
  path_part   = "repos"
}

resource "aws_api_gateway_resource" "gitlab_status" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.gitlab.id
  path_part   = "status"
}

resource "aws_api_gateway_resource" "gitlab_disconnect" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.gitlab.id
  path_part   = "disconnect"
}

# /gitlab/projects
resource "aws_api_gateway_resource" "gitlab_projects" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.gitlab.id
  path_part   = "projects"
}

# GitLab project paths are namespaced (group/project, often group/subgroup/
# project). Encoded slashes (%2F) in a REST API Gateway path segment are
# fragile — API Gateway / CloudFront may reject or normalize them. So the
# project reference travels as a `?project=<url-encoded path>` QUERY STRING
# (passed through verbatim by API Gateway) rather than a path segment. The
# Lambda then URL-encodes it into the GitLab API path, which is the format
# GitLab requires on the server-to-server hop (no API Gateway in between).

# /gitlab/projects/branches  (GET ?project=)
resource "aws_api_gateway_resource" "gitlab_projects_branches" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.gitlab_projects.id
  path_part   = "branches"
}

# /gitlab/projects/tree  (GET ?project=&branch=)
resource "aws_api_gateway_resource" "gitlab_projects_tree" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.gitlab_projects.id
  path_part   = "tree"
}

# /gitlab/projects/contents  (GET ?project=&path=&branch=)
resource "aws_api_gateway_resource" "gitlab_projects_contents" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.gitlab_projects.id
  path_part   = "contents"
}

# /gitlab/projects/merge_requests  (mrIid is numeric, so it is slash-free and
# safe as a path segment; the project still travels as ?project=)
resource "aws_api_gateway_resource" "gitlab_projects_merge_requests" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.gitlab_projects.id
  path_part   = "merge_requests"
}

# /gitlab/projects/merge_requests/{mrIid}
resource "aws_api_gateway_resource" "gitlab_projects_mr_iid" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.gitlab_projects_merge_requests.id
  path_part   = "{mrIid}"
}

# /gitlab/projects/merge_requests/{mrIid}/notes
resource "aws_api_gateway_resource" "gitlab_projects_mr_notes" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.gitlab_projects_mr_iid.id
  path_part   = "notes"
}

# -----------------------------------------------------------------------------
# GitLab Methods
# -----------------------------------------------------------------------------

# GET /gitlab/auth (authenticated)
resource "aws_api_gateway_method" "gitlab_auth_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.gitlab_auth.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "gitlab_auth_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.gitlab_auth.id
  http_method             = aws_api_gateway_method.gitlab_auth_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.gitlab_lambda_invoke_arn
}

# GET /gitlab/callback (no auth - OAuth redirect)
resource "aws_api_gateway_method" "gitlab_callback_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.gitlab_callback.id
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "gitlab_callback_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.gitlab_callback.id
  http_method             = aws_api_gateway_method.gitlab_callback_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.gitlab_lambda_invoke_arn
}

# GET /gitlab/repos (authenticated)
resource "aws_api_gateway_method" "gitlab_repos_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.gitlab_repos.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "gitlab_repos_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.gitlab_repos.id
  http_method             = aws_api_gateway_method.gitlab_repos_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.gitlab_lambda_invoke_arn
}

# GET /gitlab/status (authenticated)
resource "aws_api_gateway_method" "gitlab_status_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.gitlab_status.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "gitlab_status_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.gitlab_status.id
  http_method             = aws_api_gateway_method.gitlab_status_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.gitlab_lambda_invoke_arn
}

# DELETE /gitlab/disconnect (authenticated)
resource "aws_api_gateway_method" "gitlab_disconnect_delete" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.gitlab_disconnect.id
  http_method   = "DELETE"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "gitlab_disconnect_delete" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.gitlab_disconnect.id
  http_method             = aws_api_gateway_method.gitlab_disconnect_delete.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.gitlab_lambda_invoke_arn
}

# GET /gitlab/projects/branches?project= (authenticated)
resource "aws_api_gateway_method" "gitlab_projects_branches_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.gitlab_projects_branches.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "gitlab_projects_branches_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.gitlab_projects_branches.id
  http_method             = aws_api_gateway_method.gitlab_projects_branches_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.gitlab_lambda_invoke_arn
}

# GET /gitlab/projects/tree?project=&branch= (authenticated)
resource "aws_api_gateway_method" "gitlab_projects_tree_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.gitlab_projects_tree.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "gitlab_projects_tree_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.gitlab_projects_tree.id
  http_method             = aws_api_gateway_method.gitlab_projects_tree_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.gitlab_lambda_invoke_arn
}

# GET /gitlab/projects/contents?project=&path=&branch= (authenticated)
resource "aws_api_gateway_method" "gitlab_projects_contents_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.gitlab_projects_contents.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "gitlab_projects_contents_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.gitlab_projects_contents.id
  http_method             = aws_api_gateway_method.gitlab_projects_contents_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.gitlab_lambda_invoke_arn
}

# GET /gitlab/projects/merge_requests/{mrIid}/notes?project= (authenticated)
resource "aws_api_gateway_method" "gitlab_mr_notes_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.gitlab_projects_mr_notes.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "gitlab_mr_notes_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.gitlab_projects_mr_notes.id
  http_method             = aws_api_gateway_method.gitlab_mr_notes_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.gitlab_lambda_invoke_arn
}

# POST /gitlab/projects/merge_requests/{mrIid}/notes?project= (authenticated)
resource "aws_api_gateway_method" "gitlab_mr_notes_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.gitlab_projects_mr_notes.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "gitlab_mr_notes_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.gitlab_projects_mr_notes.id
  http_method             = aws_api_gateway_method.gitlab_mr_notes_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.gitlab_lambda_invoke_arn
}

# -----------------------------------------------------------------------------
# GitLab CORS
# -----------------------------------------------------------------------------
module "cors_gitlab_auth" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.gitlab_auth.id
}

module "cors_gitlab_callback" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.gitlab_callback.id
}

module "cors_gitlab_repos" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.gitlab_repos.id
}

module "cors_gitlab_status" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.gitlab_status.id
}

module "cors_gitlab_disconnect" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.gitlab_disconnect.id
}

module "cors_gitlab_projects_branches" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.gitlab_projects_branches.id
}

module "cors_gitlab_projects_tree" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.gitlab_projects_tree.id
}

module "cors_gitlab_projects_contents" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.gitlab_projects_contents.id
}

module "cors_gitlab_mr_notes" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.gitlab_projects_mr_notes.id
}

# -----------------------------------------------------------------------------
# GitLab Lambda Permission
# -----------------------------------------------------------------------------
resource "aws_lambda_permission" "gitlab" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.gitlab_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

# =============================================================================
# /trackers — provider-agnostic tracker provider routes (issue #196)
#
# Backs the post-Phase-2 frontend. Replaces /github/repos/{o}/{r}/issues* —
# old route paths are no longer registered; clients call the binding-keyed
# routes under /projects/{projectId}/trackers/{bindingId}/issues instead.
# =============================================================================

# /trackers
resource "aws_api_gateway_resource" "trackers_root" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "trackers"
}

# /trackers/auth/{provider}
resource "aws_api_gateway_resource" "trackers_auth" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_root.id
  path_part   = "auth"
}

resource "aws_api_gateway_resource" "trackers_auth_provider" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_auth.id
  path_part   = "{provider}"
}

# /trackers/callback/{provider}
resource "aws_api_gateway_resource" "trackers_callback" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_root.id
  path_part   = "callback"
}

resource "aws_api_gateway_resource" "trackers_callback_provider" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_callback.id
  path_part   = "{provider}"
}

# /trackers/external-projects/{provider}/{instance} — picker for listing
# resources the user can bind (Jira projects today; future providers'
# equivalents). Phase 3 / #197.
resource "aws_api_gateway_resource" "trackers_external_projects" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_root.id
  path_part   = "external-projects"
}

resource "aws_api_gateway_resource" "trackers_external_projects_provider" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_external_projects.id
  path_part   = "{provider}"
}

resource "aws_api_gateway_resource" "trackers_external_projects_provider_instance" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_external_projects_provider.id
  path_part   = "{instance}"
}

# /trackers/connections/{provider}/{instance} — finalize an OAuth flow that
# returned a pendingChoice (Jira multi-site picker). POST only.
resource "aws_api_gateway_resource" "trackers_connections" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_root.id
  path_part   = "connections"
}

resource "aws_api_gateway_resource" "trackers_connections_provider" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_connections.id
  path_part   = "{provider}"
}

resource "aws_api_gateway_resource" "trackers_connections_provider_instance" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_connections_provider.id
  path_part   = "{instance}"
}

# /trackers/providers — operator OAuth-config status + admin secret
# writer. Sibling to the `{provider}` path parameter below; API Gateway
# matches the literal `providers` first when both are present.
resource "aws_api_gateway_resource" "trackers_providers" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_root.id
  path_part   = "providers"
}

resource "aws_api_gateway_resource" "trackers_providers_provider" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_providers.id
  path_part   = "{provider}"
}

resource "aws_api_gateway_resource" "trackers_providers_provider_oauth_config" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_providers_provider.id
  path_part   = "oauth-config"
}

# /trackers/{provider}/{instance}
resource "aws_api_gateway_resource" "trackers_provider" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_root.id
  path_part   = "{provider}"
}

resource "aws_api_gateway_resource" "trackers_provider_instance" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.trackers_provider.id
  path_part   = "{instance}"
}

# /projects/{projectId}/trackers
resource "aws_api_gateway_resource" "project_trackers" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project.id
  path_part   = "trackers"
}

resource "aws_api_gateway_resource" "project_tracker_binding" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project_trackers.id
  path_part   = "{bindingId}"
}

resource "aws_api_gateway_resource" "project_tracker_binding_issues" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project_tracker_binding.id
  path_part   = "issues"
}

resource "aws_api_gateway_resource" "project_tracker_binding_issue" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project_tracker_binding_issues.id
  path_part   = "{resourceId}"
}

resource "aws_api_gateway_resource" "project_tracker_binding_issue_comments" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project_tracker_binding_issue.id
  path_part   = "comments"
}

# Helper local for the tracker integration uri — every method below points here.
locals {
  trackers_integration_uri = var.trackers_lambda_invoke_arn
}

# GET /trackers
resource "aws_api_gateway_method" "trackers_root_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.trackers_root.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "trackers_root_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.trackers_root.id
  http_method             = aws_api_gateway_method.trackers_root_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_trackers_root" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.trackers_root.id
}

# GET /trackers/auth/{provider}
resource "aws_api_gateway_method" "trackers_auth_provider_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.trackers_auth_provider.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = {
    "method.request.path.provider" = true
  }
}

resource "aws_api_gateway_integration" "trackers_auth_provider_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.trackers_auth_provider.id
  http_method             = aws_api_gateway_method.trackers_auth_provider_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_trackers_auth_provider" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.trackers_auth_provider.id
}

# GET /trackers/callback/{provider} — no auth (the OAuth provider redirects
# the user's browser here without a Cognito JWT). The handler validates the
# HMAC-signed `state` parameter to bind the callback to the user who started
# the flow.
resource "aws_api_gateway_method" "trackers_callback_provider_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.trackers_callback_provider.id
  http_method   = "GET"
  authorization = "NONE"
  request_parameters = {
    "method.request.path.provider" = true
  }
}

resource "aws_api_gateway_integration" "trackers_callback_provider_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.trackers_callback_provider.id
  http_method             = aws_api_gateway_method.trackers_callback_provider_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_trackers_callback_provider" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.trackers_callback_provider.id
}

# GET /trackers/external-projects/{provider}/{instance}
resource "aws_api_gateway_method" "trackers_external_projects_provider_instance_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.trackers_external_projects_provider_instance.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = {
    "method.request.path.provider" = true
    "method.request.path.instance" = true
  }
}

resource "aws_api_gateway_integration" "trackers_external_projects_provider_instance_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.trackers_external_projects_provider_instance.id
  http_method             = aws_api_gateway_method.trackers_external_projects_provider_instance_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_trackers_external_projects_provider_instance" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.trackers_external_projects_provider_instance.id
}

# POST /trackers/connections/{provider}/{instance}
resource "aws_api_gateway_method" "trackers_connections_provider_instance_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.trackers_connections_provider_instance.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = {
    "method.request.path.provider" = true
    "method.request.path.instance" = true
  }
}

resource "aws_api_gateway_integration" "trackers_connections_provider_instance_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.trackers_connections_provider_instance.id
  http_method             = aws_api_gateway_method.trackers_connections_provider_instance_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_trackers_connections_provider_instance" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.trackers_connections_provider_instance.id
}

# GET /trackers/providers — operator OAuth-config status
resource "aws_api_gateway_method" "trackers_providers_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.trackers_providers.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "trackers_providers_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.trackers_providers.id
  http_method             = aws_api_gateway_method.trackers_providers_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_trackers_providers" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.trackers_providers.id
}

# PUT /trackers/providers/{provider}/oauth-config — admin secret writer
resource "aws_api_gateway_method" "trackers_providers_provider_oauth_config_put" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.trackers_providers_provider_oauth_config.id
  http_method   = "PUT"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = {
    "method.request.path.provider" = true
  }
}

resource "aws_api_gateway_integration" "trackers_providers_provider_oauth_config_put" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.trackers_providers_provider_oauth_config.id
  http_method             = aws_api_gateway_method.trackers_providers_provider_oauth_config_put.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_trackers_providers_provider_oauth_config" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.trackers_providers_provider_oauth_config.id
}

# DELETE /trackers/{provider}/{instance}
resource "aws_api_gateway_method" "trackers_provider_instance_delete" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.trackers_provider_instance.id
  http_method   = "DELETE"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = {
    "method.request.path.provider" = true
    "method.request.path.instance" = true
  }
}

resource "aws_api_gateway_integration" "trackers_provider_instance_delete" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.trackers_provider_instance.id
  http_method             = aws_api_gateway_method.trackers_provider_instance_delete.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_trackers_provider_instance" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.trackers_provider_instance.id
}

# GET /projects/{projectId}/trackers
resource "aws_api_gateway_method" "project_trackers_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project_trackers.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_integration" "project_trackers_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_trackers.id
  http_method             = aws_api_gateway_method.project_trackers_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

# POST /projects/{projectId}/trackers
resource "aws_api_gateway_method" "project_trackers_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project_trackers.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_integration" "project_trackers_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_trackers.id
  http_method             = aws_api_gateway_method.project_trackers_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_project_trackers" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.project_trackers.id
}

# DELETE /projects/{projectId}/trackers/{bindingId}
resource "aws_api_gateway_method" "project_tracker_binding_delete" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project_tracker_binding.id
  http_method   = "DELETE"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = {
    "method.request.path.projectId" = true
    "method.request.path.bindingId" = true
  }
}

resource "aws_api_gateway_integration" "project_tracker_binding_delete" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_tracker_binding.id
  http_method             = aws_api_gateway_method.project_tracker_binding_delete.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_project_tracker_binding" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.project_tracker_binding.id
}

# GET /projects/{projectId}/trackers/{bindingId}/issues
resource "aws_api_gateway_method" "project_tracker_binding_issues_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project_tracker_binding_issues.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = {
    "method.request.path.projectId" = true
    "method.request.path.bindingId" = true
  }
}

resource "aws_api_gateway_integration" "project_tracker_binding_issues_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_tracker_binding_issues.id
  http_method             = aws_api_gateway_method.project_tracker_binding_issues_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_project_tracker_binding_issues" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.project_tracker_binding_issues.id
}

# GET /projects/{projectId}/trackers/{bindingId}/issues/{resourceId}
resource "aws_api_gateway_method" "project_tracker_binding_issue_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project_tracker_binding_issue.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = {
    "method.request.path.projectId"  = true
    "method.request.path.bindingId"  = true
    "method.request.path.resourceId" = true
  }
}

resource "aws_api_gateway_integration" "project_tracker_binding_issue_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_tracker_binding_issue.id
  http_method             = aws_api_gateway_method.project_tracker_binding_issue_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_project_tracker_binding_issue" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.project_tracker_binding_issue.id
}

# GET /projects/{projectId}/trackers/{bindingId}/issues/{resourceId}/comments
resource "aws_api_gateway_method" "project_tracker_binding_issue_comments_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.project_tracker_binding_issue_comments.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
  request_parameters = {
    "method.request.path.projectId"  = true
    "method.request.path.bindingId"  = true
    "method.request.path.resourceId" = true
  }
}

resource "aws_api_gateway_integration" "project_tracker_binding_issue_comments_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.project_tracker_binding_issue_comments.id
  http_method             = aws_api_gateway_method.project_tracker_binding_issue_comments_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = local.trackers_integration_uri
}

module "cors_project_tracker_binding_issue_comments" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.project_tracker_binding_issue_comments.id
}

resource "aws_lambda_permission" "trackers" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.trackers_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

# =============================================================================
# Cognito Users (GET /users - list all Cognito users)
# =============================================================================
resource "aws_api_gateway_method" "cognito_users_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.cognito_users.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "cognito_users_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.cognito_users.id
  http_method             = aws_api_gateway_method.cognito_users_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.cognito_users_lambda_invoke_arn
}

module "cors_cognito_users" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.cognito_users.id
}

# GET /admin/users (authenticated; the Lambda additionally enforces the
# Cognito platform-admin group — see lambda/shared/authz.js)
resource "aws_api_gateway_method" "admin_users_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.admin_users.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "admin_users_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.admin_users.id
  http_method             = aws_api_gateway_method.admin_users_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.cognito_users_lambda_invoke_arn
}

# PUT /admin/users/{username}/platform-admin (authenticated; platform-admin
# enforced in the Lambda, plus a self-demotion guard)
resource "aws_api_gateway_method" "admin_users_platform_admin_put" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.admin_users_platform_admin.id
  http_method   = "PUT"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "admin_users_platform_admin_put" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.admin_users_platform_admin.id
  http_method             = aws_api_gateway_method.admin_users_platform_admin_put.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.cognito_users_lambda_invoke_arn
}

module "cors_admin_users" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.admin_users.id
}

module "cors_admin_users_platform_admin" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.admin_users_platform_admin.id
}

resource "aws_lambda_permission" "cognito_users" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.cognito_users_lambda_name
  principal     = "apigateway.${local.dns_suffix}"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

# ===========================================================================
# Multi-repo project /repos routes (projects lambda, PR #183)
# ===========================================================================
# -----------------------------------------------------------------------------
# /projects/{projectId}/repos Resource (multi-repo support, projects lambda)
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "repos" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project.id
  path_part   = "repos"
}

# =============================================================================
# Repos Methods (GET list, POST add, DELETE remove — projects lambda)
# DELETE takes the repo url as a ?url= query param, so it lives on the same
# resource (no child resource needed).
# =============================================================================
resource "aws_api_gateway_method" "repos_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.repos.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_method" "repos_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.repos.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_method" "repos_delete" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.repos.id
  http_method   = "DELETE"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_integration" "repos_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.repos.id
  http_method             = aws_api_gateway_method.repos_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "repos_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.repos.id
  http_method             = aws_api_gateway_method.repos_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "repos_delete" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.repos.id
  http_method             = aws_api_gateway_method.repos_delete.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

module "cors_repos" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.repos.id
}
# ===========================================================================
# Custom agent config routes (projects lambda). Both are project-scoped, GET + PUT.
# Owner/admin only for BOTH read and write — the config may carry secrets
# (MCP env/headers), so a plain member cannot read it (enforced in the lambda).
#   /projects/{projectId}/custom-mcp-servers   GET + PUT (owner/admin)
#   /projects/{projectId}/custom-rules         GET + PUT (owner/admin)
# custom-rules PUT/GET return presigned S3 upload/download URLs for the .md
# bodies (metadata persisted on the Project vertex).
# ===========================================================================

# -----------------------------------------------------------------------------
# /projects/{projectId}/custom-mcp-servers
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "custom_mcp_servers" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project.id
  path_part   = "custom-mcp-servers"
}

resource "aws_api_gateway_method" "custom_mcp_servers_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.custom_mcp_servers.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_method" "custom_mcp_servers_put" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.custom_mcp_servers.id
  http_method   = "PUT"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_integration" "custom_mcp_servers_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.custom_mcp_servers.id
  http_method             = aws_api_gateway_method.custom_mcp_servers_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "custom_mcp_servers_put" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.custom_mcp_servers.id
  http_method             = aws_api_gateway_method.custom_mcp_servers_put.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

module "cors_custom_mcp_servers" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.custom_mcp_servers.id
}

# -----------------------------------------------------------------------------
# /projects/{projectId}/custom-mcp-servers/secrets
# Per-var MCP secret SecureStrings (set-state GET / rotate+clear PUT). Same
# projects lambda + owner/admin authz as the parent config route.
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "custom_mcp_servers_secrets" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.custom_mcp_servers.id
  path_part   = "secrets"
}

resource "aws_api_gateway_method" "custom_mcp_servers_secrets_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.custom_mcp_servers_secrets.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_method" "custom_mcp_servers_secrets_put" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.custom_mcp_servers_secrets.id
  http_method   = "PUT"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_integration" "custom_mcp_servers_secrets_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.custom_mcp_servers_secrets.id
  http_method             = aws_api_gateway_method.custom_mcp_servers_secrets_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "custom_mcp_servers_secrets_put" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.custom_mcp_servers_secrets.id
  http_method             = aws_api_gateway_method.custom_mcp_servers_secrets_put.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

module "cors_custom_mcp_servers_secrets" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.custom_mcp_servers_secrets.id
}

# -----------------------------------------------------------------------------
# /projects/{projectId}/custom-rules
# -----------------------------------------------------------------------------
resource "aws_api_gateway_resource" "custom_rules" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.project.id
  path_part   = "custom-rules"
}

resource "aws_api_gateway_method" "custom_rules_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.custom_rules.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_method" "custom_rules_put" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.custom_rules.id
  http_method   = "PUT"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id

  request_parameters = {
    "method.request.path.projectId" = true
  }
}

resource "aws_api_gateway_integration" "custom_rules_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.custom_rules.id
  http_method             = aws_api_gateway_method.custom_rules_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

resource "aws_api_gateway_integration" "custom_rules_put" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.custom_rules.id
  http_method             = aws_api_gateway_method.custom_rules_put.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.projects_lambda_invoke_arn
}

module "cors_custom_rules" {
  source      = "./cors"
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.custom_rules.id
}
