import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const list = vi.fn();
const create = vi.fn();
const createVersion = vi.fn();
const updateVersion = vi.fn();
const build = vi.fn();
const retry = vi.fn();
const acceptFindings = vi.fn();
const recommend = vi.fn();

vi.mock('@/services/environments', () => ({
  toolsService: {
    list: (...args: unknown[]) => list(...args),
    create: (...args: unknown[]) => create(...args),
    createVersion: (...args: unknown[]) => createVersion(...args),
    updateVersion: (...args: unknown[]) => updateVersion(...args),
    build: (...args: unknown[]) => build(...args),
    retry: (...args: unknown[]) => retry(...args),
    acceptFindings: (...args: unknown[]) => acceptFindings(...args),
    publish: vi.fn(),
    recommend: (...args: unknown[]) => recommend(...args),
  },
}));

import { ToolsRegistry } from './ToolsRegistry';
import { ApiError } from '@/services/api';

const publishedVersion = {
  toolId: 'go',
  versionId: 'tv-go-1',
  status: 'PUBLISHED' as const,
  definition: {
    schemaVersion: 1 as const,
    version: '1.24.6',
    source: { type: 'https' as const, url: 'https://go.dev/dl/go1.24.6.linux-arm64.tar.gz' },
    installer: { mode: 'generated' as const, stripComponents: 1 },
    executables: [{ name: 'go', path: 'bin/go' }],
    dependencies: [],
    aptPackages: [],
    environmentVariables: { GOROOT: '${TOOL_ROOT}' },
    verification: {
      preset: 'go' as const,
      versionCommand: { argv: ['go', 'version'], expected: 'go1.24.6' },
      script: '',
      files: [],
    },
  },
  system: true,
  autoBuild: false,
  buildAttempt: 1,
  imageUri: 'registry/tools',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  imageSizeBytes: 100,
  source: {
    requestedUrl: 'https://go.dev/dl/go1.24.6.linux-arm64.tar.gz',
    resolvedUrl: 'https://go.dev/dl/go1.24.6.linux-arm64.tar.gz',
    sha256: 'b'.repeat(64),
    sizeBytes: 100,
    trustLevel: 'PUBLISHER_VERIFIED' as const,
  },
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
  publishedAt: '2026-08-13T00:00:00.000Z',
};

const goTool = {
  toolId: 'go',
  name: 'Go SDK',
  description: 'Go toolchain',
  category: 'language-sdk',
  publisher: 'The Go project',
  system: true,
  recommendedVersionId: null,
  versions: [publishedVersion],
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
};

describe('ToolsRegistry', () => {
  beforeAll(() => {
    Object.defineProperties(Element.prototype, {
      hasPointerCapture: { configurable: true, value: () => false },
      setPointerCapture: { configurable: true, value: () => undefined },
      releasePointerCapture: { configurable: true, value: () => undefined },
      scrollIntoView: { configurable: true, value: () => undefined },
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue([]);
    create.mockImplementation(async (input: { name: string }) => ({
      toolId: input.name === '.NET SDK' ? 'dotnet-sdk' : 'rust-toolchain',
      name: input.name,
      description: '',
      category: 'language-sdk',
      publisher: input.name === '.NET SDK' ? 'Microsoft' : '',
      system: false,
      recommendedVersionId: null,
      versions: [],
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    }));
    createVersion.mockImplementation(async (toolId: string) => ({
      tool: { toolId },
      version: {
        toolId,
        versionId: toolId === 'dotnet-sdk' ? 'tv-dotnet-8' : 'tv-rust-1',
        status: 'DRAFT',
      },
    }));
    build.mockResolvedValue({});
    retry.mockResolvedValue({});
    acceptFindings.mockResolvedValue({});
    updateVersion.mockResolvedValue({
      tool: { toolId: 'go' },
      version: { ...publishedVersion, status: 'FAILED' },
    });
  });

  it('creates and builds a .NET SDK version from the verification preset', async () => {
    const user = userEvent.setup();
    render(<ToolsRegistry />);

    await user.click(await screen.findByRole('button', { name: 'New tool family' }));
    await user.type(screen.getByLabelText('Name'), '.NET SDK');
    await user.type(screen.getByLabelText('Publisher'), 'Microsoft');
    await user.type(screen.getByLabelText('Exact version'), '8.0.408');
    await user.click(screen.getByLabelText('Tool type'));
    await user.click(await screen.findByRole('option', { name: '.NET SDK' }));
    await user.type(
      screen.getByLabelText('Linux ARM64 download URL'),
      'https://download.visualstudio.microsoft.com/dotnet-sdk-8.0.408-linux-arm64.tar.gz',
    );
    await user.click(screen.getByRole('button', { name: 'Create and start build' }));

    expect(create).toHaveBeenCalledWith({
      name: '.NET SDK',
      description: '',
      category: 'language-sdk',
      publisher: 'Microsoft',
    });
    expect(createVersion).toHaveBeenCalledWith(
      'dotnet-sdk',
      expect.objectContaining({
        version: '8.0.408',
        source: expect.objectContaining({
          url: 'https://download.visualstudio.microsoft.com/dotnet-sdk-8.0.408-linux-arm64.tar.gz',
        }),
        installer: { mode: 'generated', stripComponents: 0 },
        executables: [{ name: 'dotnet', path: 'dotnet' }],
        environmentVariables: { DOTNET_ROOT: '${TOOL_ROOT}' },
        verification: {
          preset: 'dotnet',
          versionCommand: { argv: ['dotnet', '--version'], expected: '8.0.408' },
          script: '',
          files: [],
        },
      }),
    );
    expect(build).toHaveBeenCalledWith('dotnet-sdk', 'tv-dotnet-8');
  });

  it('adds Amazon Corretto as a Java distribution in the existing tool family', async () => {
    const user = userEvent.setup();
    const temurinVersion = {
      ...publishedVersion,
      toolId: 'java',
      versionId: 'tv-java-temurin',
      definition: {
        ...publishedVersion.definition,
        version: '21.0.8',
        distribution: 'Eclipse Temurin',
        publisher: 'Eclipse Adoptium',
        executables: [
          { name: 'java', path: 'bin/java' },
          { name: 'javac', path: 'bin/javac' },
        ],
        environmentVariables: { JAVA_HOME: '${TOOL_ROOT}' },
        verification: {
          preset: 'java' as const,
          versionCommand: { argv: ['java', '-version'], expected: '21.0.8' },
          script: '',
          files: [],
        },
      },
    };
    const javaTool = {
      ...goTool,
      toolId: 'java',
      name: 'Java JDK',
      publisher: 'Eclipse Temurin',
      recommendedVersionId: temurinVersion.versionId,
      versions: [temurinVersion],
    };
    list.mockResolvedValue([javaTool]);
    createVersion.mockResolvedValue({
      tool: javaTool,
      version: { ...temurinVersion, versionId: 'tv-java-corretto', status: 'DRAFT' },
    });

    render(<ToolsRegistry />);

    await user.click(await screen.findByRole('button', { name: 'Add distribution or version' }));
    expect(screen.getByText(/Java JDK settings are applied automatically/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Tool type')).not.toBeInTheDocument();
    expect(screen.getByText('Recommend')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Distribution'));
    await user.type(screen.getByLabelText('Distribution'), 'Amazon Corretto');
    await user.clear(screen.getByLabelText('Publisher'));
    await user.type(screen.getByLabelText('Publisher'), 'Amazon Web Services');
    await user.type(screen.getByLabelText('Exact version'), '21.0.8.9.1');
    await user.type(
      screen.getByLabelText('Linux ARM64 download URL'),
      'https://corretto.aws/downloads/resources/21.0.8.9.1/amazon-corretto-21.0.8.9.1-linux-aarch64.tar.gz',
    );
    await user.click(screen.getByRole('button', { name: 'Create and start build' }));

    expect(createVersion).toHaveBeenCalledWith(
      'java',
      expect.objectContaining({
        version: '21.0.8.9.1',
        distribution: 'Amazon Corretto',
        publisher: 'Amazon Web Services',
        verification: expect.objectContaining({ preset: 'java' }),
      }),
    );
    expect(build).toHaveBeenCalledWith('java', 'tv-java-corretto');
  });

  it('does not mistake JavaScript tool families for Java JDKs', async () => {
    const user = userEvent.setup();
    list.mockResolvedValue([
      {
        ...goTool,
        toolId: 'javascript-cli',
        name: 'JavaScript CLI',
        recommendedVersionId: null,
        versions: [],
      },
    ]);

    render(<ToolsRegistry />);

    await user.click(await screen.findByRole('button', { name: 'Add distribution or version' }));
    expect(screen.getByText(/Other CLI settings are applied automatically/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Tool type')).not.toBeInTheDocument();
  });

  it('shows field-level API validation instead of a generic definition error', async () => {
    const user = userEvent.setup();
    list.mockResolvedValue([goTool]);
    createVersion.mockRejectedValue(
      new ApiError(400, 'Invalid tool version definition', {
        issues: [
          {
            path: 'executables.0.path',
            message: 'executable path must stay inside the tool',
          },
        ],
      }),
    );

    render(<ToolsRegistry />);

    await user.click(await screen.findByRole('button', { name: 'Add distribution or version' }));
    await user.type(screen.getByLabelText('Exact version'), '1.25.0');
    await user.type(
      screen.getByLabelText('Linux ARM64 download URL'),
      'https://go.dev/dl/go1.25.0.linux-arm64.tar.gz',
    );
    await user.click(screen.getByRole('button', { name: 'Create and start build' }));

    expect(await screen.findByText(/Check these fields/)).toBeInTheDocument();
    expect(
      screen.getByText(/Executables: executable path must stay inside the tool/),
    ).toBeInTheDocument();
  });

  it('shows live build progress and the CodeBuild link in the lifecycle', async () => {
    const buildingVersion = {
      ...publishedVersion,
      status: 'BUILDING' as const,
      source: null,
      imageUri: null,
      imageDigest: null,
      imageSizeBytes: null,
      buildLogUrl: 'https://console.aws.amazon.com/codesuite/codebuild/builds/example',
      verification: null,
    };
    list.mockResolvedValue([{ ...goTool, versions: [buildingVersion] }]);

    render(<ToolsRegistry />);

    expect(await screen.findByText(/CodeBuild is downloading the source/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /CodeBuild logs/ })).toHaveAttribute(
      'href',
      buildingVersion.buildLogUrl,
    );
    expect(screen.getByText('Check')).toBeInTheDocument();
    expect(screen.getByText('Recommend')).toBeInTheDocument();
  });

  it('uses the sandboxed vendor installer and native compiler prerequisite for Rust', async () => {
    const user = userEvent.setup();
    render(<ToolsRegistry />);

    await user.click(await screen.findByRole('button', { name: 'New tool family' }));
    await user.type(screen.getByLabelText('Name'), 'Rust Toolchain');
    await user.type(screen.getByLabelText('Exact version'), '1.89.0');
    await user.click(screen.getByLabelText('Tool type'));
    await user.click(await screen.findByRole('option', { name: 'Rust toolchain' }));
    await user.type(
      screen.getByLabelText('Linux ARM64 download URL'),
      'https://static.rust-lang.org/dist/rust-1.89.0-aarch64-unknown-linux-gnu.tar.gz',
    );
    await user.click(screen.getByRole('button', { name: 'Create and start build' }));

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ category: 'language-sdk' }));
    expect(createVersion).toHaveBeenCalledWith(
      'rust-toolchain',
      expect.objectContaining({
        installer: expect.objectContaining({
          mode: 'script',
          script: expect.stringContaining('--disable-ldconfig'),
        }),
        aptPackages: [{ name: 'build-essential', version: '12.9' }],
        verification: expect.objectContaining({ preset: 'rust' }),
      }),
    );
  });

  it('edits and retries a failed tool version without creating a duplicate', async () => {
    const user = userEvent.setup();
    const failedVersion = {
      ...publishedVersion,
      status: 'FAILED' as const,
      failure: { reason: 'installer_failed', detail: 'archive layout changed' },
    };
    const failedTool = { ...goTool, versions: [failedVersion] };
    list.mockResolvedValue([failedTool]);
    updateVersion.mockResolvedValue({
      tool: failedTool,
      version: failedVersion,
    });

    render(<ToolsRegistry />);

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Exact version')).toBeDisabled();
    await user.clear(screen.getByLabelText('Root folders to remove'));
    await user.type(screen.getByLabelText('Root folders to remove'), '0');
    await user.click(screen.getByRole('button', { name: 'Save and rebuild' }));

    expect(create).not.toHaveBeenCalled();
    expect(createVersion).not.toHaveBeenCalled();
    expect(updateVersion).toHaveBeenCalledWith(
      'go',
      'tv-go-1',
      expect.objectContaining({
        version: '1.24.6',
        installer: { mode: 'generated', stripComponents: 0 },
      }),
    );
    expect(retry).toHaveBeenCalledWith('go', 'tv-go-1');
  });

  it('lets an administrator explicitly recommend a published version', async () => {
    const user = userEvent.setup();
    list.mockResolvedValue([goTool]);
    recommend.mockResolvedValue({ tool: { ...goTool, recommendedVersionId: 'tv-go-1' } });

    render(<ToolsRegistry />);

    expect(await screen.findByRole('button', { name: 'Details and evidence' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByText('Download complete')).not.toBeInTheDocument();
    expect(screen.queryByText(/Recommendations are replaced/)).not.toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Make recommended' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Make recommended',
      }),
    );
    expect(recommend).toHaveBeenCalledWith('go', 'tv-go-1');
  });

  it('replaces an existing recommendation without requiring a removal step', async () => {
    const user = userEvent.setup();
    const current = {
      ...publishedVersion,
      versionId: 'tv-java-temurin',
      definition: {
        ...publishedVersion.definition,
        distribution: 'Eclipse Temurin',
        version: '21.0.8',
      },
    };
    const candidate = {
      ...publishedVersion,
      versionId: 'tv-java-corretto',
      definition: {
        ...publishedVersion.definition,
        distribution: 'Amazon Corretto',
        publisher: 'Amazon Web Services',
        version: '21.0.8.9.1',
      },
    };
    const javaTool = {
      ...goTool,
      toolId: 'java',
      name: 'Java JDK',
      recommendedVersionId: current.versionId,
      versions: [candidate, current],
    };
    list.mockResolvedValue([javaTool]);
    recommend.mockResolvedValue({
      tool: { ...javaTool, recommendedVersionId: candidate.versionId },
    });

    render(<ToolsRegistry />);

    await user.click(await screen.findByRole('button', { name: 'Replace recommendation' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Replace Eclipse Temurin as recommended?');
    await user.click(
      within(dialog).getByRole('button', {
        name: 'Replace recommendation',
      }),
    );

    expect(recommend).toHaveBeenCalledWith('java', 'tv-java-corretto');
  });

  it('requires explicit acceptance when ECR cannot scan a tool artifact', async () => {
    const user = userEvent.setup();
    const unsupportedVersion = {
      ...publishedVersion,
      status: 'SECURITY_REVIEW' as const,
      imageUri: '123456789012.dkr.ecr.eu-west-1.amazonaws.com/managed-tools',
      scanFindings: {
        status: 'UNSUPPORTED',
        description:
          'UnsupportedImageError: The operating system and/or package manager are not supported.',
        severityCounts: {},
        findings: [],
      },
    };
    list.mockResolvedValue([{ ...goTool, versions: [unsupportedVersion] }]);
    render(<ToolsRegistry />);

    expect(await screen.findAllByText('Scan unavailable')).toHaveLength(2);
    expect(
      screen.getByText(/This is a scan limitation, not a detected vulnerability/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open ECR/ })).toHaveAttribute(
      'href',
      'https://eu-west-1.console.aws.amazon.com/ecr/repositories/private/123456789012/managed-tools?region=eu-west-1',
    );
    await user.click(screen.getByRole('button', { name: 'Continue without scan' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'This does not mean a vulnerability was found',
    );
    await user.click(screen.getByRole('button', { name: 'Continue after review' }));
    expect(acceptFindings).toHaveBeenCalledWith('go', 'tv-go-1');
  });

  it('shows an accepted ECR scan limitation as resolved evidence', async () => {
    const acceptedVersion = {
      ...publishedVersion,
      scanFindings: {
        status: 'UNSUPPORTED',
        description:
          'UnsupportedImageError: The operating system and/or package manager are not supported.',
        severityCounts: {},
        findings: [],
      },
      verification: {
        status: 'PASSED',
        securityScan: 'ACCEPTED',
        runtimeCompatibilityVersion: '1',
      },
      securityFindingsAcceptedAt: '2026-08-14T11:23:28.161Z',
      securityFindingsAcceptedBy: 'admin@example.com',
    };
    list.mockResolvedValue([{ ...goTool, versions: [acceptedVersion] }]);

    render(<ToolsRegistry />);

    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Details and evidence',
      }),
    );
    expect(
      await screen.findByText('Automated package scan was unavailable and reviewed.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        'UnsupportedImageError: The operating system and/or package manager are not supported.',
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Automated scan limitation reviewed by admin@example.com/),
    ).toBeInTheDocument();
  });

  it('shows dependent drafts as pending until the dependency is recommended', async () => {
    const mavenVersion = {
      ...publishedVersion,
      toolId: 'maven',
      versionId: 'tv-maven-3',
      status: 'DRAFT' as const,
      definition: {
        ...publishedVersion.definition,
        version: '3.9.11',
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
    };
    const mavenTool = {
      ...goTool,
      toolId: 'maven',
      name: 'Apache Maven',
      recommendedVersionId: null,
      versions: [mavenVersion],
    };
    const javaTool = {
      ...goTool,
      toolId: 'java',
      name: 'Java JDK',
      recommendedVersionId: null,
      versions: [],
    };
    list.mockResolvedValue([mavenTool, javaTool]);

    render(<ToolsRegistry />);

    expect(
      await screen.findByText('Publish and recommend Java JDK before building this version.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Build' })).toBeDisabled();
  });
});
