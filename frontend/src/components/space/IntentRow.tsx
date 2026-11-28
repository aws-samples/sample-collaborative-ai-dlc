import type { Intent } from '@/services/intents';
import { isUntitledIntent } from './intentGrouping';

export function intentRowTitle(intent: Pick<Intent, 'title' | 'status'>): string {
  if (!isUntitledIntent(intent.title)) return intent.title as string;
  return intent.status === 'DRAFT' ? 'Untitled draft' : 'Untitled intent';
}
