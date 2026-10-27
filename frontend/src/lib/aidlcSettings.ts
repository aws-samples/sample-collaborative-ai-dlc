// The per-intent AI-DLC settings as the compose page knows them.
//
// `normalizeAidlcSettings` is the CLIENT HALF of the server's rule of the same
// name (`lambda/shared/intent-aidlc-settings.js`), implemented once here and run
// before anything is written into the shared document — the same mirroring
// `setComposedGrid` already does for the server's skip pruning. Keeping the two
// in step is what makes the document's settings and the stored settings the same
// thing, so nothing has to be published back from the server to correct the
// page.
//
// Three rules, in the server's order:
//   1. a key the effective selection does not author is DROPPED and named;
//   2. a value outside the setting's own option list is REJECTED;
//   3. a value equal to the authored default is OMITTED — it is not an
//      override, and only overrides are stored.

// A setting value as the methodology authors it: a string switch, or the
// boolean `existing_code` project type.
export type AidlcSettingValue = string | boolean;

export interface AidlcSettingOption {
  value: AidlcSettingValue;
  label: string;
  help: string;
}

export interface AidlcSettingDefinition {
  key: string;
  label: string;
  description: string;
  options: AidlcSettingOption[];
}

// The options a member is offered, in the methodology's own values with our
// words. The server validates against the capability registry, so a label here
// can never widen what is accepted.
export const AIDLC_SETTING_DEFINITIONS: AidlcSettingDefinition[] = [
  {
    key: 'guardPolicy',
    label: 'Guard Policy',
    description: 'What happens when someone edits an input a stage already approved.',
    options: [
      {
        value: 'strict',
        label: 'Strict',
        help: 'Editing an approved input reopens its approval, so it is approved again before the run moves on.',
      },
      {
        value: 'relaxed',
        label: 'Relaxed',
        help: 'The run continues, and the gate shows a notice naming what changed since the approval.',
      },
      {
        value: 'off',
        label: 'Off',
        help: 'No reopen and no change notice. It never removes a human approval gate.',
      },
    ],
  },
  {
    key: 'planApproval',
    label: 'Plan Approval',
    description: 'Whether the agent presents its implementation plan for approval before building.',
    options: [
      {
        value: 'on',
        label: 'On',
        help: 'The agent asks for approval of its plan, and the stage cannot complete without it.',
      },
      {
        value: 'off',
        label: 'Off',
        help: 'The agent builds without presenting a plan. The stage still has its own approval gate.',
      },
    ],
  },
  {
    key: 'collaborators',
    label: 'Collaborators',
    description: 'Whether the stage’s support personas review the lead agent’s draft.',
    options: [
      {
        value: 'on',
        label: 'On',
        help: 'Each support persona gets its own session and reviews the draft without seeing the others.',
      },
      {
        value: 'off',
        label: 'Off',
        help: 'One session: the lead agent produces every output itself. Faster and cheaper, with no peer review.',
      },
    ],
  },
  {
    key: 'existingCode',
    label: 'Project type',
    description: 'Whether this intent works on an existing codebase or starts from nothing.',
    options: [
      {
        value: true,
        label: 'Brownfield',
        help: 'There is existing code to read, respect and extend.',
      },
      {
        value: false,
        label: 'Greenfield',
        help: 'Nothing exists yet; the agents start from a clean slate.',
      },
    ],
  },
];

export const AIDLC_SETTING_KEYS = AIDLC_SETTING_DEFINITIONS.map(({ key }) => key);

// The human label of each setting, so a page that has to NAME one outside the
// panel — a choice a scope change withdrew — uses the words the control used.
export const AIDLC_SETTING_LABELS: Record<string, string> = Object.fromEntries(
  AIDLC_SETTING_DEFINITIONS.map((definition) => [definition.key, definition.label]),
);

const definitionFor = (key: string) =>
  AIDLC_SETTING_DEFINITIONS.find((definition) => definition.key === key) ?? null;

// A select's value must be a string; the methodology authors one setting as a
// boolean, so an option value is compared as text and mapped back on change.
export const asOptionValue = (value: AidlcSettingValue) => String(value);

export const aidlcSettingOptionLabel = (key: string, value: AidlcSettingValue | undefined) => {
  if (value === undefined) return 'unset';
  return (
    definitionFor(key)?.options.find(
      (option) => asOptionValue(option.value) === asOptionValue(value),
    )?.label ?? String(value)
  );
};

// The per-intent settings a composer proposal proposes, keyed as the intent API
// keys them. Guard Policy and two of the scope settings are choices a person can
// make for one intent here; the rest are shown as what the plan follows, so a
// proposed value is never silently absent from what the member reads before
// accepting. The compose job has already proved every key here is authored by
// the proposal's own settings scope.
export const CHOOSABLE_SCOPE_SETTINGS: Record<string, string> = {
  plan_approval: 'planApproval',
  collaborators: 'collaborators',
};

export function aidlcSettingsFromComposeProposal(proposal: {
  guardPolicy?: AidlcSettingValue;
  scopeSettings?: Record<string, string>;
}): Record<string, AidlcSettingValue> {
  const settings: Record<string, AidlcSettingValue> = {};
  if (proposal.guardPolicy != null) settings.guardPolicy = proposal.guardPolicy;
  for (const [authored, key] of Object.entries(CHOOSABLE_SCOPE_SETTINGS)) {
    const value = proposal.scopeSettings?.[authored];
    if (value != null) settings[key] = value;
  }
  return settings;
}

export interface NormalizedAidlcSettings {
  value: Record<string, AidlcSettingValue> | null;
  dropped: string[];
}

export function normalizeAidlcSettings({
  settings,
  authored,
}: {
  settings: Record<string, AidlcSettingValue> | null | undefined;
  authored: Record<string, AidlcSettingValue> | null | undefined;
}): NormalizedAidlcSettings {
  if (!settings) return { value: null, dropped: [] };
  const value: Record<string, AidlcSettingValue> = {};
  const dropped: string[] = [];
  for (const [key, raw] of Object.entries(settings)) {
    if (raw === null || raw === undefined) continue;
    const definition = definitionFor(key);
    if (!definition) {
      dropped.push(key);
      continue;
    }
    if (!authored || !Object.hasOwn(authored, key)) {
      dropped.push(key);
      continue;
    }
    if (!definition.options.some((option) => asOptionValue(option.value) === asOptionValue(raw))) {
      continue;
    }
    if (asOptionValue(raw) === asOptionValue(authored[key])) continue;
    value[key] = raw;
  }
  return { value: Object.keys(value).length > 0 ? value : null, dropped };
}
