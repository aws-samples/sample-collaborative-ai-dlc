mock_provider "aws" {}
mock_provider "aws" {
  alias = "us_east_1"
}

variables {
  enabled      = true
  project_name = "waf-test"
  environment  = "test"
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
        for override in rule.statement[0].managed_rule_group_statement[0].rule_action_override :
        "${rule.name}/${override.name}"
      ]
    ])) == toset(["AWSManagedRulesCommonRuleSet/SizeRestrictions_BODY"])
    error_message = "The regional ACL must override only the Common Rule Set body size rule."
  }

  assert {
    condition = alltrue(flatten([
      for acl in [aws_wafv2_web_acl.cloudfront[0], aws_wafv2_web_acl.regional[0]] : [
        for rule in acl.rule : [
          for override in rule.statement[0].managed_rule_group_statement[0].rule_action_override :
          length(override.action_to_use[0].count) == 1
        ]
      ]
    ]))
    error_message = "Individual size overrides must count matches so subsequent rules still evaluate requests."
  }

  assert {
    condition = alltrue([
      for acl in [aws_wafv2_web_acl.cloudfront[0], aws_wafv2_web_acl.regional[0]] :
      toset([for rule in acl.rule : rule.name]) == toset([
        "AWSManagedRulesAmazonIpReputationList",
        "AWSManagedRulesCommonRuleSet",
        "AWSManagedRulesKnownBadInputsRuleSet",
        ]) && alltrue([
        for rule in acl.rule :
        length(rule.override_action[0].none) == 1 &&
        length(rule.statement[0].managed_rule_group_statement[0].scope_down_statement) == 0
      ])
    ])
    error_message = "Both ACLs must retain all baseline groups with their default actions and no route exclusions."
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
    condition     = length(aws_wafv2_web_acl.cloudfront) == 0 && length(aws_wafv2_web_acl.regional) == 0
    error_message = "Disabling WAF must create neither ACL."
  }
}
