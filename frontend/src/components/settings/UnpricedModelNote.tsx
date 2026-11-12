// Shown below a model picker when the selected model has no price in the AWS
// Price List table (`priced: false` from the capabilities endpoint). The model
// stays selectable; its usage is recorded and its cost shows as unavailable.

import type { AgentModel } from '@/services/agents';

export const UNPRICED_MODEL_NOTE = 'Cost estimate unavailable for this model';

interface Props {
  /** The options the picker offers. */
  options: AgentModel[];
  /** The selected model id ('' when the picker is on its default). */
  selected: string;
  'data-testid'?: string;
}

export function UnpricedModelNote({ options, selected, 'data-testid': testId }: Props) {
  if (!selected) return null;
  if (options.find((option) => option.id === selected)?.priced !== false) return null;
  return (
    <p data-testid={testId} className="text-[11px] text-muted-foreground">
      {UNPRICED_MODEL_NOTE}
    </p>
  );
}
