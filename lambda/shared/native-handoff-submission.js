import { sha256, validateStructuredBlock } from './artifact-extractors.js';

const MAX_HANDOFF_DOCUMENT_BYTES = 256 * 1024;
const REQUIRED_DOCUMENTS = Object.freeze({
  'code-generation-plan': 'code-generation-plan.md',
  'code-summary': 'code-summary.md',
});

const validateHandoffDocuments = (documents) => {
  const findings = [];
  if (!documents || typeof documents !== 'object' || Array.isArray(documents)) {
    return { ok: false, findings: [{ field: 'documents', code: 'documents_required' }] };
  }
  const keys = Object.keys(documents).toSorted();
  const expected = Object.keys(REQUIRED_DOCUMENTS).toSorted();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    findings.push({
      field: 'documents',
      code: 'document_set_invalid',
      expected,
    });
  }

  const normalized = {};
  for (const [artifactType, filename] of Object.entries(REQUIRED_DOCUMENTS)) {
    const candidate = documents[artifactType];
    if (!candidate || typeof candidate !== 'object') {
      findings.push({ field: artifactType, code: 'document_missing' });
      continue;
    }
    if (typeof candidate.content !== 'string' || !candidate.content.trim()) {
      findings.push({ field: artifactType, code: 'content_required' });
      continue;
    }
    if (candidate.content.includes('\0')) {
      findings.push({ field: artifactType, code: 'content_not_text' });
      continue;
    }
    const bytes = Buffer.byteLength(candidate.content, 'utf8');
    if (bytes > MAX_HANDOFF_DOCUMENT_BYTES) {
      findings.push({
        field: artifactType,
        code: 'content_too_large',
        maxBytes: MAX_HANDOFF_DOCUMENT_BYTES,
      });
      continue;
    }
    const structure = validateStructuredBlock({
      artifactType,
      content: candidate.content,
    });
    if (!structure.ok) {
      findings.push({
        field: artifactType,
        code: 'structure_invalid',
        detail: structure.error,
      });
      continue;
    }
    normalized[artifactType] = {
      filename,
      content: candidate.content,
      bytes,
      sha256: sha256(candidate.content),
    };
  }
  return { ok: findings.length === 0, findings, documents: normalized };
};

export { MAX_HANDOFF_DOCUMENT_BYTES, REQUIRED_DOCUMENTS, sha256, validateHandoffDocuments };
