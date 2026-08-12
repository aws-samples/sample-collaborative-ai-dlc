import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const list = vi.fn();
const catalog = vi.fn();
const get = vi.fn();
const build = vi.fn();
const create = vi.fn();
const acceptFindings = vi.fn();

vi.mock('@/services/environments', () => ({
  environmentsService: {
    list: (...args: unknown[]) => list(...args),
    catalog: (...args: unknown[]) => catalog(...args),
    get: (...args: unknown[]) => get(...args),
    build: (...args: unknown[]) => build(...args),
    create: (...args: unknown[]) => create(...args),
    update: vi.fn(),
    retry: vi.fn(),
    acceptFindings: (...args: unknown[]) => acceptFindings(...args),
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

const scanFindings = {
  status: 'COMPLETE',
  severityCounts: { CRITICAL: 1, HIGH: 2, MEDIUM: 3 },
  findings: [
    {
      id: 'CVE-2026-42010',
      severity: 'CRITICAL',
      packageName: 'gnutls28',
      packageVersion: '3.7.9-2+deb12u6',
      uri: 'https://example.test/CVE-2026-42010',
    },
  ],
  evaluatedAt: '2026-08-12T06:26:52.283Z',
  imageDigest: `sha256:${'b'.repeat(64)}`,
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

  it('shows a successful image build and lets an admin accept security findings', async () => {
    const user = userEvent.setup();
    const securityEnvironment = {
      ...custom,
      status: 'SECURITY_REVIEW',
    };
    const securityRevision = {
      ...revision,
      status: 'SECURITY_REVIEW',
      imageUri: 'registry/environments',
      imageDigest: scanFindings.imageDigest,
      scanFindings,
    };
    list.mockResolvedValue([securityEnvironment, standard]);
    get.mockImplementation(async (environmentId: string) =>
      environmentId === 'standard'
        ? standardDetail
        : {
            environment: securityEnvironment,
            revisions: [securityRevision],
            publishedRevision: null,
          },
    );
    acceptFindings.mockResolvedValue({
      environment: securityEnvironment,
      revision: {
        ...securityRevision,
        securityFindingsAcceptedAt: '2026-08-12T07:00:00.000Z',
        securityFindingsAcceptedBy: 'admin@example.com',
      },
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<EnvironmentsTab />);

    expect(await screen.findByText('Build passed')).toBeInTheDocument();
    expect(screen.getByText('Review required')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /CVE-2026-42010/ })).toHaveAttribute(
      'href',
      'https://example.test/CVE-2026-42010',
    );
    expect(screen.getByText('gnutls28 3.7.9-2+deb12u6')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept Findings & Continue' }));

    expect(confirm).toHaveBeenCalledWith(
      'Accept 1 Critical and 2 High security findings and continue to runtime validation? The findings will remain visible after publication.',
    );
    expect(acceptFindings).toHaveBeenCalledWith('custom', 'r-1');
    confirm.mockRestore();
  });

  it('offers acceptance for a prior security-only failure', async () => {
    const failedEnvironment = {
      ...custom,
      status: 'FAILED',
    };
    const failedRevision = {
      ...revision,
      status: 'FAILED',
      imageUri: 'registry/environments',
      imageDigest: scanFindings.imageDigest,
      scanFindings,
      failure: {
        reason: 'critical_vulnerability_findings',
        detail: '1 Critical finding(s)',
      },
    };
    list.mockResolvedValue([failedEnvironment, standard]);
    get.mockImplementation(async (environmentId: string) =>
      environmentId === 'standard'
        ? standardDetail
        : {
            environment: failedEnvironment,
            revisions: [failedRevision],
            publishedRevision: null,
          },
    );

    render(<EnvironmentsTab />);

    expect(await screen.findByText('Build passed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept Findings & Continue' })).toBeInTheDocument();
    expect(screen.queryByText('critical_vulnerability_findings')).not.toBeInTheDocument();
  });

  it('keeps accepted security issues visible after publication', async () => {
    const publishedEnvironment = {
      ...custom,
      status: 'PUBLISHED',
      publishedRevisionId: 'r-1',
    };
    const publishedRevision = {
      ...revision,
      status: 'PUBLISHED',
      imageUri: 'registry/environments',
      imageDigest: scanFindings.imageDigest,
      scanFindings,
      securityFindingsAcceptedAt: '2026-08-12T07:00:00.000Z',
      securityFindingsAcceptedBy: 'admin@example.com',
    };
    list.mockResolvedValue([publishedEnvironment, standard]);
    get.mockImplementation(async (environmentId: string) =>
      environmentId === 'standard'
        ? standardDetail
        : {
            environment: publishedEnvironment,
            revisions: [publishedRevision],
            publishedRevision,
          },
    );

    render(<EnvironmentsTab />);

    expect(await screen.findByText('Findings accepted')).toBeInTheDocument();
    expect(screen.getByText(/Accepted by admin@example.com/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /CVE-2026-42010/ })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Accept Findings & Continue' }),
    ).not.toBeInTheDocument();
  });
});
