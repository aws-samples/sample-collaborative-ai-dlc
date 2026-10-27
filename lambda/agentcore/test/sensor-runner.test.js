import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSensorRunner, __test } from '../sensor-runner.js';
import { sensorGateFindings } from '../../shared/gate-preconditions.js';
import {
  knownChangedFileProvenance,
  unknownChangedFileProvenance,
} from '../../shared/changed-file-provenance.js';

const {
  globToRegExp,
  resultFromScript,
  scopeToChangedFiles,
  expandToAffectedProjects,
  tailDiagnostic,
  summarizeFileResults,
  redactCredentialText,
  sensitiveEnvironmentValues,
} = __test;

describe('globToRegExp', () => {
  it('matches a brace-alternation code glob', () => {
    const re = globToRegExp('**/*.{ts,tsx}');
    expect(re.test('src/a.ts')).toBe(true);
    expect(re.test('src/a.tsx')).toBe(true);
    expect(re.test('src/a.js')).toBe(false);
  });
  it('matches an aidlc-docs path glob', () => {
    const re = globToRegExp('**/aidlc-docs/**');
    expect(re.test('aidlc-docs/x/y.md')).toBe(true);
    expect(re.test('src/aidlc-docs/z.md')).toBe(true);
    expect(re.test('src/other.md')).toBe(false);
  });
});

describe('resultFromScript', () => {
  it('reads the stdout JSON pass field over the exit code', () => {
    expect(resultFromScript({ exitCode: 0, stdout: '{"pass":false}' }).result).toBe('FAIL');
    expect(resultFromScript({ exitCode: 0, stdout: '{"pass":true}' }).result).toBe('PASS');
  });

  const oversizedDiagnostic = 'x'.repeat(5_000);
  it.each([
    ['empty output', '', 'missing-verdict'],
    ['malformed JSON', `{"diagnostic":"${oversizedDiagnostic}`, 'invalid-verdict'],
    [
      'schema-invalid JSON',
      JSON.stringify({ pass: 'PASS', diagnostic: oversizedDiagnostic }),
      'invalid-verdict',
    ],
    [
      'unsupported verdict',
      JSON.stringify({ verdict: 'SKIP', diagnostic: oversizedDiagnostic }),
      'invalid-verdict',
    ],
  ])('keeps successful stdout-json %s bounded and INCONCLUSIVE', (_label, stdout, reason) => {
    const outcome = resultFromScript({
      exitCode: 0,
      stdout,
      stderr: 'protocol failure',
      verdictMode: 'stdout-json',
    });

    expect(outcome).toMatchObject({
      result: 'INCONCLUSIVE',
      detail: { reason, exitCode: 0, stderr: 'protocol failure' },
    });
    expect(Buffer.byteLength(JSON.stringify(outcome.detail), 'utf8')).toBeLessThanOrEqual(1_200);
    expect(outcome.detail.stdout === null || outcome.detail.stdout.length <= 501).toBe(true);
  });

  it.each([
    ['missing pass', '{}'],
    ['non-boolean pass', '{"pass":"PASS"}'],
    ['trailing output', '{"pass":true}\nunexpected output'],
  ])('rejects successful stdout-json with %s', (_label, stdout) => {
    expect(resultFromScript({ exitCode: 0, stdout, verdictMode: 'stdout-json' })).toMatchObject({
      result: 'INCONCLUSIVE',
      detail: { reason: 'invalid-verdict' },
    });
  });

  it('accepts only boolean pass verdicts in strict stdout-json mode', () => {
    expect(
      resultFromScript({
        exitCode: 0,
        stdout: '{"pass":true,"findings_count":0}',
        verdictMode: 'stdout-json',
      }),
    ).toEqual({
      result: 'PASS',
      detail: { pass: true, findings_count: 0 },
    });
    expect(
      resultFromScript({
        exitCode: 0,
        stdout: '{"pass":false,"findings_count":1}',
        verdictMode: 'stdout-json',
      }),
    ).toEqual({
      result: 'FAIL',
      detail: { pass: false, findings_count: 1 },
    });
  });

  it('bounds invalid stdout-json protocol diagnostics', () => {
    const stdout = `not-json-${'x'.repeat(5_000)}`;
    const outcome = resultFromScript({
      exitCode: 0,
      stdout,
      verdictMode: 'stdout-json',
    });

    expect(outcome.result).toBe('INCONCLUSIVE');
    expect(outcome.detail.reason).toBe('invalid-verdict');
    expect(outcome.detail.stdout).toHaveLength(501);
    expect(outcome.detail.stdout).toBe(`…${stdout.slice(-500)}`);
  });

  it('falls back to the exit code without JSON', () => {
    expect(resultFromScript({ exitCode: 2, stdout: '' }).result).toBe('INCONCLUSIVE');
  });

  it('classifies tool-unavailable as diagnostic INCONCLUSIVE', () => {
    const outcome = resultFromScript({
      exitCode: 127,
      stdout: '',
      stderr: 'tsc-unavailable\n',
      verdictMode: 'stdout-json',
    });
    expect(outcome).toEqual({
      result: 'INCONCLUSIVE',
      detail: { reason: 'tool-unavailable', exitCode: 127, stderr: 'tsc-unavailable' },
    });
  });

  it('classifies a stdout-json harness failure as INCONCLUSIVE', () => {
    const outcome = resultFromScript({
      exitCode: 1,
      stdout: '',
      stderr: 'unable to load config',
      verdictMode: 'stdout-json',
    });
    expect(outcome.result).toBe('INCONCLUSIVE');
    expect(outcome.detail).toMatchObject({ reason: 'script-error', exitCode: 1 });
  });

  it('keeps classic non-zero-is-FAIL behavior for exit-code sensors', () => {
    expect(
      resultFromScript({ exitCode: 1, stdout: '', stderr: 'failure', verdictMode: 'exit-code' })
        .result,
    ).toBe('FAIL');
  });
});

describe('changed-file sensor scoping', () => {
  it('matches known workspace-relative paths exactly across repositories', () => {
    expect(
      scopeToChangedFiles(
        ['acme/api/src/index.ts', 'acme/web/src/index.ts'],
        knownChangedFileProvenance(['acme/api/src/index.ts']),
      ),
    ).toEqual(['acme/api/src/index.ts']);
  });

  it('distinguishes proven-empty provenance from an unknown Git failure', () => {
    const globbed = ['acme/api/src/index.ts', 'acme/web/src/index.ts'];
    expect(scopeToChangedFiles(globbed, knownChangedFileProvenance([]))).toEqual([]);
    expect(
      scopeToChangedFiles(
        globbed,
        unknownChangedFileProvenance('git_status_failed', 'fatal: status unavailable'),
      ),
    ).toEqual(globbed);
  });

  it('widens a changed provider to untouched files in the affected project', () => {
    expect(
      expandToAffectedProjects({
        globbed: [
          'packages/api/src/provider.ts',
          'packages/api/src/consumer.ts',
          'packages/web/src/page.ts',
        ],
        changed: ['packages/api/src/provider.ts'],
        allFiles: [
          'packages/api/tsconfig.json',
          'packages/api/src/provider.ts',
          'packages/api/src/consumer.ts',
          'packages/web/tsconfig.json',
          'packages/web/src/page.ts',
        ],
        configFile: 'tsconfig.json',
      }),
    ).toEqual(['packages/api/src/provider.ts', 'packages/api/src/consumer.ts']);
  });

  it('widens both projects when rename provenance crosses project boundaries', () => {
    const globbed = [
      'packages/api/src/api-consumer.ts',
      'packages/web/src/moved-provider.ts',
      'packages/web/src/web-consumer.ts',
      'packages/docs/src/docs.ts',
    ];
    const allFiles = [
      'packages/api/tsconfig.json',
      'packages/api/src/api-consumer.ts',
      'packages/web/tsconfig.json',
      'packages/web/src/moved-provider.ts',
      'packages/web/src/web-consumer.ts',
      'packages/docs/tsconfig.json',
      'packages/docs/src/docs.ts',
    ];

    expect(
      expandToAffectedProjects({
        globbed,
        changed: ['packages/api/src/original-provider.ts', 'packages/web/src/moved-provider.ts'],
        allFiles,
        configFile: 'tsconfig.json',
      }),
    ).toEqual([
      'packages/api/src/api-consumer.ts',
      'packages/web/src/moved-provider.ts',
      'packages/web/src/web-consumer.ts',
    ]);
  });
});

describe('sensor diagnostics', () => {
  it('retains the tail of long stderr', () => {
    expect(tailDiagnostic(`${'banner\n'.repeat(100)}actual error`)).toContain('actual error');
    expect(tailDiagnostic('')).toBeNull();
  });

  it('redacts every Authorization scheme, known sensitive environment values, and credential paths', () => {
    const sensitiveValues = sensitiveEnvironmentValues({
      MCP_SERVER_TOKEN: 'opaque-mcp-value',
      AWS_SHARED_CREDENTIALS_FILE: '/runtime/private/aws-credentials',
      GIT_ASKPASS: '/runtime/private/git-askpass.sh',
      TOKENIZERS_PARALLELISM: 'true',
      UNRELATED_STATE: 'keep-visible',
    });
    const raw = [
      'Authorization: Token scheme-secret-value',
      'Proxy-Authorization: Digest digest-secret-value',
      'tool echoed opaque-mcp-value',
      'credentials at /runtime/private/aws-credentials',
      'askpass at /runtime/private/git-askpass.sh',
      'fallback at /home/node/.aws/credentials',
      'ordinary true keep-visible',
    ].join('\n');

    const redacted = redactCredentialText(raw, sensitiveValues);

    expect(redacted).toContain('Authorization: [REDACTED]');
    expect(redacted).toContain('Proxy-Authorization: [REDACTED]');
    expect(redacted).toContain('tool echoed [REDACTED]');
    expect(redacted).toContain('credentials at [REDACTED]');
    expect(redacted).toContain('askpass at [REDACTED]');
    expect(redacted).toContain('fallback at [REDACTED]');
    expect(redacted).toContain('ordinary true keep-visible');
    for (const secret of [
      'scheme-secret-value',
      'digest-secret-value',
      'opaque-mcp-value',
      '/runtime/private/aws-credentials',
      '/runtime/private/git-askpass.sh',
      '/home/node/.aws/credentials',
    ]) {
      expect(redacted).not.toContain(secret);
    }
  });

  it('deduplicates only after known environment-derived values are redacted', () => {
    const sensitiveValues = sensitiveEnvironmentValues({
      PRIMARY_API_TOKEN: 'first-private-value',
      SECONDARY_API_TOKEN: 'second-private-value',
    });
    const detail = summarizeFileResults(
      [
        {
          file: 'src/a.ts',
          result: 'INCONCLUSIVE',
          detail: {
            reason: 'script-error',
            exitCode: 1,
            stderr: 'registry rejected first-private-value',
          },
        },
        {
          file: 'src/b.ts',
          result: 'INCONCLUSIVE',
          detail: {
            reason: 'script-error',
            exitCode: 1,
            stderr: 'registry rejected second-private-value',
          },
        },
      ],
      sensitiveValues,
    );

    expect(detail.harnessFailures).toEqual([
      expect.objectContaining({
        fileCount: 2,
        stderr: 'registry rejected [REDACTED]',
        sampleFiles: ['src/a.ts', 'src/b.ts'],
      }),
    ]);
    expect(JSON.stringify(detail)).not.toMatch(/first-private-value|second-private-value/);
  });

  it('deduplicates repeated harness failures with sample files', () => {
    const detail = summarizeFileResults(
      Array.from({ length: 20 }, (_, index) => ({
        file: `src/file-${index}.ts`,
        result: 'INCONCLUSIVE',
        timedOut: false,
        detail: { reason: 'script-error', exitCode: 1, stderr: 'same error' },
      })),
    );
    expect(detail.harnessFailures).toHaveLength(1);
    expect(detail.harnessFailures[0]).toMatchObject({ fileCount: 20, exitCode: 1 });
    expect(detail.harnessFailures[0].sampleFiles).toHaveLength(5);
  });

  it('bounds mixed high-cardinality details with exact omission counts and stable ordering', () => {
    const harnessEntries = Array.from({ length: 300 }, (_, index) => ({
      file: `packages/harness/src/file-${String(index).padStart(4, '0')}.ts`,
      result: 'INCONCLUSIVE',
      timedOut: false,
      detail: {
        reason: 'script-error',
        exitCode: 1,
        stderr: `harness-${index % 3}-${'h'.repeat(300)}`,
      },
    }));
    const fileEntries = Array.from({ length: 4_000 }, (_, index) => ({
      file: `packages/project-${index % 11}/src/file-${String(index).padStart(4, '0')}.ts`,
      result: 'FAIL',
      timedOut: false,
      detail: {
        pass: false,
        errors: [{ code: index, message: `diagnostic-${index}-${'d'.repeat(400)}` }],
      },
    }));
    const entries = [...harnessEntries, ...fileEntries];

    const detail = summarizeFileResults(entries);
    const repeated = summarizeFileResults(entries);
    const representedFiles =
      (detail.files?.length ?? 0) +
      (detail.harnessFailures?.reduce((total, failure) => total + failure.fileCount, 0) ?? 0);

    expect(Buffer.byteLength(JSON.stringify(detail), 'utf8')).toBeLessThanOrEqual(120_000);
    expect(detail.harnessFailures?.map((failure) => failure.stderr)).toEqual([
      `harness-0-${'h'.repeat(300)}`,
      `harness-1-${'h'.repeat(300)}`,
      `harness-2-${'h'.repeat(300)}`,
    ]);
    expect(detail.harnessFailures?.[0].sampleFiles).toEqual([
      'packages/harness/src/file-0000.ts',
      'packages/harness/src/file-0003.ts',
      'packages/harness/src/file-0006.ts',
      'packages/harness/src/file-0009.ts',
      'packages/harness/src/file-0012.ts',
    ]);
    expect(detail.files?.slice(0, 3).map((entry) => entry.file)).toEqual([
      'packages/project-0/src/file-0000.ts',
      'packages/project-1/src/file-0001.ts',
      'packages/project-2/src/file-0002.ts',
    ]);
    expect(detail.filesOmitted).toBeGreaterThan(0);
    expect(representedFiles + detail.filesOmitted).toBe(entries.length);
    expect(detail.omissionReason).toBe('detail size budget');
    expect(repeated).toEqual(detail);
  });

  it('processes high-cardinality details with one serialization per candidate before timeout', () => {
    const entries = Array.from({ length: 20_000 }, (_, index) => ({
      file: `packages/project-${index % 17}/src/file-${String(index).padStart(5, '0')}.ts`,
      result: 'FAIL',
      timedOut: false,
      detail: {
        pass: false,
        errors: [{ code: index, message: `diagnostic-${index}-${'x'.repeat(300)}` }],
      },
    }));
    const stringifySpy = vi.spyOn(JSON, 'stringify');
    let detail;
    let serializationCalls;
    let elapsedMs;

    try {
      const startedAt = performance.now();
      detail = summarizeFileResults(entries);
      elapsedMs = performance.now() - startedAt;
      serializationCalls = stringifySpy.mock.calls.length;
    } finally {
      stringifySpy.mockRestore();
    }

    expect(serializationCalls).toBe(entries.length);
    expect(elapsedMs).toBeLessThan(4_000);
    expect(Buffer.byteLength(JSON.stringify(detail), 'utf8')).toBeLessThanOrEqual(120_000);
    expect((detail.files?.length ?? 0) + detail.filesOmitted).toBe(entries.length);
  });

  // Without the authored contract nothing moves: an unpinned run and every
  // catalog that invokes its scripts directly keep the default mapping.
  it('keeps the default mapping for non-zero exits without the authored contract', () => {
    expect(
      resultFromScript({ exitCode: 127, stdout: '', stderr: 'eslint-unavailable' }),
    ).toMatchObject({
      result: 'INCONCLUSIVE',
      detail: { reason: 'tool-unavailable', exitCode: 127 },
    });
    expect(
      resultFromScript({ exitCode: 1, stdout: '', stderr: 'eslint-bad-output' }),
    ).toMatchObject({ result: 'FAIL', detail: { exitCode: 1 } });
  });

  // With it, the exits the release's own dispatcher documents are read the way
  // it reads them, and the reason reaches the record.
  it('passes exit 127 with the tool named when the contract is authored', () => {
    expect(
      resultFromScript({
        exitCode: 127,
        stdout: '',
        stderr: 'eslint-unavailable\n',
        dispatcherExitCodes: true,
      }),
    ).toMatchObject({
      result: 'PASS',
      detail: {
        toolUnavailable: true,
        exitCode: 127,
        reason: 'eslint is not available here, so the check did not run',
      },
    });
  });

  it('passes exit 127 with the missing config named when the contract is authored', () => {
    expect(
      resultFromScript({
        exitCode: 127,
        stdout: '',
        stderr: 'no-eslint-config\n',
        dispatcherExitCodes: true,
      }).detail.reason,
    ).toBe('no eslint configuration was found, so the check did not run');
  });

  it('reports a script error with its exit code and stderr', () => {
    expect(
      resultFromScript({
        exitCode: 1,
        stdout: '',
        stderr: 'eslint-bad-output\n',
        dispatcherExitCodes: true,
      }),
    ).toMatchObject({
      result: 'FAIL',
      detail: { scriptError: true, exitCode: 1, stderr: 'eslint-bad-output' },
    });
  });

  it('still reads a verdict the script printed on exit 0 under the contract', () => {
    expect(
      resultFromScript({ exitCode: 0, stdout: '{"pass":false}', dispatcherExitCodes: true }),
    ).toMatchObject({ result: 'FAIL', detail: { pass: false } });
  });

  // A timeout has no exit code to read, so the contract cannot apply and the
  // default mapping stands.
  it('leaves a timeout BLOCKED under the contract (no exit code to read)', () => {
    expect(
      resultFromScript({
        exitCode: null,
        stdout: '',
        stderr: '',
        dispatcherExitCodes: true,
      }),
    ).toMatchObject({ result: 'BLOCKED' });
  });
});

// A fake graph-writer returning canned artifact rows by type.
const fakeGraph = (byType) => ({
  lookupArtifacts: async ({ artifactType }) => byType[artifactType] ?? [],
});

describe('runStageSensors — graph kind', () => {
  it('passes required-sections when produced content has >= 2 H2s', async () => {
    const runner = createSensorRunner({
      graph: fakeGraph({ requirements: [{ id: 'r1', content: '## A\n## B\n' }] }),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'required-sections', severity: 'advisory' }],
      outputArtifacts: [{ artifact: 'requirements' }],
      stageId: 'requirements-analysis',
    });
    expect(verdicts[0]).toMatchObject({ kind: 'graph', result: 'PASS', held: false });
  });

  it('a blocking required-sections that fails marks the verdict held', async () => {
    const runner = createSensorRunner({
      graph: fakeGraph({ requirements: [{ id: 'r1', content: '## only one' }] }),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'required-sections', severity: 'blocking' }],
      outputArtifacts: [{ artifact: 'requirements' }],
      stageId: 's',
    });
    expect(verdicts[0]).toMatchObject({ result: 'FAIL', held: true });
  });

  it('upstream-coverage flags an unreferenced consume', async () => {
    const runner = createSensorRunner({
      graph: fakeGraph({ design: [{ id: 'd1', content: 'mentions requirements only' }] }),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'upstream-coverage', severity: 'advisory' }],
      outputArtifacts: [{ artifact: 'design' }],
      inputArtifacts: [{ artifact: 'requirements' }, { artifact: 'security-design' }],
      stageId: 's',
    });
    expect(verdicts[0].result).toBe('FAIL');
    expect(verdicts[0].detail.artifacts[0].unreferenced).toEqual(['security-design']);
  });

  it('upstream-coverage skips expectedAbsent consumes (no false FAIL in lean scopes)', async () => {
    // `unit-of-work` is never produced in this scope (producer out of scope) —
    // the output can't legitimately reference it, so it must not be threaded
    // into the coverage check. Only the present input counts.
    const runner = createSensorRunner({
      graph: fakeGraph({ design: [{ id: 'd1', content: 'derived from requirements' }] }),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'upstream-coverage', severity: 'advisory' }],
      outputArtifacts: [{ artifact: 'design' }],
      inputArtifacts: [
        { artifact: 'requirements', required: true },
        { artifact: 'unit-of-work', required: true, expectedAbsent: true },
      ],
      stageId: 's',
    });
    expect(verdicts[0].result).toBe('PASS');
  });

  it('graph-coverage runs intent-wide off getCoverage (not per produced artifact)', async () => {
    const runner = createSensorRunner({
      graph: {
        ...fakeGraph({}),
        getCoverage: async () => ({
          counts: { requirements: 1, stories: 1, mappings: 1, components: 0 },
          uncoveredRequirements: [],
          uncoveredMustHave: [{ slug: 'req-pay' }],
          unmappedStories: [],
          unknownReferences: [],
          componentCycles: [],
        }),
      },
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'graph-coverage', severity: 'advisory' }],
      // No produced artifacts needed — the report is intent-wide.
      outputArtifacts: [],
      stageId: 's',
    });
    expect(verdicts[0]).toMatchObject({ kind: 'graph', result: 'FAIL', held: false });
    expect(verdicts[0].detail.uncovered_must_have).toEqual(['req-pay']);
  });

  it('graph-coverage degrades to INCONCLUSIVE when the writer lacks getCoverage', async () => {
    const runner = createSensorRunner({
      graph: fakeGraph({}),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'graph-coverage', severity: 'advisory' }],
      outputArtifacts: [],
      stageId: 's',
    });
    expect(verdicts[0].result).toBe('INCONCLUSIVE');
  });

  it('INCONCLUSIVE when the stage produced no artifacts', async () => {
    const runner = createSensorRunner({
      graph: fakeGraph({}),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'required-sections', severity: 'advisory' }],
      outputArtifacts: [],
      stageId: 's',
    });
    expect(verdicts[0].result).toBe('INCONCLUSIVE');
  });
});

describe('runStageSensors — script kind', () => {
  let ws;
  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), 'sensor-ws-'));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  // A fake spawn that emits a JSON verdict on stdout and exits 0.
  const fakeSpawn =
    (stdout, code = 0) =>
    () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from(stdout));
        child.emit('close', code);
      }, 0);
      return child;
    };

  it('INCONCLUSIVE when no workspace file matches the glob', async () => {
    await writeFile(path.join(ws, 'README.md'), '# hi');
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'console.log("{}")',
      workspaceDir: ws,
      spawnFn: fakeSpawn('{"pass":true}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'advisory',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.{ts,js}',
          timeoutSeconds: 5,
        },
      ],
      stageId: 'code-generation',
    });
    expect(verdicts[0].result).toBe('INCONCLUSIVE');
    expect(verdicts[0].detail.reason).toBe('no files match');
  });

  it('holds a blocking sensor when a workspace directory cannot be read', async () => {
    const readError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'SENSOR_SCRIPT_BODY',
      workspaceDir: ws,
      changedFileProvenance: knownChangedFileProvenance(['src/a.ts']),
      fileListOptions: {
        readdirFn: async () => {
          throw readError;
        },
      },
    });

    const [verdict] = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'blocking',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
        },
      ],
      stageId: 'code-generation',
    });

    expect(verdict).toMatchObject({
      result: 'INCONCLUSIVE',
      applicability: 'UNKNOWN',
      held: true,
      detail: {
        reason: 'workspace enumeration incomplete',
        enumeration: {
          complete: false,
          scanned: 0,
          cap: 5000,
          reason: 'directory_read_failed',
          failures: [{ directory: '.', code: 'EACCES' }],
        },
      },
    });
  });

  it('holds a blocking sensor when the workspace walk reaches its file cap', async () => {
    await writeFile(path.join(ws, 'a.ts'), 'export const a = true;');
    await writeFile(path.join(ws, 'b.ts'), 'export const b = true;');
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'SENSOR_SCRIPT_BODY',
      workspaceDir: ws,
      changedFileProvenance: knownChangedFileProvenance(['missing.ts']),
      fileListOptions: { cap: 1 },
      spawnFn: () => {
        throw new Error('an incomplete selection must not spawn');
      },
    });

    const [verdict] = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'blocking',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
        },
      ],
      stageId: 'code-generation',
    });

    expect(verdict).toMatchObject({
      result: 'INCONCLUSIVE',
      applicability: 'UNKNOWN',
      held: true,
      detail: {
        reason: 'workspace enumeration incomplete',
        enumeration: {
          complete: false,
          scanned: 1,
          cap: 1,
          reason: 'file_limit_exceeded',
        },
      },
    });
  });

  it('spawns the materialized script per matching file and reads its verdict', async () => {
    await mkdir(path.join(ws, 'src'), { recursive: true });
    await writeFile(path.join(ws, 'src', 'a.ts'), 'export const x = 1;');
    let scriptWritten = '';
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => {
        scriptWritten = 'SENSOR_SCRIPT_BODY';
        return scriptWritten;
      },
      workspaceDir: ws,
      spawnFn: fakeSpawn('{"pass":true,"errorCount":0}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'blocking',
          runtime: 'bun',
          command: 'bun <runtime-managed>/tools/aidlc-sensor-linter.ts',
          matches: '**/*.{ts,js}',
          timeoutSeconds: 5,
        },
      ],
      stageId: 'code-generation',
    });
    expect(verdicts[0]).toMatchObject({ kind: 'script', result: 'PASS', held: false });
    expect(verdicts[0].detail.files[0].file).toBe('src/a.ts');
  });

  // PRODUCER → CONSUMER: the runner's own verdict, handed straight to the gate
  // evaluator that renders it for the human. A script sensor reports per file, so
  // the script's `reason` lives inside `detail.files[]` — a consumer reading only
  // the top level shows "Sensor linter (gate) → FAIL" with nothing else, which is
  // the whole decision the reviewer is being asked to make.
  it("hands the script's reason to the gate finding a reviewer reads", async () => {
    await mkdir(path.join(ws, 'src'), { recursive: true });
    await writeFile(path.join(ws, 'src', 'a.ts'), 'export const x = 1;');
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'SENSOR_SCRIPT_BODY',
      workspaceDir: ws,
      spawnFn: fakeSpawn('{"pass":false,"reason":"2 problems (2 errors, 0 warnings)"}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'blocking',
          runtime: 'bun',
          command: 'bun <runtime-managed>/tools/aidlc-sensor-linter.ts',
          matches: '**/*.{ts,js}',
          timeoutSeconds: 5,
        },
      ],
      stageId: 'code-generation',
    });
    expect(verdicts[0]).toMatchObject({ result: 'FAIL', held: true });
    expect(verdicts[0].detail.reason).toBeUndefined();

    const findings = sensorGateFindings({ sensorVerdicts: verdicts });
    expect(findings).toHaveLength(1);
    expect(findings[0].quote).toBe('src/a.ts: 2 problems (2 errors, 0 warnings)');
    expect(findings[0].detail.reason).toBe('src/a.ts: 2 problems (2 errors, 0 warnings)');
  });

  it('runs a blocking sensor across every match when changed-file provenance is unknown', async () => {
    await mkdir(path.join(ws, 'src'), { recursive: true });
    await writeFile(path.join(ws, 'src', 'a.ts'), 'export const a = 1;');
    await writeFile(path.join(ws, 'src', 'b.ts'), 'export const b = 2;');
    let spawnCalls = 0;
    const emitPass = fakeSpawn('{"pass":true}');
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'SENSOR_SCRIPT_BODY',
      workspaceDir: ws,
      changedFileProvenance: unknownChangedFileProvenance(
        'git_diff_failed',
        'fatal: revision unavailable',
      ),
      spawnFn: (...args) => {
        spawnCalls += 1;
        return emitPass(...args);
      },
    });

    const [verdict] = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'blocking',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          verdictMode: 'stdout-json',
          timeoutSeconds: 5,
        },
      ],
      stageId: 'code-generation',
    });

    expect(spawnCalls).toBe(2);
    expect(verdict).toMatchObject({
      result: 'PASS',
      applicability: 'UNKNOWN',
      held: false,
      detail: {
        applicability: 'UNKNOWN',
        provenance: {
          state: 'unknown',
          reason: 'git_diff_failed',
          detail: 'fatal: revision unavailable',
        },
        files: [{ file: 'src/a.ts' }, { file: 'src/b.ts' }],
      },
    });
  });

  it('does not materialize or run a blocking sensor for a definitively inapplicable change set', async () => {
    await mkdir(path.join(ws, 'src'), { recursive: true });
    await writeFile(path.join(ws, 'src', 'a.ts'), 'export const a = 1;');
    let scriptLoads = 0;
    let spawnCalls = 0;
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => {
        scriptLoads += 1;
        return 'SENSOR_SCRIPT_BODY';
      },
      workspaceDir: ws,
      changedFileProvenance: knownChangedFileProvenance(['README.md']),
      spawnFn: () => {
        spawnCalls += 1;
        throw new Error('definitively inapplicable sensors must not spawn');
      },
    });

    const [verdict] = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'blocking',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          verdictMode: 'stdout-json',
          timeoutSeconds: 5,
        },
      ],
      stageId: 'documentation',
    });

    expect(scriptLoads).toBe(0);
    expect(spawnCalls).toBe(0);
    expect(verdict).toMatchObject({
      result: 'INCONCLUSIVE',
      applicability: 'NOT_APPLICABLE',
      held: false,
      detail: {
        reason: 'no changed files match',
        applicability: 'NOT_APPLICABLE',
        provenance: { state: 'known', files: ['README.md'] },
        globbed: 1,
        changed: 1,
      },
    });
  });

  it('passes only harness-required environment variables to sensor children', async () => {
    await writeFile(path.join(ws, 'a.ts'), 'export const x = 1;');
    let spawnOptions;
    const emitPass = fakeSpawn('{"pass":true}');
    const captureSpawn = (file, args, options) => {
      spawnOptions = options;
      return emitPass(file, args, options);
    };
    const requiredEnv = {
      PATH: '/opt/bun/bin:/usr/bin:/bin',
      HOME: '/home/node',
      TMPDIR: '/sensor-tmp',
      TMP: '/sensor-tmp',
      TEMP: '/sensor-tmp',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      LC_CTYPE: 'C.UTF-8',
      TZ: 'UTC',
    };
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'SENSOR_SCRIPT_BODY',
      workspaceDir: ws,
      spawnFn: captureSpawn,
      childEnv: {
        ...requiredEnv,
        AIDLC_GIT_USERNAME: 'x-access-token',
        AIDLC_GIT_PASSWORD: 'repository-secret',
        AWS_ACCESS_KEY_ID: 'access-key',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
        AWS_SESSION_TOKEN: 'session-token',
        AWS_BEARER_TOKEN_BEDROCK: 'bedrock-token',
        GITHUB_TOKEN: 'github-token',
        KIRO_API_KEY: 'kiro-token',
        MCP_SERVER_TOKEN: 'mcp-token',
        HTTP_PROXY: 'http://user:password@proxy.example',
        NODE_OPTIONS: '--require /untrusted/hook.cjs',
        XDG_DATA_HOME: '/home/node/.agent-state',
        UNRELATED_PROCESS_STATE: 'do-not-forward',
      },
    });

    const [verdict] = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'blocking',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
        },
      ],
      stageId: 'code-generation',
    });

    expect(verdict).toMatchObject({ result: 'PASS', held: false });
    expect(spawnOptions).toMatchObject({ cwd: ws, shell: false });
    expect(spawnOptions.env).toEqual(requiredEnv);
  });

  it('emits only redacted harness details to persistence and rendering consumers', async () => {
    await writeFile(path.join(ws, 'a.ts'), 'export const a = 1;');
    await writeFile(path.join(ws, 'b.ts'), 'export const b = 2;');
    const diagnostics = [
      'Authorization: Token first-private-value\ncredential file /runtime/private/first-creds',
      'Authorization: Digest second-private-value\ncredential file /runtime/private/second-creds',
    ];
    let spawned = 0;
    const spawnFailure = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      const diagnostic = diagnostics[spawned++];
      setTimeout(() => {
        child.stderr.emit('data', Buffer.from(diagnostic));
        child.emit('close', 1);
      }, 0);
      return child;
    };
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'SENSOR_SCRIPT_BODY',
      workspaceDir: ws,
      spawnFn: spawnFailure,
      childEnv: {
        PATH: '/usr/bin:/bin',
        PRIMARY_API_TOKEN: 'first-private-value',
        SECONDARY_API_TOKEN: 'second-private-value',
        AWS_SHARED_CREDENTIALS_FILE: '/runtime/private/first-creds',
        GOOGLE_APPLICATION_CREDENTIALS: '/runtime/private/second-creds',
      },
    });

    const [verdict] = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'type-check',
          severity: 'advisory',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
        },
      ],
      stageId: 'code-generation',
    });

    expect(verdict.detail.harnessFailures).toEqual([
      expect.objectContaining({
        fileCount: 2,
        stderr: 'Authorization: [REDACTED]\ncredential file [REDACTED]',
        sampleFiles: ['a.ts', 'b.ts'],
      }),
    ]);
    expect(JSON.stringify(verdict)).not.toMatch(
      /first-private-value|second-private-value|\/runtime\/private\/(?:first|second)-creds/,
    );
  });

  it('uses a stdout-json sensor verdict mode for harness failures', async () => {
    await writeFile(path.join(ws, 'a.ts'), 'export const x = 1;');
    const spawnFailure = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => {
        child.stderr.emit('data', Buffer.from('unable to load tsconfig'));
        child.emit('close', 1);
      }, 0);
      return child;
    };
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'SENSOR_SCRIPT_BODY',
      workspaceDir: ws,
      spawnFn: spawnFailure,
      changedFileProvenance: unknownChangedFileProvenance(
        'git_status_failed',
        'fatal: status unavailable',
      ),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'type-check',
          severity: 'advisory',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
        },
      ],
      stageId: 'code-generation',
    });

    expect(verdicts[0].result).toBe('INCONCLUSIVE');
    expect(verdicts[0].detail.provenance).toEqual({
      state: 'unknown',
      reason: 'git_status_failed',
      detail: 'fatal: status unavailable',
    });
    expect(verdicts[0].detail.harnessFailures).toHaveLength(1);
    expect(verdicts[0].detail.harnessFailures[0]).toMatchObject({
      reason: 'script-error',
      exitCode: 1,
      stderr: 'unable to load tsconfig',
    });
  });

  it('BLOCKED when a script sensor has no script bytes', async () => {
    await writeFile(path.join(ws, 'a.ts'), 'x');
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => '',
      workspaceDir: ws,
      spawnFn: fakeSpawn('{}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'blocking',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
        },
      ],
      stageId: 's',
    });
    expect(verdicts[0]).toMatchObject({ result: 'BLOCKED', held: true });
  });

  it('holds an advisory sensor on a typed release-integrity failure', async () => {
    await writeFile(path.join(ws, 'a.ts'), 'x');
    const error = Object.assign(new Error('release script digest mismatch'), {
      name: 'ReleaseResolverError',
      code: 'release_closure_mismatch',
    });
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => {
        throw error;
      },
      workspaceDir: ws,
      spawnFn: fakeSpawn('{}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'advisory',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
          scriptRef: { s3Key: 'blocks/scripts/sha256/abc123' },
        },
      ],
      stageId: 's',
    });

    expect(verdicts[0]).toMatchObject({
      result: 'BLOCKED',
      severity: 'advisory',
      held: true,
      detail: {
        code: 'release_closure_mismatch',
        releaseIntegrityFailure: true,
      },
    });
  });

  it('keeps an advisory sensor non-blocking when its legacy script is absent', async () => {
    await writeFile(path.join(ws, 'a.ts'), 'x');
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => '',
      workspaceDir: ws,
      spawnFn: fakeSpawn('{}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'advisory',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
        },
      ],
      stageId: 's',
    });

    expect(verdicts[0]).toMatchObject({
      result: 'BLOCKED',
      held: false,
      detail: { error: 'sensor has no script' },
    });
  });

  const advisoryScriptSensor = {
    sensorId: 'linter',
    severity: 'advisory',
    runtime: 'bun',
    command: 'bun x.ts',
    matches: '**/*.ts',
    timeoutSeconds: 5,
    scriptRef: { s3Key: 'blocks/scripts/sha256/abc123' },
  };

  const runWithLoaderError = async (error) => {
    await writeFile(path.join(ws, 'a.ts'), 'x');
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => {
        throw error;
      },
      workspaceDir: ws,
      spawnFn: fakeSpawn('{}'),
    });
    const [verdict] = await runner.runStageSensors({
      sensors: [advisoryScriptSensor],
      stageId: 's',
    });
    return verdict;
  };

  it('keeps an advisory sensor non-blocking when the legacy loader rejects', async () => {
    const verdict = await runWithLoaderError(new Error('NoSuchKey: blocks/scripts/sha256/abc123'));

    expect(verdict).toMatchObject({
      result: 'BLOCKED',
      held: false,
      detail: { error: 'sensor has no script' },
    });
    expect(verdict.detail).not.toHaveProperty('releaseIntegrityFailure');
  });

  // A release-pinned sensor whose user-tenant overlay cannot be resolved runs a
  // different check than the one the intent pinned, which is exactly the drift
  // a pin exists to prevent, so it holds like a digest mismatch.
  it.each(['user_block_missing', 'unpinned_user_block'])(
    'holds an advisory release sensor whose user overlay fails with %s',
    async (code) => {
      const verdict = await runWithLoaderError(
        Object.assign(new Error(`release overlay failed: ${code}`), {
          name: 'ReleaseResolverError',
          code,
        }),
      );

      expect(verdict).toMatchObject({
        result: 'BLOCKED',
        held: true,
        detail: { code, releaseIntegrityFailure: true },
      });
    },
  );

  it('does not hold an advisory sensor on an overlay code raised outside release resolution', async () => {
    const verdict = await runWithLoaderError(
      Object.assign(new Error('user block missing'), { code: 'user_block_missing' }),
    );

    expect(verdict).toMatchObject({
      result: 'BLOCKED',
      held: false,
      detail: { error: 'sensor has no script' },
    });
    expect(verdict.detail).not.toHaveProperty('releaseIntegrityFailure');
  });

  // Regression for the plan→runner scriptRef contract. The PROD loadBlockScript
  // reads sensor.scriptRef.s3Key from S3; here we mimic that (return bytes if
  // the sensor carries a scriptRef) instead of the argument-ignoring stub the
  // other tests use. A plan sensor that carries its scriptRef must run; one
  // whose scriptRef was stripped must BLOCK. This is the shape that
  // v2-execution-plan.resolveSensors now guarantees.
  it('runs a script sensor whose plan object carries a scriptRef (prod loader semantics)', async () => {
    await writeFile(path.join(ws, 'a.ts'), 'export const x = 1;');
    // Mirrors block-loader.loadBlockScript: '' when there is no scriptRef.
    const loadBlockScript = async (sensor) =>
      sensor?.scriptRef?.s3Key ? 'SENSOR_SCRIPT_BODY' : '';
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript,
      workspaceDir: ws,
      spawnFn: fakeSpawn('{"pass":true,"errorCount":0}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'advisory',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
          scriptRef: { s3Key: 'blocks/scripts/sha256/abc123' },
        },
      ],
      stageId: 'code-generation',
    });
    expect(verdicts[0]).toMatchObject({ kind: 'script', result: 'PASS' });
  });

  it('BLOCKS a script sensor whose plan object lost its scriptRef (prod loader semantics)', async () => {
    await writeFile(path.join(ws, 'a.ts'), 'export const x = 1;');
    const loadBlockScript = async (sensor) =>
      sensor?.scriptRef?.s3Key ? 'SENSOR_SCRIPT_BODY' : '';
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript,
      workspaceDir: ws,
      spawnFn: fakeSpawn('{"pass":true,"errorCount":0}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'advisory',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
          // scriptRef intentionally absent — the pre-fix regression shape.
        },
      ],
      stageId: 'code-generation',
    });
    expect(verdicts[0]).toMatchObject({ result: 'BLOCKED' });
    expect(verdicts[0].detail.error).toBe('sensor has no script');
  });

  it('preserves typed release script errors on a blocked sensor verdict', async () => {
    await writeFile(path.join(ws, 'a.ts'), 'export const x = 1;');
    const releaseError = Object.assign(new Error('release object digest mismatch'), {
      name: 'ReleaseResolverError',
      code: 'release_object_digest_mismatch',
      details: { key: 'runtime/sha256/script' },
    });
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => {
        throw releaseError;
      },
      workspaceDir: ws,
      spawnFn: fakeSpawn('{}'),
    });

    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'blocking',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
          scriptRef: { s3Key: 'blocks/scripts/sha256/abc123' },
        },
      ],
      stageId: 'code-generation',
    });

    expect(verdicts[0]).toMatchObject({
      result: 'BLOCKED',
      held: true,
      detail: { error: releaseError.message, code: releaseError.code, name: releaseError.name },
    });
  });
});

// The record sensor runs in-process over graph artifacts, so the exemption has
// to travel on the plan sensor entry to reach the evaluator at all.
describe('runStageSensors — a timestamp run record at the gate', () => {
  const runnerFor = () =>
    createSensorRunner({
      graph: fakeGraph({
        'practices-discovery-timestamp': [
          { id: 'ts1', content: 'Discovered: 2026-10-08T00:00:00Z\n' },
        ],
      }),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });

  const verdictFor = async (sensor) =>
    (
      await runnerFor().runStageSensors({
        sensors: [sensor],
        outputArtifacts: [{ artifact: 'practices-discovery-timestamp' }],
        stageId: 'practices-discovery',
      })
    )[0];

  it('reports two missing headings when the catalog claims no record coverage', async () => {
    const verdict = await verdictFor({ sensorId: 'required-sections', severity: 'advisory' });
    expect(verdict).toMatchObject({ kind: 'graph', result: 'FAIL', held: false });
    expect(verdict.detail.artifacts[0]).toMatchObject({ h2_count: 0, findings_count: 2 });
  });

  it('passes when the plan carries the catalog record coverage', async () => {
    const verdict = await verdictFor({
      sensorId: 'required-sections',
      severity: 'advisory',
      recordTimestampExempt: true,
    });
    expect(verdict).toMatchObject({ result: 'PASS' });
    expect(verdict.detail.artifacts[0]).toMatchObject({ h2_count: 0, findings_count: 0 });
  });
});

// A release sensor script's sibling imports. Without them the spawned
// interpreter fails at startup with `Cannot find module` before the sensor
// checks anything, which is what every pinned document sensor did.
describe('runStageSensors — script import closure', () => {
  let ws;
  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), 'sensor-closure-'));
    await mkdir(path.join(ws, 'src'), { recursive: true });
    await writeFile(path.join(ws, 'src', 'a.ts'), 'export const x = 1;');
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  const okSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from('{"pass":true}'));
      child.emit('close', 0);
    }, 0);
    return child;
  };

  const LINTER = Object.freeze({
    sensorId: 'linter',
    severity: 'advisory',
    runtime: 'bun',
    command: 'bun aidlc-sensor-linter.ts',
    matches: '**/*.ts',
    timeoutSeconds: 5,
  });

  const runWith = async (loadScriptClosure) => {
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'import { budget } from "./aidlc-runtime-budget.ts";',
      workspaceDir: ws,
      spawnFn: okSpawn,
      loadScriptClosure,
    });
    return runner.runStageSensors({ sensors: [LINTER], stageId: 'code-generation' });
  };

  const sensorsDir = () => path.join(ws, '.aidlc', 'sensors');

  it('writes each sibling module next to the script before spawning it', async () => {
    const verdicts = await runWith(async (sensorId, script) => {
      expect(sensorId).toBe('linter');
      expect(script).toContain('./aidlc-runtime-budget.ts');
      return [{ relativePath: 'aidlc-runtime-budget.ts', content: 'export const budget = 1;' }];
    });
    expect(verdicts[0].result).toBe('PASS');
    expect(await readFile(path.join(sensorsDir(), 'linter.ts'), 'utf8')).toContain(
      './aidlc-runtime-budget.ts',
    );
    expect(await readFile(path.join(sensorsDir(), 'aidlc-runtime-budget.ts'), 'utf8')).toBe(
      'export const budget = 1;',
    );
  });

  it('holds the stage on an incomplete closure and writes nothing', async () => {
    const error = Object.assign(new Error('core/tools/aidlc-runtime-budget.ts is not published'), {
      name: 'ReleaseResolverError',
      code: 'release_script_dependency_missing',
    });
    const verdicts = await runWith(async () => {
      throw error;
    });
    expect(verdicts[0]).toMatchObject({
      result: 'BLOCKED',
      detail: { code: 'release_script_dependency_missing', releaseIntegrityFailure: true },
    });
    await expect(readFile(path.join(sensorsDir(), 'linter.ts'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('writes only the script when no closure reader is injected', async () => {
    const verdicts = await runWith(null);
    expect(verdicts[0].result).toBe('PASS');
    expect(await readdir(sensorsDir())).toEqual(['linter.ts']);
  });

  // The resolver raises `runtime_file_missing` — a code without the `release_`
  // prefix — when the release manifest lists a dependency whose object is gone
  // from storage. An incompletely published closure has to hold the stage like
  // any other integrity failure; classifying it as a best-effort loader error
  // let an advisory sensor continue on a release that cannot be run.
  it('holds the stage when a manifest-listed dependency is missing from storage', async () => {
    const verdicts = await runWith(async () => {
      throw Object.assign(new Error('runtime object for core/tools/aidlc-lib.ts is missing'), {
        name: 'ReleaseResolverError',
        code: 'runtime_file_missing',
        details: { repoPath: 'core/tools/aidlc-lib.ts' },
      });
    });
    expect(verdicts[0]).toMatchObject({
      result: 'BLOCKED',
      held: true,
      detail: {
        code: 'runtime_file_missing',
        releaseIntegrityFailure: true,
        details: { repoPath: 'core/tools/aidlc-lib.ts' },
      },
    });
    await expect(readFile(path.join(sensorsDir(), 'linter.ts'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

// The flag a script sensor is spawned with comes from the plan, which resolved
// it from the sensor's declared contract. A document sensor spawned with the
// code sensors' --file-path exits before it runs its check.
describe('runStageSensors — script argv', () => {
  let ws;
  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), 'sensor-argv-'));
    await mkdir(path.join(ws, 'aidlc-docs'), { recursive: true });
    await writeFile(path.join(ws, 'aidlc-docs', 'traceability.json'), '{}');
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  const spawnRecording = (calls) => (file, args) => {
    calls.push({ file, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from('{"pass":true}'));
      child.emit('close', 0);
    }, 0);
    return child;
  };

  const runWith = async (sensor, runnerOptions = {}) => {
    const calls = [];
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'SENSOR_SCRIPT_BODY',
      workspaceDir: ws,
      spawnFn: spawnRecording(calls),
      ...runnerOptions,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [sensor],
      stageId: 'intent-capture',
    });
    return { calls, verdicts };
  };

  const traceability = {
    sensorId: 'traceability',
    severity: 'advisory',
    runtime: 'bun',
    command: 'bun aidlc-sensor-traceability.ts',
    matches: '**/traceability.json',
    timeoutSeconds: 5,
  };

  it('spawns a document sensor on the output path its plan entry carries', async () => {
    const { calls, verdicts } = await runWith({ ...traceability, pathFlag: '--output-path' });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      path.join(ws, '.aidlc', 'sensors', 'traceability.ts'),
      '--stage',
      'intent-capture',
      '--output-path',
      'aidlc-docs/traceability.json',
    ]);
    expect(verdicts[0].result).toBe('PASS');
  });

  it('spawns a sensor with no resolved flag on the file path, as before', async () => {
    const { calls } = await runWith(traceability);
    expect(calls[0].args.slice(-2)).toEqual(['--file-path', 'aidlc-docs/traceability.json']);
  });

  it('shortens a long budget to the stage deadline and says so in the verdict', async () => {
    const { calls, verdicts } = await runWith(
      { ...traceability, timeoutSeconds: 1200 },
      { remainingStageMs: () => 90000 },
    );
    expect(calls).toHaveLength(1);
    expect(verdicts[0].detail).toMatchObject({ timeoutMs: 90000, boundedBy: 'stage-deadline' });
  });

  it('reports no bound when the authored budget is the one that runs', async () => {
    const { verdicts } = await runWith(traceability, { remainingStageMs: () => 90000 });
    expect(verdicts[0].detail).not.toHaveProperty('boundedBy');
  });
});

// What is left of the stage's wall-clock budget bounds EVERY child, not just the
// first. A sensor matching several files handed each of them the allowance the
// first one found, and an already-expired budget restored the whole authored
// allowance instead of stopping the pass — so the bound protected nothing.
describe('runStageSensors — the stage budget bounds every child', () => {
  let ws;
  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), 'sensor-budget-'));
    await writeFile(path.join(ws, 'a.ts'), 'export const a = 1;');
    await writeFile(path.join(ws, 'b.ts'), 'export const b = 2;');
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  const typeCheck = {
    sensorId: 'type-check',
    severity: 'advisory',
    runtime: 'bun',
    command: 'bun aidlc-sensor-type-check.ts',
    matches: '**/*.ts',
    timeoutSeconds: 600,
  };

  // Returns each value in turn, then repeats the last one — so a test can say
  // "there was time for the first file and none for the second".
  const remainingSequence = (values, reads) => () => {
    const value = values[Math.min(reads.length, values.length - 1)];
    reads.push(value);
    return value;
  };

  const runWith = async ({ sensor = typeCheck, remaining = null } = {}) => {
    const calls = [];
    const reads = [];
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'SENSOR_SCRIPT_BODY',
      workspaceDir: ws,
      spawnFn: (file, args) => {
        calls.push({ file, args });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        setTimeout(() => {
          child.stdout.emit('data', Buffer.from('{"pass":true}'));
          child.emit('close', 0);
        }, 0);
        return child;
      },
      ...(remaining ? { remainingStageMs: remainingSequence(remaining, reads) } : {}),
    });
    const verdicts = await runner.runStageSensors({ sensors: [sensor], stageId: 'construction' });
    return { calls, reads, verdict: verdicts[0] };
  };

  it('re-reads what is left of the stage before each file, not once for the pass', async () => {
    const { calls, reads, verdict } = await runWith({ remaining: [300000, 120000] });
    expect(calls).toHaveLength(2);
    expect(reads).toEqual([300000, 120000]);
    expect(verdict.detail).toMatchObject({ timeoutMs: 120000, boundedBy: 'stage-deadline' });
  });

  it('stops the sweep when the budget runs out part-way, and says which file it never read', async () => {
    const { calls, verdict } = await runWith({ remaining: [300000, -1] });
    expect(calls).toHaveLength(1);
    expect(verdict.result).toBe('BLOCKED');
    expect(verdict.detail.stageBudgetExhausted).toBe(true);
    expect(verdict.detail.files).toHaveLength(2);
    expect(verdict.detail.files[1]).toMatchObject({
      result: 'BLOCKED',
      detail: { error: expect.stringContaining('stage budget was exhausted') },
    });
    expect(verdict.detail).toMatchObject({ timeoutMs: 300000, boundedBy: 'stage-deadline' });
  });

  it('launches nothing at all once the stage deadline has already passed', async () => {
    const { calls, verdict } = await runWith({ remaining: [-1] });
    expect(calls).toEqual([]);
    expect(verdict.result).toBe('BLOCKED');
    expect(verdict.detail).toMatchObject({ stageBudgetExhausted: true });
    expect(verdict.detail.files.map((f) => f.result)).toEqual(['BLOCKED', 'BLOCKED']);
    expect(verdict.detail).not.toHaveProperty('timeoutMs');
    expect(verdict.detail).not.toHaveProperty('boundedBy');
  });

  it('reports exhaustion without a launch bound when the earlier child kept its authored budget', async () => {
    const { calls, verdict } = await runWith({ remaining: [900000, 0] });
    expect(calls).toHaveLength(1);
    expect(verdict.detail).toMatchObject({ stageBudgetExhausted: true });
    expect(verdict.detail.files.map((f) => f.result)).toEqual(['PASS', 'BLOCKED']);
    expect(verdict.detail).not.toHaveProperty('timeoutMs');
    expect(verdict.detail).not.toHaveProperty('boundedBy');
  });

  it('holds the stage on an exhausted budget when the sensor is blocking', async () => {
    const { verdict } = await runWith({
      sensor: { ...typeCheck, severity: 'blocking' },
      remaining: [0],
    });
    expect(verdict.held).toBe(true);
  });

  it('leaves the authored budget alone when no deadline is available', async () => {
    const { calls, verdict } = await runWith();
    expect(calls).toHaveLength(2);
    expect(verdict.result).toBe('PASS');
    expect(verdict.detail).not.toHaveProperty('boundedBy');
    expect(verdict.detail).not.toHaveProperty('stageBudgetExhausted');
  });
});

// D3 on staging: every file of a pinned `linter` sweep recorded
// `{result:"FAIL",detail:null}` because each child exited non-zero without a
// JSON line, and neither the exit code nor stderr was kept. The release's own
// dispatcher answers 127 with a tool-unavailable PASS, so a pinned sweep reads
// it that way too, and a real script error keeps its FAIL but now says why.
describe("runStageSensors — a release script sensor's documented exit codes", () => {
  let ws;
  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), 'sensor-exit-'));
    await mkdir(path.join(ws, 'src'), { recursive: true });
    await writeFile(path.join(ws, 'src', 'a.ts'), 'export const a = 1;');
    await writeFile(path.join(ws, 'src', 'b.ts'), 'export const b = 2;');
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  const exitingSpawn = (exitCode, stderr) => () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => {
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', exitCode);
    }, 0);
    return child;
  };

  const linter = (extra = {}) => ({
    sensorId: 'linter',
    severity: 'advisory',
    runtime: 'bun',
    command: '{{INVOKE}} engine sensor-linter',
    matches: '**/*.{ts,js}',
    timeoutSeconds: 30,
    ...extra,
  });

  const verdictFor = async ({ exitCode, stderr, sensor }) => {
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'console.log("x");',
      workspaceDir: ws,
      spawnFn: exitingSpawn(exitCode, stderr),
    });
    const [verdict] = await runner.runStageSensors({
      sensors: [sensor],
      stageId: 'functional-design',
    });
    return verdict;
  };

  it('passes a tool-unavailable sweep and names the tool on the record', async () => {
    const verdict = await verdictFor({
      exitCode: 127,
      stderr: 'eslint-unavailable\n',
      sensor: linter({ dispatcherExitCodes: true }),
    });
    expect(verdict).toMatchObject({ kind: 'script', result: 'PASS', held: false });
    expect(verdict.detail.reason).toBe(
      '2 of 2 files: eslint is not available here, so the check did not run',
    );
    for (const file of verdict.detail.files) {
      expect(file).toMatchObject({
        result: 'PASS',
        detail: {
          toolUnavailable: true,
          exitCode: 127,
          reason: 'eslint is not available here, so the check did not run',
        },
      });
    }
  });

  it('names the missing config when that is what the script reported', async () => {
    const verdict = await verdictFor({
      exitCode: 127,
      stderr: 'no-eslint-config\n',
      sensor: linter({ dispatcherExitCodes: true }),
    });
    expect(verdict.result).toBe('PASS');
    expect(verdict.detail.reason).toBe(
      '2 of 2 files: no eslint configuration was found, so the check did not run',
    );
  });

  it('records a script error as the FAIL it was, now with the exit code and stderr', async () => {
    const verdict = await verdictFor({
      exitCode: 1,
      stderr: 'eslint-bad-output\nat parse (file.ts:1:1)\n',
      sensor: linter({ dispatcherExitCodes: true }),
    });
    expect(verdict).toMatchObject({ result: 'FAIL', held: false });
    expect(verdict.detail.reason).toBe(
      '2 of 2 files: the sensor script exited 1 without a verdict',
    );
    expect(verdict.detail.files[0].detail).toMatchObject({
      scriptError: true,
      exitCode: 1,
      stderr: 'eslint-bad-output\nat parse (file.ts:1:1)',
    });
  });

  it('a blocking script error holds the stage', async () => {
    const verdict = await verdictFor({
      exitCode: 1,
      stderr: 'eslint-bad-output\n',
      sensor: linter({ severity: 'blocking', dispatcherExitCodes: true }),
    });
    expect(verdict).toMatchObject({ result: 'FAIL', held: true });
  });

  // The behaviour an unpinned run and every pre-dispatcher catalog still get:
  // the default exit mapping, with none of the dispatcher contract's reading of
  // the exit and no sensor-level reason summarizing it.
  it('keeps the default mapping when the catalog authors no contract', async () => {
    const verdict = await verdictFor({
      exitCode: 127,
      stderr: 'eslint-unavailable\n',
      sensor: linter(),
    });
    expect(verdict).toMatchObject({ kind: 'script', result: 'INCONCLUSIVE' });
    expect(verdict.detail).not.toHaveProperty('reason');
    for (const failure of verdict.detail.harnessFailures) {
      expect(failure).toMatchObject({ reason: 'tool-unavailable', exitCode: 127 });
      expect(failure).not.toHaveProperty('toolUnavailable');
      expect(failure).not.toHaveProperty('scriptError');
    }
  });
});
