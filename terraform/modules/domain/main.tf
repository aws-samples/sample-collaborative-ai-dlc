locals {
  # A supplied ARN short-circuits issuance entirely: the certificate already
  # exists and is already issued, so there is nothing to validate or wait for.
  issue_certificate = var.enabled && var.certificate_arn == ""

  # Only meaningful when this module issues the certificate. A supplied ARN is
  # expected to be ISSUED already; the installer preflight verifies that.
  validate_via_route53 = local.issue_certificate && var.route53_zone_id != ""

  # ACM rejects duplicates between domain_name and subject_alternative_names.
  subject_alternative_names = [for a in distinct(var.aliases) : a if a != var.domain_name]

  # Terraform evaluates only the selected branch of a conditional, so the
  # indexed reference is safe while the certificate is count-gated off.
  validation_records = local.validate_via_route53 ? {
    for dvo in aws_acm_certificate.this[0].domain_validation_options :
    dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  } : {}

  # Resolving through aws_acm_certificate_validation rather than the certificate
  # itself is what makes the distribution wait for validation to complete.
  # Routed through time_sleep so the release delay lands between the
  # distribution update and the certificate deletion — see that resource.
  resolved_certificate_arn = (
    !var.enabled ? "" :
    var.certificate_arn != "" ? var.certificate_arn :
    time_sleep.certificate_release[0].triggers["certificate_arn"]
  )
}

resource "aws_acm_certificate" "this" {
  count    = local.issue_certificate ? 1 : 0
  provider = aws.us_east_1

  domain_name               = var.domain_name
  subject_alternative_names = local.subject_alternative_names
  validation_method         = "DNS"

  # Alias or SAN changes replace the certificate. Creating the replacement
  # first keeps the distribution on a valid certificate throughout.
  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name        = "${var.project_name}-${var.environment}-frontend"
    Environment = var.environment
    Project     = var.project_name
  }
}

resource "aws_route53_record" "certificate_validation" {
  for_each = local.validation_records

  zone_id = var.route53_zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.value]
  ttl     = var.validation_record_ttl

  # ACM reuses validation records across renewals and re-issues, so an existing
  # record for the same name must be adopted rather than causing a conflict.
  allow_overwrite = true
}

# Gates the certificate ARN behind successful validation. Referencing an
# unvalidated certificate from a distribution fails with InvalidViewerCertificate.
resource "aws_acm_certificate_validation" "this" {
  count    = local.validate_via_route53 ? 1 : 0
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.this[0].arn
  validation_record_fqdns = [for r in aws_route53_record.certificate_validation : r.fqdn]
}

# Holds the certificate ARN on its way to the distribution, purely to create a
# graph position between the two.
#
# CloudFront releases a certificate asynchronously. The distribution reaching
# Deployed does not mean ACM has observed the disassociation yet, so deleting the
# certificate immediately afterwards fails with ResourceInUseException. Because
# dependents are dealt with before their dependencies on destroy, sitting here
# means the wait happens after the distribution has been updated off this
# certificate and before ACM is asked to delete it:
#
#   distribution updated -> this delay -> validation destroyed -> certificate deleted
#
# Only present when Terraform owns the certificate. A supplied certificate ARN is
# never deleted by Terraform, so it cannot hit the race.
resource "time_sleep" "certificate_release" {
  count = local.issue_certificate ? 1 : 0

  destroy_duration = var.certificate_release_delay

  triggers = {
    certificate_arn = (
      local.validate_via_route53
      ? aws_acm_certificate_validation.this[0].certificate_arn
      : aws_acm_certificate.this[0].arn
    )
  }

  # Matches the certificate so a domain rename creates the replacement before
  # tearing down the old pair.
  lifecycle {
    create_before_destroy = true
  }
}
