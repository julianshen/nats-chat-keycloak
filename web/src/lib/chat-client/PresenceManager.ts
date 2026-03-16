import { TypedEmitter } from './EventEmitter';
import { ConnectionManager, sc } from './ConnectionManager';
import { RoomManager } from './RoomManager';
import { tracedHeaders } from '../../utils/tracing';

export type PresenceMember = { userId: string; status: string };

type PresenceEvents = {
  presenceChanged: (room: string, users: PresenceMember[]) => void;
};

export class PresenceManager extends TypedEmitter<PresenceEvents> {
  private cm: ConnectionManager;
  private rm: RoomManager;
  private username: string;
  private connId: string;
  private _currentStatus = 'online';
  private onlineUsersByRoom = new Map<string, PresenceMember[]>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private unsubJoined: (() => void) | null = null;
  private unsubRawPresence: (() => void) | null = null;

  constructor(cm: ConnectionManager, rm: RoomManager, username: string) {
    super();
    this.cm = cm;
    this.rm = rm;
    this.username = username;
    this.connId = crypto.randomUUID().slice(0, 8);

    // Listen for presence diffs from RoomManager
    this.unsubRawPresence = rm.on('rawPresence', (room: string, data: Uint8Array) => {
      this.handlePresenceDiff(room, data);
    });

    // Listen for newly joined rooms to fetch initial presence
    this.unsubJoined = rm.on('joined', (room: string) => {
      this.fetchInitialPresence(room);
    });
  }

  /** Returns current user's presence status */
  get currentStatus(): string {
    return this._currentStatus;
  }

  /** Returns a snapshot of online users for the given room */
  getOnlineUsers(room: string): PresenceMember[] {
    return this.onlineUsersByRoom.get(room) ?? [];
  }

  /** Publish a status update to presence.update */
  setStatus(status: string): void {
    this._currentStatus = status;
    const nc = this.cm.nc;
    if (!nc || !this.cm.isConnected) return;
    const payload = JSON.stringify({ userId: this.username, status });
    const { headers } = tracedHeaders('presence.update.publish');
    nc.publish('presence.update', sc.encode(payload), { headers });
  }

  /** Start sending periodic heartbeats every 10 seconds */
  startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;

    const publishHeartbeat = () => {
      const nc = this.cm.nc;
      if (!nc || !this.cm.isConnected) return;
      const payload = JSON.stringify({ userId: this.username, connId: this.connId });
      const { headers } = tracedHeaders('presence.heartbeat.publish');
      nc.publish('presence.heartbeat', sc.encode(payload), { headers });
    };

    // Publish immediately, then on interval
    publishHeartbeat();
    this.heartbeatTimer = setInterval(publishHeartbeat, 10_000);
  }

  /** Stop the heartbeat interval */
  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Publish a graceful disconnect so presence-service can mark user offline */
  publishDisconnect(): void {
    const nc = this.cm.nc;
    if (!nc) return;
    const payload = JSON.stringify({ userId: this.username, connId: this.connId });
    const { headers } = tracedHeaders('presence.disconnect.publish');
    nc.publish('presence.disconnect', sc.encode(payload), { headers });
  }

  /** Clean up all state and listeners */
  destroy(): void {
    this.stopHeartbeat();
    if (this.unsubRawPresence) {
      this.unsubRawPresence();
      this.unsubRawPresence = null;
    }
    if (this.unsubJoined) {
      this.unsubJoined();
      this.unsubJoined = null;
    }
    this.onlineUsersByRoom.clear();
    this.removeAllListeners();
  }

  /** Handle a raw presence diff message for a room */
  private handlePresenceDiff(room: string, data: Uint8Array): void {
    try {
      const diff = JSON.parse(sc.decode(data)) as {
        action: string;
        userId: string;
        status?: string;
      };

      const current = this.onlineUsersByRoom.get(room) ?? [];

      let updated: PresenceMember[];
      switch (diff.action) {
        case 'online':
        case 'status': {
          const member: PresenceMember = { userId: diff.userId, status: diff.status ?? 'online' };
          const idx = current.findIndex(m => m.userId === diff.userId);
          if (idx >= 0) {
            updated = [...current];
            updated[idx] = member;
          } else {
            updated = [...current, member];
          }
          break;
        }
        case 'offline': {
          updated = current.filter(m => m.userId !== diff.userId);
          break;
        }
        default:
          return;
      }

      this.onlineUsersByRoom.set(room, updated);
      this.emit('presenceChanged', room, updated);
    } catch {
      // ignore malformed messages
    }
  }

  /** Request initial presence for a room via presence.room.{memberKey} request/reply */
  private fetchInitialPresence(room: string): void {
    const nc = this.cm.nc;
    if (!nc || !this.cm.isConnected) return;

    const memberKey = this.rm.roomToMemberKey(room);
    const { headers } = tracedHeaders('presence.room.request');
    nc.request(`presence.room.${memberKey}`, sc.encode(''), { timeout: 5000, headers })
      .then((reply) => {
        try {
          const members = JSON.parse(sc.decode(reply.data)) as PresenceMember[];
          this.onlineUsersByRoom.set(room, members);
          this.emit('presenceChanged', room, members);
        } catch {
          // ignore malformed response
        }
      })
      .catch(() => {
        // presence service may not respond — not fatal
      });
  }
}
