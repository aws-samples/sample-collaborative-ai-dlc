import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AIDLC_SETTING_DEFINITIONS,
  aidlcSettingOptionLabel,
  asOptionValue,
  type AidlcSettingValue,
} from '@/lib/aidlcSettings';

// The AI-DLC settings an AI-DLC release authors for the chosen scope, offered to
// the team at the compose step.
//
// What the user sees is deliberately plain: one row per setting, the option in
// the methodology's own words, a sentence saying what it actually does to the
// run, and a line saying whether the run follows the scope's own default or a
// choice made for this intent. Nothing is rendered unless the pinned release
// authors the setting, so an unpinned intent and every release before 2.11 show
// this block not at all.
//
// A row says NO NAME. A setting is ordinary collaborative selection state, like
// the scope: who is editing it right now is shown by the same awareness presence
// that shows who is editing the scope, and the intent timeline records which
// member's SAVE stored the change. That is the chooser in the normal case and a
// peer whose autosave carried it otherwise, so the panel says exactly that
// rather than promising more than the record holds. Carrying a name in the
// state is what made a retained choice describable as a scope's own default,
// which is a sentence that can become false.

interface AidlcSettingsPanelProps {
  // The settings the pinned release's chosen scope authors, with their authored
  // value — `plan.aidlcSettingsAuthored` from the execution preview.
  authored: Record<string, AidlcSettingValue> | null | undefined;
  // The overrides the team has chosen for this intent, from the shared
  // document. An absent key follows the authored default.
  chosen: Record<string, AidlcSettingValue> | null | undefined;
  disabled?: boolean;
  // `null` goes back to the authored default, which is also what the panel
  // sends when a member picks the default value itself: it is not an override,
  // so it is not stored.
  onChange: (key: string, value: AidlcSettingValue | null) => void;
}

export function AidlcSettingsPanel({
  authored,
  chosen,
  disabled = false,
  onChange,
}: AidlcSettingsPanelProps) {
  const rows = AIDLC_SETTING_DEFINITIONS.filter(
    (definition) => authored != null && Object.hasOwn(authored, definition.key),
  );
  if (rows.length === 0) return null;

  return (
    <div className="space-y-2" data-testid="aidlc-settings">
      <Label className="text-sm font-medium">AI-DLC settings</Label>
      <p className="text-xs text-muted-foreground">
        Chosen for this intent by anyone on the project, saved with the rest of the selection, and
        locked when the run starts. A setting the selected scope does not offer follows that
        scope&rsquo;s defaults instead. The intent timeline records which member&rsquo;s save stored
        a change.
      </p>
      <div className="grid gap-3 lg:grid-cols-2">
        {rows.map((definition) => {
          const authoredValue = authored![definition.key];
          const override = chosen?.[definition.key];
          const current = override ?? authoredValue;
          const option = definition.options.find(
            (item) => asOptionValue(item.value) === asOptionValue(current),
          );
          const authoredLabel = aidlcSettingOptionLabel(definition.key, authoredValue);
          const selectId = `aidlc-setting-${definition.key}`;
          const describedBy = [`${selectId}-description`, `${selectId}-source`]
            .concat(option ? [`${selectId}-help`] : [])
            .join(' ');
          return (
            <div key={definition.key} className="border rounded-md p-3 space-y-1.5">
              <Label htmlFor={selectId} className="text-sm font-medium">
                {definition.label}
              </Label>
              <p id={`${selectId}-description`} className="text-xs text-muted-foreground">
                {definition.description}
              </p>
              <Select
                value={asOptionValue(current)}
                onValueChange={(next) => {
                  const picked = definition.options.find(
                    (item) => asOptionValue(item.value) === next,
                  );
                  if (!picked) return;
                  // Picking the authored value is not an override, so it clears
                  // the entry rather than storing a value equal to the default.
                  onChange(
                    definition.key,
                    asOptionValue(picked.value) === asOptionValue(authoredValue)
                      ? null
                      : picked.value,
                  );
                }}
                disabled={disabled}
              >
                <SelectTrigger
                  id={selectId}
                  aria-label={definition.label}
                  aria-describedby={describedBy}
                >
                  <SelectValue placeholder={`Select ${definition.label}`} />
                </SelectTrigger>
                <SelectContent>
                  {definition.options.map((item) => (
                    <SelectItem key={asOptionValue(item.value)} value={asOptionValue(item.value)}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {option && (
                <p id={`${selectId}-help`} className="text-xs text-foreground">
                  {option.help}
                </p>
              )}
              <p
                id={`${selectId}-source`}
                className="text-xs text-muted-foreground"
                data-testid={`aidlc-setting-source-${definition.key}`}
              >
                {override === undefined
                  ? `Scope default — ${authoredLabel}`
                  : `Changed for this intent (scope default: ${authoredLabel})`}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
