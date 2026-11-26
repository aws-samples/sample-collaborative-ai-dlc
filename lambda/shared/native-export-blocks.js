// Whether a user-library block still reproduces the release block it shadows,
// as far as native export is concerned.
//
// Native export ships the official distribution of the intent's pinned release,
// so a user-tenant block is only safe to export when the release distribution
// already carries it: same type, same id, same content. Storage envelope fields
// and display names are not content. Everything else is, including sensor
// severity and `fireOn`, scopes, model tier, references to other blocks and the
// body and script (compared by their content-addressed digests). Comparison is
// exact: an empty value is not the same as an absent one, and the body is not
// normalized, so any doubt keeps the block reported as edited.
import { canonicalJson } from './workflow-checkpoint.js';

const ENVELOPE_FIELDS = new Set([
  'pk',
  'sk',
  'GSI1PK',
  'GSI1SK',
  'tenantId',
  'blockType',
  'type',
  'blockId',
  'id',
  'slug',
  'version',
  'sourceRef',
  'createdAt',
  'updatedAt',
  'readOnly',
  'hasBody',
  'bodyBytes',
  'hasScript',
  'scriptBytes',
]);

// The fields a user may change without changing what the methodology does. The
// export keeps the release's values for them.
const DISPLAY_FIELDS = ['name', 'displayName'];

const contentOf = (block) => {
  const content = {};
  for (const [key, value] of Object.entries(block)) {
    if (ENVELOPE_FIELDS.has(key) || DISPLAY_FIELDS.includes(key)) continue;
    if (key === 'bodyRef' || key === 'scriptRef') continue;
    content[key] = value;
  }
  content.bodySha256 = block.bodyRef?.sha256 ?? null;
  content.scriptSha256 = block.scriptRef?.sha256 ?? null;
  // Drop undefined values the way the stored JSON does before hashing.
  return canonicalJson(JSON.parse(JSON.stringify(content)));
};

/**
 * True when `userBlock` has the same methodology content as `releaseBlock`.
 * A placeholder for a pinned row that no longer exists never matches.
 */
const sameMethodologyContent = (userBlock, releaseBlock) =>
  Boolean(userBlock && releaseBlock && !userBlock.missing) &&
  contentOf(userBlock) === contentOf(releaseBlock);

/** True when a matching block differs from its release block only by name. */
const renamedFromRelease = (userBlock, releaseBlock) =>
  DISPLAY_FIELDS.some((field) => (userBlock?.[field] ?? null) !== (releaseBlock?.[field] ?? null));

export { renamedFromRelease, sameMethodologyContent };
export default { renamedFromRelease, sameMethodologyContent };
