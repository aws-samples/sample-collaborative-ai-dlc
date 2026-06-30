# =============================================================================
# Partition-Aware Data Sources
# =============================================================================
data "aws_partition" "current" {}

locals {
  dns_suffix = data.aws_partition.current.dns_suffix
}

resource "random_id" "bucket_suffix" {
  byte_length = 4
}

# S3 bucket for static website hosting
resource "aws_s3_bucket" "frontend" {
  bucket = "${var.project_name}-${var.environment}-frontend-${random_id.bucket_suffix.hex}"
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  versioning_configuration {
    status = "Enabled"
  }
}

# CloudFront Origin Access Control
resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${var.project_name}-${var.environment}-frontend-oac"
  description                       = "OAC for ${var.project_name} frontend"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# CloudFront Function: SPA URI rewrite for the S3 origin only.
#
# Rewrites requests that look like SPA routes (no file extension, or trailing
# slash) to /index.html so the React app can handle client-side routing on
# hard reloads (e.g. /dashboard, /project/123).
#
# This replaces the previous distribution-level custom_error_response that
# mapped 403/404 -> /index.html. That config applied globally and rewrote
# legitimate API Gateway errors (e.g. expired Cognito token -> 403) to HTML,
# breaking fetch().json() on the client. See issue #186.
#
# Attached only to the default (S3) cache behavior, so /api/*, /yjs/*, and
# /ws behaviors are unaffected.
resource "aws_cloudfront_function" "spa_rewrite" {
  name    = "${var.project_name}-${var.environment}-spa-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "Rewrite SPA routes to /index.html for the S3 origin"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var request = event.request;
      var uri = request.uri;

      if (uri.endsWith('/')) {
        request.uri = '/index.html';
      } else if (!uri.includes('.')) {
        request.uri = '/index.html';
      }

      return request;
    }
  EOT
}

# CloudFront VPC Origin for internal Yjs ALB
resource "aws_cloudfront_vpc_origin" "yjs_alb" {
  count = var.yjs_enabled ? 1 : 0

  vpc_origin_endpoint_config {
    name                   = "${var.project_name}-${var.environment}-yjs-vpc-origin"
    arn                    = var.yjs_alb_arn
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = "http-only"

    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name        = "${var.project_name}-${var.environment}-yjs-vpc-origin"
    Environment = var.environment
  }
}

# CloudFront Distribution
resource "aws_cloudfront_distribution" "frontend" {
  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
    origin_id                = "S3-${aws_s3_bucket.frontend.bucket}"
  }

  # Yjs WebSocket origin (internal ALB via VPC Origin)
  dynamic "origin" {
    for_each = var.yjs_enabled ? [1] : []
    content {
      domain_name = var.yjs_alb_dns_name
      origin_id   = "yjs-alb"

      vpc_origin_config {
        vpc_origin_id = aws_cloudfront_vpc_origin.yjs_alb[0].id
      }
    }
  }

  # API Gateway origin — routes /api/* traffic through CloudFront.
  # Authentication is enforced by the Cognito authorizer on API Gateway.
  dynamic "origin" {
    for_each = var.api_gateway_domain_name != "" ? [1] : []
    content {
      domain_name = var.api_gateway_domain_name
      origin_id   = "api-gateway"
      origin_path = var.api_gateway_stage_path

      custom_origin_config {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }

      custom_header {
        name  = "X-Origin-Verify"
        value = random_password.cloudfront_origin_secret.result
      }
    }
  }

  dynamic "origin" {
    for_each = var.websocket_domain_name != "" ? [1] : []
    content {
      domain_name = var.websocket_domain_name
      origin_id   = "websocket-apigw"

      custom_origin_config {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
    }
  }

  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"

  default_cache_behavior {
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "S3-${aws_s3_bucket.frontend.bucket}"
    compress               = true
    viewer_protocol_policy = "redirect-to-https"

    # SPA URI rewrite — only applied to the S3 origin so API Gateway errors
    # (e.g. 403 on expired Cognito token) are not rewritten to HTML.
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_rewrite.arn
    }

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 3600
    max_ttl     = 86400
  }

  # Yjs WebSocket path behavior
  dynamic "ordered_cache_behavior" {
    for_each = var.yjs_enabled ? [1] : []
    content {
      path_pattern           = "/yjs/*"
      allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
      cached_methods         = ["GET", "HEAD"]
      target_origin_id       = "yjs-alb"
      viewer_protocol_policy = "https-only"

      forwarded_values {
        query_string = true
        headers      = ["Origin", "Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Protocol", "Sec-WebSocket-Accept", "Sec-WebSocket-Extensions"]
        cookies {
          forward = "none"
        }
      }

      min_ttl     = 0
      default_ttl = 0
      max_ttl     = 0
    }
  }

  dynamic "ordered_cache_behavior" {
    for_each = var.websocket_domain_name != "" ? [1] : []
    content {
      path_pattern           = "/ws"
      allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
      cached_methods         = ["GET", "HEAD"]
      target_origin_id       = "websocket-apigw"
      viewer_protocol_policy = "https-only"

      forwarded_values {
        query_string = true
        headers      = ["Origin", "Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Protocol", "Sec-WebSocket-Accept", "Sec-WebSocket-Extensions"]
        cookies {
          forward = "none"
        }
      }

      min_ttl     = 0
      default_ttl = 0
      max_ttl     = 0
    }
  }

  # API Gateway /api/* behavior — all REST API traffic (including the
  # GitHub OAuth callback) goes through CloudFront for single-domain
  # routing which eliminates browser CORS preflight requests.
  dynamic "ordered_cache_behavior" {
    for_each = var.api_gateway_domain_name != "" ? [1] : []
    content {
      path_pattern           = "/api/*"
      allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
      cached_methods         = ["GET", "HEAD"]
      target_origin_id       = "api-gateway"
      viewer_protocol_policy = "https-only"
      compress               = true

      forwarded_values {
        query_string = true
        headers      = ["Authorization", "Content-Type", "Origin", "Accept"]
        cookies {
          forward = "none"
        }
      }

      min_ttl     = 0
      default_ttl = 0
      max_ttl     = 0
    }
  }

  # SPA routing is handled by the aws_cloudfront_function.spa_rewrite
  # function attached to the default cache behavior. We intentionally do NOT
  # set custom_error_response here: it applies distribution-wide and would
  # rewrite API Gateway 403/404 responses to /index.html (issue #186).

  logging_config {
    bucket          = var.access_logs_bucket_domain_name
    prefix          = "cloudfront/"
    include_cookies = false
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = {
    Name        = "${var.project_name}-${var.environment}-frontend"
    Environment = var.environment
    Project     = var.project_name
  }
}

# S3 bucket policy: allow CloudFront access + deny non-TLS requests (CKV_AWS_93)
resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontServicePrincipal"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.${local.dns_suffix}"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.frontend.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.frontend.arn
          }
        }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.frontend.arn,
          "${aws_s3_bucket.frontend.arn}/*",
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      }
    ]
  })
}