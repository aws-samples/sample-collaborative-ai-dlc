import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const list = vi.fn();
const listTools = vi.fn();
const get = vi.fn();
const build = vi.fn();
const create = vi.fn();
const acceptFindings = vi.fn();
const rebuild = vi.fn();

vi.mock('@/services/environments', () => ({
  environmentsService: {
    list: (...args: unknown[]) => list(...args),
    get: (...args: unknown[]) => get(...args),
    build: (...args: unknown[]) => build(...args),
    create: (...args: unknown[]) => create(...args),
    update: vi.fn(),
    retry: vi.fn(),
    acceptFindings: (...args: unknown[]) => acceptFindings(...args),
    publish: vi.fn(),
    rebuild: (...args: unknown[]) => rebuild(...args),
    rebuildAll: vi.fn(),
    retire: vi.fn(),
  },
  toolsService: {
    list: (...args: unknown[]) => listTools(...args),
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
  schemaVersion: 2 as const,
  base: {
    environmentId: 'standard',
    revisionId: 'core-1',
    imageUri: 'core',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    imageSizeBytes: 900 * 1024 * 1024,
  },
  toolVersionIds: [],
  tools: [],
  resolvedTools: [],
  aptPackages: [],
  environmentVariables: {},
  buildCommands: [],
};

const javaVersion = {
  toolId: 'java',
  versionId: 'tv-java-21',
  status: 'PUBLISHED' as const,
  definition: {
    schemaVersion: 1 as const,
    version: '21.0.8',
    distribution: 'Eclipse Temurin',
    publisher: 'Eclipse Adoptium',
    source: {
      type: 'https' as const,
      url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.8%2B9/OpenJDK21U-jdk_aarch64_linux_hotspot_21.0.8_9.tar.gz',
    },
    installer: { mode: 'generated' as const, stripComponents: 1 },
    executables: [
      { name: 'java', path: 'bin/java' },
      { name: 'javac', path: 'bin/javac' },
    ],
    dependencies: [],
    aptPackages: [],
    environmentVariables: { JAVA_HOME: '${TOOL_ROOT}' },
    verification: {
      preset: 'java' as const,
      versionCommand: { argv: ['java', '-version'], expected: '21.0.8' },
      script: '',
      files: [],
    },
  },
  system: true,
  autoBuild: false,
  buildAttempt: 1,
  imageUri: 'registry/tools',
  imageDigest: `sha256:${'c'.repeat(64)}`,
  imageSizeBytes: 200 * 1024 * 1024,
  source: {
    requestedUrl: 'https://example.test/java.tar.gz',
    resolvedUrl: 'https://example.test/java.tar.gz',
    sha256: 'd'.repeat(64),
    sizeBytes: 100,
    trustLevel: 'PUBLISHER_VERIFIED' as const,
  },
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
  publishedAt: '2026-08-13T00:00:00.000Z',
};

const javaTool = {
  toolId: 'java',
  name: 'Java JDK',
  description: 'Java SDK',
  category: 'language-sdk',
  publisher: 'Eclipse Temurin',
  system: true,
  recommendedVersionId: javaVersion.versionId,
  versions: [javaVersion],
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
};

const mavenVersion = {
  ...javaVersion,
  toolId: 'maven',
  versionId: 'tv-maven-3',
  definition: {
    ...javaVersion.definition,
    version: '3.9.11',
    distribution: 'Apache Maven',
    publisher: 'Apache Software Foundation',
    source: {
      type: 'https' as const,
      url: 'https://archive.apache.org/maven.tar.gz',
    },
    executables: [{ name: 'mvn', path: 'bin/mvn' }],
    dependencies: ['java'],
    environmentVariables: {},
    verification: {
      preset: 'maven' as const,
      versionCommand: { argv: ['mvn', '--version'], expected: '3.9.11' },
      script: '',
      files: [],
    },
  },
  imageDigest: `sha256:${'e'.repeat(64)}`,
  imageSizeBytes: 100 * 1024 * 1024,
};

const mavenTool = {
  ...javaTool,
  toolId: 'maven',
  name: 'Apache Maven',
  description: 'Maven build tool',
  category: 'build-tool',
  publisher: 'Apache Software Foundation',
  recommendedVersionId: mavenVersion.versionId,
  versions: [mavenVersion],
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
  imageSizeBytes: null,
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
  schemaVersion: 1 as const,
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
  buildTools: {},
  aptPackages: [],
  environmentVariables: {},
  buildCommands: [],
};

const standardRevision = {
  ...revision,
  environmentId: 'standard',
  revisionId: 'core-1',
  status: 'PUBLISHED',
  imageSizeBytes: 900 * 1024 * 1024,
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
    listTools.mockResolvedValue([javaTool]);
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
    await user.click(await screen.findByRole('tab', { name: /Revisions/ }));
    await user.click(await screen.findByRole('button', { name: 'Details and evidence' }));
    await user.click(await screen.findByRole('button', { name: 'Generated Dockerfile' }));
    expect(screen.getByText(/FROM core@sha256:abc/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Build' }));
    expect(build).toHaveBeenCalledWith('custom', 'r-1');
  });

  it('preserves unsaved definition changes while revision actions refresh', async () => {
    const user = userEvent.setup();
    render(<EnvironmentsTab />);

    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Unsaved custom name');
    await user.click(screen.getByRole('tab', { name: /Revisions/ }));
    await user.click(screen.getByRole('button', { name: 'Build' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Build' })).not.toBeDisabled());
    await user.click(screen.getByRole('tab', { name: /Definition/ }));

    expect(screen.getByLabelText('Name')).toHaveValue('Unsaved custom name');
  });

  it('offers a latest-base rebuild instead of retrying a stale failed revision', async () => {
    const user = userEvent.setup();
    const outdated = {
      ...custom,
      status: 'FAILED',
      updateAvailable: true,
    };
    const failedRevision = {
      ...revision,
      status: 'FAILED',
      failure: {
        reason: 'image_build_failed',
        detail: 'Base image is unavailable',
        failedAt: '2026-08-12T11:17:13.000Z',
      },
    };
    list.mockResolvedValue([outdated, standard]);
    get.mockImplementation(async (environmentId: string) =>
      environmentId === 'standard'
        ? standardDetail
        : {
            environment: outdated,
            revisions: [failedRevision],
            publishedRevision: null,
          },
    );
    rebuild.mockResolvedValue({
      environment: { ...outdated, status: 'BUILDING', updateAvailable: false },
      revision: { ...revision, revisionId: 'r-new', status: 'BUILDING' },
    });

    render(<EnvironmentsTab />);

    const rebuildButton = await screen.findByRole('button', {
      name: 'Rebuild on latest base',
    });
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    await user.click(rebuildButton);
    expect(rebuild).toHaveBeenCalledWith('custom');
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
    await screen.findByText('Environment details');
    await user.click(screen.getByRole('button', { name: 'New environment' }));
    await user.type(screen.getByLabelText('Name'), 'Generated Name');
    await user.click(screen.getByRole('button', { name: 'Create draft' }));

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Generated Name',
        baseEnvironmentId: 'standard',
      }),
    );
    expect(await screen.findAllByText('generated-name')).toHaveLength(2);
    expect(get).toHaveBeenCalledWith('generated-name');
  });

  it('validates generated IDs before sending a create request', async () => {
    const user = userEvent.setup();
    render(<EnvironmentsTab />);

    await screen.findByText('Environment details');
    await user.click(screen.getByRole('button', { name: 'New environment' }));
    await user.type(screen.getByLabelText('Name'), '123 build');

    expect(
      screen.getByText('The environment ID must start with a letter and contain 2–63 characters.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create draft' })).toBeDisabled();

    await user.type(screen.getByLabelText(/Environment ID/), 'build-123');

    expect(
      screen.queryByText(
        'The environment ID must start with a letter and contain 2–63 characters.',
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create draft' })).toBeEnabled();
  });

  it('shows inherited and platform versions without archive configuration inputs', async () => {
    const user = userEvent.setup();
    create.mockResolvedValue({
      environment: custom,
      revision,
    });

    render(<EnvironmentsTab />);
    await screen.findByText('Environment details');
    await user.click(screen.getByRole('button', { name: 'New environment' }));

    expect(screen.getByText('Choose the base, tools, and optional settings.')).toBeInTheDocument();
    expect(screen.getByText('Publish')).toBeInTheDocument();
    expect(await screen.findByText('Node.js 24.15.0')).toBeInTheDocument();
    expect(screen.getByText('Python 3.11')).toBeInTheDocument();
    expect(screen.getByText('Eclipse Temurin 21.0.8')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Node.js version' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Java version' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Java archive URL')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Java checksum')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add Java JDK' }));
    await user.type(screen.getByLabelText('Name'), 'Java Custom');
    await user.click(screen.getByRole('button', { name: 'Create draft' }));

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        recipe: expect.objectContaining({
          schemaVersion: 2,
          toolVersionIds: [javaVersion.versionId],
        }),
      }),
    );
  });

  it('shows automatically included dependencies and counts them in projected size', async () => {
    const user = userEvent.setup();
    listTools.mockResolvedValue([javaTool, mavenTool]);

    render(<EnvironmentsTab />);
    await screen.findByText('Environment details');
    await user.click(screen.getByRole('button', { name: 'New environment' }));
    await user.click(screen.getByRole('button', { name: 'Add Apache Maven' }));

    expect(await screen.findByText('Added automatically for Apache Maven')).toBeInTheDocument();
    expect(screen.getByText('Required')).toBeInTheDocument();
    expect(screen.getByText('1200 / 2048 MiB')).toBeInTheDocument();
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
    render(<EnvironmentsTab />);

    expect(await screen.findByText('Built successfully')).toBeInTheDocument();
    expect(screen.getByText('1 Critical · 2 High')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /CVE-2026-42010/ })).toHaveAttribute(
      'href',
      'https://example.test/CVE-2026-42010',
    );
    expect(screen.getByText('gnutls28 3.7.9-2+deb12u6')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review findings' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'Accept 1 Critical and 2 High security findings',
    );
    await user.click(screen.getByRole('button', { name: 'Accept and continue' }));
    expect(acceptFindings).toHaveBeenCalledWith('custom', 'r-1');
  });

  it('shows live lifecycle progress with CodeBuild and ECR links', async () => {
    const buildingEnvironment = {
      ...custom,
      status: 'SCANNING',
    };
    const scanningRevision = {
      ...revision,
      status: 'SCANNING',
      imageUri: '123456789012.dkr.ecr.eu-west-1.amazonaws.com/managed-environments',
      imageDigest: `sha256:${'f'.repeat(64)}`,
      buildLogUrl:
        'https://console.aws.amazon.com/codesuite/codebuild/projects/environments/build/1',
    };
    list.mockResolvedValue([buildingEnvironment, standard]);
    get.mockImplementation(async (environmentId: string) =>
      environmentId === 'standard'
        ? standardDetail
        : {
            environment: buildingEnvironment,
            revisions: [scanningRevision],
            publishedRevision: null,
          },
    );

    render(<EnvironmentsTab />);

    expect(await screen.findByRole('status')).toHaveTextContent(
      'ECR is inspecting its operating-system packages',
    );
    expect(screen.getByRole('link', { name: /CodeBuild logs/ })).toHaveAttribute(
      'href',
      scanningRevision.buildLogUrl,
    );
    expect(screen.getByRole('link', { name: /Open ECR/ })).toHaveAttribute(
      'href',
      'https://eu-west-1.console.aws.amazon.com/ecr/repositories/private/123456789012/managed-environments?region=eu-west-1',
    );
  });

  it('keeps protected environment revisions compact and shows READY checks as complete', async () => {
    const readyRevision = {
      ...standardRevision,
      revisionId: 'core-96-cde6f3fd0e12',
      status: 'READY' as const,
      imageDigest: `sha256:${'f'.repeat(64)}`,
      verification: { status: 'PASSED' },
    };
    const publishedRevision = {
      ...standardRevision,
      revisionId: 'core-95-5e8a3c490898',
    };
    const readyEnvironment = {
      ...standard,
      status: 'READY',
      currentRevisionId: readyRevision.revisionId,
      publishedRevisionId: publishedRevision.revisionId,
      updateAvailable: true,
    };
    list.mockResolvedValue([readyEnvironment]);
    get.mockResolvedValue({
      environment: readyEnvironment,
      revisions: [readyRevision, publishedRevision],
      publishedRevision,
    });

    render(<EnvironmentsTab />);

    expect(await screen.findByRole('combobox', { name: 'Revision' })).toBeInTheDocument();
    expect(screen.queryByText('Revision history')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Definition/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Check: complete')).toBeInTheDocument();
    expect(screen.getByLabelText('Verify: complete')).toBeInTheDocument();
    expect(screen.getByLabelText('Publish: current')).toBeInTheDocument();
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

    expect(await screen.findByText('Built successfully')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review findings' })).toBeInTheDocument();
    expect(screen.queryByText('critical_vulnerability_findings')).not.toBeInTheDocument();
  });

  it('keeps accepted security issues visible after publication', async () => {
    const user = userEvent.setup();
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

    expect(await screen.findByRole('button', { name: 'Details and evidence' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await user.click(screen.getByRole('button', { name: 'Details and evidence' }));
    expect(await screen.findByText('Findings accepted')).toBeInTheDocument();
    expect(screen.getByText(/Accepted by admin@example.com/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /CVE-2026-42010/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review findings' })).not.toBeInTheDocument();
  });

  it('builds advanced settings with structured rows', async () => {
    const user = userEvent.setup();
    create.mockResolvedValue({
      environment: custom,
      revision,
    });

    render(<EnvironmentsTab />);
    await screen.findByText('Environment details');
    await user.click(screen.getByRole('button', { name: 'New environment' }));
    await user.type(screen.getByLabelText('Name'), 'Native Build');
    await user.click(screen.getByRole('button', { name: /Advanced settings/ }));
    await user.click(screen.getByRole('button', { name: 'Add package' }));
    await user.type(screen.getByLabelText('Package name 1'), 'libssl-dev');
    await user.type(screen.getByLabelText('Package version 1'), '3.0.17-1~deb12u2');
    await user.click(screen.getByRole('button', { name: 'Add variable' }));
    await user.type(screen.getByLabelText('Variable name 1'), 'BUILD_MODE');
    await user.type(screen.getByLabelText('Variable value 1'), 'release');
    await user.click(screen.getByRole('button', { name: 'Create draft' }));

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        recipe: expect.objectContaining({
          aptPackages: [{ name: 'libssl-dev', version: '3.0.17-1~deb12u2' }],
          environmentVariables: { BUILD_MODE: 'release' },
        }),
      }),
    );
  });

  it('points a read-only fixed-tool environment at an action the UI actually offers', async () => {
    const fixedToolRevision = {
      ...revision,
      status: 'PUBLISHED',
      recipe: standardRecipe,
      flattenedRecipe: standardRecipe,
    };
    get.mockImplementation(async (environmentId: string) =>
      environmentId === 'standard'
        ? standardDetail
        : {
            environment: { ...custom, status: 'PUBLISHED', publishedRevisionId: 'r-1' },
            revisions: [fixedToolRevision],
            publishedRevision: fixedToolRevision,
          },
    );

    render(<EnvironmentsTab />);

    expect(await screen.findByText(/This fixed-tool environment is read-only/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retire' })).toBeInTheDocument();
    expect(screen.queryByText(/Reset/)).not.toBeInTheDocument();
  });
});
