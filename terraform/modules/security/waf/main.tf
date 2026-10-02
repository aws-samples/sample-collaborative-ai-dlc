locals {
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
            for_each = rule.key == "AWSManagedRulesCommonRuleSet" ? ["SizeRestrictions_BODY", "SizeRestrictions_QUERYSTRING"] : []

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
            for_each = rule.key == "AWSManagedRulesCommonRuleSet" ? ["SizeRestrictions_BODY"] : []

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
