// Changed-file provenance shared by Git collection, stage orchestration, and
// sensor selection. An empty known list means "proved no files changed";
// unknown always carries a collection-failure reason and widens sensor checks.

export const knownChangedFileProvenance = (files = []) => ({
  state: 'known',
  files: [...files],
});

export const unknownChangedFileProvenance = (reason, detail = null) => ({
  state: 'unknown',
  reason: typeof reason === 'string' && reason.trim() ? reason.trim() : 'unspecified',
  ...(detail ? { detail: String(detail) } : {}),
});

export const normalizeChangedFileProvenance = (provenance) => {
  if (provenance?.state === 'known' && Array.isArray(provenance.files)) {
    return knownChangedFileProvenance(provenance.files);
  }
  if (provenance?.state === 'unknown') {
    return unknownChangedFileProvenance(provenance.reason, provenance.detail);
  }
  return unknownChangedFileProvenance('invalid_or_missing_provenance');
};

export const mapKnownChangedFiles = (provenance, mapFile) => {
  const normalized = normalizeChangedFileProvenance(provenance);
  if (normalized.state === 'unknown') return normalized;
  return knownChangedFileProvenance(normalized.files.map(mapFile));
};

export const mergeChangedFileProvenance = (entries = []) => {
  const normalized = entries.map(({ source = null, provenance }) => ({
    source,
    provenance: normalizeChangedFileProvenance(provenance),
  }));
  const unknown = normalized.filter((entry) => entry.provenance.state === 'unknown');
  if (unknown.length > 0) {
    const reason = [
      ...new Set(
        unknown.map(({ source, provenance }) =>
          source ? `${source}: ${provenance.reason}` : provenance.reason,
        ),
      ),
    ].join('; ');
    const detail = [
      ...new Set(unknown.map(({ provenance }) => provenance.detail).filter(Boolean)),
    ].join('; ');
    return unknownChangedFileProvenance(reason, detail || null);
  }
  return knownChangedFileProvenance(
    [...new Set(normalized.flatMap(({ provenance }) => provenance.files))].toSorted(),
  );
};
