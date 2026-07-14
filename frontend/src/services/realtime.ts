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

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
type MessageHandler = (data: any) => void;

interface ConnectionRequest {
  documentId: string;
  scopeTarget: RealtimeScopeTarget;
  generation: number;
}

const targetKey = (target: RealtimeScopeTarget): string => {
  if ('sprintId' in target) return `sprint:${target.sprintId}`;
  if ('intentId' in target) return `intent:${target.intentId}:${target.projectId}`;
  return `project:${target.projectId}`;
};

export class RealtimeService {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private statusHandlers: Set<(status: ConnectionStatus) => void> = new Set();
  private reconnectAttempts = 0;
  private request: ConnectionRequest | null = null;
  private generation = 0;
  private connectingPromise: Promise<void> | null = null;
  private tokenRefreshTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private tokenExp: number | null = null;
  private cancelPendingHandshake: (() => void) | null = null;

  constructor(listenForResume = true) {
    if (!listenForResume || typeof window === 'undefined' || typeof document === 'undefined')
      return;
    window.addEventListener('focus', this.resumeConnection);
    window.addEventListener('online', this.resumeConnection);
    document.addEventListener('visibilitychange', this.resumeConnection);
  }

  async connect(documentId: string, explicitTarget?: RealtimeScopeTarget): Promise<void> {
    const existingTarget =
      this.request?.documentId === documentId ? this.request.scopeTarget : null;
    const scopeTarget = explicitTarget ?? existingTarget ?? scopeTargetForChannel(documentId);
    if (!scopeTarget) throw new Error(`Unknown realtime documentId format: ${documentId}`);

    const sameRequest =
      this.request?.documentId === documentId &&
      targetKey(this.request.scopeTarget) === targetKey(scopeTarget);
    if (sameRequest) {
      if (this.ws?.readyState === WebSocket.OPEN) return;
      if (this.connectingPromise) return this.connectingPromise;
    }

    this.reconnectAttempts = 0;
    return this.startConnection(documentId, scopeTarget);
  }

  private async startConnection(
    documentId: string,
    scopeTarget: RealtimeScopeTarget,
  ): Promise<void> {
    this.clearReconnect();

    const request: ConnectionRequest = {
      documentId,
      scopeTarget,
      generation: ++this.generation,
    };
    this.request = request;
    this.closeTransport();
    this.setStatus('connecting');

    const promise = this.doConnect(request).catch((error) => {
      if (this.isCurrent(request)) {
        this.setStatus('error');
        this.scheduleReconnect(request);
      }
      throw error;
    });
    this.connectingPromise = promise;
    try {
      await promise;
    } finally {
      if (this.connectingPromise === promise) this.connectingPromise = null;
    }
  }

  private async doConnect(request: ConnectionRequest): Promise<void> {
    const session = await authService.getSession();
    if (!session?.idToken) throw new Error('Not authenticated');

    const docToken = await getRealtimeToken(request.scopeTarget);
    if (!this.isCurrent(request)) return;

    const url = `${WS_URL}?token=${session.idToken}&documentId=${encodeURIComponent(request.documentId)}&docToken=${encodeURIComponent(docToken.token)}`;
    console.log('[WebSocket] Connecting to:', request.documentId);
    const ws = new WebSocket(url);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      let opened = false;
      let settled = false;
      let handshakeTimer: number | null = null;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (handshakeTimer !== null) clearTimeout(handshakeTimer);
        if (this.cancelPendingHandshake === cancel) this.cancelPendingHandshake = null;
        if (error) reject(error);
        else resolve();
      };
      const cancel = () => settle();
      this.cancelPendingHandshake = cancel;
      handshakeTimer = window.setTimeout(() => {
        if (opened || !this.isCurrent(request) || this.ws !== ws) return;
        ws.close();
        settle(new Error(`WebSocket handshake timed out: ${request.documentId}`));
      }, 15_000);

      // Handler assignment is intentional: closeTransport() detaches these
      // before an intentional close so that it cannot schedule a reconnect.
      ws.onopen = () => {
        if (!this.isCurrent(request) || this.ws !== ws) {
          ws.close();
          return;
        }
        opened = true;
        console.log('[WebSocket] Connected to:', request.documentId);
        this.setStatus('connected');
        this.reconnectAttempts = 0;
        this.tokenExp = docToken.exp;
        this.scheduleTokenRefresh(request, docToken.exp);
        settle();
      };

      ws.onmessage = (event) => {
        if (!this.isCurrent(request) || this.ws !== ws) return;
        let data: any;
        try {
          data = JSON.parse(event.data);
        } catch (error) {
          console.error('[WebSocket] Ignoring malformed message:', error);
          return;
        }
        const key = data.action || data.type;
        if (!key) return;
        for (const handler of this.handlers.get(key) ?? []) {
          try {
            handler(data);
          } catch (error) {
            console.error(`[WebSocket] Handler failed for ${key}:`, error);
          }
        }
      };

      ws.onclose = () => {
        if (!this.isCurrent(request) || this.ws !== ws) return;
        this.ws = null;
        this.clearTokenRefresh();
        this.setStatus('disconnected');
        this.scheduleReconnect(request);
        if (!opened) {
          settle(new Error(`WebSocket closed before connecting: ${request.documentId}`));
        }
      };

      ws.onerror = () => {
        if (this.isCurrent(request) && this.ws === ws) this.setStatus('error');
      };
    });
  }

  disconnect(): void {
    this.request = null;
    this.generation++;
    this.reconnectAttempts = 0;
    this.clearReconnect();
    this.closeTransport();
    this.setStatus('disconnected');
  }

  send(action: string, data: any): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.log('WebSocket not open, cannot send:', action);
      return;
    }
    const message = JSON.stringify({
      ...data,
      action,
      documentId: this.request?.documentId ?? null,
    });
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
    if (this.status === status) return;
    this.status = status;
    for (const handler of this.statusHandlers) {
      try {
        handler(status);
      } catch (error) {
        console.error('[WebSocket] Status handler failed:', error);
      }
    }
  }

  private isCurrent(request: ConnectionRequest): boolean {
    return (
      this.request?.generation === request.generation &&
      this.request.documentId === request.documentId
    );
  }

  private scheduleTokenRefresh(request: ConnectionRequest, exp: number): void {
    this.clearTokenRefresh();
    this.tokenRefreshTimer = window.setTimeout(() => {
      this.tokenRefreshTimer = null;
      if (!this.isCurrent(request)) return;
      invalidateRealtimeToken(request.scopeTarget);
      console.log('[WebSocket] Scope token expiring - reconnecting:', request.documentId);
      this.startConnection(request.documentId, request.scopeTarget).catch((error) =>
        console.error('[WebSocket] Token-refresh reconnect failed:', error),
      );
    }, msUntilRefresh(exp));
  }

  private scheduleReconnect(request: ConnectionRequest): void {
    if (!this.isCurrent(request) || this.reconnectTimer !== null) return;
    invalidateRealtimeToken(request.scopeTarget);
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    this.reconnectAttempts++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isCurrent(request)) return;
      this.startConnection(request.documentId, request.scopeTarget).catch((error) =>
        console.error('[WebSocket] Reconnect failed:', error),
      );
    }, delay);
  }

  private closeTransport(): void {
    this.clearTokenRefresh();
    this.tokenExp = null;
    this.cancelPendingHandshake?.();
    this.cancelPendingHandshake = null;
    if (!this.ws) return;
    this.ws.onclose = null;
    this.ws.onerror = null;
    this.ws.onmessage = null;
    this.ws.onopen = null;
    this.ws.close();
    this.ws = null;
  }

  private clearTokenRefresh(): void {
    if (this.tokenRefreshTimer === null) return;
    clearTimeout(this.tokenRefreshTimer);
    this.tokenRefreshTimer = null;
  }

  private clearReconnect(): void {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private resumeConnection = () => {
    if (document.visibilityState !== 'visible' || !this.request) return;
    if (this.connectingPromise) return;
    const request = this.request;
    const staleToken = this.tokenExp !== null && msUntilRefresh(this.tokenExp) === 0;
    if (this.ws?.readyState === WebSocket.OPEN && !staleToken) return;

    if (staleToken) invalidateRealtimeToken(request.scopeTarget);
    this.startConnection(request.documentId, request.scopeTarget).catch((error) =>
      console.error('[WebSocket] Resume reconnect failed:', error),
    );
  };
}

export const realtimeService = new RealtimeService();
