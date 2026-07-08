import { describe, it, expect } from 'vitest';
import {
  SENSOR_RESULT,
  sensorKind,
  severityGate,
  validateScriptSpec,
  resultFromExit,
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
});

describe('resultFromExit', () => {
  it('maps the convention', () => {
    expect(resultFromExit(0)).toBe(SENSOR_RESULT.PASS);
    expect(resultFromExit(2)).toBe(SENSOR_RESULT.INCONCLUSIVE);
    expect(resultFromExit(1)).toBe(SENSOR_RESULT.FAIL);
    expect(resultFromExit(null)).toBe(SENSOR_RESULT.BLOCKED);
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
});
