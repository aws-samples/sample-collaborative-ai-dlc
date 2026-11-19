import type { IntentArtifact, IntentArtifactContent, IntentDetail } from '@/services/intents';

// Artifact bodies arrive separately from the intent detail. These helpers keep
// a body attached only to the artifact revision it was read for. Heads are
// matched on `contentKey`: ids can repeat across unit lanes.

/** The key pairing a head with its body; `id` when the server sends none. */
export function artifactContentKey(artifact: Pick<IntentArtifact, 'id' | 'contentKey'>): string {
  return artifact.contentKey ?? `id:${artifact.id}`;
}

/** Fields that change when an artifact head is replaced or edited. */
export function artifactContentIdentity(artifact: IntentArtifact): string {
  return JSON.stringify([
    artifactContentKey(artifact),
    artifact.generation ?? null,
    artifact.stageAttempt ?? null,
    artifact.collaborationEpoch ?? null,
    artifact.editRevision ?? null,
    artifact.createdAt ?? null,
    artifact.editedAt ?? null,
    artifact.versionCount ?? null,
  ]);
}

export function artifactContentIdentities(detail: IntentDetail): Map<string, string> {
  return new Map(detail.artifacts.map((a) => [artifactContentKey(a), artifactContentIdentity(a)]));
}

type LoadedBody = Pick<IntentArtifact, 'content' | 'contentUnavailable'>;

/** Show the previous body while a fresh one loads, if the revision is unchanged. */
export function carryArtifactContent(next: IntentDetail, prev: IntentDetail | null): IntentDetail {
  if (!prev) return next;
  // A failed fetch is not carried: the new load retries it.
  const known = new Map<string, LoadedBody>(
    prev.artifacts
      .filter((a) => a.content !== undefined && a.contentUnavailable !== 'error')
      .map((a) => [
        artifactContentIdentity(a),
        { content: a.content, contentUnavailable: a.contentUnavailable },
      ]),
  );
  if (known.size === 0) return next;
  let changed = false;
  const artifacts = next.artifacts.map((a) => {
    if (a.content !== undefined) return a;
    const body = known.get(artifactContentIdentity(a));
    if (!body) return a;
    changed = true;
    return withBody(a, body);
  });
  return changed ? { ...next, artifacts } : next;
}

/**
 * Attach fetched bodies to `detail`. `identities` are the revisions the fetch
 * was started for; a body is dropped if its artifact has since changed.
 */
export function applyArtifactContents(
  detail: IntentDetail,
  entries: readonly IntentArtifactContent[],
  identities: ReadonlyMap<string, string>,
): IntentDetail {
  if (entries.length === 0) return detail;
  const byKey = new Map<string, LoadedBody>(
    entries.map((e) => [
      artifactContentKey(e),
      e.contentOmitted
        ? { content: null, contentUnavailable: 'too_large' }
        : { content: e.content ?? null },
    ]),
  );
  return mapArtifacts(detail, (a) => {
    const key = artifactContentKey(a);
    const body = byKey.get(key);
    if (!body || identities.get(key) !== artifactContentIdentity(a)) return a;
    return withBody(a, body);
  });
}

/** Mark bodies still unloaded from a failed fetch so the UI can offer a retry. */
export function markArtifactContentsFailed(
  detail: IntentDetail,
  identities: ReadonlyMap<string, string>,
): IntentDetail {
  return mapArtifacts(detail, (a) =>
    a.content === undefined && identities.get(artifactContentKey(a)) === artifactContentIdentity(a)
      ? { ...a, content: null, contentUnavailable: 'error' }
      : a,
  );
}

function withBody(artifact: IntentArtifact, body: LoadedBody): IntentArtifact {
  if (
    artifact.content === body.content &&
    artifact.contentUnavailable === body.contentUnavailable
  ) {
    return artifact;
  }
  const { contentUnavailable: _previous, ...rest } = artifact;
  return body.contentUnavailable
    ? { ...rest, content: body.content, contentUnavailable: body.contentUnavailable }
    : { ...rest, content: body.content };
}

function mapArtifacts(
  detail: IntentDetail,
  update: (artifact: IntentArtifact) => IntentArtifact,
): IntentDetail {
  let changed = false;
  const artifacts = detail.artifacts.map((a) => {
    const next = update(a);
    if (next !== a) changed = true;
    return next;
  });
  return changed ? { ...detail, artifacts } : detail;
}
