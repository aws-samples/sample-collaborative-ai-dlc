import type { ComponentType } from 'react';

// A provider's settings UI. Setup collects a draft configuration; the shell
// turns it into a reviewed connection-draft, so providers never write directly.
export interface AgentAuthSetupProps {
  scope: 'platform' | 'space';
  projectId?: string;
  initial?: Readonly<Record<string, unknown>>;
  onClose(): void;
  onSubmit(configuration: Record<string, unknown>): Promise<void>;
}

export interface AgentAuthSummaryLine {
  label: string;
  value: string;
}

export interface AgentAuthProviderUi {
  mode: string;
  noun: string;
  Setup: ComponentType<AgentAuthSetupProps>;
  summarize?(configuration: Readonly<Record<string, unknown>>): AgentAuthSummaryLine[];
}
