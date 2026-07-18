resource "random_id" "bucket_suffix" {
  byte_length = 4
}

# Artifacts bucket for Yjs docs and artifact content
resource "aws_s3_bucket" "artifacts" {
  bucket        = "${var.project_name}-artifacts-${var.environment}-${random_id.bucket_suffix.hex}"
  force_destroy = true
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Browser attachment uploads use presigned POSTs directly to this bucket. Keep
# the existing artifact read/PUT methods while adding POST; object access stays
# private because this only controls browser CORS preflight responses.
resource "aws_s3_bucket_cors_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD", "POST", "PUT"]
    allowed_origins = var.cors_allowed_origins
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = "glacier_transition"
    status = "Enabled"

    filter {}

    noncurrent_version_transition {
      noncurrent_days = 90
      storage_class   = "GLACIER"
    }
  }

  # Browser attachment uploads land under this staging prefix before the
  # intents Lambda validates and promotes them. Expire abandoned current
  # objects as well as their noncurrent versions; committed references live
  # outside this prefix and remain available for the intent lifetime.
  rule {
    id     = "expire_attachment_staging"
    status = "Enabled"

    filter {
      prefix = "intent-attachments/staging/"
    }

    expiration {
      days = 1
    }

    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }
}

# Code snapshots bucket for agent code outputs
resource "aws_s3_bucket" "code_snapshots" {
  bucket        = "${var.project_name}-code-snapshots-${var.environment}-${random_id.bucket_suffix.hex}"
  force_destroy = true
}

resource "aws_s3_bucket_versioning" "code_snapshots" {
  bucket = aws_s3_bucket.code_snapshots.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "code_snapshots" {
  bucket = aws_s3_bucket.code_snapshots.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "code_snapshots" {
  bucket = aws_s3_bucket.code_snapshots.id

  rule {
    id     = "glacier_transition"
    status = "Enabled"

    filter {}

    noncurrent_version_transition {
      noncurrent_days = 90
      storage_class   = "GLACIER"
    }
  }
}

# Shared access logging bucket (CloudFront, ALB, etc.)
resource "aws_s3_bucket" "access_logs" {
  bucket        = "${var.project_name}-access-logs-${var.environment}-${random_id.bucket_suffix.hex}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    id     = "expire_old_logs"
    status = "Enabled"

    filter {}

    expiration {
      days = var.environment == "prod" ? 90 : 30
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_acl" "access_logs" {
  depends_on = [aws_s3_bucket_ownership_controls.access_logs]
  bucket     = aws_s3_bucket.access_logs.id
  acl        = "log-delivery-write"
}

# -----------------------------------------------------------------------------
# Enforce TLS on every request (CKV_AWS_93 / CKV2_AWS_6 / AWS Foundational SBP).
# Denies any s3:* action when the request is not made over HTTPS.
# -----------------------------------------------------------------------------
data "aws_iam_policy_document" "deny_insecure_transport_artifacts" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.artifacts.arn,
      "${aws_s3_bucket.artifacts.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  policy = data.aws_iam_policy_document.deny_insecure_transport_artifacts.json
}

data "aws_iam_policy_document" "deny_insecure_transport_code_snapshots" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.code_snapshots.arn,
      "${aws_s3_bucket.code_snapshots.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "code_snapshots" {
  bucket = aws_s3_bucket.code_snapshots.id
  policy = data.aws_iam_policy_document.deny_insecure_transport_code_snapshots.json
}

data "aws_iam_policy_document" "deny_insecure_transport_access_logs" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.access_logs.arn,
      "${aws_s3_bucket.access_logs.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  policy = data.aws_iam_policy_document.deny_insecure_transport_access_logs.json
}
