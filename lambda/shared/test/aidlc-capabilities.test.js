import { describe, expect, it } from 'vitest';
import {
  AIDLC_CAPABILITIES,
  FRONTMATTER_ENUMS,
  RUNTIME_HANDLERS,
  unhonouredValues,
} from '../aidlc-capabilities.js';
import { STAGE_MODES } from '../blocks.js';

describe('release capability descriptions', () => {
  it('keeps a unique description row for each adapted field', () => {
    const keys = AIDLC_CAPABILITIES.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of AIDLC_CAPABILITIES) {
      expect(entry.key).toBe(`${entry.blockType}:${entry.field}`);
    }
  });

  it('keeps the authored stage-mode vocabulary aligned with the block validator', () => {
    expect(FRONTMATTER_ENUMS.STAGE.mode).toEqual([...STAGE_MODES]);
    expect(
      Object.keys(AIDLC_CAPABILITIES.find((entry) => entry.key === 'STAGE:mode').values),
    ).toEqual([...STAGE_MODES]);
  });

  it('classifies mode values against the handlers registered in this build', () => {
    expect(RUNTIME_HANDLERS).toContain('stage.mode.single-session@v1');
    expect(RUNTIME_HANDLERS).toContain('workspace.always-restored@v1');
    const modes = AIDLC_CAPABILITIES.find((entry) => entry.key === 'STAGE:mode');
    for (const mode of STAGE_MODES) {
      const classification = modes.values[mode];
      const implemented = Boolean(
        classification.handler && RUNTIME_HANDLERS.has(classification.handler),
      );
      expect(['native', 'approximated'].includes(classification.handling)).toBe(implemented);
    }
  });

  it('preserves authored fidelity gaps and reevaluates them against this build', () => {
    const gaps = [
      { blockType: 'STAGE', field: 'mode', value: 'pipeline' },
      { blockType: 'STAGE', field: 'mode', value: 'inline' },
      { blockType: 'UNKNOWN', field: 'future', value: 'value' },
    ];
    const modes = AIDLC_CAPABILITIES.find((entry) => entry.key === 'STAGE:mode');
    const expected = gaps.filter((gap) => {
      if (gap.blockType !== 'STAGE' || gap.field !== 'mode') return true;
      const handler = modes.values[gap.value]?.handler;
      return !handler || !RUNTIME_HANDLERS.has(handler);
    });
    expect(unhonouredValues({ fidelityGaps: gaps })).toEqual(expected);
  });
});
