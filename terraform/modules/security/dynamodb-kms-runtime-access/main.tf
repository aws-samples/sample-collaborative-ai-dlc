resource "aws_iam_role_policy" "this" {
  for_each = var.kms_key_arn == "" ? {} : var.role_names

  name = "dynamodb-kms-runtime-access"
  role = each.value

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "UseDynamoDBEncryptionKey"
        Effect = "Allow"
        Action = [
          "kms:DescribeKey",
          "kms:Decrypt",
          "kms:Encrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
        ]
        Resource = var.kms_key_arn
        Condition = {
          StringLike = {
            "kms:ViaService" = "dynamodb.*.${var.dns_suffix}"
          }
        }
      },
      {
        Sid      = "AllowDynamoDBResourceGrant"
        Effect   = "Allow"
        Action   = ["kms:CreateGrant"]
        Resource = var.kms_key_arn
        Condition = {
          StringLike = {
            "kms:ViaService" = "dynamodb.*.${var.dns_suffix}"
          }
          Bool = {
            "kms:GrantIsForAWSResource" = "true"
          }
        }
      },
    ]
  })
}
