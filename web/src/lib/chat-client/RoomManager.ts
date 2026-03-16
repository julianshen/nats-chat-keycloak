import type { NatsConnection, Subscription, MsgHdrs } from 'nats.ws';
import { TypedEmitter } from './EventEmitter';
import { ConnectionManager, sc } from './ConnectionManager';
import { tracedHeaders } from '../../utils/tracing';

type RoomManagerEvents = {
  joined: (room: string) => void;
  left: (room: string) => void;
  rawNotification: (room: string, data: Uint8Array, headers: MsgHdrs | undefined) => void;
  rawPresence: (room: string, data: Uint8Array) => void;
};

interface RoomSubs {
  notifySub: Subscription;
  presSub: Subscription;
}

export class RoomManager extends TypedEmitter<RoomManagerEvents> {
  private cm: ConnectionManager;
  private username: string;
  private joinedRooms = new Set<string>();
  private roomSubs = new Map<string, RoomSubs>();

  constructor(cm: ConnectionManager, username: string) {
    super();
    this.cm = cm;
    this.username = username;
  }

  /** Maps a room name to the membership key used by fanout-service */
  roomToMemberKey(room: string): string {
    if (room === '__admin__') return '__admin__chat';
    return room;
  }

  /** Returns the set of currently joined rooms (by room name, not member key) */
  getJoinedRooms(): ReadonlySet<string> {
    return this.joinedRooms;
  }

  /** Join a room: subscribe to notifications + presence, publish join event */
  join(room: string): void {
    const nc = this.cm.nc;
    if (!nc || !this.cm.isConnected) return;

    const memberKey = this.roomToMemberKey(room);
    if (this.joinedRooms.has(room)) return;
    this.joinedRooms.add(room);

    // Publish join event
    const joinSubject = `room.join.${memberKey}`;
    const payload = JSON.stringify({ userId: this.username });
    const { headers: joinHdr } = tracedHeaders('room.join.publish');
    nc.publish(joinSubject, sc.encode(payload), { headers: joinHdr });

    // Subscribe to per-room subjects
    this.setupRoomSubscriptions(nc, memberKey, room);

    this.emit('joined', room);
  }

  /** Leave a room: unsubscribe and publish leave event */
  leave(room: string): void {
    const nc = this.cm.nc;
    if (!nc || !this.cm.isConnected) return;

    const memberKey = this.roomToMemberKey(room);
    if (!this.joinedRooms.has(room)) return;
    this.joinedRooms.delete(room);

    // Unsubscribe from per-room subjects
    const subs = this.roomSubs.get(memberKey);
    if (subs) {
      subs.notifySub.unsubscribe();
      subs.presSub.unsubscribe();
      this.roomSubs.delete(memberKey);
    }

    // Publish leave event
    const leaveSubject = `room.leave.${memberKey}`;
    const payload = JSON.stringify({ userId: this.username });
    const { headers: leaveHdr } = tracedHeaders('room.leave.publish');
    nc.publish(leaveSubject, sc.encode(payload), { headers: leaveHdr });

    this.emit('left', room);
  }

  /** Leave all currently joined rooms */
  leaveAll(): void {
    const rooms = [...this.joinedRooms];
    for (const room of rooms) {
      this.leave(room);
    }
  }

  /** Re-join all previously joined rooms (e.g. after reconnect) */
  rejoinAll(): void {
    const nc = this.cm.nc;
    if (!nc || !this.cm.isConnected) return;

    const previousRooms = [...this.joinedRooms];

    // Clear old subscriptions (dead from previous nc)
    for (const [, subs] of this.roomSubs) {
      try { subs.notifySub.unsubscribe(); } catch { /* ignore */ }
      try { subs.presSub.unsubscribe(); } catch { /* ignore */ }
    }
    this.roomSubs.clear();
    this.joinedRooms.clear();

    // Re-join each room
    for (const room of previousRooms) {
      const memberKey = this.roomToMemberKey(room);
      this.joinedRooms.add(room);

      const joinPayload = JSON.stringify({ userId: this.username });
      const { headers: rejoinHdr } = tracedHeaders('room.rejoin.publish');
      nc.publish(`room.join.${memberKey}`, sc.encode(joinPayload), { headers: rejoinHdr });

      this.setupRoomSubscriptions(nc, memberKey, room);
      this.emit('joined', room);
    }
  }

  /** Clean up all subscriptions and state */
  destroy(): void {
    for (const [, subs] of this.roomSubs) {
      try { subs.notifySub.unsubscribe(); } catch { /* ignore */ }
      try { subs.presSub.unsubscribe(); } catch { /* ignore */ }
    }
    this.roomSubs.clear();
    this.joinedRooms.clear();
    this.removeAllListeners();
  }

  /** Set up per-room subscriptions and forward raw data via events */
  private setupRoomSubscriptions(nc: NatsConnection, memberKey: string, room: string): void {
    const notifySub = nc.subscribe(`room.notify.${memberKey}`);
    const presSub = nc.subscribe(`room.presence.${memberKey}`);
    this.roomSubs.set(memberKey, { notifySub, presSub });

    // Forward notification messages
    (async () => {
      try {
        for await (const msg of notifySub) {
          this.emit('rawNotification', room, msg.data, msg.headers);
        }
      } catch {
        // subscription ended
      }
    })();

    // Forward presence messages
    (async () => {
      try {
        for await (const msg of presSub) {
          this.emit('rawPresence', room, msg.data);
        }
      } catch {
        // subscription ended
      }
    })();
  }
}
