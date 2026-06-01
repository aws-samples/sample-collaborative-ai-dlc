// Single ProviderError class shared by every tracker provider so the
// handler's `instanceof` branch matches regardless of which provider
// raised. `extra` carries provider-specific structured payload (e.g.
// GitHub rate-limit info or Jira's `reconnect: true` flag).

export class ProviderError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
