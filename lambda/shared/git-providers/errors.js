'use strict';

// ProviderError — uniform error shape thrown by every git-provider method.
// status mirrors the upstream HTTP status (or a synthetic 4xx for client
// errors); message is human-readable; extra is optional structured data
// that callers may surface back to the API consumer (e.g. retryAfter).
class ProviderError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.extra = extra;
  }
}

module.exports = { ProviderError };
