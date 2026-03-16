import { connect, type NatsConnection, StringCodec } from 'nats.ws';
import { TypedEmitter } from './EventEmitter';

export const sc = StringCodec();

type ConnectionEvents = {
  connected: () => void;
  disconnected: () => void;
  reconnected: () => void;
  error: (err: string) => void;
};

export class ConnectionManager extends TypedEmitter<ConnectionEvents> {
  private _nc: NatsConnection | null = null;
  private _connected = false;
  private connecting = false;
  private wsUrl: string;
  private name: string;

  constructor(config: { wsUrl: string; name: string }) {
    super();
    this.wsUrl = config.wsUrl;
    this.name = config.name;
  }

  get nc(): NatsConnection | null { return this._nc; }
  get isConnected(): boolean { return this._connected; }

  async connect(token: string): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;

    // Drain old connection
    if (this._nc) {
      try { await this._nc.drain(); } catch { /* ignore */ }
      this._nc = null;
      this._connected = false;
    }

    try {
      const conn = await connect({
        servers: this.wsUrl,
        token,
        name: this.name,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 2000,
      });

      this._nc = conn;
      this._connected = true;
      this.emit('connected');

      // Monitor status — stop if connection replaced
      (async () => {
        for await (const s of conn.status()) {
          if (this._nc !== conn) break;
          switch (s.type) {
            case 'disconnect':
              this._connected = false;
              this.emit('disconnected');
              break;
            case 'reconnect':
              this._connected = true;
              this.emit('reconnected');
              break;
            case 'error':
              this.emit('error', `Connection error: ${s.data}`);
              break;
          }
        }
      })();

      // Handle close
      conn.closed().then(() => {
        if (this._nc === conn) {
          this._connected = false;
          this._nc = null;
          this.emit('disconnected');
        }
      });
    } catch (err: any) {
      this.emit('error', `Failed to connect: ${err.message}`);
      this._connected = false;
    } finally {
      this.connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    if (this._nc) {
      try { await this._nc.drain(); } catch { /* ignore */ }
      this._nc = null;
      this._connected = false;
    }
  }
}
