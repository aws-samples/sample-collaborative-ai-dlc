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
): string {
  switch (section) {
    case 'work':
      return `/space/${projectId}/intent/${intentId}`;
    case 'graph':
      return `/space/${projectId}/intent/${intentId}/graph`;
    case 'overview':
    default:
      return `/space/${projectId}/intent/${intentId}/observability`;
  }
}
