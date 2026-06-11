import http from 'http';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { verifyRealtimeAccess, requiredScopeForYjsDoc } from './realtime-token.js';
import { docNameFromPath } from './doc-name.js';

const PORT = Number(process.env.PORT) || 1234;
const DOC_TTL_MS = 60_000; // Keep docs alive 60 s after last client leaves

// -----------------------------------------------------------------------------
// Realtime scope-token enforcement (discussions plan §4a)
//
// In addition to the Cognito JWT, every upgrade must present a short-lived
// HMAC-signed scope token (`?docToken=`) issued by `lambda/discussions` after
// a project-membership check. Four mandatory checks: valid signature, not
// expired, requested doc covered by the token's scopes, and principal binding
// (`docToken.sub === JWT sub`). Unknown doc-name formats are rejected
// (deny-by-default).
//
// DOC_TOKEN_ENFORCE is an operational kill switch only: set to "false" to
// log-and-allow during an incident. Default is enforcing.
// -----------------------------------------------------------------------------
const DOC_TOKEN_ENFORCE = process.env.DOC_TOKEN_ENFORCE !== 'false';
const REALTIME_DOC_SECRET = process.env.REALTIME_DOC_SECRET || '';

if (DOC_TOKEN_ENFORCE && !REALTIME_DOC_SECRET) {
  console.error(
    'FATAL: REALTIME_DOC_SECRET must be set when DOC_TOKEN_ENFORCE is on (the default).',
  );
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Cognito JWT verifier
//
// We authenticate every WebSocket upgrade by verifying a Cognito ID token
// passed as `?token=<jwt>` in the query string. This mirrors the pattern used
// by the API Gateway WebSocket authorizer (see `lambda/ws-authorizer/index.js`).
//
// The verifier lazily fetches the Cognito JWKS on first use and caches it
// in-memory, so there is no per-connection network round-trip after warm-up.
// -----------------------------------------------------------------------------
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID;

if (!COGNITO_USER_POOL_ID || !COGNITO_CLIENT_ID) {
  console.error(
    'FATAL: COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID must be set in the environment.',
  );
  process.exit(1);
}

const verifier = CognitoJwtVerifier.create({
  userPoolId: COGNITO_USER_POOL_ID,
  tokenUse: 'id',
  clientId: COGNITO_CLIENT_ID,
});

const docs = new Map();

const getDoc = (docName) => {
  if (docs.has(docName)) {
    const docData = docs.get(docName);
    // Cancel pending destroy if a new client arrives within the grace window
    if (docData.destroyTimeout) {
      clearTimeout(docData.destroyTimeout);
      docData.destroyTimeout = null;
    }
    return docData;
  }

  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const conns = new Map(); // conn → Set<awarenessClientId>

  const docData = { doc, awareness, conns, destroyTimeout: null };
  docs.set(docName, docData);

  // Single update listener per document - broadcasts to all connections
  doc.on('update', (update, origin) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.writeUpdate(encoder, update);
    const msg = encoding.toUint8Array(encoder);
    conns.forEach((_clientIds, conn) => {
      if (conn !== origin && conn.readyState === 1) conn.send(msg);
    });
  });

  // Single awareness listener per document
  awareness.on('update', ({ added, updated, removed }) => {
    const changed = added.concat(updated, removed);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
    );
    const msg = encoding.toUint8Array(encoder);
    conns.forEach((_clientIds, conn) => {
      if (conn.readyState === 1) conn.send(msg);
    });
  });

  return docData;
};

const messageHandler = (conn, docData, message) => {
  const { doc, awareness } = docData;
  const decoder = decoding.createDecoder(message);
  const messageType = decoding.readVarUint(decoder);

  switch (messageType) {
    case 0: {
      // sync
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.readSyncMessage(decoder, encoder, doc, conn);
      if (encoding.length(encoder) > 1) conn.send(encoding.toUint8Array(encoder));
      break;
    }
    case 1: {
      // awareness
      const update = decoding.readVarUint8Array(decoder);
      awarenessProtocol.applyAwarenessUpdate(awareness, update, conn);
      const connClientIds = docData.conns.get(conn) || new Set();
      // Awareness protocol encodes [clientId, clock, state?] tuples.
      // Re-decode the update to extract client IDs so we can clean them up
      // when the connection closes.
      try {
        const updateDecoder = decoding.createDecoder(update);
        const len = decoding.readVarUint(updateDecoder);
        for (let i = 0; i < len; i++) {
          const clientId = decoding.readVarUint(updateDecoder);
          connClientIds.add(clientId);
          decoding.readVarUint(updateDecoder); // clock
          const stateStr = decoding.readVarString(updateDecoder);
          if (stateStr === 'null' || stateStr === '') {
            connClientIds.delete(clientId);
          }
        }
      } catch {
        /* best-effort tracking */
      }
      docData.conns.set(conn, connClientIds);
      break;
    }
  }
};

// -----------------------------------------------------------------------------
// HTTP + WebSocket server wiring
//
// We use an HTTP server with `WebSocketServer({ noServer: true })` so that
// we can authenticate the JWT in the `upgrade` handler *before* completing
// the WebSocket handshake. This is the pattern recommended by the `ws`
// library docs for async authentication (verifyClient is discouraged).
// -----------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  // Health check endpoint for the ALB target group (health check path = "/").
  // Respond 200 for non-upgrade HTTP requests so the target stays healthy
  // without exposing anything interesting.
  if (req.method === 'GET' && (req.url === '/' || req.url === '/healthz')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

const wss = new WebSocketServer({ noServer: true });

// Reject the upgrade with an HTTP status code and close the socket cleanly.
// We deliberately do not include the failure reason in the body to avoid
// leaking information, and we never log the token itself.
const rejectUpgrade = (socket, statusCode, reason) => {
  try {
    socket.write(
      `HTTP/1.1 ${statusCode} ${reason}\r\n` +
        'Connection: close\r\n' +
        'Content-Length: 0\r\n' +
        '\r\n',
    );
  } catch {
    /* socket may already be dead */
  }
  socket.destroy();
};

server.on('upgrade', async (req, socket, head) => {
  // Parse the request URL once; we need both the path (docName) and the
  // query string (token). A dummy base is required because req.url is
  // path-only.
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, 'http://localhost');
  } catch {
    rejectUpgrade(socket, 400, 'Bad Request');
    return;
  }

  const token = parsedUrl.searchParams.get('token');
  if (!token) {
    // Do NOT log the (missing) token. Log only the event.
    console.warn('WS upgrade rejected: missing token');
    rejectUpgrade(socket, 401, 'Unauthorized');
    return;
  }

  let jwtPayload;
  try {
    jwtPayload = await verifier.verify(token);
  } catch (err) {
    // Never log the token itself, only the verification error message.
    console.warn('WS upgrade rejected: invalid token:', err.message);
    rejectUpgrade(socket, 401, 'Unauthorized');
    return;
  }

  // Strip the query string before computing docName so that a token
  // refresh doesn't create a "new" document identity, and drop the
  // CloudFront `/yjs/*` routing prefix (see doc-name.js).
  const docName = docNameFromPath(parsedUrl.pathname);

  // Scope-token check (plan §4a): signature, expiry, scope coverage for this
  // doc name, and principal binding to the JWT-authenticated user. Deny by
  // default for unknown doc-name formats.
  const docToken = parsedUrl.searchParams.get('docToken');
  const access = verifyRealtimeAccess({
    token: docToken,
    secret: REALTIME_DOC_SECRET,
    requiredScope: requiredScopeForYjsDoc(docName),
    sub: jwtPayload.sub,
  });
  if (!access.ok) {
    if (DOC_TOKEN_ENFORCE) {
      console.warn(`WS upgrade rejected: doc token ${access.reason} for doc "${docName}"`);
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    console.warn(
      `WS upgrade allowed despite doc token ${access.reason} for doc "${docName}" (DOC_TOKEN_ENFORCE=false)`,
    );
  }

  // Stash the docName + token expiry on the request so the 'connection'
  // handler can use them without re-parsing (and without seeing the raw
  // token via req.url).
  req.yjsDocName = docName;
  req.yjsTokenExp = access.ok ? access.payload.exp : null;

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (conn, req) => {
  const docName = req.yjsDocName || 'default';
  const docData = getDoc(docName);
  docData.conns.set(conn, new Set());

  // Post-connect token lifecycle (plan §4a): an established socket must not
  // outlive its scope token. Close at expiry with 4401 — the client's
  // reconnect logic fetches a fresh token, so membership is re-validated at
  // most every token TTL (10 min).
  let tokenExpiryTimer = null;
  if (req.yjsTokenExp) {
    const msUntilExpiry = req.yjsTokenExp * 1000 - Date.now();
    tokenExpiryTimer = setTimeout(
      () => {
        tokenExpiryTimer = null;
        console.log(`Closing connection on doc "${docName}": scope token expired`);
        try {
          conn.close(4401, 'token expired');
        } catch {
          /* already closed */
        }
      },
      Math.max(msUntilExpiry, 0),
    );
  }

  // Send sync step 1 (state vector request)
  const syncEncoder = encoding.createEncoder();
  encoding.writeVarUint(syncEncoder, 0);
  syncProtocol.writeSyncStep1(syncEncoder, docData.doc);
  conn.send(encoding.toUint8Array(syncEncoder));

  // Send sync step 2 (full document state)
  const stateEncoder = encoding.createEncoder();
  encoding.writeVarUint(stateEncoder, 0);
  syncProtocol.writeSyncStep2(stateEncoder, docData.doc);
  conn.send(encoding.toUint8Array(stateEncoder));

  // Send current awareness states
  const awarenessStates = Array.from(docData.awareness.getStates().keys());
  if (awarenessStates.length > 0) {
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, 1);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(docData.awareness, awarenessStates),
    );
    conn.send(encoding.toUint8Array(awarenessEncoder));
  }

  conn.on('message', (msg) => {
    try {
      messageHandler(conn, docData, new Uint8Array(msg));
    } catch (e) {
      console.error('Message handling error:', e.message);
    }
  });

  conn.on('close', () => {
    if (tokenExpiryTimer) {
      clearTimeout(tokenExpiryTimer);
      tokenExpiryTimer = null;
    }
    // Remove awareness states that belong to THIS connection (not the server)
    const clientIds = docData.conns.get(conn) || new Set();
    if (clientIds.size > 0) {
      awarenessProtocol.removeAwarenessStates(docData.awareness, Array.from(clientIds), null);
    }
    docData.conns.delete(conn);

    if (docData.conns.size === 0) {
      // Grace period: keep the doc alive for DOC_TTL_MS so a refreshing
      // user or brief network blip doesn't lose in-flight state.
      docData.destroyTimeout = setTimeout(() => {
        if (docData.conns.size === 0) {
          docData.doc.destroy();
          docData.awareness.destroy();
          docs.delete(docName);
          console.log(`Document "${docName}" destroyed after ${DOC_TTL_MS / 1000}s idle`);
        }
        docData.destroyTimeout = null;
      }, DOC_TTL_MS);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Yjs server running on port ${PORT} (Cognito auth enabled)`);
});
