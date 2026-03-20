import { TypedEmitter } from './EventEmitter';
import { ConnectionManager, sc } from './ConnectionManager';
import { RoomManager } from './RoomManager';
import { MessageStore } from './MessageStore';
import { PresenceManager } from './PresenceManager';
import { E2EEKeyManager } from './E2EEKeyManager';
import { ReadReceiptManager } from './ReadReceiptManager';
import { TranslationService } from './TranslationService';
import { FileService } from './FileService';
import { tracedHeaders } from '../../utils/tracing';
import type { ChatClientConfig, SendOptions } from './types';

type ClientEvents = {
  connected: () => void;
  disconnected: () => void;
  error: (err: string) => void;
};

export function shouldRejoinRoomsOnConnected(joinedRooms: ReadonlySet<string>): boolean {
  return joinedRooms.size > 0;
}

export class ChatClient extends TypedEmitter<ClientEvents> {
  readonly connection: ConnectionManager;
  readonly rooms: RoomManager;
  readonly messages: MessageStore;
  readonly presence: PresenceManager;
  readonly e2ee: E2EEKeyManager;
  readonly readReceipts: ReadReceiptManager;
  readonly translation: TranslationService;
  readonly files: FileService;

  private config: ChatClientConfig;
  private cleanupBeforeUnload: (() => void) | null = null;

  constructor(config: ChatClientConfig) {
    super();
    this.config = config;

    // Create managers
    this.connection = new ConnectionManager({ wsUrl: config.wsUrl, name: config.username });
    this.rooms = new RoomManager(this.connection, config.username);
    this.e2ee = new E2EEKeyManager(this.connection, config.username);
    this.messages = new MessageStore(this.connection, this.rooms, config.username);
    this.presence = new PresenceManager(this.connection, this.rooms, config.username);
    this.readReceipts = new ReadReceiptManager(this.connection, this.rooms, config.username);
    this.translation = new TranslationService(this.connection);

    const mediaBaseUrl = (typeof window !== 'undefined' && ((window as any).__env__?.VITE_MEDIA_BASE_URL || import.meta.env.VITE_MEDIA_BASE_URL)) || `http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:8095`;
    this.files = new FileService(this.connection, config.username, mediaBaseUrl);

    // Wire events
    this.connection.on('connected', () => {
      // If we had previously joined rooms, ensure subscriptions are restored on fresh reconnects.
      if (shouldRejoinRoomsOnConnected(this.rooms.getJoinedRooms())) {
        this.rooms.rejoinAll();
      }
      this.e2ee.init();
      this.presence.startHeartbeat();
      this.translation.startPolling();
      this.messages.start();
      this.emit('connected');
    });

    this.connection.on('reconnected', () => {
      this.rooms.rejoinAll();
      this.presence.startHeartbeat();
      this.messages.start();
      this.emit('connected');
    });

    this.connection.on('disconnected', () => {
      this.presence.stopHeartbeat();
      this.emit('disconnected');
    });

    this.connection.on('error', (err) => this.emit('error', err));

    this.rooms.on('joined', (room) => {
      this.e2ee.fetchRoomMeta(room);
    });

    // Wire translation results: MessageStore receives on deliver.{user}.translate.*,
    // forwards to TranslationService which emits to useTranslation hook
    this.messages.on('translationReceived', (msgKey, translation) => {
      this.translation.handleResult(msgKey, translation.text, translation.done ?? true);
    });

    // beforeunload cleanup
    if (typeof window !== 'undefined') {
      const handler = () => {
        this.rooms.leaveAll();
        this.presence.publishDisconnect();
        try { this.connection.nc?.flush(); } catch { /* ignore */ }
      };
      window.addEventListener('beforeunload', handler);
      this.cleanupBeforeUnload = () => window.removeEventListener('beforeunload', handler);
    }
  }

  async connect(): Promise<void> {
    await this.connection.connect(this.config.token);
  }

  async disconnect(): Promise<void> {
    this.messages.destroy();
    this.presence.destroy();
    this.translation.destroy();
    this.readReceipts.destroy();
    this.rooms.destroy();
    this.e2ee.destroy();
    await this.connection.disconnect();
    if (this.cleanupBeforeUnload) {
      this.cleanupBeforeUnload();
      this.cleanupBeforeUnload = null;
    }
    this.removeAllListeners();
  }

  get isConnected(): boolean { return this.connection.isConnected; }
  get username(): string { return this.config.username; }

  // Convenience methods — delegate to managers
  joinRoom(room: string): void { this.rooms.join(room); }
  leaveRoom(room: string): void { this.rooms.leave(room); }

  async sendMessage(room: string, text: string, opts?: SendOptions): Promise<void> {
    if (!this.connection.nc) throw new Error('Not connected');
    const payload: Record<string, unknown> = {
      user: this.config.username,
      text,
      timestamp: Date.now(),
    };
    if (opts?.mentions) payload.mentions = opts.mentions;
    if (opts?.sticker) payload.sticker = opts.sticker;
    if (opts?.threadId) payload.threadId = opts.threadId;

    if (this.e2ee.isRoomEncrypted(room)) {
      const result = await this.e2ee.encrypt(room, text, this.config.username, payload.timestamp as number);
      if (result) {
        payload.text = result.ciphertext;
        payload.e2ee = { epoch: result.epoch, v: 1 };
      }
    }

    const subject = opts?.threadId
      ? `deliver.${this.config.username}.send.${room}.thread.${opts.threadId}`
      : `deliver.${this.config.username}.send.${room}`;

    const { headers } = tracedHeaders('chat.send');
    this.connection.nc.publish(subject, sc.encode(JSON.stringify(payload)), { headers });
  }

  async editMessage(room: string, timestamp: number, user: string, newText: string): Promise<void> {
    if (!this.connection.nc) return;
    const payload = {
      user: this.config.username,
      text: newText,
      timestamp: Date.now(),
      editTimestamp: timestamp,
      editUser: user,
      action: 'edit',
    };
    const { headers } = tracedHeaders('chat.edit');
    this.connection.nc.publish(`deliver.${this.config.username}.send.${room}`,
      sc.encode(JSON.stringify(payload)), { headers });
  }

  async deleteMessage(room: string, timestamp: number, user: string): Promise<void> {
    if (!this.connection.nc) return;
    const payload = {
      user: this.config.username,
      timestamp: Date.now(),
      deleteTimestamp: timestamp,
      deleteUser: user,
      action: 'delete',
    };
    const { headers } = tracedHeaders('chat.delete');
    this.connection.nc.publish(`deliver.${this.config.username}.send.${room}`,
      sc.encode(JSON.stringify(payload)), { headers });
  }

  async reactToMessage(room: string, timestamp: number, user: string, emoji: string): Promise<void> {
    if (!this.connection.nc) return;
    const payload = {
      user: this.config.username,
      timestamp: Date.now(),
      reactTimestamp: timestamp,
      reactUser: user,
      emoji,
      action: 'react',
    };
    const { headers } = tracedHeaders('chat.react');
    this.connection.nc.publish(`deliver.${this.config.username}.send.${room}`,
      sc.encode(JSON.stringify(payload)), { headers });
  }

  // Room management operations (request/reply to room-service)
  async searchUsers(query: string): Promise<Array<{ username: string; email?: string }>> {
    if (!this.connection.nc) return [];
    try {
      const reply = await this.connection.nc.request('users.search',
        sc.encode(query), { timeout: 5000 });
      return JSON.parse(sc.decode(reply.data));
    } catch { return []; }
  }

  async getRoomInfo(room: string): Promise<any> {
    if (!this.connection.nc) return null;
    try {
      const reply = await this.connection.nc.request(`room.info.${room}`,
        sc.encode(JSON.stringify({ user: this.config.username })), { timeout: 5000 });
      return JSON.parse(sc.decode(reply.data));
    } catch { return null; }
  }

  async listRooms(): Promise<any[]> {
    if (!this.connection.nc) return [];
    try {
      const reply = await this.connection.nc.request('room.list',
        sc.encode(JSON.stringify({ user: this.config.username })), { timeout: 5000 });
      return JSON.parse(sc.decode(reply.data));
    } catch { return []; }
  }

  async listDMs(): Promise<string[]> {
    if (!this.connection.nc) return [];
    try {
      const reply = await this.connection.nc.request('chat.dms',
        sc.encode(this.config.username), { timeout: 5000 });
      return JSON.parse(sc.decode(reply.data));
    } catch { return []; }
  }

  async createRoom(name: string, displayName?: string): Promise<any> {
    if (!this.connection.nc) return null;
    try {
      const reply = await this.connection.nc.request('room.create',
        sc.encode(JSON.stringify({ name, displayName, user: this.config.username })), { timeout: 5000 });
      return JSON.parse(sc.decode(reply.data));
    } catch { return null; }
  }

  async inviteUser(room: string, targetUser: string): Promise<any> {
    if (!this.connection.nc) return null;
    try {
      const reply = await this.connection.nc.request(`room.invite.${room}`,
        sc.encode(JSON.stringify({ user: this.config.username, target: targetUser })), { timeout: 5000 });
      return JSON.parse(sc.decode(reply.data));
    } catch { return null; }
  }

  async kickUser(room: string, targetUser: string): Promise<any> {
    if (!this.connection.nc) return null;
    try {
      const reply = await this.connection.nc.request(`room.kick.${room}`,
        sc.encode(JSON.stringify({ user: this.config.username, target: targetUser })), { timeout: 5000 });
      return JSON.parse(sc.decode(reply.data));
    } catch { return null; }
  }

  async departRoom(room: string): Promise<any> {
    if (!this.connection.nc) return null;
    try {
      const reply = await this.connection.nc.request(`room.depart.${room}`,
        sc.encode(JSON.stringify({ user: this.config.username })), { timeout: 5000 });
      return JSON.parse(sc.decode(reply.data));
    } catch { return null; }
  }

  async getInstalledApps(room: string): Promise<any[]> {
    if (!this.connection.nc) return [];
    try {
      const reply = await this.connection.nc.request(`apps.room.${room}`,
        sc.encode(JSON.stringify({ room })), { timeout: 5000 });
      return JSON.parse(sc.decode(reply.data));
    } catch { return []; }
  }

  async getStickerProducts(): Promise<any[]> {
    if (!this.connection.nc) return [];
    try {
      const reply = await this.connection.nc.request('stickers.products',
        sc.encode(''), { timeout: 5000 });
      return JSON.parse(sc.decode(reply.data));
    } catch { return []; }
  }

  async getStickersByProduct(productId: string): Promise<any[]> {
    if (!this.connection.nc) return [];
    try {
      const reply = await this.connection.nc.request(`stickers.product.${productId}`,
        sc.encode(''), { timeout: 5000 });
      return JSON.parse(sc.decode(reply.data));
    } catch { return []; }
  }

  async requestTranslation(text: string, targetLang: string, msgKey: string): Promise<void> {
    this.translation.request(text, targetLang, msgKey, this.username);
  }

  // Thread operations
  async sendThreadReply(room: string, threadId: string, text: string, opts?: { mentions?: string[]; broadcast?: boolean }): Promise<void> {
    if (!this.connection.nc) throw new Error('Not connected');
    // Extract parentTimestamp from threadId format: {room}-{timestamp}
    const lastDash = threadId.lastIndexOf('-');
    const parentTimestamp = lastDash > 0 ? Number(threadId.substring(lastDash + 1)) : 0;

    const payload: Record<string, unknown> = {
      user: this.config.username,
      text,
      timestamp: Date.now(),
      room,
      threadId,
      parentTimestamp,
    };
    if (opts?.mentions) payload.mentions = opts.mentions;
    if (opts?.broadcast) payload.broadcast = true;

    if (this.e2ee.isRoomEncrypted(room)) {
      const result = await this.e2ee.encrypt(room, text, this.config.username, payload.timestamp as number);
      if (result) {
        payload.text = result.ciphertext;
        payload.e2ee = { epoch: result.epoch, v: 1 };
      }
    }

    const { headers } = tracedHeaders('chat.thread.send');
    const threadSubject = `deliver.${this.config.username}.send.${room}.thread.${threadId}`;
    this.connection.nc.publish(threadSubject, sc.encode(JSON.stringify(payload)), { headers });

    // Broadcast to main room if requested
    if (opts?.broadcast) {
      const roomSubject = `deliver.${this.config.username}.send.${room}`;
      const { headers: bh } = tracedHeaders('chat.thread.broadcast');
      this.connection.nc.publish(roomSubject, sc.encode(JSON.stringify(payload)), { headers: bh });
    }
  }

  async editThreadMessage(room: string, threadId: string, timestamp: number, _user: string, newText: string): Promise<void> {
    if (!this.connection.nc) return;
    let editText = newText;
    let e2eeField: { epoch: number; v: number } | undefined;

    if (this.e2ee.isRoomEncrypted(room)) {
      const result = await this.e2ee.encrypt(room, newText, this.config.username, timestamp);
      if (result) {
        editText = result.ciphertext;
        e2eeField = { epoch: result.epoch, v: 1 };
      }
    }

    const payload: Record<string, unknown> = {
      user: this.config.username,
      text: editText,
      timestamp,
      room,
      threadId,
      action: 'edit' as const,
    };
    if (e2eeField) payload.e2ee = e2eeField;

    const { headers } = tracedHeaders('chat.thread.edit');
    this.connection.nc.publish(`deliver.${this.config.username}.send.${room}.thread.${threadId}`,
      sc.encode(JSON.stringify(payload)), { headers });
  }

  async deleteThreadMessage(room: string, threadId: string, timestamp: number): Promise<void> {
    if (!this.connection.nc) return;
    const payload = {
      user: this.config.username,
      text: '',
      timestamp,
      room,
      threadId,
      action: 'delete' as const,
    };
    const { headers } = tracedHeaders('chat.thread.delete');
    this.connection.nc.publish(`deliver.${this.config.username}.send.${room}.thread.${threadId}`,
      sc.encode(JSON.stringify(payload)), { headers });
  }

  async reactToThreadMessage(room: string, threadId: string, timestamp: number, user: string, emoji: string): Promise<void> {
    if (!this.connection.nc) return;
    const payload = {
      user: this.config.username,
      text: '',
      timestamp: Date.now(),
      room,
      threadId,
      reactTimestamp: timestamp,
      reactUser: user,
      emoji,
      action: 'react' as const,
    };
    const { headers } = tracedHeaders('chat.thread.react');
    this.connection.nc.publish(`deliver.${this.config.username}.send.${room}.thread.${threadId}`,
      sc.encode(JSON.stringify(payload)), { headers });
  }
}
