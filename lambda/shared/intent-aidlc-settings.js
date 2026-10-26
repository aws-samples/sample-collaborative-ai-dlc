// Per-intent AI-DLC settings — the four 2.11.0 scope switches a project member
// may choose for one intent.
//
// A setting is a TEAM decision about one intent, and it is ORDINARY DRAFT
// SELECTION STATE: it lives beside `scope`, `composedGrid` and `skipStageIds` in
// the collaborative document, travels in the same debounced `PATCH` under the
// same draft-revision CAS, and is flushed by the same barrier before Start.
// There is deliberately no second write path, no server answer published back
// into the shared document and no per-setting provenance record — those were the
// mechanisms that made the settings race the selection they depend on.
//
// Three consequences worth stating, because they are the contract:
//   - it is read-only once the intent leaves DRAFT (the intents API answers 409
//     `settings_locked`), because a mid-run settings change is refused by name
//     in the dialect annex;
//   - no MCP tool writes it — the only write path is the authenticated intent
//     API, which is asserted against the tool surface;
//   - ONLY DELTAS FROM THE SCOPE DEFAULT ARE STORED. A value equal to the
//     scope's own default is not an override, so it is not persisted. That is
//     what makes every later statement about a setting's origin true: there is
//     no stored state capable of claiming a value came from a scope that does
//     not supply it. The cost is that an explicit choice which happens to equal
//     the default is not retained across a later scope change — the same
//     semantics `composedGrid` already has relative to `scope`.
//
// Who changed a setting is recorded in the intent's append-only timeline by the
// `PATCH` that changed it, and shown live by the existing awareness presence. It
// is never frozen into a pinned plan.
//
// The legal values are NOT duplicated here: each setting names the capability
// registry entry whose value set the importer already validates, so the API's
// 400, the plan's `policy_enum_invalid` and the UI's options are one vocabulary.

import { capabilityFor } from './aidlc-capabilities.js';

// setting key (and plan/META key) → the SCOPE capability it overrides.
const AIDLC_SETTING_CAPABILITIES = Object.freeze({
  guardPolicy: 'SCOPE:guard_policy',
  planApproval: 'SCOPE:plan_approval',
  collaborators: 'SCOPE:collaborators',
  existingCode: 'SCOPE:existing_code',
});

const AIDLC_SETTING_KEYS = Object.freeze(Object.keys(AIDLC_SETTING_CAPABILITIES));

const aidlcSettingValues = (key) =>
  Object.keys(capabilityFor(AIDLC_SETTING_CAPABILITIES[key])?.values ?? {});

// The type the methodology authors the setting as, from the same registry entry
// that owns its values. Three settings are text switches; `existing_code` is a
// YAML boolean.
const aidlcSettingType = (key) =>
  capabilityFor(AIDLC_SETTING_CAPABILITIES[key])?.authoredType ?? 'string';

// The authored field name the methodology itself uses, for a prompt or a notice
// that has to speak the scope file's words rather than ours.
const aidlcSettingField = (key) => capabilityFor(AIDLC_SETTING_CAPABILITIES[key])?.field ?? key;

// The authored value of each setting the resolved SCOPE block carries. Absent
// keys are omitted rather than nulled: "the release does not author this
// setting" and "the release authored it off" are different facts, and only the
// first one may hide the setting from a human.
const scopeAidlcSettings = (scopeBlock) => {
  const authored = {};
  if (!scopeBlock) return authored;
  for (const key of AIDLC_SETTING_KEYS) {
    if (scopeBlock[key] != null) authored[key] = scopeBlock[key];
  }
  return authored;
};

// THE normalisation, run identically by the client before it writes into the
// shared document and by the server before it stores anything — the same
// mirroring `setComposedGrid` already does for the server's skip pruning. Three
// rules, in this order:
//
//   1. a key the EFFECTIVE selection does not author is DROPPED and named, so
//      the UI can say which choice a scope change withdrew;
//   2. a value outside the key's vocabulary or authored type is REJECTED, which
//      is a caller sending something no runtime consumer could act on;
//   3. a value equal to the authored default is OMITTED — it is not an
//      override, and storing it is what would later let the platform claim a
//      value came from a scope that does not supply it.
//
// `settings: null` clears every override. An empty result is `null` so an intent
// with no overrides keeps exactly the attributes it always had.
const normalizeAidlcSettings = ({ settings, authored = null }) => {
  if (settings === null || settings === undefined) return { value: null, dropped: [] };
  if (typeof settings !== 'object' || Array.isArray(settings)) {
    return {
      error: {
        code: 'aidlc_settings_invalid',
        message: 'aidlcSettings must be an object of setting values or null',
      },
    };
  }
  const value = {};
  const dropped = [];
  for (const [key, raw] of Object.entries(settings)) {
    if (!AIDLC_SETTING_KEYS.includes(key)) {
      return {
        error: {
          code: 'aidlc_setting_unknown',
          message: `Unknown AI-DLC setting "${key}"; this intent accepts ${AIDLC_SETTING_KEYS.join(' | ')}`,
          field: key,
        },
      };
    }
    if (raw === null || raw === undefined) continue;
    if (!authored || !Object.hasOwn(authored, key)) {
      dropped.push({ key, value: raw });
      continue;
    }
    const allowed = aidlcSettingValues(key);
    const authoredType = aidlcSettingType(key);
    // The stored value keeps the methodology's own type so the plan reads
    // exactly what the scope would have given it, which makes the type part of
    // the contract: every runtime consumer compares with `===`, so a stored
    // `['off']` matches no branch and `'true'` is not `true`. Comparing the
    // text alone accepted both.
    if (typeof raw !== authoredType) {
      return {
        error: {
          code: 'aidlc_setting_invalid',
          message: `AI-DLC setting "${key}" must be authored as ${authoredType === 'boolean' ? 'true or false' : 'one of ' + allowed.join(' | ')}`,
          field: key,
          values: allowed,
        },
      };
    }
    // Compared as text because one authored value is a YAML boolean
    // (`existing_code: true`).
    if (!allowed.includes(String(raw))) {
      return {
        error: {
          code: 'aidlc_setting_invalid',
          message: `AI-DLC setting "${key}" must be one of ${allowed.join(' | ')}`,
          field: key,
          values: allowed,
        },
      };
    }
    if (String(raw) === String(authored[key])) continue;
    value[key] = raw;
  }
  return { value: Object.keys(value).length > 0 ? value : null, dropped };
};

// One plain-language line per changed key, for the intent timeline. The actor is
// supplied by the caller — it is the authenticated member whose write produced
// the change — and never read out of stored state, which is what stops an old
// record from attributing a change nobody made.
//
// `dropped` is the keys the caller's payload still carried and the new
// selection does not author. A key the new selection does not author is a
// WITHDRAWAL however it disappeared — the page prunes it locally before saving,
// so by the time the write arrives the payload no longer carries it and
// `dropped` is empty — which is why the authored map, not `dropped` alone,
// decides which sentence applies. A member whose stricter guard just vanished
// is told it was withdrawn, not that it returned to a default the scope does
// not have.
const describeAidlcSettingsChange = ({
  previous = null,
  next = null,
  authored = null,
  dropped = [],
  scope = null,
}) => {
  const where = scope ? `the ${scope} scope` : 'the selected scope';
  const lines = [];
  const withdrawn = new Set(dropped.map(({ key }) => key));
  for (const key of AIDLC_SETTING_KEYS) {
    const field = aidlcSettingField(key);
    const before = previous?.[key];
    const after = next?.[key];
    if (String(before ?? '—') === String(after ?? '—')) continue;
    if (after === undefined || after === null) {
      const unauthored = !authored || !Object.hasOwn(authored, key);
      lines.push(
        withdrawn.has(key) || unauthored
          ? `${field} withdrawn: ${where} does not offer it`
          : `${field} returned to ${where} default (${String(authored?.[key] ?? 'unset')})`,
      );
      continue;
    }
    lines.push(
      `${field} set to ${String(after)} for this intent (${where} default: ${String(
        authored?.[key] ?? 'unset',
      )})`,
    );
  }
  return lines;
};

// The EFFECTIVE settings as prompt rows: the authored field name the
// methodology itself uses, the value in force, and whether that value is the
// scope's own or an override recorded for this intent. This is the honest half
// of upstream's `engine config get` — the composer reads the effective settings
// out of its prompt, and the dialect annex forbids it looking for them in a
// settings or environment file, which upstream warns can hold credentials.
//
// Effective means the SELECTED SCOPE's own value with any override on top, which
// is what the run resolves. Rendering only the overrides made the section a list
// of deltas while calling itself the whole truth: an intent that changed one
// setting showed that one and hid the rest, and an intent that changed none
// produced no section at all — leaving the composer to conclude the release has
// no such settings.
const effectiveAidlcSettingRows = (settings, authored = null) => {
  const rows = [];
  for (const key of AIDLC_SETTING_KEYS) {
    const override = settings?.[key];
    const value = override ?? authored?.[key];
    if (value == null) continue;
    rows.push({
      name: aidlcSettingField(key),
      value: String(value),
      source: override == null ? 'scope default' : 'changed for this intent',
    });
  }
  return rows;
};

// The per-intent settings a composer proposal proposes, mapped onto the keys a
// human may actually choose here. Guard Policy and two of the six ceremony
// settings have a per-intent surface; the rest are reported to the member
// instead (`composeSettingsWithoutIntentSurface`) rather than being dropped, so
// a proposal is never silently thinner than what the composer sent.
const COMPOSE_PROPOSAL_SETTING_SOURCES = Object.freeze({
  planApproval: 'plan_approval',
  collaborators: 'collaborators',
});

const aidlcSettingsFromComposeProposal = (proposal) => {
  const proposed = {};
  if (!proposal) return proposed;
  if (proposal.guardPolicy != null) proposed.guardPolicy = proposal.guardPolicy;
  for (const [key, authoredName] of Object.entries(COMPOSE_PROPOSAL_SETTING_SOURCES)) {
    const value = proposal.scopeSettings?.[authoredName];
    if (value != null) proposed[key] = value;
  }
  return proposed;
};

// The settings a proposal carries that this platform does not make per-intent:
// they stay visible on the proposal for the member to read and keep following
// the scope. Named, never dropped.
const composeSettingsWithoutIntentSurface = (proposal) =>
  Object.entries(proposal?.scopeSettings ?? {})
    .filter(([key]) => !Object.values(COMPOSE_PROPOSAL_SETTING_SOURCES).includes(key))
    .map(([key, value]) => ({ name: key, value: String(value) }));

export {
  AIDLC_SETTING_CAPABILITIES,
  AIDLC_SETTING_KEYS,
  aidlcSettingField,
  aidlcSettingType,
  aidlcSettingValues,
  aidlcSettingsFromComposeProposal,
  composeSettingsWithoutIntentSurface,
  describeAidlcSettingsChange,
  effectiveAidlcSettingRows,
  normalizeAidlcSettings,
  scopeAidlcSettings,
};
