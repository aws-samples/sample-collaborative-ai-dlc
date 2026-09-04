import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

    await user.click(await screen.findByRole('button', { name: 'Add Tool' }));
    await user.type(screen.getByLabelText('Name'), '.NET SDK');
    await user.type(screen.getByLabelText('Publisher'), 'Microsoft');
    await user.type(screen.getByLabelText('Exact version'), '8.0.408');
    await user.click(screen.getByLabelText('Verification'));
    await user.click(await screen.findByRole('option', { name: 'dotnet' }));
    await user.type(
      screen.getByLabelText('Official ARM64 archive'),
      'https://download.visualstudio.microsoft.com/dotnet-sdk-8.0.408-linux-arm64.tar.gz',
    );
    await user.click(screen.getByRole('button', { name: 'Create and Build' }));

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

  it('uses the sandboxed vendor installer and native compiler prerequisite for Rust', async () => {
    const user = userEvent.setup();
    render(<ToolsRegistry />);

    await user.click(await screen.findByRole('button', { name: 'Add Tool' }));
    await user.type(screen.getByLabelText('Name'), 'Rust Toolchain');
    await user.type(screen.getByLabelText('Exact version'), '1.89.0');
    await user.click(screen.getByLabelText('Verification'));
    await user.click(await screen.findByRole('option', { name: 'rust' }));
    await user.type(
      screen.getByLabelText('Official ARM64 archive'),
      'https://static.rust-lang.org/dist/rust-1.89.0-aarch64-unknown-linux-gnu.tar.gz',
    );
    await user.click(screen.getByRole('button', { name: 'Create and Build' }));

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
    await user.click(screen.getByRole('button', { name: 'Save and Build' }));

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

    await user.click(await screen.findByRole('button', { name: 'Recommend' }));
    expect(recommend).toHaveBeenCalledWith('go', 'tv-go-1');
  });

  it('requires explicit acceptance when ECR cannot scan a tool artifact', async () => {
    const user = userEvent.setup();
    const unsupportedVersion = {
      ...publishedVersion,
      status: 'SECURITY_REVIEW' as const,
      scanFindings: {
        status: 'UNSUPPORTED',
        description:
          'UnsupportedImageError: The operating system and/or package manager are not supported.',
        severityCounts: {},
        findings: [],
      },
    };
    list.mockResolvedValue([{ ...goTool, versions: [unsupportedVersion] }]);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<ToolsRegistry />);

    expect(await screen.findByText('ECR scan unavailable')).toBeInTheDocument();
    expect(
      screen.getByText(
        'UnsupportedImageError: The operating system and/or package manager are not supported.',
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept Scan Limitation' }));

    expect(confirm).toHaveBeenCalledWith(
      'ECR could not scan this artifact. Accept the scan limitation and continue verification?',
    );
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

    expect(await screen.findByText('ECR scan limitation accepted')).toBeInTheDocument();
    expect(
      screen.queryByText(
        'UnsupportedImageError: The operating system and/or package manager are not supported.',
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Security scan limitation accepted by admin@example.com/),
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
