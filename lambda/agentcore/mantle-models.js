// Read the Codex model catalogue from bedrock-mantle's OpenAI-compatible
// Models API for the inference region (#674).
//
// Mantle is a separate endpoint from bedrock-runtime and has no AWS SDK client
// in this repository, so the request is a signed GET against
//   https://bedrock-mantle.<region>.api.aws/v1/models
// Credentials are the invocation's own: the Bedrock API key in keys mode, the
// IAM session in IAM mode. That matters — the catalogue must describe the same
// region and entitlement the Codex run will use, not the control plane's.
//
// The signer mirrors the Gateway proxy (mcp/gateway-proxy.js) because the AWS
// SDK clients cannot sign a request for a service they do not model.

import { createHash, createHmac } from 'node:crypto';
import { SignatureV4 } from '@smithy/signature-v4';

const SERVICE = 'bedrock-mantle';
const DEFAULT_TIMEOUT_MS = 5_000;

export const mantleModelsUrl = (region) => `https://bedrock-mantle.${region}.api.aws/v1/models`;

class NodeSha256 {
  constructor(secret) {
    this.hash = secret ? createHmac('sha256', secret) : createHash('sha256');
  }
  update(data) {
    this.hash.update(typeof data === 'string' ? Buffer.from(data) : data);
  }
  async digest() {
    return new Uint8Array(this.hash.digest());
  }
}

// One GET, either bearer-authenticated (keys mode) or SigV4-signed with the
// invocation's session credentials (IAM mode).
export const createMantleFetch = ({ region, apiKey, credentials, fetchImpl = fetch }) => {
  if (apiKey) {
    return (url, init = {}) =>
      fetchImpl(url, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${apiKey}` },
      });
  }
  const signer = new SignatureV4({ service: SERVICE, region, credentials, sha256: NodeSha256 });
  return async (url, init = {}) => {
    const target = new URL(url);
    const headers = { host: target.host };
    const signed = await signer.sign({
      method: init.method ?? 'GET',
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port ? Number(target.port) : undefined,
      path: target.pathname,
      query: Object.fromEntries(target.searchParams),
      headers,
    });
    const { host: _host, ...sendHeaders } = signed.headers;
    return fetchImpl(url, { ...init, headers: sendHeaders });
  };
};

// Returns the parsed payload; throws when the endpoint answers non-2xx, times
// out, or returns something that is not a model list. Callers turn a throw into
// an explicit "lookup failed" state (see listCodexModels).
export const listMantleModels = async ({
  region,
  apiKey,
  credentials,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) => {
  if (!region) throw new Error('An inference region is required to list Mantle models');
  const send = createMantleFetch({ region, apiKey, credentials, fetchImpl });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await send(mantleModelsUrl(region), {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response?.ok) {
      throw new Error(`The Mantle model catalogue answered ${response?.status ?? 'no status'}`);
    }
    const payload = await response.json();
    if (!Array.isArray(payload?.data)) {
      throw new Error('The Mantle model catalogue did not return a model list');
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
};

export default { listMantleModels, createMantleFetch, mantleModelsUrl };
