data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  account_root_arn = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"
  data_service_endpoints = [
    "dynamodb.${data.aws_region.current.region}.${data.aws_partition.current.dns_suffix}",
    "rds.${data.aws_region.current.region}.${data.aws_partition.current.dns_suffix}",
  ]
}

data "aws_iam_policy_document" "data" {
  statement {
    sid     = "EnableAccountAdministration"
    effect  = "Allow"
    actions = ["kms:*"]
    resources = [
      "*",
    ]

    principals {
      type        = "AWS"
      identifiers = [local.account_root_arn]
    }
  }

  # Keep data-plane access coupled to the caller's DynamoDB/Neptune IAM
  # authorization. This service-use grant cannot authorize direct KMS calls.
  statement {
    sid    = "AllowDataServicesForThisAccount"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey*",
      "kms:ReEncrypt*",
    ]
    resources = [
      "*",
    ]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = local.data_service_endpoints
    }
  }

  statement {
    sid    = "AllowDataServiceGrantsForThisAccount"
    effect = "Allow"
    actions = [
      "kms:CreateGrant",
      "kms:ListGrants",
      "kms:RevokeGrant",
    ]
    resources = [
      "*",
    ]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = local.data_service_endpoints
    }

    condition {
      test     = "Bool"
      variable = "kms:GrantIsForAWSResource"
      values   = ["true"]
    }
  }
}

resource "aws_kms_key" "data" {
  description             = "Shared customer-managed key for ${var.name_prefix} data stores"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.data.json

  tags = var.tags
}

resource "aws_kms_alias" "data" {
  name          = "alias/${var.name_prefix}-data"
  target_key_id = aws_kms_key.data.key_id
}
