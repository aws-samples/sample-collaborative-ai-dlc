import { authService } from './auth';
import {
  getRealtimeToken,
  invalidateRealtimeToken,
  msUntilRefresh,
  scopeTargetForChannel,
  type RealtimeScopeTarget,
} from '../lib/realtimeToken';

const WS_URL = import.meta.env.VITE_WEBSOCKET_URL;
const YJS_URL = import.meta.env.VITE_YJS_SERVER_URL;

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
type MessageHandler = (data: any) => void;

class RealtimeService {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private statusHandlers: Set<(status: ConnectionStatus) => void> = new Set();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private documentId: string | null = null;
  private connectingPromise: Promise<void> | null = null;
  private tokenRefreshTimer: number | null = null;
  // Explicit scope target for channels whose documentId can't yield the full
  // token target on its own (e.g. `intent:<id>`, where the token endpoint is
  // project-scoped). When set, it overrides scopeTargetForChannel.
  private scopeTarget: RealtimeScopeTarget | null = null;

  // Resolve the token target for the current connection: the explicit override
  // when set, else derived from the documentId shape.
  private tokenTarget(documentId: string): RealtimeScopeTarget | null {
    return this.scopeTarget ?? scopeTargetForChannel(documentId);
  }

  async connect(documentId: string, scopeTarget?: RealtimeScopeTarget): Promise<void> {
    // Already connected or connecting to this document — skip
    if (this.documentId === documentId) {
      if (
        this.ws &&
        (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
      )
        return;
      if (this.connectingPromise) return this.connectingPromise;
    }

    this.documentId = documentId;
    this.scopeTarget = scopeTarget ?? null;
    this.disconnect();
    this.reconnectAttempts = 0;

    this.connectingPromise = this.doConnect(documentId);
    try {
      await this.connectingPromise;
    } finally {
      this.connectingPromise = null;
    }
  }

  private async doConnect(documentId: string): Promise<void> {
    const session = await authService.getSession();
    if (!session?.idToken) throw new Error('Not authenticated');

    // Realtime scope token: ws-connection verifies signature,
    // expiry, scope coverage for this documentId, and sub binding at $connect.
    const target = this.tokenTarget(documentId);
    if (!target) throw new Error(`Unknown realtime documentId format: ${documentId}`);
    const docToken = await getRealtimeToken(target);

    // After the async calls, verify we're still supposed to connect to this documentId
    if (this.documentId !== documentId) return;

    const url = `${WS_URL}?token=${session.idToken}&documentId=${encodeURIComponent(documentId)}&docToken=${encodeURIComponent(docToken.token)}`;
    console.log('[WebSocket] Connecting to:', documentId);
    this.setStatus('connecting');

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[WebSocket] Connected to:', documentId);
      this.setStatus('connected');
      this.reconnectAttempts = 0;
      // Proactively reconnect shortly before the scope token expires so the
      // connection row's tokenExp is renewed (server fan-out filters expired
      // rows, and ws-message rejects sends from them).
      this.scheduleTokenRefresh(documentId, docToken.exp);
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log('[WebSocket] Received message:', data);
      const key = data.action || data.type;
      if (key) {
        const handlers = this.handlers.get(key);
        console.log('[WebSocket] Handlers for', key, ':', handlers?.size || 0);
        handlers?.forEach((h) => h(data));
      }
    };

    this.ws.onclose = () => {
      this.setStatus('disconnected');
      this.scheduleReconnect();
    };

    this.ws.onerror = () => this.setStatus('error');
  }

  disconnect(): void {
    this.clearTokenRefresh();
    if (this.ws) {
      // Detach handlers before closing: an intentional close must not trigger
      // scheduleReconnect() via onclose, which would resurrect the connection.
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      this.ws.close();
      this.ws = null;
    }
    this.setStatus('disconnected');
  }

  send(action: string, data: any): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.log('WebSocket not open, cannot send:', action);
      return;
    }
    // `action` and `documentId` are spread LAST so payload fields can never
    // clobber the route action, and the target is always the connected
    // document (the server binds to the registered document anyway).
    const message = JSON.stringify({ ...data, action, documentId: this.documentId });
    console.log('Sending WebSocket message:', message);
    this.ws.send(message);
  }

  on(action: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(action)) this.handlers.set(action, new Set());
    this.handlers.get(action)!.add(handler);
    return () => this.handlers.get(action)?.delete(handler);
  }

  onStatusChange(handler: (status: ConnectionStatus) => void): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getYjsUrl(documentId: string, idToken: string, docToken?: string): string {
    const encodedToken = encodeURIComponent(idToken);
    const encodedDoc = encodeURIComponent(documentId);
    const docTokenParam = docToken ? `&docToken=${encodeURIComponent(docToken)}` : '';
    return `${YJS_URL}/${encodedDoc}?token=${encodedToken}${docTokenParam}`;
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.statusHandlers.forEach((h) => h(status));
  }

  private scheduleTokenRefresh(documentId: string, exp: number): void {
    this.clearTokenRefresh();
    this.tokenRefreshTimer = window.setTimeout(() => {
      this.tokenRefreshTimer = null;
      if (this.documentId !== documentId) return;
      const target = this.tokenTarget(documentId);
      if (target) invalidateRealtimeToken(target);
      console.log('[WebSocket] Scope token expiring — reconnecting:', documentId);
      this.disconnect();
      this.connect(documentId).catch((e) =>
        console.error('[WebSocket] Token-refresh reconnect failed:', e),
      );
    }, msUntilRefresh(exp));
  }

  private clearTokenRefresh(): void {
    if (this.tokenRefreshTimer !== null) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts || !this.documentId) return;
    // The close may be an authorization rejection (e.g. expired scope token) —
    // drop the cached token so the retry fetches a fresh one.
    const target = this.tokenTarget(this.documentId);
    if (target) invalidateRealtimeToken(target);
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    setTimeout(() => this.documentId && this.connect(this.documentId), delay);
  }
}

export const realtimeService = new RealtimeService();
