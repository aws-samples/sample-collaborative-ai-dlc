// The space directory: an Owner can make a space discoverable, so signed-in
// people who are not members can find it, see who owns it, and ask to join
// (lambda/users/access-requests.js). Discovery shows only a space's name,
// description and Owners; everything else stays members-only.

import gremlin from 'gremlin';
import { getVal } from '../shared/trackers.js';
import { listOwnerContacts } from '../shared/space-membership.js';

const __ = gremlin.process.statics;

export const MAX_DESCRIPTION_LENGTH = 500;
const DIRECTORY_CONCURRENCY = 10;

export const readDirectorySettings = (v) => ({
  description: getVal(v, 'description') || '',
  discoverable: getVal(v, 'discoverable') === 'true',
});

// Validates the directory fields of a settings update. Absent fields stay absent.
export const normalizeDirectoryInput = (data) => {
  const value = {};
  if (data.discoverable !== undefined) {
    if (typeof data.discoverable !== 'boolean')
      return { valid: false, error: 'discoverable must be a boolean' };
    value.discoverable = data.discoverable;
  }
  if (data.description !== undefined) {
    if (typeof data.description !== 'string')
      return { valid: false, error: 'description must be a string' };
    value.description = data.description.trim();
    if (value.description.length > MAX_DESCRIPTION_LENGTH)
      return {
        valid: false,
        error: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
      };
  }
  return { valid: true, value };
};

const field = (row, key) => (row instanceof Map ? row.get(key) : row[key]);
const rowId = (row) => field(row, 'id');

const mapSettled = async (items, limit, fn) => {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    results.push(...(await Promise.allSettled(items.slice(i, i + limit).map(fn))));
  }
  return results;
};

// Every discoverable space, with the caller's relationship to it:
// `member` (any role), `pending` (an open request) or `none`. A space whose
// details can't be read is left out (and reported to `onError`) rather than
// failing the whole directory.
export const listDiscoverableSpaces = async ({ g, store, userId, onError = () => {} }) => {
  const rows = await g
    .V()
    .hasLabel('Project')
    .has('discoverable', 'true')
    .project('id', 'name', 'description')
    .by(__.values('id'))
    .by(__.coalesce(__.values('name'), __.constant('')))
    .by(__.coalesce(__.values('description'), __.constant('')))
    .toList();
  const settled = await mapSettled(rows, DIRECTORY_CONCURRENCY, async (row) => {
    const get = (key) => field(row, key);
    const id = get('id');
    const [membership, request, owners] = await Promise.all([
      store.get(id, userId),
      store.getRequest(id, userId),
      listOwnerContacts(g, id, store),
    ]);
    return {
      id,
      name: get('name'),
      description: get('description'),
      owners: owners.map(({ email }) => ({ email })),
      access: membership ? 'member' : request ? 'pending' : 'none',
    };
  });
  const failed = settled.flatMap((r, i) =>
    r.status === 'rejected' ? [{ spaceId: rowId(rows[i]), error: r.reason }] : [],
  );
  if (failed.length) onError(failed);
  return settled
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value)
    .toSorted((a, b) => a.name.localeCompare(b.name));
};
