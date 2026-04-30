import { authService } from './auth';

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

  async connect(documentId: string): Promise<void> {
    // Already connected or connecting to this document — skip
    if (this.documentId === documentId) {
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
      if (this.connectingPromise) return this.connectingPromise;
    }

    this.documentId = documentId;
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

    // After the async getSession(), verify we're still supposed to connect to this documentId
    if (this.documentId !== documentId) return;

    const url = `${WS_URL}?token=${session.idToken}&documentId=${documentId}`;
    console.log('[WebSocket] Connecting to:', documentId);
    this.setStatus('connecting');

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[WebSocket] Connected to:', documentId);
      this.setStatus('connected');
      this.reconnectAttempts = 0;
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log('[WebSocket] Received message:', data);
      const key = data.action || data.type;
      if (key) {
        const handlers = this.handlers.get(key);
        console.log('[WebSocket] Handlers for', key, ':', handlers?.size || 0);
        handlers?.forEach(h => h(data));
      }
    };

    this.ws.onclose = () => {
      this.setStatus('disconnected');
      this.scheduleReconnect();
    };

    this.ws.onerror = () => this.setStatus('error');
  }

  disconnect(): void {
    if (this.ws) {
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
    const message = JSON.stringify({ action, ...data, documentId: this.documentId });
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

  getYjsUrl(documentId: string, idToken: string): string {
    const encodedToken = encodeURIComponent(idToken);
    const encodedDoc = encodeURIComponent(documentId);
    return `${YJS_URL}/${encodedDoc}?token=${encodedToken}`;
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.statusHandlers.forEach(h => h(status));
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts || !this.documentId) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    setTimeout(() => this.documentId && this.connect(this.documentId), delay);
  }
}

export const realtimeService = new RealtimeService();
