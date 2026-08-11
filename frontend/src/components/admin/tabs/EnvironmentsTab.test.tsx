import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const list = vi.fn();
const catalog = vi.fn();
const get = vi.fn();
const build = vi.fn();
const create = vi.fn();

vi.mock('@/services/environments', () => ({
  environmentsService: {
    list: (...args: unknown[]) => list(...args),
    catalog: (...args: unknown[]) => catalog(...args),
    get: (...args: unknown[]) => get(...args),
    build: (...args: unknown[]) => build(...args),
    create: (...args: unknown[]) => create(...args),
    update: vi.fn(),
    retry: vi.fn(),
    acknowledge: vi.fn(),
    publish: vi.fn(),
    rebuild: vi.fn(),
    rebuildAll: vi.fn(),
    retire: vi.fn(),
  },
}));

import { EnvironmentsTab } from './EnvironmentsTab';

const standard = {
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
};

const custom = {
  environmentId: 'custom',
  name: 'Custom',
  description: 'Custom build',
  system: false,
  status: 'DRAFT',
  baseEnvironmentId: 'standard',
  currentRevisionId: 'r-1',
  publishedRevisionId: null,
  updateAvailable: false,
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
};

const recipe = {
  schemaVersion: 1,
  base: {
    environmentId: 'standard',
    revisionId: 'core-1',
    imageUri: 'core',
    imageDigest: `sha256:${'a'.repeat(64)}`,
  },
  tools: { node: { version: '24.15.0', source: 'base' } },
  buildTools: {},
  aptPackages: [],
  environmentVariables: {},
  buildCommands: [],
};

const javaPackage = {
  version: '21.0.8',
  source: 'archive' as const,
  url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.8%2B9/OpenJDK21U-jdk_aarch64_linux_hotspot_21.0.8_9.tar.gz',
  checksum: {
    algorithm: 'sha256' as const,
    value: 'e5c41a1ab0865ea5de9b4529bf8526005f1d4593090845387d14fe450ce39c33',
  },
  stripComponents: 1,
};

const toolCatalog = {
  schemaVersion: 1 as const,
  tools: {
    node: {
      label: 'Node.js',
      publisher: 'Protected runtime',
      versions: [{ version: '24.15.0', source: 'base' as const }],
    },
    python: {
      label: 'Python',
      publisher: 'Protected runtime',
      versions: [{ version: '3.11', source: 'base' as const }],
    },
    java: {
      label: 'Java',
      publisher: 'Eclipse Temurin',
      versions: [javaPackage],
    },
    go: { label: 'Go', publisher: 'The Go project', versions: [] },
    rust: { label: 'Rust', publisher: 'The Rust project', versions: [] },
  },
  buildTools: {
    maven: { label: 'Apache Maven', publisher: 'Apache Software Foundation', versions: [] },
    gradle: { label: 'Gradle', publisher: 'Gradle', versions: [] },
  },
};

const revision = {
  environmentId: 'custom',
  revisionId: 'r-1',
  status: 'DRAFT',
  recipe,
  flattenedRecipe: recipe,
  runtimeCompatibilityVersion: '1',
  imageUri: null,
  imageDigest: null,
  runtimeArn: null,
  runtimeEndpoint: null,
  generatedDockerfile: 'FROM core@sha256:abc\nUSER node\n',
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
};

const standardRecipe = {
  ...recipe,
  base: {
    environmentId: 'core',
    revisionId: 'core-1',
    imageUri: 'core',
    imageDigest: `sha256:${'a'.repeat(64)}`,
  },
  tools: {
    node: { version: '24.15.0', source: 'base' as const },
    python: { version: '3.11', source: 'base' as const },
  },
};

const standardRevision = {
  ...revision,
  environmentId: 'standard',
  revisionId: 'core-1',
  status: 'PUBLISHED',
  recipe: standardRecipe,
  flattenedRecipe: standardRecipe,
};

const standardDetail = {
  environment: standard,
  revisions: [standardRevision],
  publishedRevision: standardRevision,
};

describe('EnvironmentsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue([custom, standard]);
    catalog.mockResolvedValue(toolCatalog);
    get.mockImplementation(async (environmentId: string) =>
      environmentId === 'standard'
        ? standardDetail
        : {
            environment: custom,
            revisions: [revision],
            publishedRevision: null,
          },
    );
    build.mockResolvedValue({
      environment: { ...custom, status: 'BUILDING' },
      revision: { ...revision, status: 'BUILDING' },
    });
  });

  it('shows revision evidence and starts a draft build', async () => {
    const user = userEvent.setup();
    render(<EnvironmentsTab />);
    expect(await screen.findByText('Generated Dockerfile')).toBeInTheDocument();
    expect(screen.getByText(/FROM core@sha256:abc/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Build' }));
    expect(build).toHaveBeenCalledWith('custom', 'r-1');
  });

  it('selects a newly created environment when the ID is generated by the API', async () => {
    const user = userEvent.setup();
    const generated = {
      ...custom,
      environmentId: 'generated-name',
      name: 'Generated Name',
      currentRevisionId: 'r-generated',
    };
    const generatedRevision = {
      ...revision,
      environmentId: generated.environmentId,
      revisionId: generated.currentRevisionId,
    };
    list.mockResolvedValueOnce([custom, standard]).mockResolvedValue([generated, custom, standard]);
    get.mockImplementation(async (environmentId: string) =>
      environmentId === 'standard'
        ? standardDetail
        : environmentId === generated.environmentId
          ? {
              environment: generated,
              revisions: [generatedRevision],
              publishedRevision: null,
            }
          : {
              environment: custom,
              revisions: [revision],
              publishedRevision: null,
            },
    );
    create.mockResolvedValue({
      environment: generated,
      revision: generatedRevision,
    });

    render(<EnvironmentsTab />);
    await screen.findByText('Generated Dockerfile');
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.type(screen.getByLabelText('Name'), 'Generated Name');
    await user.click(screen.getByRole('button', { name: 'Create Draft' }));

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Generated Name',
        baseEnvironmentId: 'standard',
      }),
    );
    expect(await screen.findAllByText('generated-name')).toHaveLength(2);
    expect(get).toHaveBeenCalledWith('generated-name');
  });

  it('shows inherited and platform versions without archive configuration inputs', async () => {
    const user = userEvent.setup();
    create.mockResolvedValue({
      environment: custom,
      revision,
    });

    render(<EnvironmentsTab />);
    await screen.findByText('Generated Dockerfile');
    await user.click(screen.getByRole('button', { name: 'New' }));

    expect(await screen.findByText('Node.js 24.15.0')).toBeInTheDocument();
    expect(screen.getByText('Python 3.11')).toBeInTheDocument();
    expect(screen.getAllByText('Inherited from Standard Node/Python')).toHaveLength(2);
    expect(screen.getByText('21.0.8')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Node.js version' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Java version' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Java archive URL')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Java checksum')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Java official package' })).toHaveAttribute(
      'href',
      javaPackage.url,
    );

    await user.click(screen.getByRole('switch', { name: 'Include Java' }));
    await user.type(screen.getByLabelText('Name'), 'Java Custom');
    await user.click(screen.getByRole('button', { name: 'Create Draft' }));

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        recipe: expect.objectContaining({
          tools: expect.objectContaining({
            java: javaPackage,
          }),
        }),
      }),
    );
  });
});
