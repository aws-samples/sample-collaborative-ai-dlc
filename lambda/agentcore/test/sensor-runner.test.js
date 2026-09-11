import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSensorRunner, __test } from '../sensor-runner.js';
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
});
