
data "aws_iam_policy_document" "rest_api" {
  count = var.enable_cloudfront_origin_policy ? 1 : 0

  statement {
    sid    = "AllowExecuteViaCloudFront"
    effect = "Allow"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["execute-api:Invoke"]
    resources = ["${aws_api_gateway_rest_api.main.execution_arn}/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestHeader/X-Origin-Verify"
      values   = [var.cloudfront_origin_secret]
    }
  }

  statement {
    sid    = "DenyExecuteWithoutCloudFrontHeader"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["execute-api:Invoke"]
    resources = ["${aws_api_gateway_rest_api.main.execution_arn}/*"]

    condition {
      test     = "StringNotEquals"
      variable = "aws:RequestHeader/X-Origin-Verify"
      values   = [var.cloudfront_origin_secret]
    }
  }
}

resource "aws_api_gateway_rest_api_policy" "main" {
  count       = var.enable_cloudfront_origin_policy ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.main.id
  policy      = data.aws_iam_policy_document.rest_api[0].json
}
