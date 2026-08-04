variable "aws_region" {
  description = "AWS region for the disposable upstream Cognito User Pool."
  type        = string
  default     = "us-east-1"
}

variable "downstream_callback_url" {
  description = "The oidc_idp_callback_url output from the AI-DLC deployment."
  type        = string

  validation {
    condition     = can(regex("^https://[^/]+/oauth2/idpresponse$", var.downstream_callback_url))
    error_message = "downstream_callback_url must be the HTTPS Cognito /oauth2/idpresponse URL."
  }
}

variable "name_prefix" {
  description = "Prefix applied to disposable fixture resources."
  type        = string
  default     = "aidlc-oidc-test"
}
