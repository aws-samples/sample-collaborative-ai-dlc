mock_provider "aws" {}
mock_provider "aws" {
  alias = "us_east_1"
}

variables {
  enabled                  = true
  project_name             = "waf-test"
  environment              = "test"
  cloudfront_origin_secret = "test-origin-secret"
}

run "preserve_application_request_sizes" {
  command = plan
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }
  module {
    source = "./modules/security/waf"
  }

  assert {
    condition = toset(flatten([
      for rule in aws_wafv2_web_acl.cloudfront[0].rule : [
        for override in rule.statement[0].managed_rule_group_statement[0].rule_action_override :
        "${rule.name}/${override.name}"
      ]
      ])) == toset([
      "AWSManagedRulesCommonRuleSet/SizeRestrictions_BODY",
      "AWSManagedRulesCommonRuleSet/SizeRestrictions_QUERYSTRING",
    ])
    error_message = "CloudFront must override only the Common Rule Set body and query-string size rules."
  }

  assert {
    condition = toset(flatten([
      for rule in aws_wafv2_web_acl.regional[0].rule : [
        for group in rule.statement[0].managed_rule_group_statement : [
          for override in group.rule_action_override : "${rule.name}/${override.name}"
        ]
      ]
    ])) == toset(["AWSManagedRulesCommonRuleSet/SizeRestrictions_BODY"])
    error_message = "The regional ACL must override only the Common Rule Set body size rule."
  }

  assert {
    condition = alltrue(flatten([
      for acl in [aws_wafv2_web_acl.cloudfront[0], aws_wafv2_web_acl.regional[0]] : [
        for rule in acl.rule : [
          for group in rule.statement[0].managed_rule_group_statement : [
            for override in group.rule_action_override : length(override.action_to_use[0].count) == 1
          ]
        ]
      ]
    ]))
    error_message = "Individual size overrides must count matches so subsequent rules still evaluate requests."
  }

  assert {
    condition = alltrue([
      for acl in [aws_wafv2_web_acl.cloudfront[0], aws_wafv2_web_acl.regional[0]] :
      toset([for rule in acl.rule : rule.name if rule.name != "RequireCloudFrontOrigin"]) == toset([
        "AWSManagedRulesAmazonIpReputationList",
        "AWSManagedRulesCommonRuleSet",
        "AWSManagedRulesKnownBadInputsRuleSet",
        ]) && alltrue([
        for rule in acl.rule :
        length(rule.override_action[0].none) == 1 &&
        length(rule.statement[0].managed_rule_group_statement[0].scope_down_statement) == 0
        if rule.name != "RequireCloudFrontOrigin"
      ])
    ])
    error_message = "Both ACLs must retain all baseline groups with their default actions and no route exclusions."
  }
}

run "api_origin_verification" {
  command = plan
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }
  module {
    source = "./modules/security/waf"
  }

  assert {
    condition = alltrue([
      for rule in aws_wafv2_web_acl.regional[0].rule : (
        rule.priority == 0 &&
        length(rule.action[0].block) == 1 &&
        length(rule.statement[0].and_statement[0].statement) == 2 &&
        length([for part in rule.statement[0].and_statement[0].statement : part if length(part.byte_match_statement) == 1]) == 1 &&
        length([for part in rule.statement[0].and_statement[0].statement : part if length(part.not_statement) == 1]) == 1 &&
        alltrue([
          for part in rule.statement[0].and_statement[0].statement :
          part.byte_match_statement[0].search_string == "/api" &&
          part.byte_match_statement[0].positional_constraint == "CONTAINS" &&
          length(part.byte_match_statement[0].field_to_match[0].uri_path) == 1 &&
          one(part.byte_match_statement[0].text_transformation).type == "URL_DECODE"
          if length(part.byte_match_statement) == 1
        ]) &&
        alltrue([
          for part in rule.statement[0].and_statement[0].statement :
          part.not_statement[0].statement[0].byte_match_statement[0].search_string == var.cloudfront_origin_secret &&
          part.not_statement[0].statement[0].byte_match_statement[0].positional_constraint == "EXACTLY" &&
          part.not_statement[0].statement[0].byte_match_statement[0].field_to_match[0].single_header[0].name == "x-origin-verify" &&
          one(part.not_statement[0].statement[0].byte_match_statement[0].text_transformation).type == "NONE"
          if length(part.not_statement) == 1
        ])
      ) if rule.name == "RequireCloudFrontOrigin"
    ]) && length([for rule in aws_wafv2_web_acl.regional[0].rule : rule if rule.name == "RequireCloudFrontOrigin"]) == 1
    error_message = "The shared ACL must block API paths with a missing or incorrect secret while leaving Cognito paths outside the origin check."
  }

  assert {
    condition = toset([for rule in aws_wafv2_web_acl.regional[0].rule : rule.name]) == toset([
      "RequireCloudFrontOrigin",
      "AWSManagedRulesAmazonIpReputationList",
      "AWSManagedRulesCommonRuleSet",
      "AWSManagedRulesKnownBadInputsRuleSet",
      ]) && alltrue([
      for rule in aws_wafv2_web_acl.regional[0].rule :
      rule.priority > 0 &&
      length(rule.override_action[0].none) == 1 &&
      length(rule.statement[0].managed_rule_group_statement[0].scope_down_statement) == 0
      if rule.name != "RequireCloudFrontOrigin"
    ])
    error_message = "A correct origin header must continue through every existing managed rule group."
  }

  assert {
    condition = alltrue([
      for acl in [aws_wafv2_web_acl.cloudfront[0], aws_wafv2_web_acl.regional[0]] :
      !acl.visibility_config[0].sampled_requests_enabled &&
      alltrue([for rule in acl.rule : !rule.visibility_config[0].sampled_requests_enabled])
    ])
    error_message = "Request sampling must stay disabled to keep credentials and the origin secret out of WAF samples."
  }
}

run "waf_disabled" {
  command = plan
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }
  module {
    source = "./modules/security/waf"
  }
  variables {
    enabled = false
  }
  assert {
    condition     = length(aws_wafv2_web_acl.cloudfront) == 0 && length(aws_wafv2_web_acl.regional) == 0 && output.regional_web_acl_arn == ""
    error_message = "Disabling WAF must create no ACLs or origin restriction."
  }
}
