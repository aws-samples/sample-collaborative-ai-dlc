const PLACEHOLDER_TITLES = new Set(['title', 'untitled', 'i want to do xyz']);

export function isUntitledIntent(title: string | null | undefined): boolean {
  const trimmed = (title ?? '').trim();
  return trimmed === '' || PLACEHOLDER_TITLES.has(trimmed.toLowerCase());
}
