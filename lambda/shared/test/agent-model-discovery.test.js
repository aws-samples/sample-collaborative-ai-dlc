import { describe, expect, it, vi } from 'vitest';
import { discoverAgentModels } from '../agent-model-discovery.js';
describe('provider-directed model discovery', () => {
  it('uses runtime models for a mode that owns inference credentials', async () => {
    const loadKeyModels = vi.fn();
    const result = await discoverAgentModels({
      credentialBindings: { bedrock: { mode: 'iam' } },
      loadKeyModels,
      loadRuntimeCapabilities: async () => ({ bedrockModels: ['scoped-model'] }),
    });
    expect(result.claudeModels).toEqual(['scoped-model']);
    expect(loadKeyModels).not.toHaveBeenCalled();
  });
  it('does not substitute application model access when runtime discovery fails', async () => {
    const loadKeyModels = vi.fn();
    const result = await discoverAgentModels({
      credentialBindings: { bedrock: { mode: 'litellm' } },
      loadKeyModels,
      loadRuntimeCapabilities: async () => null,
    });
    expect(result.claudeModels).toEqual([]);
    expect(loadKeyModels).not.toHaveBeenCalled();
  });
  it('retains legacy key discovery and can skip model listing for status requests', async () => {
    const loadKeyModels = vi.fn(async () => ['key-model']);
    const request = {
      credentialBindings: { bedrock: { provider: 'bedrock', source: 'platform' } },
      loadKeyModels,
      loadRuntimeCapabilities: async () => ({}),
    };
    expect((await discoverAgentModels(request)).claudeModels).toEqual(['key-model']);
    expect((await discoverAgentModels({ ...request, withModels: false })).claudeModels).toEqual([]);
    expect(loadKeyModels).toHaveBeenCalledOnce();
  });
});
