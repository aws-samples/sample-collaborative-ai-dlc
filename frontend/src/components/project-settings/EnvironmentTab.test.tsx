import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const list = vi.fn();
const get = vi.fn();
const getEnvironment = vi.fn();
const assignEnvironment = vi.fn();

vi.mock('@/services/environments', () => ({
  environmentsService: {
    list: (...args: unknown[]) => list(...args),
    get: (...args: unknown[]) => get(...args),
  },
}));

vi.mock('@/services/projects', () => ({
  projectsService: {
    getEnvironment: (...args: unknown[]) => getEnvironment(...args),
    assignEnvironment: (...args: unknown[]) => assignEnvironment(...args),
  },
}));

vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
    children: React.ReactNode;
  }) => (
    <select
      aria-label="Environment"
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

import { EnvironmentTab } from './EnvironmentTab';

const environments = [
  {
    environmentId: 'standard',
    name: 'Standard Node/Python',
    description: '',
    system: true,
    status: 'PUBLISHED',
    baseEnvironmentId: null,
    currentRevisionId: 'core-1',
    publishedRevisionId: 'core-1',
    updateAvailable: false,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  },
  {
    environmentId: 'polyglot',
    name: 'Polyglot',
    description: '',
    system: true,
    status: 'PUBLISHED',
    baseEnvironmentId: 'standard',
    currentRevisionId: 'r-7',
    publishedRevisionId: 'r-7',
    updateAvailable: false,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  },
];

const detail = (environmentId: string) => {
  const environment = environments.find((item) => item.environmentId === environmentId)!;
  const revisionId = environment.publishedRevisionId!;
  const revision = {
    environmentId,
    revisionId,
    status: 'PUBLISHED',
    runtimeCompatibilityVersion: '1',
    imageUri: 'repo',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    runtimeArn: 'runtime',
    runtimeEndpoint: `revision_${revisionId}`,
    recipe: {
      schemaVersion: 1,
      base: null,
      tools:
        environmentId === 'polyglot'
          ? {
              node: { version: '24.15.0', source: 'base' },
              python: { version: '3.11', source: 'base' },
              rust: { version: '1.89.0', source: 'base' },
            }
          : { node: { version: '24.15.0', source: 'base' } },
      buildTools: {},
      aptPackages: [],
      environmentVariables: {},
      buildCommands: [],
    },
    flattenedRecipe: {
      schemaVersion: 1,
      base: null,
      tools:
        environmentId === 'polyglot'
          ? {
              node: { version: '24.15.0', source: 'base' },
              python: { version: '3.11', source: 'base' },
              rust: { version: '1.89.0', source: 'base' },
            }
          : { node: { version: '24.15.0', source: 'base' } },
      buildTools: {},
      aptPackages: [],
      environmentVariables: {},
      buildCommands: [],
    },
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  };
  return { environment, revisions: [revision], publishedRevision: revision };
};

const project = {
  id: 'p1',
  name: 'Space',
  gitProvider: 'github' as const,
  gitRepo: 'owner/repo',
  agentCli: 'kiro' as const,
  createdAt: '2026-08-10T00:00:00.000Z',
  trackers: [],
  environmentId: 'standard',
  repos: [
    {
      url: 'owner/repo',
      provider: 'github' as const,
      role: 'primary' as const,
      detectedStack: 'Python and Rust',
      addedAt: '2026-08-10T00:00:00.000Z',
    },
  ],
};

describe('EnvironmentTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue(environments);
    get.mockImplementation((environmentId: string) => Promise.resolve(detail(environmentId)));
    getEnvironment.mockResolvedValue({
      environmentId: 'standard',
      environment: environments[0],
      revision: detail('standard').publishedRevision,
    });
    assignEnvironment.mockResolvedValue({
      environmentId: 'polyglot',
      environment: environments[1],
      revision: detail('polyglot').publishedRevision,
    });
  });

  it('shows repository compatibility warnings for missing tools', async () => {
    render(<EnvironmentTab project={project} canEdit onProjectUpdated={vi.fn()} />);
    expect(
      await screen.findByText('Python is detected in a repository but is not included.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Rust is detected in a repository but is not included.'),
    ).toBeInTheDocument();
  });

  it('assigns a published environment to the space', async () => {
    const user = userEvent.setup();
    const onProjectUpdated = vi.fn();
    render(<EnvironmentTab project={project} canEdit onProjectUpdated={onProjectUpdated} />);
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Environment' }),
      'polyglot',
    );
    await user.click(screen.getByRole('button', { name: 'Assign Environment' }));
    expect(assignEnvironment).toHaveBeenCalledWith('p1', 'polyglot');
    expect(onProjectUpdated).toHaveBeenCalledWith({ environmentId: 'polyglot' });
  });
});
