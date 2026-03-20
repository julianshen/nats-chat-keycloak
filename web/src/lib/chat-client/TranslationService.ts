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
  private _results = new Map<string, string>();

  constructor(cm: ConnectionManager) {
    super();
    this.cm = cm;
  }

  /** Get all cached translation results. */
  get results(): ReadonlyMap<string, string> { return this._results; }

  get isAvailable(): boolean { return this._available; }

  async checkAvailability(): Promise<void> {
    if (!this.cm.nc) return;
    try {
      const reply = await this.cm.nc.request('translate.ping', sc.encode('ping'), { timeout: 3000 });
      const result = JSON.parse(sc.decode(reply.data));
      const was = this._available;
      this._available = result.available === true || result.status === 'ok';
      if (was !== this._available) this.emit('availabilityChanged', this._available);
    } catch (err) {
      console.warn('[Translation] Ping failed:', err);
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

  request(text: string, targetLang: string, msgKey: string, user: string): void {
    if (!this.cm.nc || !this._available) return;
    const { headers } = tracedHeaders('translate.request');
    this.cm.nc.publish('translate.request',
      sc.encode(JSON.stringify({ text, targetLang, msgKey, user })),
      { headers }
    );
  }

  /** Called by ChatClient when MessageStore receives a translation response */
  handleResult(msgKey: string, text: string, done: boolean): void {
    this._results.set(msgKey, text);
    this.emit('result', msgKey, text, done);
  }

  clearResult(msgKey: string): void {
    this._results.delete(msgKey);
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
