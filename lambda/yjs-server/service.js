import http from 'node:http';
import { isIP } from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import { docNameFromPath } from './doc-name.js';
import { requiredScopeForYjsDoc, verifyRealtimeAccess } from './realtime-token.js';
import { routeHeader, verifyRoute } from './cluster.js';
import { RoomManager } from './rooms.js';
import { closeConnection, send } from './protocol.js';

const reject = (socket, code) => {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
};

export const validateOwnerAddress = (address, allowLoopback = false) => {
  const url = new URL(address);
  const parts = url.hostname.split('.').map(Number);
  const privateAddress =
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (allowLoopback && parts[0] === 127);
  if (
    url.protocol !== 'ws:' ||
    isIP(url.hostname) !== 4 ||
    !privateAddress ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid private document owner');
  }
  return url;
};

export const createCollaborationServer = ({
  config,
  verifyJwt,
  secret,
  enforceScope = true,
  cluster = null,
  logger = console,
  allowLoopback = false,
}) => {
  if (enforceScope && !secret) throw new Error('REALTIME_DOC_SECRET is required');
  if (config.clusterEnabled && !cluster) throw new Error('Cluster storage is required');
  const rooms = new RoomManager({ config, cluster, logger });
  const upgrades = new Set();
  const peers = new Map();
  let draining = false;
  let closePromise;
  let heartbeat;
  let metricTimer;
  let rejectedConnections = 0;
  const loop = monitorEventLoopDelay({ resolution: 20 });
  const server = http.createServer((req, res) => {
    if (['GET', 'HEAD'].includes(req.method) && (req.url === '/' || req.url === '/healthz')) {
      const ready = !draining && (!cluster || cluster.ready);
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'text/plain' });
      res.end(ready ? 'ok' : 'not ready');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.headersTimeout = config.handshakeMs;
  server.requestTimeout = config.handshakeMs;
  server.on('clientError', (_error, socket) => socket.destroy());
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayloadBytes });
  wss.on('error', (error) => logger.error('Yjs WebSocket server error:', error.message));

  const track = (conn, upstream = null) => {
    conn.alive = true;
    conn.on('pong', () => {
      conn.alive = true;
    });
    conn.on('error', () => conn.terminate());
    if (upstream) {
      peers.set(conn, upstream);
      conn.on('close', () => {
        peers.delete(conn);
        upstream.terminate();
      });
    }
  };

  const proxy = async (req, socket, head, remote, docName, tokenExp) => {
    const destination = validateOwnerAddress(remote.address, allowLoopback);
    // The path and auth parameters are forwarded to the private owner. They are
    // never logged, exposed as redirects, or accepted from an arbitrary host.
    destination.pathname = new URL(req.url, 'http://localhost').pathname;
    destination.search = new URL(req.url, 'http://localhost').search;
    const upstream = new WebSocket(destination, {
      handshakeTimeout: config.handshakeMs,
      maxPayload: config.maxBufferedBytes,
      headers: { 'x-yjs-route': routeHeader(secret, docName, remote.id) },
    });
    await new Promise((resolve, rejectPromise) => {
      let connected = false;
      upstream.on('error', (error) => {
        if (!connected) rejectPromise(error);
      });
      upstream.on('unexpected-response', (_request, response) => {
        response.resume();
        upstream.terminate();
        rejectPromise(new Error('Document owner unavailable'));
      });
      upstream.once('open', () => {
        if (socket.destroyed || draining) {
          upstream.terminate();
          rejectPromise(new Error('Upgrade cancelled'));
          return;
        }
        wss.handleUpgrade(req, socket, head, (conn) => {
          connected = true;
          track(conn, upstream);
          const expiry = tokenExp
            ? setTimeout(
                () => closeConnection(conn, 4401, 'token expired'),
                Math.max(0, tokenExp * 1000 - Date.now()),
              )
            : null;
          expiry?.unref?.();
          conn.on('close', () => clearTimeout(expiry));
          conn.on('message', (message, binary) => {
            if (!binary) return closeConnection(conn, 1003, 'binary messages required');
            send(upstream, message, config.maxBufferedBytes);
          });
          upstream.on('message', (message) => send(conn, message, config.maxBufferedBytes));
          upstream.on('close', (code, reason) => {
            closeConnection(
              conn,
              code >= 1000 && code !== 1005 && code !== 1006 ? code : 1012,
              reason.toString().slice(0, 100),
            );
          });
          resolve();
        });
      });
      socket.once('close', () => {
        if (!connected) {
          upstream.terminate();
          rejectPromise(new Error('Upgrade socket closed'));
        }
      });
    });
  };

  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    if (
      draining ||
      (cluster && !cluster.ready) ||
      wss.clients.size + upgrades.size >= config.maxConnections
    ) {
      rejectedConnections++;
      reject(socket, 503);
      return;
    }
    upgrades.add(socket);
    const deadline = setTimeout(() => socket.destroy(), config.handshakeMs);
    deadline.unref?.();
    try {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      if (!token) return reject(socket, 401);
      let identity;
      try {
        identity = await verifyJwt(token);
      } catch {
        return reject(socket, 401);
      }
      if (socket.destroyed || draining) return socket.destroy();
      const docName = docNameFromPath(url.pathname);
      const access = verifyRealtimeAccess({
        token: url.searchParams.get('docToken'),
        secret,
        requiredScope: requiredScopeForYjsDoc(docName),
        sub: identity.sub,
      });
      if (!access.ok && enforceScope) return reject(socket, 403);
      let lease = null;
      if (cluster) {
        const routed = verifyRoute(req.headers['x-yjs-route'], secret, docName, cluster.id);
        const route = await cluster.resolve(docName, routed);
        if (route.remote) {
          // A stale member view must produce a retry, not an unbounded proxy
          // chain. The next client reconnect re-resolves the owner.
          if (routed) return reject(socket, 503);
          await proxy(req, socket, head, route.remote, docName, access.payload?.exp);
          return;
        }
        lease = route.lease;
      }
      const room = await rooms.get(docName, lease);
      if (socket.destroyed || draining) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (conn) => {
        track(conn);
        rooms.attach(room, conn, access.payload?.exp);
      });
    } catch (error) {
      rejectedConnections++;
      logger.warn('Yjs upgrade unavailable:', error.name);
      reject(socket, 503);
    } finally {
      clearTimeout(deadline);
      upgrades.delete(socket);
    }
  });

  const metrics = () => {
    let queuedBytes = 0;
    let documentBytes = 0;
    for (const conn of wss.clients) queuedBytes += conn.bufferedAmount;
    for (const conn of peers.values()) queuedBytes += conn.bufferedAmount;
    for (const room of rooms.rooms.values()) documentBytes += room.estimatedBytes;
    const values = {
      Connections: wss.clients.size,
      ProxiedConnections: peers.size,
      Documents: rooms.rooms.size,
      DocumentBytes: documentBytes,
      QueuedBytes: queuedBytes,
      ResidentMemoryBytes: process.memoryUsage().rss,
      EventLoopDelayP99Ms: Number.isFinite(loop.percentile(99)) ? loop.percentile(99) / 1e6 : 0,
      Updates: rooms.updates,
      UpdateBytes: rooms.updateBytes,
      PersistenceErrors: rooms.persistenceErrors,
      RejectedConnections: rejectedConnections,
      CapacityUtilization:
        100 *
        Math.max(
          (wss.clients.size + upgrades.size) / config.maxConnections,
          rooms.rooms.size / config.maxDocuments,
          documentBytes / config.maxTotalDocumentBytes,
        ),
    };
    rooms.updates = 0;
    rooms.updateBytes = 0;
    rooms.persistenceErrors = 0;
    rejectedConnections = 0;
    loop.reset();
    return values;
  };

  const close = () => {
    if (closePromise) return closePromise;
    draining = true;
    clearInterval(heartbeat);
    clearInterval(metricTimer);
    loop.disable();
    for (const socket of upgrades) socket.destroy();
    closePromise = (async () => {
      const deadline = setTimeout(() => {
        for (const conn of wss.clients) conn.terminate();
        for (const upstream of peers.values()) upstream.terminate();
        server.closeAllConnections();
      }, config.shutdownMs);
      deadline.unref?.();
      try {
        const results = cluster ? await cluster.stop() : await rooms.drain();
        if (results.some((result) => result.status === 'rejected')) {
          logger.error('Yjs shutdown left uncommitted changes; clients must resynchronize');
        }
        for (const conn of wss.clients) closeConnection(conn, 1012, 'server restarting');
        await new Promise((resolve) => server.close(resolve));
        await new Promise((resolve) => wss.close(resolve));
      } finally {
        clearTimeout(deadline);
      }
    })();
    return closePromise;
  };

  const listen = async () => {
    await new Promise((resolve, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(config.port, () => {
        server.removeListener('error', rejectPromise);
        resolve();
      });
    });
    if (cluster) {
      if (!cluster.address) cluster.address = `ws://127.0.0.1:${server.address().port}`;
      try {
        await cluster.start(rooms);
      } catch (error) {
        await close();
        throw error;
      }
    }
    loop.enable();
    heartbeat = setInterval(() => {
      for (const conn of wss.clients) {
        if (!conn.alive) conn.terminate();
        else {
          conn.alive = false;
          if (conn.readyState === 1) conn.ping();
        }
      }
    }, config.heartbeatMs);
    heartbeat.unref?.();
    metricTimer = setInterval(() => {
      const values = metrics();
      logger.log(
        JSON.stringify({
          _aws: {
            Timestamp: Date.now(),
            CloudWatchMetrics: [
              {
                Namespace: config.metricsNamespace,
                Dimensions: [['ServiceName']],
                Metrics: Object.keys(values).map((Name) => ({ Name })),
              },
            ],
          },
          ServiceName: config.serviceName,
          ...values,
        }),
      );
    }, 30_000);
    metricTimer.unref?.();
    return server.address();
  };
  return { server, wss, rooms, cluster, listen, close, metrics };
};
