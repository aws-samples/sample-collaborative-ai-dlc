data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_ecr_authorization_token" "token" {}

locals {
  partition       = data.aws_partition.current.partition
  dns_suffix      = data.aws_partition.current.dns_suffix
  yjs_lb_name_raw = "${var.project_name}-yjs-${var.environment}"
  yjs_lb_name     = length(local.yjs_lb_name_raw) <= 32 ? local.yjs_lb_name_raw : "${substr(local.yjs_lb_name_raw, 0, 23)}-${substr(sha1(local.yjs_lb_name_raw), 0, 8)}"
}

terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0"
    }
  }
}

provider "docker" {
  # Support for Podman via DOCKER_HOST environment variable (e.g., unix:///path/to/podman.sock)
  # If DOCKER_HOST is not set, defaults to the standard Docker socket
  registry_auth {
    address  = format("%v.dkr.ecr.%v.%v", data.aws_caller_identity.current.account_id, data.aws_region.current.region, local.dns_suffix)
    username = data.aws_ecr_authorization_token.token.user_name
    password = data.aws_ecr_authorization_token.token.password
  }
}

# Calculate hash of all source files for change detection
locals {
  yjs_source_path = abspath("${path.module}/../../../../lambda/yjs-server")

  path_include = ["**"]
  path_exclude = ["**/node_modules/**", "**/.git/**"]

  yjs_files_include = setunion([for f in local.path_include : fileset(local.yjs_source_path, f)]...)
  yjs_files_exclude = setunion([for f in local.path_exclude : fileset(local.yjs_source_path, f)]...)
  yjs_files         = sort(setsubtract(local.yjs_files_include, local.yjs_files_exclude))
  yjs_files_sha     = sha1(join("", [for f in local.yjs_files : filesha1("${local.yjs_source_path}/${f}")]))
  yjs_image_tag     = substr(local.yjs_files_sha, 0, 16)
}

# ECR Repository
resource "aws_ecr_repository" "yjs_server" {
  name                 = "${var.project_name}-yjs-server-${var.environment}"
  image_tag_mutability = "MUTABLE"
  force_delete         = var.environment == "dev"

  image_scanning_configuration {
    scan_on_push = true
  }

}

resource "aws_ecr_lifecycle_policy" "yjs_server" {
  repository = aws_ecr_repository.yjs_server.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep only the last 3 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 3
      }
      action = {
        type = "expire"
      }
    }]
  })
}

# Docker build module
module "yjs_docker_build" {
  source  = "terraform-aws-modules/lambda/aws//modules/docker-build"
  version = "~> 8.0"

  create_ecr_repo = false
  ecr_repo        = aws_ecr_repository.yjs_server.name
  ecr_address     = format("%v.dkr.ecr.%v.%v", data.aws_caller_identity.current.account_id, data.aws_region.current.region, local.dns_suffix)

  use_image_tag = true
  # substr(var.build_after, 0, 0) is always "" — it exists only to create a
  # plan-graph dependency on the agents image build, so the two docker builds
  # never run concurrently (parallel kreuzwerker provider builds deadlock).
  # It can never change the tag or trigger a rebuild.
  image_tag        = "${local.yjs_image_tag}${substr(var.build_after, 0, 0)}"
  source_path      = local.yjs_source_path
  docker_file_path = "${local.yjs_source_path}/Dockerfile"
  platform         = "linux/amd64"
  # BuildKit session path instead of the provider's legacy tar.gz streaming —
  # see the agents module for rationale.
  builder = "default"

  triggers = {
    dir_sha = local.yjs_files_sha
  }
}

# ECS Cluster
resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-${var.environment}"

  setting {
    name  = "containerInsights"
    value = var.environment == "prod" ? "enabled" : "disabled"
  }
}

# ECS Task Execution Role
resource "aws_iam_role" "ecs_execution" {
  name = "${var.project_name}-ecs-execution-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.${local.dns_suffix}" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# The realtime doc-token secret is injected as an ECS secret from SSM,
# which the execution role resolves at task start.
resource "aws_iam_role_policy" "ecs_execution_doc_secret" {
  name = "${var.project_name}-yjs-doc-secret-${var.environment}"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameters"]
        Resource = var.realtime_doc_secret_param_arn
      }
    ]
  })
}

# ECS Task Role
resource "aws_iam_role" "ecs_task" {
  name = "${var.project_name}-yjs-task-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.${local.dns_suffix}" }
    }]
  })
}

resource "aws_iam_role_policy" "ecs_task" {
  name = "${var.project_name}-yjs-task-policy"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.yjs_server.arn}:*"
      }
    ]
  })
}

# Task Definition
resource "aws_ecs_task_definition" "yjs_server" {
  family                   = "${var.project_name}-yjs-server-${var.environment}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.environment == "prod" ? "512" : "256"
  memory                   = var.environment == "prod" ? "1024" : "512"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name      = "yjs-server"
    image     = module.yjs_docker_build.image_uri
    essential = true
    portMappings = [{
      containerPort = 1234
      protocol      = "tcp"
    }]
    environment = [
      {
        name  = "COGNITO_USER_POOL_ID"
        value = var.cognito_user_pool_id
      },
      {
        name  = "COGNITO_CLIENT_ID"
        value = var.cognito_client_id
      },
      {
        name  = "DOC_TOKEN_ENFORCE"
        value = var.doc_token_enforce ? "true" : "false"
      },
    ]
    secrets = [
      {
        # Realtime doc-token secret — verifies HMAC scope tokens
        # on every WebSocket upgrade.
        name      = "REALTIME_DOC_SECRET"
        valueFrom = var.realtime_doc_secret_param_arn
      },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.yjs_server.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "yjs"
      }
    }
  }])
}

# CloudWatch Log Group
resource "aws_cloudwatch_log_group" "yjs_server" {
  name              = "/ecs/${var.project_name}-yjs-server-${var.environment}"
  retention_in_days = var.environment == "prod" ? 30 : 7
}

# Security Group for Yjs Server
resource "aws_security_group" "yjs_server" {
  name_prefix = "${var.project_name}-yjs-${var.environment}"
  description = "Security group for Yjs real-time collaboration ECS service"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Allow WebSocket traffic from the internal ALB on Yjs port 1234"
    from_port       = 1234
    to_port         = 1234
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "Allow all egress for AWS API calls (Cognito JWKS, CloudWatch Logs) via VPC endpoints / NAT"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }
}

# CloudFront managed prefix list for VPC origins.
# Using the managed prefix list (rather than the service-managed
# "CloudFront-VPCOrigins-Service-SG") avoids a chicken-and-egg on fresh
# accounts: the service-managed SG only exists after the first VPC origin
# is provisioned, so a terraform data source lookup fails on cold start.
# The managed prefix list exists from day one.
data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

# Security Group for ALB
resource "aws_security_group" "alb" {
  name_prefix = "${var.project_name}-yjs-alb-${var.environment}"
  description = "Security group for the internal ALB fronting the Yjs service; ingress restricted to CloudFront VPC origins"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Allow HTTP from CloudFront VPC origins (managed prefix list) only"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id]
  }

  egress {
    description = "Allow ALB health checks and traffic forwarding to the Yjs target group"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Application Load Balancer
resource "aws_lb" "yjs_server" {
  name               = local.yjs_lb_name
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.private_subnet_ids
}

# Target Group
resource "aws_lb_target_group" "yjs_server" {
  name        = local.yjs_lb_name
  port        = 1234
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = "/"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    matcher             = "200,426"
  }
}

# ALB Listener
resource "aws_lb_listener" "yjs_server" {
  load_balancer_arn = aws_lb.yjs_server.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.yjs_server.arn
  }
}

# ECS Service
resource "aws_ecs_service" "yjs_server" {
  name            = "${var.project_name}-yjs-server"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.yjs_server.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.yjs_server.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.yjs_server.arn
    container_name   = "yjs-server"
    container_port   = 1234
  }

  depends_on = [aws_lb_listener.yjs_server]
}
