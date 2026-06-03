// test/e2e/apiClient.mjs
export function createApiClient({ apiBaseUrl, idToken }) {
  async function call(method, path, body) {
    const res = await fetch(`${apiBaseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || text || res.statusText;
      const err = new Error(`${method} ${path} -> ${res.status}: ${msg}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b ?? {}),
    put: (p, b) => call('PUT', p, b ?? {}),
    del: (p) => call('DELETE', p),
  };
}
