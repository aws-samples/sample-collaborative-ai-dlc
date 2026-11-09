locals {
  # The Common Rule Set body rules that real building-block bodies trigger.
  # Methodology markdown and sensor scripts carry relative links
  # (GenericLFI_BODY) and HTML comments and tags (CrossSiteScripting_BODY);
  # sent to a deployed ACL, a published AI-DLC release's bodies matched these
  # two and no other body rule. Both ACLs count them, and
  # BlockBodyContentOutsideBlockWrites re-blocks their matches on every request
  # except a block write. GenericRFI_BODY and EC2MetaDataSSRF_BODY keep blocking
  # everywhere.
  body_content_rules = ["CrossSiteScripting_BODY", "GenericLFI_BODY"]
  body_content_labels = [
    "awswaf:managed:aws:core-rule-set:CrossSiteScripting_Body",
    "awswaf:managed:aws:core-rule-set:GenericLFI_Body",
  ]


  # The routes that carry a block body (terraform/modules/api/routes.tf):
  # POST /api/blocks/{type} creates and PUT /api/blocks/{type}/{id} updates.
  # Types are lambda/shared/blocks.js BLOCK_TYPES, as the app sends them; ids
  # are kebab-case (validateId). Anchored, with no `.` or `%` allowed, so no
  # other route or encoded traversal can match.
  block_types = "stage|agent|scope|rule|sensor|artifact|knowledge|skill|template"
  block_id    = "[a-z0-9]+(-[a-z0-9]+)*"

  # CloudFront sees the browser path; API Gateway may see it after the stage
  # name (/<stage>/api/...), whose characters are [A-Za-z0-9_-].
  path_prefix = {
    cloudfront = ""
    regional   = "(/[A-Za-z0-9_-]+)?"
  }

  # Added by LabelBlockWrites. A label match on the bare name matches only the
  # label this web ACL's own rule added.
  block_write_label = "block-write"
  block_write_routes = {
    for acl, prefix in local.path_prefix : acl => [
      { method = "POST", regex = "^${prefix}/api/blocks/(${local.block_types})$" },
      { method = "PUT", regex = "^${prefix}/api/blocks/(${local.block_types})/${local.block_id}$" },
    ]
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
            for_each = rule.key == "AWSManagedRulesCommonRuleSet" ? concat(["SizeRestrictions_BODY", "SizeRestrictions_QUERYSTRING"], local.body_content_rules) : []

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

  # Label a block write: POST /api/blocks/{type} or PUT /api/blocks/{type}/{id}.
  # Count adds the label and nothing else.
  rule {
    name     = "LabelBlockWrites"
    priority = 24

    action {
      count {}
    }

    rule_label {
      name = local.block_write_label
    }

    statement {
      or_statement {
        dynamic "statement" {
          for_each = local.block_write_routes.cloudfront
          content {
            and_statement {
              statement {
                byte_match_statement {
                  search_string         = statement.value.method
                  positional_constraint = "EXACTLY"
                  field_to_match {
                    method {}
                  }
                  text_transformation {
                    priority = 0
                    type     = "NONE"
                  }
                }
              }
              statement {
                regex_match_statement {
                  regex_string = statement.value.regex
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
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project_name}-${var.environment}-cloudfront-block-writes"
      sampled_requests_enabled   = false
    }
  }

  # Re-block the body-content matches counted above, except on a block write.
  # Every other request body keeps these rules, and a block write keeps every
  # other managed rule and needs the platform-admin group.
  rule {
    name     = "BlockBodyContentOutsideBlockWrites"
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
              label_match_statement {
                scope = "LABEL"
                key   = local.block_write_label
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project_name}-${var.environment}-cloudfront-body-content-outside-block-writes"
      sampled_requests_enabled   = false
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
            for_each = rule.key == "AWSManagedRulesCommonRuleSet" ? concat(["SizeRestrictions_BODY"], local.body_content_rules) : []

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

  # Label a block write: POST /api/blocks/{type} or PUT /api/blocks/{type}/{id}.
  # Count adds the label and nothing else.
  rule {
    name     = "LabelBlockWrites"
    priority = 24

    action {
      count {}
    }

    rule_label {
      name = local.block_write_label
    }

    statement {
      or_statement {
        dynamic "statement" {
          for_each = local.block_write_routes.regional
          content {
            and_statement {
              statement {
                byte_match_statement {
                  search_string         = statement.value.method
                  positional_constraint = "EXACTLY"
                  field_to_match {
                    method {}
                  }
                  text_transformation {
                    priority = 0
                    type     = "NONE"
                  }
                }
              }
              statement {
                regex_match_statement {
                  regex_string = statement.value.regex
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
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project_name}-${var.environment}-regional-block-writes"
      sampled_requests_enabled   = false
    }
  }

  # Re-block the body-content matches counted above, except on a block write.
  # Every other request body keeps these rules, and a block write keeps every
  # other managed rule and needs the platform-admin group.
  rule {
    name     = "BlockBodyContentOutsideBlockWrites"
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
              label_match_statement {
                scope = "LABEL"
                key   = local.block_write_label
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project_name}-${var.environment}-regional-body-content-outside-block-writes"
      sampled_requests_enabled   = false
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
