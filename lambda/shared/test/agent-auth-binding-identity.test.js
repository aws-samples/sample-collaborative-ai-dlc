import { describe, expect, it } from 'vitest';
import {
  bindingIdentity,
  normalizeConnection,
  normalizeCredentialBinding,
} from '../agent-auth-contracts.js';
import {
  AGENT_AUTH_MODES_CATALOG,
  normalizeConnectionConfiguration,
} from '../agent-auth-providers.js';
import { connectionBinding } from '../agent-auth-selection-strategies.js';
import { legacyConnection } from '../agent-connection-repository.js';
import golden from './fixtures/agent-auth-binding-identity.json' with { type: 'json' };

// Signed grants, renewal tokens and pinned executions compare these strings byte-for-byte,
// so the fixture is never edited: a refactor may only change how a case is evaluated.
// Inputs are hand-written. Every expectation was captured once on a637d1b from the repo root:
//   node --input-type=module <<'EOF'
//   import { readFileSync, writeFileSync } from 'node:fs';
//   import { bindingIdentity, normalizeConnection } from './lambda/shared/agent-auth-contracts.js';
//   import { AGENT_AUTH_MODES_CATALOG, normalizeConnectionConfiguration } from './lambda/shared/agent-auth-providers.js';
//   import { connectionBinding } from './lambda/shared/agent-auth-selection-strategies.js';
//   import { legacyConnection } from './lambda/shared/agent-connection-repository.js';
//   const file = 'lambda/shared/test/fixtures/agent-auth-binding-identity.json';
//   const golden = JSON.parse(readFileSync(file, 'utf8'));
//   const pinned = (c) => ({ normalized: JSON.stringify(c), identity: bindingIdentity(connectionBinding(c, golden.policyRevision)) });
//   const run = {
//     connection: (input) => pinned(normalizeConnection(input)),
//     legacy: (id) => pinned(legacyConnection(id)),
//     binding: (input) => ({ identity: bindingIdentity(input) }),
//     'planned-configuration': ({ backend, mechanism, configuration }) => ({ configuration: JSON.stringify(normalizeConnectionConfiguration(backend, mechanism, configuration)) }),
//   };
//   for (const c of golden.cases) c.expected = run[c.via](c.input);
//   for (const c of golden.errors) {
//     try { run[c.via](c.input); } catch ({ code, message }) { c.error = { code, message }; continue; }
//     throw new Error(`${c.name} did not throw`);
//   }
//   golden.catalog = JSON.parse(JSON.stringify(AGENT_AUTH_MODES_CATALOG));
//   writeFileSync(file, `${JSON.stringify(golden, null, 2)}\n`);
//   EOF
//   npx oxfmt lambda/shared/test/fixtures/agent-auth-binding-identity.json

// Planned modes are pinned at the configuration level only. A provider PR replaces a planned
// descriptor in the shared root, so these two readers are the only evaluation allowed to move:
// they must keep reading the built-in planned descriptors, not whatever the root registers.
const plannedConfiguration = ({ backend, mechanism, configuration }) =>
  normalizeConnectionConfiguration(backend, mechanism, configuration);
const builtInCatalog = () => AGENT_AUTH_MODES_CATALOG;

const pinned = (connection) => ({
  normalized: JSON.stringify(connection),
  identity: bindingIdentity(connectionBinding(connection, golden.policyRevision)),
});
const EVALUATE = Object.freeze({
  connection: (input) => pinned(normalizeConnection(input)),
  legacy: (id) => pinned(legacyConnection(id)),
  binding: (input) => ({ identity: bindingIdentity(input) }),
  'planned-configuration': (input) => ({
    configuration: JSON.stringify(plannedConfiguration(input)),
  }),
});
const failure = (evaluate) => {
  try {
    evaluate();
  } catch ({ code, message }) {
    return { code, message };
  }
  return null;
};
const identities = golden.cases.filter(({ expected }) => expected.identity);
const connections = golden.cases.filter(({ expected }) => expected.normalized);

describe('golden agent auth binding identities', () => {
  it.each(golden.cases)('$name', ({ via, input, expected }) => {
    expect(EVALUATE[via](input)).toStrictEqual(expected);
  });

  it.each(golden.errors)('rejects $name', ({ via, input, error }) => {
    expect(failure(() => EVALUATE[via](input))).toStrictEqual(error);
  });

  it.each(identities)('re-normalizes the pinned binding of $name unchanged', ({ expected }) => {
    const binding = JSON.parse(expected.identity);
    expect(JSON.stringify(normalizeCredentialBinding(binding))).toBe(expected.identity);
    expect(bindingIdentity(binding)).toBe(expected.identity);
  });

  it.each(connections)('re-normalizes the stored connection of $name unchanged', ({ expected }) => {
    expect(JSON.stringify(normalizeConnection(JSON.parse(expected.normalized)))).toBe(
      expected.normalized,
    );
  });

  it('projects the mode catalog with the same entries, flags and order', () => {
    // Consumers read catalog fields by name, so key order within an entry is not pinned.
    expect(JSON.parse(JSON.stringify(builtInCatalog()))).toStrictEqual(golden.catalog);
  });
});
