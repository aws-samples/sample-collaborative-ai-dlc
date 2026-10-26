import { describe, it, expect } from 'vitest';
import {
  SENSOR_RESULT,
  recordSensorsCoverRunRecords,
  sensorDeclaresDispatcherExitCodes,
  sensorKind,
  severityGate,
  sensorPathFlag,
  scriptTimeoutBound,
  validateScriptSpec,
  resultFromExit,
  resultFromDispatcherExit,
  dispatcherExitReason,
  TOOL_UNAVAILABLE_EXIT,
  sensorVerdictMode,
  sensorScope,
  projectConfigFile,
  buildScriptArgv,
  evalRequiredSections,
  evalUpstreamCoverage,
  evalGraphCoverage,
  parseBoltDag,
} from '../v2-sensor-contract.js';

describe('sensorKind', () => {
  it('routes the document-shape sensors in-process', () => {
    expect(sensorKind({ sensorId: 'required-sections' })).toBe('graph');
    expect(sensorKind({ sensorId: 'upstream-coverage' })).toBe('graph');
    expect(sensorKind({ sensorId: 'graph-coverage' })).toBe('graph');
  });
  it('routes code-quality sensors to the script path', () => {
    expect(sensorKind({ sensorId: 'linter', runtime: 'bun' })).toBe('script');
    expect(sensorKind({ sensorId: 'type-check', runtime: 'bun' })).toBe('script');
  });
  it('honours an explicit runtime:graph override', () => {
    expect(sensorKind({ sensorId: 'whatever', runtime: 'graph' })).toBe('graph');
  });
});

describe('severityGate', () => {
  it('advisory never holds, whatever the result', () => {
    for (const r of Object.values(SENSOR_RESULT)) {
      expect(severityGate(r, 'advisory')).toEqual({ continues: true, held: false });
    }
  });
  it('blocking holds on any non-PASS', () => {
    expect(severityGate(SENSOR_RESULT.PASS, 'blocking')).toEqual({ continues: true, held: false });
    expect(severityGate(SENSOR_RESULT.FAIL, 'blocking')).toEqual({ continues: false, held: true });
    expect(severityGate(SENSOR_RESULT.BLOCKED, 'blocking')).toEqual({
      continues: false,
      held: true,
    });
    expect(severityGate(SENSOR_RESULT.INCONCLUSIVE, 'blocking')).toEqual({
      continues: false,
      held: true,
    });
  });
});

describe('validateScriptSpec', () => {
  it('accepts an allowed runtime + command + timeout', () => {
    const r = validateScriptSpec({
      sensorId: 'linter',
      runtime: 'bun',
      command: 'bun x.ts',
      timeoutSeconds: 30,
    });
    expect(r.ok).toBe(true);
    expect(r.spec.timeoutMs).toBe(30000);
  });
  it('rejects an unknown runtime (anti-interpreter-smuggling)', () => {
    const r = validateScriptSpec({ runtime: 'python', command: 'x', timeoutSeconds: 5 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unsupported runtime/);
  });
  it('clamps an oversized timeout to the ceiling', () => {
    const r = validateScriptSpec({ runtime: 'sh', command: 'echo', timeoutSeconds: 99999 });
    expect(r.spec.timeoutMs).toBe(600000);
  });
  it('rejects an empty command', () => {
    expect(validateScriptSpec({ runtime: 'bun', command: '  ', timeoutSeconds: 5 }).ok).toBe(false);
  });
  it('carries the authored budget and its bound, leaving the stage deadline to the runner', () => {
    const r = validateScriptSpec({ runtime: 'bun', command: 'bun x.ts', timeoutSeconds: 60 });
    expect(r.spec).toMatchObject({ timeoutSeconds: 60, timeoutMs: 60000, boundedBy: 'authored' });
  });
  it('routes the path flag the sensor contract declares', () => {
    const specFor = (inputSchema) =>
      validateScriptSpec({ runtime: 'bun', command: 'bun x.ts', timeoutSeconds: 5, inputSchema })
        .spec;
    expect(specFor({ output_path: 'string', stage_slug: 'string' }).pathFlag).toBe('--output-path');
    expect(specFor({ file_path: 'string' }).pathFlag).toBe('--file-path');
    expect(specFor(undefined).pathFlag).toBe('--file-path');
  });
  it('takes a path flag the plan already resolved', () => {
    const r = validateScriptSpec({
      runtime: 'bun',
      command: 'bun x.ts',
      timeoutSeconds: 5,
      pathFlag: '--output-path',
    });
    expect(r.spec.pathFlag).toBe('--output-path');
  });

  it.each([
    ['verdictMode', 'yaml', /unsupported verdictMode/],
    ['scope', 'workspace', /unsupported scope/],
  ])('rejects an unsupported %s before a sensor can run', (field, value, error) => {
    const result = validateScriptSpec({
      sensorId: 'custom-checker',
      runtime: 'bun',
      command: 'bun checker.ts',
      timeoutSeconds: 5,
      [field]: value,
    });

    expect(result).toEqual({ ok: false, error: expect.stringMatching(error) });
  });

  it.each([
    ['/etc/tsconfig.json', 'POSIX absolute path'],
    ['C:\\secrets\\tsconfig.json', 'Windows absolute path'],
    ['../tsconfig.json', 'parent traversal'],
    ['config/../../tsconfig.json', 'nested parent traversal'],
  ])('rejects unsafe projectConfig %s (%s)', (projectConfig) => {
    const result = validateScriptSpec({
      sensorId: 'type-check',
      runtime: 'bun',
      command: 'bun type-check.ts',
      timeoutSeconds: 5,
      scope: 'project',
      projectConfig,
    });

    expect(result).toEqual({
      ok: false,
      error: 'projectConfig must be a normalized safe relative path',
    });
  });
});

// The bound one child launch gets. The three states of the remaining stage
// budget are NOT interchangeable: an unavailable deadline leaves the authored
// budget alone, while an exhausted one must stop the pass instead of restoring
// the whole authored allowance after the stage is already over.
describe('scriptTimeoutBound', () => {
  it('keeps the authored budget when no deadline is available', () => {
    for (const remaining of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(scriptTimeoutBound(60, remaining)).toEqual({
        timeoutMs: 60000,
        boundedBy: 'authored',
        exhausted: false,
      });
    }
  });
  it('clamps an absurd authored budget to the ceiling', () => {
    expect(scriptTimeoutBound(99999)).toEqual({
      timeoutMs: 600000,
      boundedBy: 'ceiling',
      exhausted: false,
    });
  });
  it('narrows to what is left of the stage, and names that bound', () => {
    expect(scriptTimeoutBound(600, 90000)).toEqual({
      timeoutMs: 90000,
      boundedBy: 'stage-deadline',
      exhausted: false,
    });
  });
  it('leaves the authored budget alone when more stage time remains than it asks for', () => {
    expect(scriptTimeoutBound(5, 90000)).toEqual({
      timeoutMs: 5000,
      boundedBy: 'authored',
      exhausted: false,
    });
  });
  it('reports an exhausted stage budget instead of restoring the authored one', () => {
    for (const remaining of [0, -1, -600000]) {
      expect(scriptTimeoutBound(600, remaining)).toEqual({
        timeoutMs: 0,
        boundedBy: 'stage-deadline',
        exhausted: true,
      });
    }
  });
});

describe('sensorPathFlag', () => {
  it('reads the declared contract, not the sensor id', () => {
    expect(sensorPathFlag({ file_path: 'string' })).toBe('--file-path');
    expect(sensorPathFlag({ output_path: 'string', stage_slug: 'string' })).toBe('--output-path');
  });
  it('keeps the file-path default when no contract is authored', () => {
    expect(sensorPathFlag(undefined)).toBe('--file-path');
    expect(sensorPathFlag(null)).toBe('--file-path');
    expect(sensorPathFlag({})).toBe('--file-path');
    expect(sensorPathFlag('output_path')).toBe('--file-path');
  });
});

describe('resultFromExit', () => {
  it('maps the convention', () => {
    expect(resultFromExit(0)).toBe(SENSOR_RESULT.PASS);
    expect(resultFromExit(2)).toBe(SENSOR_RESULT.INCONCLUSIVE);
    expect(resultFromExit(1)).toBe(SENSOR_RESULT.FAIL);
    expect(resultFromExit(null)).toBe(SENSOR_RESULT.BLOCKED);
  });
});

describe('sensor script metadata', () => {
  it('classifies the reserved tool-unavailable exit as INCONCLUSIVE', () => {
    expect(TOOL_UNAVAILABLE_EXIT).toBe(127);
    expect(resultFromExit(TOOL_UNAVAILABLE_EXIT)).toBe(SENSOR_RESULT.INCONCLUSIVE);
  });

  it('uses explicit declarations and backward-compatible upstream defaults', () => {
    expect(sensorVerdictMode({ sensorId: 'custom', verdictMode: 'stdout-json' })).toBe(
      'stdout-json',
    );
    expect(sensorVerdictMode({ sensorId: 'linter' })).toBe('stdout-json');
    expect(sensorVerdictMode({ sensorId: 'custom' })).toBe('exit-code');
    expect(sensorScope({ sensorId: 'type-check' })).toBe('project');
    expect(sensorScope({ sensorId: 'linter' })).toBe('file');
    expect(sensorScope({ sensorId: 'linter', scope: 'project' })).toBe('project');
    expect(projectConfigFile({ projectConfig: 'jsconfig.json' })).toBe('jsconfig.json');
    expect(projectConfigFile({})).toBe('tsconfig.json');
  });
});

describe('buildScriptArgv', () => {
  it('runs the materialized script for bun/node (ignores the command path)', () => {
    const spec = { runtime: 'bun', command: 'bun <runtime-managed>/tools/aidlc-sensor-linter.ts' };
    expect(buildScriptArgv(spec, { scriptPath: '/ws/.aidlc/sensors/linter.ts' })).toEqual({
      file: 'bun',
      args: ['/ws/.aidlc/sensors/linter.ts'],
    });
  });
  it('runs sh -c with substitutions applied', () => {
    const spec = { runtime: 'sh', command: 'echo {{HARNESS_DIR}}' };
    expect(buildScriptArgv(spec, { substitutions: { HARNESS_DIR: '/opt/x' } })).toEqual({
      file: 'sh',
      args: ['-c', 'echo /opt/x'],
    });
  });
});

// A timestamp run record is one `Discovered: ...` line by specification, so the
// two-heading floor reported two findings on every to-spec file. The exemption
// applies only where the pinned catalog proves its record sensor covers run
// records, which is the authored change that shipped the exemption upstream.
describe('recordSensorsCoverRunRecords', () => {
  it('reads the record sensors own authored glob', () => {
    expect(
      recordSensorsCoverRunRecords({
        'required-sections': { matches: '**/{aidlc-docs,intents,codekb}/**' },
      }),
    ).toBe(true);
    expect(
      recordSensorsCoverRunRecords({
        'upstream-coverage': { matches: '**/{aidlc-docs,intents,codekb}/**' },
      }),
    ).toBe(true);
  });
  it('is false for the glob every earlier release authors', () => {
    expect(
      recordSensorsCoverRunRecords({
        'required-sections': { matches: '**/{aidlc-docs,intents}/**' },
      }),
    ).toBe(false);
    expect(recordSensorsCoverRunRecords({ 'required-sections': {} })).toBe(false);
    expect(recordSensorsCoverRunRecords({})).toBe(false);
    expect(recordSensorsCoverRunRecords()).toBe(false);
  });
  it('ignores a glob authored by a sensor that is not a record sensor', () => {
    expect(recordSensorsCoverRunRecords({ linter: { matches: '**/codekb/**' } })).toBe(false);
  });
});

describe('evalRequiredSections — a timestamp run record', () => {
  const TIMESTAMP_BODY = 'Discovered: 2026-10-08T00:00:00Z\n';
  const MARKER = 'practices-discovery-timestamp';

  it('reports two missing headings without the exemption', () => {
    const r = evalRequiredSections(TIMESTAMP_BODY, MARKER);
    expect(r).toMatchObject({ pass: false, result: SENSOR_RESULT.FAIL });
    expect(r.detail).toMatchObject({ h2_count: 0, findings_count: 2 });
  });

  it('passes with no findings under the exemption', () => {
    const r = evalRequiredSections(TIMESTAMP_BODY, MARKER, { recordTimestampExempt: true });
    expect(r).toMatchObject({ pass: true, result: SENSOR_RESULT.PASS });
    expect(r.detail).toMatchObject({ h2_count: 0, headings: [], findings_count: 0 });
  });

  it('exempts the marker whether or not the name carries the .md suffix', () => {
    for (const name of [MARKER, `${MARKER}.md`]) {
      expect(
        evalRequiredSections(TIMESTAMP_BODY, name, { recordTimestampExempt: true }).pass,
        name,
      ).toBe(true);
    }
  });

  it('keeps the floor on a questions marker, which upstream keeps', () => {
    const r = evalRequiredSections('One question?\n', 'requirements-questions', {
      recordTimestampExempt: true,
    });
    expect(r.pass).toBe(false);
    expect(r.detail.findings_count).toBe(2);
  });

  it('keeps the floor on an ordinary document', () => {
    const r = evalRequiredSections('## Only one\n', 'practices-discovery', {
      recordTimestampExempt: true,
    });
    expect(r.pass).toBe(false);
    expect(r.detail.findings_count).toBe(1);
  });

  it('leaves the unit-of-work DAG check untouched', () => {
    const name = 'unit-of-work-dependency';
    const cyclic = '## A\n## B\n```units\nunits:\n  - id: a\n    dependsOn: [a]\n```\n';
    const withExemption = evalRequiredSections(cyclic, name, { recordTimestampExempt: true });
    expect(withExemption).toEqual(evalRequiredSections(cyclic, name));
    expect(withExemption.pass).toBe(false);
  });
});

describe('evalRequiredSections', () => {
  it('passes at >= 2 distinct H2 headings', () => {
    const r = evalRequiredSections('## One\n\ntext\n\n## Two\n');
    expect(r.pass).toBe(true);
    expect(r.detail.h2_count).toBe(2);
  });
  it('fails below the threshold and counts findings', () => {
    const r = evalRequiredSections('## Only one\n\nbody');
    expect(r.pass).toBe(false);
    expect(r.detail.findings_count).toBe(1);
  });
  it('does not count ### deeper headings or duplicates', () => {
    const r = evalRequiredSections('## A\n### deeper\n## A\n## B');
    expect(r.detail.h2_count).toBe(2);
  });
  it('requires a valid units DAG for the unit-of-work-dependency artifact', () => {
    const good = [
      '## Units',
      '## Dependencies',
      '```yaml',
      'units:',
      '  - name: auth',
      '    depends_on: []',
      '  - name: api',
      '    depends_on: [auth]',
      '```',
    ].join('\n');
    const r = evalRequiredSections(good, 'unit-of-work-dependency');
    expect(r.pass).toBe(true);
    expect(r.detail.edge_block).toBe('ok');
  });
  it('fails the DAG artifact when the units block is absent', () => {
    const r = evalRequiredSections('## A\n## B\n', 'unit-of-work-dependency');
    expect(r.pass).toBe(false);
    expect(r.detail.edge_block).toBe('absent');
  });
  it('reports registered structured blocks when present', () => {
    const r = evalRequiredSections(
      [
        '## Stories',
        '## Traceability',
        '```yaml',
        'stories:',
        '  - id: s1',
        '    title: Login',
        '```',
      ].join('\n'),
      'stories',
    );
    expect(r.pass).toBe(true);
    expect(r.detail.structured_key).toBe('stories');
    expect(r.detail.structured_block).toBe('present');
    expect(r.detail.structured_items).toBe(1);
  });
  it('fails registered artifacts when a structured block is malformed', () => {
    const r = evalRequiredSections(
      ['## Stories', '## Traceability', '```yaml', 'stories:', '  - [', '```'].join('\n'),
      'stories',
    );
    expect(r.pass).toBe(false);
    expect(r.detail.structured_block).toBe('malformed');
  });
  it('an ABSENT structured block is a finding but passes by default (strictness ladder)', () => {
    const r = evalRequiredSections('## Stories\n## Traceability\nprose only', 'stories');
    expect(r.pass).toBe(true);
    expect(r.detail.structured_block).toBe('absent');
    expect(r.detail.findings_count).toBe(1);
  });
  it('strictStructuredBlocks flips an absent block to a FAIL (config, not code)', () => {
    const r = evalRequiredSections('## Stories\n## Traceability\nprose only', 'stories', {
      strictStructuredBlocks: true,
    });
    expect(r.pass).toBe(false);
    expect(r.detail.structured_block).toBe('absent');
    // Present blocks still pass under strict mode.
    const ok = evalRequiredSections(
      ['## Stories', '## More', '```yaml', 'stories:', '  - id: s1', '    title: T', '```'].join(
        '\n',
      ),
      'stories',
      { strictStructuredBlocks: true },
    );
    expect(ok.pass).toBe(true);
  });
});

describe('evalGraphCoverage', () => {
  it('is INCONCLUSIVE before any typed items exist (early stages must not fail)', () => {
    const r = evalGraphCoverage({ counts: {} });
    expect(r.result).toBe('INCONCLUSIVE');
  });

  it('passes a fully wired graph and reports non-must-have gaps without failing', () => {
    const r = evalGraphCoverage({
      counts: { requirements: 2, stories: 1, mappings: 1, components: 0 },
      uncoveredRequirements: [{ slug: 'req-theme' }], // could-have — reported only
      uncoveredMustHave: [],
      unmappedStories: [],
      unknownReferences: [],
      componentCycles: [],
    });
    expect(r.pass).toBe(true);
    expect(r.detail.uncovered_requirements).toEqual(['req-theme']);
    expect(r.detail.findings_count).toBe(0);
  });

  it('fails on uncovered must-haves, unknown references, and component cycles', () => {
    const r = evalGraphCoverage({
      counts: { requirements: 2, stories: 2, mappings: 1, components: 2 },
      uncoveredMustHave: [{ slug: 'req-pay' }],
      unmappedStories: [{ slug: 's-float' }],
      unknownReferences: [{ kind: 'story-covers-unknown-requirement', from: 's1', ref: 'ghost' }],
      componentCycles: ['a', 'b'],
    });
    expect(r.pass).toBe(false);
    expect(r.detail.findings_count).toBe(5);
    expect(r.detail.uncovered_must_have).toEqual(['req-pay']);
    expect(r.detail.component_cycles).toEqual(['a', 'b']);
  });

  it('ignores unmapped stories until a story map exists', () => {
    const r = evalGraphCoverage({
      counts: { requirements: 0, stories: 2, mappings: 0, components: 0 },
      uncoveredMustHave: [],
      unmappedStories: [{ slug: 's-a' }, { slug: 's-b' }],
      unknownReferences: [],
      componentCycles: [],
    });
    expect(r.pass).toBe(true);
    expect(r.detail.unmapped_stories).toEqual([]);
  });
});

describe('evalUpstreamCoverage', () => {
  it('passes when every consumed slug is referenced', () => {
    const body = 'We build on requirements and the [[domain-entities]] model.';
    const r = evalUpstreamCoverage(body, ['requirements', 'domain-entities']);
    expect(r.pass).toBe(true);
  });
  it('flags unreferenced upstream artifacts', () => {
    const r = evalUpstreamCoverage('only mentions requirements', [
      'requirements',
      'security-design',
    ]);
    expect(r.pass).toBe(false);
    expect(r.detail.unreferenced).toEqual(['security-design']);
  });
  it('passes trivially with no upstream', () => {
    expect(evalUpstreamCoverage('anything', []).detail.reason).toBe('no upstream');
  });
  it('accepts consume edge objects ({artifact})', () => {
    const r = evalUpstreamCoverage('mentions requirements', [{ artifact: 'requirements' }]);
    expect(r.pass).toBe(true);
  });
});

describe('parseBoltDag', () => {
  it('topo-sorts a valid DAG into batches', () => {
    const body =
      '```yaml\nunits:\n  - name: a\n    depends_on: []\n  - name: b\n    depends_on: [a]\n```';
    const r = parseBoltDag(body);
    expect(r.ok).toBe(true);
    expect(r.batches).toEqual([['a'], ['b']]);
  });
  it('detects a cycle', () => {
    const body =
      '```yaml\nunits:\n  - name: a\n    depends_on: [b]\n  - name: b\n    depends_on: [a]\n```';
    expect(parseBoltDag(body)).toMatchObject({ ok: false, reason: 'cyclic' });
  });
  it('rejects a dependency on an unknown unit', () => {
    const body = '```yaml\nunits:\n  - name: a\n    depends_on: [ghost]\n```';
    expect(parseBoltDag(body)).toMatchObject({ ok: false, reason: 'malformed' });
  });
  it('parses the optional per-unit kind (null when absent)', () => {
    const body =
      '```yaml\nunits:\n  - name: api\n    kind: service\n    depends_on: []\n  - name: docs\n    depends_on: [api]\n```';
    const r = parseBoltDag(body);
    expect(r.ok).toBe(true);
    expect(r.units).toEqual([
      { name: 'api', depends_on: [], kind: 'service' },
      { name: 'docs', depends_on: ['api'], kind: null },
    ]);
  });
  it('rejects an unknown kind loudly (never a silent full-matrix)', () => {
    const body = '```yaml\nunits:\n  - name: api\n    kind: microservice\n    depends_on: []\n```';
    const r = parseBoltDag(body);
    expect(r).toMatchObject({ ok: false, reason: 'malformed' });
    expect(r.detail).toContain('unknown kind "microservice"');
  });
});

// The exit-code contract a pinned catalog authors by routing its sensors through
// its own engine dispatcher. Read off the authored invocation, never a version
// string, so a fork that keeps the route keeps the semantics.
describe('sensorDeclaresDispatcherExitCodes', () => {
  it('reads the dispatcher route a 2.8.2+ catalog authors', () => {
    expect(sensorDeclaresDispatcherExitCodes({ command: '{{INVOKE}} engine sensor-linter' })).toBe(
      true,
    );
    expect(
      sensorDeclaresDispatcherExitCodes({ command: '{{INVOKE}} engine sensor-type-check' }),
    ).toBe(true);
  });
  it('is false for the direct script invocation every earlier catalog authors', () => {
    expect(
      sensorDeclaresDispatcherExitCodes({
        command: 'bun {{HARNESS_DIR}}/tools/aidlc-sensor-linter.ts',
      }),
    ).toBe(false);
  });
  it('is false for a sensor with no command at all', () => {
    expect(sensorDeclaresDispatcherExitCodes({})).toBe(false);
    expect(sensorDeclaresDispatcherExitCodes(null)).toBe(false);
  });
  it('is false for an engine command that is not a sensor route', () => {
    expect(
      sensorDeclaresDispatcherExitCodes({ command: '{{INVOKE}} engine state unit start' }),
    ).toBe(false);
  });
});

// Upstream's dispatcher truth table (core/tools/aidlc-sensor.ts, 2.11.0
// 6a378b53c0): branch b answers exit 127 with a PASS noted tool-unavailable, so
// an environment without the tool is not a finding. The reason has to name the
// tool or config, which only the script's own stderr marker does. Every other
// non-zero exit keeps the verdict the bare mapping gave it and only gains the
// exit code and stderr the record was dropping.
describe('resultFromDispatcherExit', () => {
  it('passes exit 127 and names the unavailable tool', () => {
    expect(resultFromDispatcherExit({ exitCode: 127, stderr: 'eslint-unavailable\n' })).toEqual({
      result: SENSOR_RESULT.PASS,
      detail: {
        toolUnavailable: true,
        exitCode: 127,
        reason: 'eslint is not available here, so the check did not run',
      },
    });
  });
  it('passes exit 127 and names the missing config', () => {
    expect(resultFromDispatcherExit({ exitCode: 127, stderr: 'no-eslint-config\n' })).toEqual({
      result: SENSOR_RESULT.PASS,
      detail: {
        toolUnavailable: true,
        exitCode: 127,
        reason: 'no eslint configuration was found, so the check did not run',
      },
    });
  });
  it('reads the type-check sensor marker with the same rule', () => {
    expect(
      resultFromDispatcherExit({ exitCode: 127, stderr: 'tsc-unavailable' }).detail.reason,
    ).toBe('tsc is not available here, so the check did not run');
  });
  it('quotes an unrecognised 127 marker rather than dropping it', () => {
    expect(
      resultFromDispatcherExit({ exitCode: 127, stderr: 'something else entirely' }).detail.reason,
    ).toBe(
      'the sensor reported its tool unavailable ("something else entirely"), so the check did not run',
    );
  });
  it('still passes 127 when the script wrote no stderr', () => {
    expect(resultFromDispatcherExit({ exitCode: 127, stderr: '' })).toMatchObject({
      result: SENSOR_RESULT.PASS,
      detail: { reason: 'the sensor reported its tool unavailable, so the check did not run' },
    });
  });
  it('reports a script error as the FAIL it already was, plus the exit code and stderr', () => {
    expect(resultFromDispatcherExit({ exitCode: 1, stderr: 'eslint-bad-output\n' })).toEqual({
      result: SENSOR_RESULT.FAIL,
      detail: {
        scriptError: true,
        exitCode: 1,
        reason: 'the sensor script exited 1 without a verdict',
        stderr: 'eslint-bad-output',
      },
    });
  });
  it('keeps the config-parse-error exit the linter reserves for a broken config', () => {
    expect(
      resultFromDispatcherExit({
        exitCode: 2,
        stderr: 'config-parse-error: SyntaxError: Unexpected token',
      }),
    ).toMatchObject({
      result: SENSOR_RESULT.INCONCLUSIVE,
      detail: { exitCode: 2, stderr: 'config-parse-error: SyntaxError: Unexpected token' },
    });
  });
  it('bounds the stderr it keeps so a stack trace per file cannot grow the row', () => {
    const detail = resultFromDispatcherExit({ exitCode: 1, stderr: 'x'.repeat(5000) }).detail;
    expect(detail.stderr).toHaveLength(401);
    expect(detail.stderr.endsWith('\u2026')).toBe(true);
  });
  it('omits stderr entirely when the script wrote none', () => {
    expect(resultFromDispatcherExit({ exitCode: 1, stderr: '   ' }).detail).not.toHaveProperty(
      'stderr',
    );
  });
});

// The gate finding and the activity note read the SENSOR-level reason, so the
// per-file reasons are summarized there — the staging run showed 43 files with
// no reason anywhere on the record.
describe('dispatcherExitReason', () => {
  const row = (detail) => ({ file: 'a.ts', detail });

  it('names the one reason a whole sweep hit', () => {
    const reason = dispatcherExitReason(
      [
        row({ toolUnavailable: true, reason: 'eslint is not available here' }),
        row({ toolUnavailable: true, reason: 'eslint is not available here' }),
      ],
      2,
    );
    expect(reason).toBe('2 of 2 files: eslint is not available here');
  });
  it('counts only the files the contract explained', () => {
    const reason = dispatcherExitReason(
      [row({ pass: true }), row({ scriptError: true, reason: 'exited 1' })],
      2,
    );
    expect(reason).toBe('1 of 2 files: exited 1');
  });
  it('counts the reasons past the first few instead of listing them all', () => {
    const rows = ['a', 'b', 'c', 'd'].map((r) => row({ scriptError: true, reason: r }));
    expect(dispatcherExitReason(rows, 4)).toBe('4 of 4 files: a; b; c (+1 more)');
  });
  it('is null when nothing hit a documented exit', () => {
    expect(dispatcherExitReason([row({ pass: true })], 1)).toBeNull();
    expect(dispatcherExitReason([], 0)).toBeNull();
  });
});
