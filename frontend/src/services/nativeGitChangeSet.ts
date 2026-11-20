import {
  decodeNativeApplicationSource,
  type NativePublication,
  type NativePublishedFile,
} from './nativeIntents';

type GitFile = NativePublishedFile & { mode: '100644' | '100755' };
export interface NativeSourceBaseline {
  id: string;
  repository: { commit: string; branch: string };
  inventory: 'native-public-files';
  files: NativePublishedFile[];
  gitChangeSet: NativeGitChangeSet | null;
}
export interface NativeGitChange {
  fileId: string;
  path: string;
  before: GitFile | null;
  after: GitFile | null;
}

function invalid(): never {
  throw new Error('The named Git change set could not be verified.');
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 2000;
const oneOf = <T extends string>(v: unknown, ...options: T[]): v is T =>
  typeof v === 'string' && options.includes(v as T);

function gitFile(
  version: unknown,
  file: NativePublishedFile | undefined,
  id: string,
): GitFile | null {
  if (version === null && !file) return null;
  if (
    !record(version) ||
    !file?.mode ||
    file.id !== id ||
    version.bytes !== file.bytes ||
    version.sha256 !== file.sha256 ||
    version.mode !== file.mode
  )
    invalid();
  return { ...file, mode: file.mode };
}

function reviewer(row: unknown, delta: string) {
  if (
    !record(row) ||
    !text(row.stage) ||
    !(row.unit === null || text(row.unit)) ||
    !text(row.reviewer) ||
    !oneOf(row.class, 'advisory', 'adversarial') ||
    !oneOf(row.status, 'ready', 'concerns', 'stale', 'not_recorded') ||
    !(row.verdict === null || oneOf(row.verdict, 'READY', 'NOT-READY')) ||
    !oneOf(row.coverage, 'full', 'scoped', 'unknown') ||
    !oneOf(row.freshness, 'current', 'stale', 'not_recorded') ||
    !(row.inspectedSha256 === null || sha(row.inspectedSha256)) ||
    (row.freshness === 'not_recorded') !== (row.inspectedSha256 === null) ||
    (row.coverage === 'full' && row.inspectedSha256 !== delta) ||
    (row.coverage === 'scoped' && (!row.inspectedSha256 || row.inspectedSha256 === delta)) ||
    (row.freshness === 'current' &&
      (row.coverage === 'unknown' || !oneOf(row.status, 'ready', 'concerns'))) ||
    (row.status === 'ready' && row.verdict !== 'READY') ||
    (row.status === 'concerns' && row.verdict !== 'NOT-READY')
  )
    invalid();
  return {
    reviewer: row.reviewer,
    stage: row.stage,
    unit: row.unit,
    class: row.class,
    status: row.status,
    verdict: row.verdict,
    coverage: row.coverage,
    freshness: row.freshness,
    inspectedSha256: row.inspectedSha256,
  };
}

function verification(value: Record<string, unknown>) {
  if (value.sha256 === undefined) {
    // The first Git API supplied only an unverified review status. Later APIs
    // identify missing or unreadable proof explicitly and still return the changes.
    const legacy =
      value.reason === undefined &&
      value.terminal === undefined &&
      value.applicability === undefined &&
      value.reviews === undefined;
    if (
      value.review !== 'not_verified' ||
      value.workflowCompletion !== undefined ||
      value.terminalSha256 !== undefined ||
      (!legacy &&
        (!oneOf(
          value.reason,
          'git_observations_not_retained',
          'proof_not_recorded',
          'proof_mismatch',
          'proof_unavailable',
        ) ||
          value.terminal !== 'not_recorded' ||
          value.applicability !== 'unknown' ||
          !Array.isArray(value.reviews) ||
          value.reviews.length !== 0))
    )
      invalid();
    return {
      reason: value.reason ?? null,
      sha256: null,
      terminalSha256: null,
      workflowCompletion: null,
      terminal: 'not_recorded' as const,
      applicability: 'unknown' as const,
      review: 'not_verified' as const,
      reviews: [],
    };
  }
  const delta = value.sha256;
  if (
    !sha(delta) ||
    !(value.terminalSha256 === null || sha(value.terminalSha256)) ||
    !oneOf(value.workflowCompletion, 'complete', 'failed', 'not_verified') ||
    !oneOf(value.terminal, 'matched', 'stale', 'not_recorded') ||
    (value.terminal === 'not_recorded') !== (value.terminalSha256 === null) ||
    (value.terminal === 'matched' && value.terminalSha256 !== delta) ||
    !oneOf(value.applicability, 'captured', 'unknown') ||
    !oneOf(value.review, 'recorded', 'not_required', 'not_verified') ||
    !Array.isArray(value.reviews) ||
    value.reviews.length > 2000
  )
    invalid();
  const reviews = value.reviews.map((row) => reviewer(row, delta));
  const review =
    value.applicability !== 'captured' || reviews.some((r) => r.freshness !== 'current')
      ? 'not_verified'
      : reviews.length
        ? 'recorded'
        : 'not_required';
  if (value.review !== review) invalid();
  return {
    reason: null,
    sha256: delta,
    terminalSha256: value.terminalSha256,
    workflowCompletion: value.workflowCompletion,
    terminal: value.terminal,
    applicability: value.applicability,
    review: value.review,
    reviews,
  };
}

export function decodeNativeGitChangeSet(
  value: unknown,
  revision: Pick<NativePublication, 'id' | 'sequence' | 'files'>,
  baseline: Omit<NativeSourceBaseline, 'gitChangeSet'>,
) {
  if (
    !record(value) ||
    value.publicationId !== revision.id ||
    value.publicationSequence !== revision.sequence ||
    value.sourceBaselineId !== baseline.id ||
    !record(value.repository) ||
    value.repository.commit !== baseline.repository.commit ||
    value.repository.branch !== baseline.repository.branch ||
    !Array.isArray(value.changes) ||
    value.changes.length > baseline.files.length + revision.files.length
  )
    invalid();
  const { provider, repository } = decodeNativeApplicationSource({
    provider: value.repository.provider,
    repository: value.repository.repository,
  });
  const originals = new Map(baseline.files.map((f) => [f.path, f]));
  const published = new Map(revision.files.map((f) => [f.path, f]));
  let previous = '';
  const changes: NativeGitChange[] = value.changes.map((change: unknown) => {
    if (
      !record(change) ||
      typeof change.path !== 'string' ||
      change.path <= previous ||
      typeof change.fileId !== 'string' ||
      !/^nf-[a-f0-9]{64}$/.test(change.fileId)
    )
      invalid();
    previous = change.path;
    const before = gitFile(change.before, originals.get(change.path), change.fileId);
    const after = gitFile(change.after, published.get(change.path), change.fileId);
    if (before?.mode === after?.mode && before?.sha256 === after?.sha256) invalid();
    return { fileId: change.fileId, path: change.path, before, after };
  });
  return {
    publicationId: revision.id,
    publicationSequence: revision.sequence,
    sourceBaselineId: baseline.id,
    repository: { provider, repository, ...baseline.repository },
    changes,
    ...verification(value),
  };
}

export type NativeGitChangeSet = ReturnType<typeof decodeNativeGitChangeSet>;
