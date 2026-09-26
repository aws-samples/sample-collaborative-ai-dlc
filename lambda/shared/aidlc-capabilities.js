// Release-description registry. It records the final authored-value vocabulary
// while only claiming the runtime behavior implemented by the versions layer.
// Later workflow layers add their handlers alongside the code that honours them.

import { STAGE_MODES } from './blocks.js';

const RUNTIME_HANDLERS = Object.freeze(
  new Set(['stage.mode.single-session@v1', 'workspace.always-restored@v1']),
);

const UNHANDLED = Object.freeze({ handling: 'unsupported', handler: null });
const singleSession = Object.freeze({
  handling: 'native',
  handler: 'stage.mode.single-session@v1',
});
const alwaysRestored = Object.freeze({
  handling: 'approximated',
  handler: 'workspace.always-restored@v1',
});

const definitions = [
  ['SENSOR', 'fire_on', 'fireOn', ['write', 'gate']],
  ['STAGE', 'mode', 'mode', STAGE_MODES],
  ['STAGE', 'workspace_requires', null, null],
  ['STAGE', 'review_class', 'reviewClass', ['adversarial', 'advisory']],
  ['STAGE', 'review_artifact', 'reviewArtifact', null],
  ['STAGE', 'summary_confirmation', 'summaryConfirmation', ['required', 'if-present']],
  ['AGENT', 'maxTurns', 'maxTurns', null],
  ['SCOPE', 'sensors', 'sensorsPolicy', ['on', 'off']],
  ['SCOPE', 'review_cap', 'reviewCap', ['none', 'advisory', 'adversarial']],
  ['SCOPE', 'summary_confirmation', 'summaryConfirmation', ['on', 'off']],
  ['SCOPE', 'change_control', 'changeControl', ['strict', 'relaxed']],
  ['SCOPE', 'learnings', 'learnings', ['on', 'off']],
  ['SCOPE', 'skeleton', 'skeleton', ['on', 'off']],
  ['SCOPE', 'runner', 'runner', null],
];

const classify = (blockType, field, value) => {
  if (blockType === 'STAGE' && field === 'mode') {
    if (value === 'inline' || value === 'subagent') return singleSession;
    return UNHANDLED;
  }
  if (blockType === 'STAGE' && field === 'workspace_requires') return alwaysRestored;
  return UNHANDLED;
};

const AIDLC_CAPABILITIES = Object.freeze(
  definitions.map(([blockType, field, planKey, valueKeys]) => {
    const key = `${blockType}:${field}`;
    const fallback = classify(blockType, field, null);
    const values = valueKeys
      ? Object.freeze(
          Object.fromEntries(valueKeys.map((value) => [value, classify(blockType, field, value)])),
        )
      : null;
    return Object.freeze({
      key,
      blockType,
      field,
      planKey,
      handling: fallback.handling,
      handler: fallback.handler,
      values,
      note: 'Recorded from the imported release; unsupported authored behavior blocks promotion until a runtime handler ships.',
    });
  }),
);

const FIELD_FIDELITY = Object.freeze(
  AIDLC_CAPABILITIES.map((entry) =>
    Object.freeze({
      blockType: entry.blockType,
      field: entry.field,
      handling: entry.handling,
      ...(entry.values
        ? {
            values: Object.freeze(
              Object.fromEntries(
                Object.entries(entry.values).map(([value, classification]) => [
                  value,
                  classification.handling,
                ]),
              ),
            ),
          }
        : {}),
      note: entry.note,
    }),
  ),
);

const FRONTMATTER_ENUMS = Object.freeze(
  Object.fromEntries(
    [...new Set(AIDLC_CAPABILITIES.map((entry) => entry.blockType))]
      .map((blockType) => [
        blockType,
        Object.freeze(
          Object.fromEntries(
            AIDLC_CAPABILITIES.filter((entry) => entry.blockType === blockType && entry.values).map(
              (entry) => [entry.field, Object.freeze(Object.keys(entry.values))],
            ),
          ),
        ),
      ])
      .filter(([, byField]) => Object.keys(byField).length > 0),
  ),
);

const unhonouredValues = ({
  fidelityGaps = [],
  registry = AIDLC_CAPABILITIES,
  handlers = RUNTIME_HANDLERS,
} = {}) =>
  fidelityGaps.filter((gap) => {
    const entry = registry.find(
      (candidate) => candidate.blockType === gap.blockType && candidate.field === gap.field,
    );
    if (!entry) return true;
    const classification =
      (typeof gap.value === 'string' ? entry.values?.[gap.value] : null) ?? entry;
    return (
      classification.handling === 'unsupported' ||
      classification.handler == null ||
      !handlers.has(classification.handler)
    );
  });

export {
  AIDLC_CAPABILITIES,
  FIELD_FIDELITY,
  FRONTMATTER_ENUMS,
  RUNTIME_HANDLERS,
  unhonouredValues,
};

export default {
  AIDLC_CAPABILITIES,
  FIELD_FIDELITY,
  FRONTMATTER_ENUMS,
  RUNTIME_HANDLERS,
  unhonouredValues,
};
