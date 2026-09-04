// Platform-wide custom MCP servers card (Admin → Agents tab). Self-loads from
// agent settings (SSM-backed) and saves through agentsService, mirroring
// DefaultModelsCard. The editor + validation live in CustomMcpServersSection;
// these servers are merged UNDER each project's own set at intent create.

import { useEffect, useState } from 'react';
import { agentsService } from '@/services/agents';
import { CustomMcpServersSection } from '@/components/settings/CustomMcpServersSection';

export function GlobalMcpServersCard() {
  const [value, setValue] = useState('{}');
  const [mcpSecretsSet, setMcpSecretsSet] = useState<Record<string, boolean>>({});

  useEffect(() => {
    agentsService
      .getSettings()
      .then((s) => {
        setValue(s.customMcpServers ?? '{}');
        setMcpSecretsSet(s.mcpSecretsSet ?? {});
      })
      .catch((e) => console.error('Failed to load global MCP servers:', e));
  }, []);

  const save = async (next: string) => {
    await agentsService.updateSettings({ customMcpServers: next });
    // Reload the canonical stored value from the server.
    const fresh = await agentsService.getSettings();
    setValue(fresh.customMcpServers ?? '{}');
    setMcpSecretsSet(fresh.mcpSecretsSet ?? {});
  };

  const saveSecrets = async (secrets: Record<string, string>) => {
    await agentsService.updateSettings({ mcpSecrets: secrets });
    const fresh = await agentsService.getSettings();
    setMcpSecretsSet(fresh.mcpSecretsSet ?? {});
  };

  return (
    <CustomMcpServersSection
      value={value}
      onChange={setValue}
      onSave={save}
      canEdit={true}
      description="Custom MCP servers injected into every agent session across all spaces. A space's own MCP servers are merged on top (space wins when names collide)."
      mcpSecretsSet={mcpSecretsSet}
      onSaveSecrets={saveSecrets}
    />
  );
}
