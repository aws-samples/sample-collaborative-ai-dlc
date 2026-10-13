import { serialFixture } from './execution-serial-fixtures.js';
import { createNativeProjector } from '../projection-worker.js';
import { createNativeProjectionStore } from '../projection-store.js';
import { projectNativePublication } from '../publication-graph.js';
import { TABLE } from './fixtures.js';

export const ROOT = 'aidlc/spaces/default/intents/261013-request';
export const requirementBytes = Buffer.from(
  '\uFEFF# Requirements\r\n## Scope\r\nExact 🐦 bytes.\r\n## Items\r\n```yaml\r\nrequirements:\r\n  - id: req-login\r\n    title: Login\r\n    priority: must-have\r\n```\r\n',
);
export const traceFiles = () => [
  {
    path: `${ROOT}/inception/requirements-analysis/unusual-name.md`,
    role: 'artifact',
    content: requirementBytes,
  },
  {
    path: `${ROOT}/inception/user-stories/stories.md`,
    role: 'artifact',
    content: Buffer.from(
      '## Stories\n```yaml\nstories:\n  - id: story-login\n    title: Sign in\n    covers: [req-login]\n```\n',
    ),
  },
  {
    path: `${ROOT}/inception/application-design/decisions.md`,
    role: 'artifact',
    content: Buffer.from(
      '## Decisions\n```yaml\ndecisions:\n  - id: decision-one\n    title: Proposal\n    status: accepted\n```\n',
    ),
  },
  {
    path: `${ROOT}/runtime-graph.json`,
    role: 'state',
    content: Buffer.from('{"outcome":"approved"}'),
  },
];

export const nativeTraceFixture = async (g, files = traceFiles()) => {
  const f = serialFixture();
  await f.ready();
  await f.publish({ project: false, files });
  const store = createNativeProjectionStore({
    ddb: f.ddb,
    tableName: TABLE,
    execution: f.store,
    preparation: f.preparationStore,
    now: f.now,
  });
  const inputs = [];
  const project = async (input) => {
    inputs.push(input);
    return projectNativePublication({ ...input, g });
  };
  const run = createNativeProjector({
    store,
    publications: f.publications,
    interactions: f.interactions,
    authorize: f.recheck,
    project,
  });
  const next = async (nextFiles) => {
    await f.respond();
    const claim = await f.store.claim(f.bindingIdentity);
    await f.store.release({ row: await f.store.dispatched({ row: claim.row }) });
    return f.publish({ project: false, files: nextFiles });
  };
  return { ...f, projection: store, run, next, inputs };
};
