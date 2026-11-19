import { beforeEach, describe, expect, it, vi } from 'vitest';

const credentials = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: () => credentials,
}));

import { handler } from '../index.js';

beforeEach(() => {
  credentials.mockReset().mockRejectedValue(new Error('Credentials unavailable'));
});

describe('installation membership invocation', () => {
  it('fails the copy invocation so Terraform cannot cut over after a setup failure', async () => {
    await expect(handler({ action: 'copy' })).rejects.toThrow('Credentials unavailable');
  });

  it('reports diagnostic setup failure without failing the deployed application update', async () => {
    expect(await handler({ action: 'report' })).toEqual({ reported: false });
  });
});
