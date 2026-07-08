// Platform-wide custom MCP servers card (Admin → Agents tab). Self-loads from
// agent settings (SSM-backed) and saves through agentsService, mirroring
// DefaultModelsCard. The editor + validation live in CustomMcpServersSection;
// these servers are merged UNDER each project's own set at intent create.

import { useEffect, useState } from 'react';
import { agentsService } from '@/services/agents';
import { CustomMcpServersSection } from '@/components/settings/CustomMcpServersSection';

export function GlobalMcpServersCard() {
  const [value, setValue] = useState('{}');

  useEffect(() => {
    agentsService
      .getSettings()
      .then((s) => setValue(s.customMcpServers ?? '{}'))
      .catch((e) => console.error('Failed to load global MCP servers:', e));
  }, []);

  const save = async (next: string) => {
    await agentsService.updateSettings({ customMcpServers: next });
    // Reload the canonical stored value from the server.
    const fresh = await agentsService.getSettings();
    setValue(fresh.customMcpServers ?? '{}');
  };

  return (
    <CustomMcpServersSection
      value={value}
      onChange={setValue}
      onSave={save}
      canEdit={true}
      description="Custom MCP servers injected into every agent session across all projects. A project's own MCP servers are merged on top (project wins when names collide)."
    />
  );
}
