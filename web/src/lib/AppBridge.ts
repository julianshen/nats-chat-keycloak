import type { NatsConnection } from 'nats.ws';
import { StringCodec } from 'nats.ws';

export type AppCallback = (data: unknown) => void;

/**
 * Shared callback registry for all app bridges.
 * Key format: "{appId}.{room}.{event}"
 * MessageProvider routes matching deliver subjects to these callbacks.
 */
const appCallbacks = new Map<string, Set<AppCallback>>();

/** Called by MessageProvider to route incoming app messages to registered callbacks. */
export function routeAppMessage(appId: string, room: string, event: string, data: unknown): void {
  const key = `${appId}.${room}.${event}`;
  const cbs = appCallbacks.get(key);
  if (cbs) {
    for (const cb of cbs) {
      try { cb(data); } catch (e) { console.error('[AppBridge] Callback error:', e); }
    }
  }
}

export interface AppBridge {
  request(action: string, data?: unknown): Promise<unknown>;
  subscribe(event: string, callback: AppCallback): () => void;
  readonly user: { username: string };
  readonly room: string;
  readonly appId: string;
}

/**
 * Creates a frozen AppBridge for a guest app.
 * The bridge scopes all communication to app.{appId}.{room}.* and
 * injects the authenticated user into every outgoing payload.
 */
export function createAppBridge(
  nc: NatsConnection,
  sc: ReturnType<typeof StringCodec>,
  appId: string,
  room: string,
  username: string,
): AppBridge {
  const localSubs = new Set<string>();

  const validateAction = (action: string) => {
    if (/[.*>]/.test(action)) {
      throw new Error(`Invalid action name: "${action}" (contains wildcard characters)`);
    }
  };

  const bridge: AppBridge = {
    async request(action: string, data?: unknown): Promise<unknown> {
      validateAction(action);
      const subject = `app.${appId}.${room}.${action}`;
      const payload = { ...((data as Record<string, unknown>) || {}), user: username };
      const reply = await nc.request(subject, sc.encode(JSON.stringify(payload)), { timeout: 5000 });
      return JSON.parse(sc.decode(reply.data));
    },

    subscribe(event: string, callback: AppCallback): () => void {
      validateAction(event);
      const key = `${appId}.${room}.${event}`;
      if (!appCallbacks.has(key)) {
        appCallbacks.set(key, new Set());
      }
      appCallbacks.get(key)!.add(callback);
      localSubs.add(key);

      return () => {
        const cbs = appCallbacks.get(key);
        if (cbs) {
          cbs.delete(callback);
          if (cbs.size === 0) appCallbacks.delete(key);
        }
        localSubs.delete(key);
      };
    },

    user: Object.freeze({ username }),
    room,
    appId,
  };

  return Object.freeze(bridge);
}

/** Cleans up all subscriptions for a given app instance. */
export function destroyAppBridge(appId: string, room: string): void {
  const prefix = `${appId}.${room}.`;
  for (const key of appCallbacks.keys()) {
    if (key.startsWith(prefix)) {
      appCallbacks.delete(key);
    }
  }
}
