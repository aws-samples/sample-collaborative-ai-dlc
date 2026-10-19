// The engine's graph access, one shape in both modes: `openEngineGraph(scope)`
// resolves to one method per engine graph operation plus `close`.
//
// Flag off, the operations run here against the runtime's own Neptune
// connection through the same shared implementation engine-data serves, so
// both modes execute identical graph code. Flag on, engine-data-client's
// remote access replaces this and the direct opener becomes a tripwire.
import { ENGINE_DATA_GRAPH_OPS } from '../shared/engine-data-ops.js';
import { createEngineGraphOps } from '../shared/engine-graph-ops.js';
import { closeGraphSource, createGraphWriter } from './mcp/graph-writer.js';

export const localEngineGraph =
  ({ openGraph, createWriter = createGraphWriter, clock, createOps = createEngineGraphOps }) =>
  async (scope = {}) => {
    const g = await openGraph();
    const ops = createOps({
      g,
      scope,
      createWriter,
      ...(clock ? { clock } : {}),
    });
    return {
      ...Object.fromEntries(ENGINE_DATA_GRAPH_OPS.map((name) => [name, ops[name]])),
      close: () => closeGraphSource(g),
    };
  };

// The opener a command uses: the injected engine graph when the runtime wires
// one, otherwise a local adapter over the command's own `openGraph` (the
// existing test seam, which may also inject `createWriter`/`clock`). Null when
// the command was given no graph at all.
export const engineGraphOpener = ({ openEngineGraph, openGraph, createWriter, clock } = {}) => {
  if (openEngineGraph) return openEngineGraph;
  if (!openGraph) return null;
  return localEngineGraph({
    openGraph,
    ...(createWriter ? { createWriter } : {}),
    ...(clock ? { clock } : {}),
  });
};

export const closeEngineGraph = async (graph) => {
  await graph?.close?.();
};
