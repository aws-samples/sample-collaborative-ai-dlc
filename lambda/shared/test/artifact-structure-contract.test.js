import { describe, it, expect } from 'vitest';
import {
  renderStructureContract,
  renderStructureContracts,
  exampleItem,
  UNITS_DAG_CONTRACT,
} from '../artifact-structure-contract.js';
import { REGISTRY, extractArtifactStructure } from '../artifact-extractors.js';
import { parseBoltDag } from '../v2-sensor-contract.js';
import upstreamSnapshot from '../upstream-artifact-ids.json' with { type: 'json' };

// Pull the fenced YAML block(s) out of rendered contract markdown.
const fencedBlocks = (md) => [...String(md).matchAll(/```yaml\n([\s\S]*?)\n```/g)].map((m) => m[1]);

describe('renderStructureContract — registry round-trip (drift-proof)', () => {
  // THE invariant: every rendered example, embedded in a minimal artifact,
  // must parse back through the extraction registry with zero errors and at
  // least one typed item. If a registry doc and its parser ever drift, this
  // fails.
  for (const [artifactType, spec] of Object.entries(REGISTRY)) {
    it(`round-trips the ${artifactType} example through the extractor`, () => {
      const contract = renderStructureContract(artifactType);
      expect(contract).toBeTruthy();
      const blocks = fencedBlocks(contract);
      // unit-of-work-dependency renders TWO blocks (units: + contracts:).
      const block = blocks.find((b) => b.startsWith(`${spec.key}:`));
      expect(block, `no ${spec.key}: example block rendered`).toBeTruthy();
      const content = `## Overview\ntext\n\n## Detail\ntext\n\n\`\`\`yaml\n${block}\n\`\`\`\n`;
      const extraction = extractArtifactStructure({ artifactType, artifactId: 'a1', content });
      expect(extraction.error).toBeNull();
      expect(extraction.structuredPresent).toBe(true);
      expect(extraction.items.length).toBeGreaterThan(0);
      // Required doc fields must actually appear in the example item —
      // an example that omits a required field teaches agents the wrong shape.
      const example = exampleItem(spec.doc);
      for (const field of spec.doc.fields.filter((f) => f.required)) {
        expect(
          example[field.name],
          `${artifactType} example missing required ${field.name}`,
        ).toBeDefined();
      }
    });
  }

  it('the units: DAG example parses through parseBoltDag (scheduling contract)', () => {
    const block = fencedBlocks(UNITS_DAG_CONTRACT)[0];
    const dag = parseBoltDag(`## Units\n\n\`\`\`yaml\n${block}\n\`\`\`\n`);
    expect(dag.ok).toBe(true);
    expect(dag.units.map((u) => u.name).toSorted()).toEqual(['auth', 'billing']);
  });

  it('unit-of-work-dependency renders BOTH the units: and contracts: contracts', () => {
    const contract = renderStructureContract('unit-of-work-dependency');
    expect(contract).toContain('`units:`');
    expect(contract).toContain('`contracts:`');
    expect(contract).toContain('REQUIRED — the stage fails without it');
  });

  it('returns null for an unregistered type', () => {
    expect(renderStructureContract('walking-skeleton-notes')).toBeNull();
  });
});

describe('renderStructureContracts (prompt section)', () => {
  it('renders one section per registered output type, deduped, with the generic rules', () => {
    const md = renderStructureContracts(['stories', 'stories', 'personas', 'not-registered']);
    expect(md).toContain('# Artifact structure contracts');
    expect(md).toContain('at least two `##` section headings');
    expect(md).toContain('[[artifact-slug]]');
    expect(md.match(/## Structure contract — stories/g)).toHaveLength(1);
    expect(md).toContain('## Structure contract — personas');
    expect(md).not.toContain('not-registered');
  });

  it('returns null when no output type is registered (no boilerplate injection)', () => {
    expect(renderStructureContracts(['code-review-notes'])).toBeNull();
    expect(renderStructureContracts([])).toBeNull();
    expect(renderStructureContracts()).toBeNull();
  });
});

// ── Pin-drift guard ──
// The snapshot (lambda/shared/upstream-artifact-ids.json) is GENERATED from
// the pinned awslabs/aidlc-workflows ref by scripts/snapshot-upstream-artifacts.mjs.
// If a ref bump renames the artifacts the registry keys target, these tests
// fail loud in CI — the alternative is structure contracts silently never
// injecting and typed extraction silently never firing.
describe('extraction registry ↔ pinned upstream workflow alignment', () => {
  const upstreamIds = new Set(upstreamSnapshot.artifactIds);

  it('every registry key is a REAL artifact id at the pinned ref', () => {
    for (const key of Object.keys(REGISTRY)) {
      expect(
        upstreamIds.has(key),
        `registry key "${key}" is not produced by any pinned upstream stage — regenerate the snapshot (scripts/snapshot-upstream-artifacts.mjs) and realign the registry`,
      ).toBe(true);
    }
  });

  it('the snapshot ref matches the terraform pin', async () => {
    const { readFile } = await import('node:fs/promises');
    const tf = await readFile(new URL('../../../terraform/variables.tf', import.meta.url), 'utf8');
    const pinned = /variable "aidlc_repo_ref"[\s\S]*?default\s*=\s*"([^"]+)"/.exec(tf)?.[1];
    expect(pinned, 'aidlc_repo_ref default not found in terraform/variables.tf').toBeTruthy();
    expect(
      upstreamSnapshot.ref,
      'snapshot is stale — rerun scripts/snapshot-upstream-artifacts.mjs after the ref bump',
    ).toBe(pinned);
  });

  it('the scheduling-critical DAG artifact is produced by units-generation', () => {
    // promote-units + the blocking units: sensor hang off this exact id.
    expect(upstreamSnapshot.producesByStage['units-generation']).toContain(
      'unit-of-work-dependency',
    );
    expect(upstreamSnapshot.producesByStage['units-generation']).toContain(
      'unit-of-work-story-map',
    );
  });
});
