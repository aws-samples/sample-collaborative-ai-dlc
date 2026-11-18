// Shown next to a model picker whose list is not the current one: the lookup
// failed and the capabilities endpoint returned the last list it read
// (`source: 'cached'`). Without it a cached list looks current.

import type { ModelListSource } from '@/services/agents';

export const CACHED_MODEL_LIST_NOTE =
  'Could not read the current model list — showing the last list read.';
/** For the narrow per-tier table header. */
export const CACHED_MODEL_LIST_NOTE_SHORT = 'Not current — last list read';

interface Props {
  source?: ModelListSource;
  short?: boolean;
  'data-testid'?: string;
}

export function CachedModelListNote({ source, short = false, 'data-testid': testId }: Props) {
  if (source !== 'cached') return null;
  return (
    <p data-testid={testId} className="text-[11px] font-normal text-muted-foreground">
      {short ? CACHED_MODEL_LIST_NOTE_SHORT : CACHED_MODEL_LIST_NOTE}
    </p>
  );
}
