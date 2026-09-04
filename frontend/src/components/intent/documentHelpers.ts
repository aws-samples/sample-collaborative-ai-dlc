import type { IntentArtifact } from '@/services/intents';
import type { IntentStageRow } from '@/contexts/IntentContext';

export interface DocProvenance {
  stageId: string | null;
  stageLabel: string | null;
  stageOrder: number;
  phaseLabel: string;
  phasePath: string;
  unitSlug: string | null;
}

const DOCUMENT_TYPE_RE = /markdown|document|statement|research|report|notes?/i;
const MD_HEADING_RE = /^#{1,3}\s/m;

export function isDocumentArtifact(a: IntentArtifact): boolean {
  if (a.artifactType && DOCUMENT_TYPE_RE.test(a.artifactType)) return true;
  const content = a.content ?? '';
  return content.length > 600 && MD_HEADING_RE.test(content);
}

export function humanizeStageId(stageId: string): string {
  return stageId.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const SUFFIX_PAREN_RE = /\(\s*([^()]+?)\s*\)\s*$/;
const SUFFIX_DASH_RE = /[—–-]\s*([^—–()]+?)\s*$/;

function trailingSuffixToken(title: string): string | null {
  const t = title.trim();
  const paren = SUFFIX_PAREN_RE.exec(t);
  if (paren) return paren[1].trim();
  const dash = SUFFIX_DASH_RE.exec(t);
  if (dash) return dash[1].trim();
  return null;
}

export function detectDocCommonSuffix(titles: string[]): string | null {
  const counts = new Map<string, number>();
  for (const title of titles) {
    const token = trailingSuffixToken(title);
    if (token) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 1;
  for (const [token, count] of counts) {
    if (count > bestCount) {
      best = token;
      bestCount = count;
    }
  }
  return best;
}

export function stripDocSuffix(title: string, token: string | null): string {
  const t = title.trim();
  if (!token) return t;
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const paren = new RegExp(`\\s*\\(\\s*${esc}\\s*\\)\\s*$`, 'i');
  const dash = new RegExp(`\\s*[—–-]\\s*${esc}\\s*$`, 'i');
  const stripped = t.replace(paren, '').replace(dash, '').trim();
  return stripped.length > 0 ? stripped : t;
}

const NO_PHASE_PATH = '';
const NO_PHASE_LABEL = 'Other';

export function docProvenance(
  stageRows: IntentStageRow[],
  phaseNameOf: (phasePath: string) => string,
): (a: IntentArtifact) => DocProvenance {
  const rowByInstance = new Map(
    stageRows.filter((r) => r.stageInstanceId).map((r) => [r.stageInstanceId as string, r]),
  );
  return (a: IntentArtifact): DocProvenance => {
    const row = a.createdByStageInstanceId
      ? rowByInstance.get(a.createdByStageInstanceId)
      : undefined;
    const stageId = row?.stageId ?? null;
    const phasePath = row?.phase ?? null;
    return {
      stageId,
      stageLabel: stageId ? humanizeStageId(stageId) : null,
      stageOrder: row?.order ?? -1,
      phaseLabel: phasePath ? phaseNameOf(phasePath) : NO_PHASE_LABEL,
      phasePath: phasePath ?? NO_PHASE_PATH,
      unitSlug: row?.unitSlug ?? null,
    };
  };
}
