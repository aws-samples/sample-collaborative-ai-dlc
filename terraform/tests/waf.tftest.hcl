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
        for group in rule.statement[0].managed_rule_group_statement : [
          for override in group.rule_action_override : "${rule.name}/${override.name}"
        ]
      ]
      ])) == toset([
      "AWSManagedRulesCommonRuleSet/SizeRestrictions_BODY",
      "AWSManagedRulesCommonRuleSet/SizeRestrictions_QUERYSTRING",
      "AWSManagedRulesCommonRuleSet/CrossSiteScripting_BODY",
      "AWSManagedRulesCommonRuleSet/GenericLFI_BODY",
    ])
    error_message = "CloudFront must override only the Common Rule Set size rules and the two block-body rules."
  }

  assert {
    condition = toset(flatten([
      for rule in aws_wafv2_web_acl.regional[0].rule : [
        for group in rule.statement[0].managed_rule_group_statement : [
          for override in group.rule_action_override : "${rule.name}/${override.name}"
        ]
      ]
      ])) == toset([
      "AWSManagedRulesCommonRuleSet/SizeRestrictions_BODY",
      "AWSManagedRulesCommonRuleSet/CrossSiteScripting_BODY",
      "AWSManagedRulesCommonRuleSet/GenericLFI_BODY",
    ])
    error_message = "The regional ACL must override only the Common Rule Set body size rule and the two block-body rules."
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
    error_message = "Individual overrides must count matches so subsequent rules still evaluate requests."
  }

  assert {
    condition = alltrue([
      for acl in [aws_wafv2_web_acl.cloudfront[0], aws_wafv2_web_acl.regional[0]] :
      toset([for rule in acl.rule : rule.name if !contains(["RequireCloudFrontOrigin", "LabelBlockWrites", "BlockBodyContentOutsideBlockWrites"], rule.name)]) == toset([
        "AWSManagedRulesAmazonIpReputationList",
        "AWSManagedRulesCommonRuleSet",
        "AWSManagedRulesKnownBadInputsRuleSet",
        ]) && alltrue([
        for rule in acl.rule :
        length(rule.override_action[0].none) == 1 &&
        length(rule.statement[0].managed_rule_group_statement[0].scope_down_statement) == 0
        if !contains(["RequireCloudFrontOrigin", "LabelBlockWrites", "BlockBodyContentOutsideBlockWrites"], rule.name)
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
      "LabelBlockWrites",
      "BlockBodyContentOutsideBlockWrites",
      ]) && alltrue([
      for rule in aws_wafv2_web_acl.regional[0].rule :
      rule.priority > 0 &&
      length(rule.override_action[0].none) == 1 &&
      length(rule.statement[0].managed_rule_group_statement[0].scope_down_statement) == 0
      if !contains(["RequireCloudFrontOrigin", "LabelBlockWrites", "BlockBodyContentOutsideBlockWrites"], rule.name)
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

# The two Common Rule Set body rules that block bodies trigger count, and their matches are
# re-blocked on every request except a block write.
run "block_write_body_content_exemption" {
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
      for acl in [aws_wafv2_web_acl.cloudfront[0], aws_wafv2_web_acl.regional[0]] : (
        one([for rule in acl.rule : rule.priority if rule.name == "LabelBlockWrites"]) == 24 &&
        one([for rule in acl.rule : length(rule.action[0].count) if rule.name == "LabelBlockWrites"]) == 1 &&
        one([for rule in acl.rule : one(rule.rule_label).name if rule.name == "LabelBlockWrites"]) == "block-write" &&
        one([for rule in acl.rule : rule.priority if rule.name == "BlockBodyContentOutsideBlockWrites"]) == 25 &&
        one([for rule in acl.rule : length(rule.action[0].block) if rule.name == "BlockBodyContentOutsideBlockWrites"]) == 1
      )
    ])
    error_message = "Both ACLs must label block writes (count) and then block body-content matches without that label, after the Common Rule Set."
  }

  assert {
    condition = alltrue([
      for acl in [aws_wafv2_web_acl.cloudfront[0], aws_wafv2_web_acl.regional[0]] : alltrue([
        for rule in acl.rule : (
          toset([
            for part in rule.statement[0].and_statement[0].statement[0].or_statement[0].statement :
            part.label_match_statement[0].key
            ]) == toset([
            "awswaf:managed:aws:core-rule-set:CrossSiteScripting_Body",
            "awswaf:managed:aws:core-rule-set:GenericLFI_Body",
          ]) &&
          rule.statement[0].and_statement[0].statement[1].not_statement[0].statement[0].label_match_statement[0].key == "block-write"
        ) if rule.name == "BlockBodyContentOutsideBlockWrites"
      ])
    ])
    error_message = "The blocking rule must match the two block-body labels and exempt only the block-write label."
  }

  assert {
    condition = alltrue([
      for acl in [aws_wafv2_web_acl.cloudfront[0], aws_wafv2_web_acl.regional[0]] : alltrue([
        for rule in acl.rule : alltrue([
          for route in rule.statement[0].or_statement[0].statement :
          length(route.and_statement[0].statement[1].regex_match_statement[0].regex_string) <= 512 &&
          one(route.and_statement[0].statement[0].byte_match_statement[0].text_transformation).type == "NONE" &&
          one(route.and_statement[0].statement[1].regex_match_statement[0].text_transformation).type == "NONE"
        ]) if rule.name == "LabelBlockWrites"
      ])
    ])
    error_message = "Each block-write pattern must fit AWS WAF's 512-character regex limit and match the raw path and method."
  }

  # The method each pattern pairs with, and what it matches. Terraform's RE2 and
  # AWS WAF agree on these patterns: anchors, alternation, character classes.
  assert {
    condition = alltrue([
      for acl, paths in {
        cloudfront = {
          POST = { match = ["/api/blocks/stage", "/api/blocks/sensor"], miss = ["/test/api/blocks/stage"] }
          PUT  = { match = ["/api/blocks/agent/aidlc-architect-agent", "/api/blocks/knowledge/k1"], miss = ["/test/api/blocks/agent/x"] }
        }
        regional = {
          POST = { match = ["/api/blocks/stage", "/test/api/blocks/stage"], miss = [] }
          PUT  = { match = ["/api/blocks/agent/x", "/test/api/blocks/agent/aidlc-architect-agent"], miss = [] }
        }
        } : alltrue([
          for method, cases in paths : alltrue(concat(
            [for path in cases.match : anytrue([
              for rule in(acl == "cloudfront" ? aws_wafv2_web_acl.cloudfront[0] : aws_wafv2_web_acl.regional[0]).rule : anytrue([
                for route in rule.statement[0].or_statement[0].statement :
                route.and_statement[0].statement[0].byte_match_statement[0].search_string == method &&
                can(regex(route.and_statement[0].statement[1].regex_match_statement[0].regex_string, path))
              ]) if rule.name == "LabelBlockWrites"
            ])],
            [for path in cases.miss : !anytrue([
              for rule in(acl == "cloudfront" ? aws_wafv2_web_acl.cloudfront[0] : aws_wafv2_web_acl.regional[0]).rule : anytrue([
                for route in rule.statement[0].or_statement[0].statement :
                route.and_statement[0].statement[0].byte_match_statement[0].search_string == method &&
                can(regex(route.and_statement[0].statement[1].regex_match_statement[0].regex_string, path))
              ]) if rule.name == "LabelBlockWrites"
            ])],
          ))
      ])
    ])
    error_message = "POST must match only the block collection and PUT only a block item, with the stage prefix allowed only on the regional ACL."
  }

  # Nothing but a block create or update may be labelled, whatever the method.
  assert {
    condition = alltrue([
      for acl in [aws_wafv2_web_acl.cloudfront[0], aws_wafv2_web_acl.regional[0]] : alltrue([
        for rule in acl.rule : alltrue([
          for route in rule.statement[0].or_statement[0].statement : alltrue([
            for path in [
              "/api/projects",
              "/api/blocks",
              "/api/blocks/",
              "/api/blocks/stage/",
              "/api/blocks/widget",
              "/api/blocks/STAGE",
              "/api/blocks/stage/x/body",
              "/api/blocks/stage/x/script",
              "/api/blocks/stage/../projects",
              "/api/blocks/stage/%2e%2e",
              "/api/blocks/stage/a.b",
              "/api/blocks/stage/-x",
              "/api/blocks/stageX",
              "/api/blocks/stage/x?y",
              "/../api/blocks/stage",
              "/a/b/api/blocks/stage",
              "/api/discussions/api/blocks/stage",
              "/x/api/blocks/stage/x/y",
            ] : !can(regex(route.and_statement[0].statement[1].regex_match_statement[0].regex_string, path))
          ])
        ]) if rule.name == "LabelBlockWrites"
      ])
    ])
    error_message = "No path other than a block create or update may be exempt, including traversal, encoded paths and sub-resources."
  }

  assert {
    condition = alltrue([
      for acl in [aws_wafv2_web_acl.cloudfront[0], aws_wafv2_web_acl.regional[0]] : toset(flatten([
        for rule in acl.rule : [
          for route in rule.statement[0].or_statement[0].statement :
          route.and_statement[0].statement[0].byte_match_statement[0].search_string
        ] if rule.name == "LabelBlockWrites"
      ])) == toset(["POST", "PUT"])
    ])
    error_message = "Only POST (create) and PUT (update) may be exempt; DELETE and GET carry no block body."
  }
}
