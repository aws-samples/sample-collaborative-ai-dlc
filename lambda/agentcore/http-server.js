// AgentCore Runtime HTTP server — the container contract.
//
// Bedrock AgentCore Runtime requires a container that listens on 0.0.0.0:8080
// (ARM64) and serves:
//   GET  /ping         → 200 { status: "Healthy" | "HealthyBusy", time_of_last_update }
//                        HealthyBusy keeps the runtime SESSION alive while a stage
//                        runs (a stage can take many minutes).
//   POST /invocations  → run a command; JSON in, JSON out.
//
// The SAME session id routes to the SAME microVM, so the git checkout from
// init-ws persists across run-stage invocations — that's how we keep filesystem
// state between stages without our own pool/lease machinery.
//
// Invocation payloads:
//   { "command": "init-ws",  ...initWs args }
//   { "command": "run-stage", ...runStage args }
//
// The dispatcher is pure (handlers injected) so it is unit-tested without a
// socket; createServer wires the real commands + clients.

import http from 'node:http';

// Track whether a stage is currently running so /ping can report HealthyBusy.
export const createBusyTracker = () => {
  let busy = 0;
  return {
    enter() {
      busy += 1;
    },
    leave() {
      busy = Math.max(0, busy - 1);
    },
    get status() {
      return busy > 0 ? 'HealthyBusy' : 'Healthy';
    },
  };
};

// Dispatch one parsed invocation to the right command handler. PURE of HTTP —
// returns { statusCode, body }. `handlers` = { initWs, runStage }; `busy` is the
// tracker so a long run-stage flips /ping to HealthyBusy.
export const dispatchInvocation = async ({
  payload,
  handlers,
  busy,
  now = () => new Date().toISOString(),
}) => {
  const command = payload?.command;
  if (!command) return { statusCode: 400, body: { error: 'missing "command"' } };
  const handler = {
    'init-ws': handlers.initWs,
    'run-stage': handlers.runStage,
    inspect: handlers.inspect,
  }[command];
  if (!handler) return { statusCode: 400, body: { error: `unknown command "${command}"` } };

  busy?.enter();
  try {
    const result = await handler(payload);
    const statusCode = result?.ok === false ? 422 : 200;
    return { statusCode, body: { ...result, command, at: now() } };
  } catch (e) {
    return { statusCode: 500, body: { error: e.message, command } };
  } finally {
    busy?.leave();
  }
};

const readJsonBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });

// Build the HTTP server. `handlers` = { initWs, runStage } already bound to their
// deps; `busy` defaults to a fresh tracker.
export const createServer = ({
  handlers,
  busy = createBusyTracker(),
  now = () => new Date().toISOString(),
}) => {
  return http.createServer(async (req, res) => {
    const send = (statusCode, body) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/ping') {
      return send(200, {
        status: busy.status,
        time_of_last_update: Math.floor(Date.parse(now()) / 1000),
      });
    }
    if (req.method === 'POST' && req.url === '/invocations') {
      let payload;
      try {
        payload = await readJsonBody(req);
      } catch (e) {
        return send(400, { error: e.message });
      }
      const { statusCode, body } = await dispatchInvocation({ payload, handlers, busy, now });
      return send(statusCode, body);
    }
    return send(404, { error: 'not found' });
  });
};

// Container entry: wire the real commands + clients, then listen on 8080.
const main = async () => {
  const { ddb, openGraph } = await import('./clients.js');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { createProcessStore } = require('../shared/v2-process-store.js');
  const { initWs } = await import('./commands/init-ws.js');
  const { runStage } = await import('./commands/run-stage.js');
  const { inspect } = await import('./commands/inspect.js');
  const { loadLibrary, loadBlockBody } = await import('./block-loader.js');
  const { materializeStage, renderRulesDoc } = await import('./stage-materializer.js');
  const { checkoutRepos } = await import('./workspace.js');
  const { discoverInstalledClis } = await import('./cli/discover.js');
  const { resolveAgentAuth } = await import('./auth-resolver.js');

  // Load the agent CLI's Bedrock bearer token / Kiro key from SSM into env so the
  // CLI drivers (envForAuth) forward them — without this the CLI falls back to
  // task-role SigV4 and Bedrock returns 403. Best-effort; logs which were set.
  const resolvedAuth = await resolveAgentAuth({ env: process.env });
  console.error(`[agentcore] resolved agent auth: ${resolvedAuth.join(', ') || 'none'}`);

  const workspaceDir = process.env.V2_WORKSPACE_DIR || '/workspace';
  const mcpEntry = process.env.V2_MCP_ENTRY || new URL('./mcp/index.js', import.meta.url).pathname;
  const store = createProcessStore({ ddb, tableName: process.env.V2_PROCESS_TABLE });
  const availableClis = await discoverInstalledClis();

  const handlers = {
    initWs: (p) => initWs(p, { store, openGraph, checkoutRepos, workspaceDir }),
    runStage: (p) =>
      runStage(
        { ...p, workspaceDir },
        {
          store,
          loadLibrary,
          loadBlockBody,
          materializeStage,
          renderRulesDoc,
          mcpEntry,
          availableClis,
          env: process.env,
        },
      ),
    inspect: (p) => inspect(p, { openGraph }),
  };

  const server = createServer({ handlers });
  server.listen(8080, '0.0.0.0', () => console.error('[agentcore] listening on 0.0.0.0:8080'));
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('[agentcore] fatal:', e);
    process.exit(1);
  });
}
