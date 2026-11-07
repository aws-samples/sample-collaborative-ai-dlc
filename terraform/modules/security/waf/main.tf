locals {
  # Common Rule Set rules that match request-body content. Content-authoring
  # routes (markdown, scripts) legitimately send what they match on, so
  # body_content_exempt_paths turns them to Count and BodyContentOutsideExemptPaths
  # re-blocks their matches on every other path.
  body_content_rules = ["CrossSiteScripting_BODY", "GenericLFI_BODY", "GenericRFI_BODY", "EC2MetaDataSSRF_BODY"]
  body_content_labels = [
    "awswaf:managed:aws:core-rule-set:CrossSiteScripting_Body",
    "awswaf:managed:aws:core-rule-set:GenericLFI_Body",
    "awswaf:managed:aws:core-rule-set:GenericRFI_Body",
    "awswaf:managed:aws:core-rule-set:EC2MetaDataSSRF_Body",
  ]
  body_content_exempt  = length(var.body_content_exempt_paths) > 0
  body_content_counted = local.body_content_exempt ? local.body_content_rules : []
  # One alternation of the escaped prefixes. API Gateway may see the path with
  # its stage prefix (/<stage>/api/...); CloudFront sees the browser path.
  exempt_path_alternation = join("|", [for path in var.body_content_exempt_paths : replace(path, ".", "\\.")])
  exempt_path_regex = {
    cloudfront = "^(${local.exempt_path_alternation})"
    regional   = "^(/[^/]+)?(${local.exempt_path_alternation})"
  }

  managed_rule_groups = {
    AWSManagedRulesAmazonIpReputationList = 10
    AWSManagedRulesCommonRuleSet          = 20
    AWSManagedRulesKnownBadInputsRuleSet  = 30
  }
}

resource "aws_wafv2_web_acl" "cloudfront" {
  count    = var.enabled ? 1 : 0
  provider = aws.us_east_1

  name        = "${var.project_name}-${var.environment}-cloudfront"
  description = "Baseline protection for the ${var.project_name} CloudFront distribution"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  dynamic "rule" {
    for_each = local.managed_rule_groups

    content {
      name     = rule.key
      priority = rule.value

      override_action {
        none {}
      }

      statement {
        managed_rule_group_statement {
          name        = rule.key
          vendor_name = "AWS"

          # Draft/artifact bodies exceed 8 KB; realtime token queries exceed 2 KB.
          # Count these size matches while retaining the other managed rules.
          dynamic "rule_action_override" {
            for_each = rule.key == "AWSManagedRulesCommonRuleSet" ? concat(["SizeRestrictions_BODY", "SizeRestrictions_QUERYSTRING"], local.body_content_counted) : []

            content {
              name = rule_action_override.value
              action_to_use {
                count {}
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.project_name}-${var.environment}-cloudfront-${rule.key}"
        sampled_requests_enabled   = false
      }
    }
  }

  # An exempt prefix must not reach other routes through "..": body-content
  # matches on any path containing it stay blocked.
  dynamic "rule" {
    for_each = local.body_content_exempt ? [1] : []

    content {
      name     = "BodyContentPathTraversal"
      priority = 24

      action {
        block {}
      }

      statement {
        and_statement {
          statement {
            or_statement {
              dynamic "statement" {
                for_each = local.body_content_labels
                content {
                  label_match_statement {
                    scope = "LABEL"
                    key   = statement.value
                  }
                }
              }
            }
          }
          statement {
            byte_match_statement {
              search_string         = ".."
              positional_constraint = "CONTAINS"
              field_to_match {
                uri_path {}
              }
              text_transformation {
                priority = 0
                type     = "URL_DECODE"
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.project_name}-${var.environment}-cloudfront-body-content-path-traversal"
        sampled_requests_enabled   = false
      }
    }
  }

  # Re-block the body-content matches counted above on every path outside
  # body_content_exempt_paths.
  dynamic "rule" {
    for_each = local.body_content_exempt ? [1] : []

    content {
      name     = "BodyContentOutsideExemptPaths"
      priority = 25

      action {
        block {}
      }

      statement {
        and_statement {
          statement {
            or_statement {
              dynamic "statement" {
                for_each = local.body_content_labels
                content {
                  label_match_statement {
                    scope = "LABEL"
                    key   = statement.value
                  }
                }
              }
            }
          }
          statement {
            not_statement {
              statement {
                regex_match_statement {
                  regex_string = local.exempt_path_regex.cloudfront
                  field_to_match {
                    uri_path {}
                  }
                  text_transformation {
                    priority = 0
                    type     = "NONE"
                  }
                }
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.project_name}-${var.environment}-cloudfront-body-content-outside-exempt-paths"
        sampled_requests_enabled   = false
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.project_name}-${var.environment}-cloudfront"
    sampled_requests_enabled   = false
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-cloudfront-waf"
  }
}

resource "aws_wafv2_web_acl" "regional" {
  count = var.enabled ? 1 : 0

  name        = "${var.project_name}-${var.environment}-regional"
  description = "Baseline protection for the ${var.project_name} API and Cognito user pool"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  # All application REST routes are under /api, including after the stage
  # prefix. Cognito login/token paths do not contain /api. Decode the path
  # before matching so encoded API paths also require the origin secret.
  # A matching secret still passes through managed rules and authentication.
  rule {
    name     = "RequireCloudFrontOrigin"
    priority = 0

    action {
      block {}
    }

    statement {
      and_statement {
        statement {
          byte_match_statement {
            search_string         = "/api"
            positional_constraint = "CONTAINS"

            field_to_match {
              uri_path {}
            }

            text_transformation {
              priority = 0
              type     = "URL_DECODE"
            }
          }
        }

        statement {
          not_statement {
            statement {
              byte_match_statement {
                search_string         = var.cloudfront_origin_secret
                positional_constraint = "EXACTLY"

                field_to_match {
                  single_header {
                    name = "x-origin-verify"
                  }
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project_name}-${var.environment}-api-origin"
      sampled_requests_enabled   = false
    }
  }

  dynamic "rule" {
    for_each = local.managed_rule_groups

    content {
      name     = rule.key
      priority = rule.value

      override_action {
        none {}
      }

      statement {
        managed_rule_group_statement {
          name        = rule.key
          vendor_name = "AWS"

          # API requests also cross this ACL. The managed 8 KB threshold is
          # independent of the configurable body inspection limit.
          dynamic "rule_action_override" {
            for_each = rule.key == "AWSManagedRulesCommonRuleSet" ? concat(["SizeRestrictions_BODY"], local.body_content_counted) : []

            content {
              name = rule_action_override.value
              action_to_use {
                count {}
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.project_name}-${var.environment}-regional-${rule.key}"
        sampled_requests_enabled   = false
      }
    }
  }

  # An exempt prefix must not reach other routes through "..": body-content
  # matches on any path containing it stay blocked.
  dynamic "rule" {
    for_each = local.body_content_exempt ? [1] : []

    content {
      name     = "BodyContentPathTraversal"
      priority = 24

      action {
        block {}
      }

      statement {
        and_statement {
          statement {
            or_statement {
              dynamic "statement" {
                for_each = local.body_content_labels
                content {
                  label_match_statement {
                    scope = "LABEL"
                    key   = statement.value
                  }
                }
              }
            }
          }
          statement {
            byte_match_statement {
              search_string         = ".."
              positional_constraint = "CONTAINS"
              field_to_match {
                uri_path {}
              }
              text_transformation {
                priority = 0
                type     = "URL_DECODE"
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.project_name}-${var.environment}-regional-body-content-path-traversal"
        sampled_requests_enabled   = false
      }
    }
  }

  # Re-block the body-content matches counted above on every path outside
  # body_content_exempt_paths.
  dynamic "rule" {
    for_each = local.body_content_exempt ? [1] : []

    content {
      name     = "BodyContentOutsideExemptPaths"
      priority = 25

      action {
        block {}
      }

      statement {
        and_statement {
          statement {
            or_statement {
              dynamic "statement" {
                for_each = local.body_content_labels
                content {
                  label_match_statement {
                    scope = "LABEL"
                    key   = statement.value
                  }
                }
              }
            }
          }
          statement {
            not_statement {
              statement {
                regex_match_statement {
                  regex_string = local.exempt_path_regex.regional
                  field_to_match {
                    uri_path {}
                  }
                  text_transformation {
                    priority = 0
                    type     = "NONE"
                  }
                }
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.project_name}-${var.environment}-regional-body-content-outside-exempt-paths"
        sampled_requests_enabled   = false
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.project_name}-${var.environment}-regional"
    sampled_requests_enabled   = false
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-regional-waf"
  }
}

# Optional CloudFront IP allow-list example.
#
# Use this only after confirming every administrator's stable IPv4 CIDR. It
# turns the CloudFront entry point into deny-by-default. For IPv6, create a
# second IPV6 IP set and combine both references with an or_statement.
#
# resource "aws_wafv2_ip_set" "cloudfront_allowlist" {
#   provider = aws.us_east_1
#
#   name               = "${var.project_name}-${var.environment}-cloudfront-allowlist"
#   scope              = "CLOUDFRONT"
#   ip_address_version = "IPV4"
#   addresses          = ["203.0.113.10/32"]
# }
#
# Add this rule block to aws_wafv2_web_acl.cloudfront before the dynamic rule:
#
# rule {
#   name     = "RequireAllowedSourceIp"
#   priority = 0
#
#   action {
#     block {}
#   }
#
#   statement {
#     not_statement {
#       statement {
#         ip_set_reference_statement {
#           arn = aws_wafv2_ip_set.cloudfront_allowlist.arn
#         }
#       }
#     }
#   }
#
#   visibility_config {
#     cloudwatch_metrics_enabled = true
#     metric_name                = "${var.project_name}-${var.environment}-cloudfront-ip-allowlist"
#     sampled_requests_enabled   = false
#   }
# }
