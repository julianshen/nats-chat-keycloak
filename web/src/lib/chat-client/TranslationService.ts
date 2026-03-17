import { TypedEmitter } from './EventEmitter';
import { ConnectionManager, sc } from './ConnectionManager';
import { tracedHeaders } from '../../utils/tracing';

type TranslationEvents = {
  availabilityChanged: (available: boolean) => void;
  result: (msgKey: string, text: string, done: boolean) => void;
};

export class TranslationService extends TypedEmitter<TranslationEvents> {
  private cm: ConnectionManager;
  private _available = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(cm: ConnectionManager) {
    super();
    this.cm = cm;
  }

  get isAvailable(): boolean { return this._available; }

  async checkAvailability(): Promise<void> {
    if (!this.cm.nc) return;
    try {
      const reply = await this.cm.nc.request('translate.ping', sc.encode('ping'), { timeout: 3000 });
      const result = JSON.parse(sc.decode(reply.data));
      const was = this._available;
      this._available = result.status === 'ok';
      if (was !== this._available) this.emit('availabilityChanged', this._available);
    } catch {
      if (this._available) {
        this._available = false;
        this.emit('availabilityChanged', false);
      }
    }
  }

  startPolling(): void {
    this.checkAvailability();
    this.pollTimer = setInterval(() => {
      if (!this._available) this.checkAvailability();
    }, 60000);
  }

  request(text: string, targetLang: string, msgKey: string): void {
    if (!this.cm.nc || !this._available) return;
    const { headers } = tracedHeaders('translate.request');
    this.cm.nc.publish('translate.request',
      sc.encode(JSON.stringify({ text, targetLang, msgKey })),
      { headers }
    );
  }

  /** Called by ChatClient when MessageStore receives a translation response */
  handleResult(msgKey: string, text: string, done: boolean): void {
    this.emit('result', msgKey, text, done);
  }

  clearResult(_msgKey: string): void {
    // Results managed by consumer (React hook) — signal only
  }

  markUnavailable(): void {
    this._available = false;
    this.emit('availabilityChanged', false);
  }

  destroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.removeAllListeners();
  }
}
