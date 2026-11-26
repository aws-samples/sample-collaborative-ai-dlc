# Private workflow packages must not share the artifacts bucket: AgentCore has
# a bucket-wide read grant there. This bucket grants no application/runtime
# principal access; protected worker permissions are wired separately.
variable "native_package_publisher_role_arn" {
  description = "Dedicated package worker IAM role ARN; other principals cannot publish package objects"
  type        = string
  nullable    = false
  validation {
    condition     = can(regex("^arn:(aws|aws-us-gov|aws-cn):iam::[0-9]{12}:role/([A-Za-z0-9_+=,.@-]+/)*[A-Za-z0-9_+=,.@-]{1,64}$", var.native_package_publisher_role_arn))
    error_message = "The package publisher must be a concrete IAM role ARN, without wildcards or session identifiers."
  }
}

resource "aws_s3_bucket" "native_packages" {
  bucket        = "${var.project_name}-native-packages-${var.environment}-${random_id.bucket_suffix.hex}"
  force_destroy = false
  tags          = var.tags
}

resource "aws_s3_bucket_versioning" "native_packages" {
  bucket = aws_s3_bucket.native_packages.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "native_packages" {
  bucket = aws_s3_bucket.native_packages.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "native_packages" {
  bucket = aws_s3_bucket.native_packages.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "native_packages" {
  bucket = aws_s3_bucket.native_packages.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Use the same document as the offline renderer and policy regression tests.
# AWS request-context behavior still requires deployed qualification.
resource "aws_s3_bucket_policy" "native_packages" {
  bucket = aws_s3_bucket.native_packages.id
  policy = templatefile("${path.module}/policies/native-packages-bucket.json.tftpl", {
    bucket_arn         = aws_s3_bucket.native_packages.arn
    publisher_role_arn = var.native_package_publisher_role_arn
  })
}

# No lifecycle expiry or transition: executions must retain their pinned bytes
# until an explicit package-retention policy is implemented.
output "native_packages_bucket_name" {
  description = "Name of the private native package bucket"
  value       = aws_s3_bucket.native_packages.id
}

output "native_packages_bucket_arn" {
  description = "ARN of the private native package bucket, available to permission consumers after bucket protection"
  value       = aws_s3_bucket.native_packages.arn

  # Preserve the dependency when another module uses this ARN for a publisher
  # grant. Exporting the raw bucket alone would allow IAM writes to race policy
  # attachment/versioning. Only the worker role (not its policies) flows back
  # into this module, so this ordering does not create a dependency cycle.
  depends_on = [
    aws_s3_bucket_policy.native_packages,
    aws_s3_bucket_versioning.native_packages,
    aws_s3_bucket_ownership_controls.native_packages,
    aws_s3_bucket_server_side_encryption_configuration.native_packages,
    aws_s3_bucket_public_access_block.native_packages,
  ]
}
