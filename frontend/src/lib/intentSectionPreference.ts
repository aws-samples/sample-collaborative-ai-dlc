export type IntentSection = 'overview' | 'work' | 'graph';

const VALID_SECTIONS: ReadonlySet<IntentSection> = new Set(['overview', 'work', 'graph']);
const STORAGE_KEY_PREFIX = 'aidlc.intentSection.v2.';

export function getLastIntentSection(intentId: string): IntentSection {
  try {
    const value = localStorage.getItem(`${STORAGE_KEY_PREFIX}${intentId}`);
    return value && VALID_SECTIONS.has(value as IntentSection)
      ? (value as IntentSection)
      : 'overview';
  } catch {
    return 'overview';
  }
}

export function setLastIntentSection(intentId: string, section: IntentSection): void {
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${intentId}`, section);
  } catch {
    /* best-effort persistence */
  }
}

export function intentSectionPath(
  projectId: string,
  intentId: string,
  section: IntentSection,
  backend: 'platform' | 'native' = 'platform',
): string {
  const base = `/space/${encodeURIComponent(projectId)}/${backend === 'native' ? 'native-intent' : 'intent'}/${encodeURIComponent(intentId)}`;
  switch (section) {
    case 'work':
      return base;
    case 'graph':
      return `${base}/graph`;
    case 'overview':
    default:
      return `${base}/observability`;
  }
}
