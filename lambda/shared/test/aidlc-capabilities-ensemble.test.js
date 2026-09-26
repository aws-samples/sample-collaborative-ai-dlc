// The capability registry's view of the ensemble runtime seam.
//
// The registry is the ONE place that says which runtime seam honours an authored
// value. A second seam handles `STAGE.mode: pipeline | mob` —
// real per-persona sessions instead of a single session playing every persona —
// and these tests pin that the registry names it, that the seam id is registered,
// and that nothing else in the mode row moved.
//
// `pipeline`/`mob` are approximated because dispatch is serial, blindness is
// enforced through brief content, and contributions are graph artifacts. The
// compatibility tests verify that classification alongside this seam.

import { describe, expect, it } from 'vitest';
import {
  AIDLC_CAPABILITIES,
  RUNTIME_HANDLERS,
  capabilityFor,
  unhandledCapabilities,
} from '../aidlc-capabilities.js';
import { SESSION_ENSEMBLE_MODES } from '../../agentcore/ensemble-runner.js';

const modeValues = () => capabilityFor('STAGE:mode').values;

describe('aidlc-capabilities — the ensemble-sessions seam', () => {
  it('registers the seam id the runtime actually implements', () => {
    expect(RUNTIME_HANDLERS.has('stage.mode.ensemble-sessions@v1')).toBe(true);
  });

  it('names that seam for pipeline and mob', () => {
    for (const mode of ['pipeline', 'mob']) {
      expect(modeValues()[mode].handler).toBe('stage.mode.ensemble-sessions@v1');
    }
  });

  it('leaves the single-session modes on their own seam', () => {
    for (const mode of ['inline', 'subagent']) {
      expect(modeValues()[mode]).toEqual({
        handling: 'native',
        handler: 'stage.mode.single-session@v1',
      });
    }
  });

  // The runtime treats `subagent` as an ensemble topology ONLY when the stage
  // declares supports, so the registry row stays `single-session`: the row
  // classifies the authored value, and a lead-only `subagent` is exactly one
  // session. This test exists so that pairing cannot drift silently.
  it('covers every mode the runtime can run as an ensemble', () => {
    for (const mode of SESSION_ENSEMBLE_MODES) {
      expect(modeValues()[mode]).toBeDefined();
      expect(modeValues()[mode].handler).not.toBeNull();
    }
    expect(SESSION_ENSEMBLE_MODES).toContain('subagent');
    expect(modeValues().subagent.handler).toBe('stage.mode.single-session@v1');
  });

  // Approximated: each persona gets its own session and a brief that decides who
  // sees whose work, but personas run serially (never concurrently), blindness is
  // brief-enforced rather than hook-enforced, and contributions are graph
  // artifacts rather than `.aidlc-engine/**` files — residual deviations named in
  // the capability note.
  it('classifies pipeline and mob approximated, with the residual deviations stated', () => {
    for (const mode of ['pipeline', 'mob']) {
      expect(modeValues()[mode]).toEqual({
        handling: 'approximated',
        handler: 'stage.mode.ensemble-sessions@v1',
      });
    }
    const note = capabilityFor('STAGE:mode').note;
    expect(note).toContain('REAL separate sessions per persona');
    expect(note).toContain('serially');
    expect(note).toContain('V2_ENSEMBLE_SESSIONS=off');
  });

  it('still refuses agent-team outright', () => {
    expect(modeValues()['agent-team']).toEqual({ handling: 'unsupported', handler: null });
  });

  // The defence-in-depth check at plan load: a mode row whose seams are all
  // registered must never be reported as an unhandled capability.
  it('does not report the mode row as unhandled', () => {
    expect(
      unhandledCapabilities({
        capabilities: { 'STAGE:mode': true },
        registry: AIDLC_CAPABILITIES,
        handlers: RUNTIME_HANDLERS,
      }),
    ).not.toContain('STAGE:mode');
  });

  it('reports the mode row as unhandled in a build that lost the seam', () => {
    const handlers = new Set(
      [...RUNTIME_HANDLERS].filter((id) => id !== 'stage.mode.ensemble-sessions@v1'),
    );
    expect(
      unhandledCapabilities({
        capabilities: { 'STAGE:mode': true },
        registry: AIDLC_CAPABILITIES,
        handlers,
      }),
    ).toContain('STAGE:mode');
  });
});
