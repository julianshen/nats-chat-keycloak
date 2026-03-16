import type { NatsConnection, Subscription } from 'nats.ws';
import { TypedEmitter } from './EventEmitter';
import { ConnectionManager, sc } from './ConnectionManager';
import { RoomManager } from './RoomManager';
import type { ChatMessage } from '../../types';
import type { MessageUpdate } from './types';
import { tracedHeaders } from '../../utils/tracing';
import { routeAppMessage } from '../AppBridge';

export interface Translation {
  text: string;
  lang: string;
  done?: boolean;
}

export interface UnreadInfo {
  count: number;
  mentions: number;
}

type MessageStoreEvents = {
  message: (room: string, msg: ChatMessage) => void;
  updated: (room: string, key: string, update: MessageUpdate) => void;
  unreadChanged: (room: string, count: number, mentions: number) => void;
  threadReply: (threadId: string, msg: ChatMessage) => void;
  historyLoaded: (room: string, messages: ChatMessage[], hasMore: boolean) => void;
  replyCountChanged: (threadId: string, count: number) => void;
  translationReceived: (msgKey: string, translation: Translation) => void;
};

const MAX_MESSAGES_PER_ROOM = 200;

export class MessageStore extends TypedEmitter<MessageStoreEvents> {
  private cm: ConnectionManager;
  private rm: RoomManager;
  private username: string;

  private messagesByRoom = new Map<string, ChatMessage[]>();
  private threadMessages = new Map<string, ChatMessage[]>();
  private unreadCounts = new Map<string, number>();
  private mentionCounts = new Map<string, number>();
  private updates = new Map<string, MessageUpdate>();
  private replyCounts = new Map<string, number>();

  private activeRoom: string | null = null;
  private deliverSub: Subscription | null = null;
  private rawNotificationUnsub: (() => void) | null = null;

  constructor(cm: ConnectionManager, rm: RoomManager, username: string) {
    super();
    this.cm = cm;
    this.rm = rm;
    this.username = username;
  }

  // --- Public getters ---

  getMessages(room: string): ChatMessage[] {
    return this.messagesByRoom.get(room) || [];
  }

  getThreadMessages(threadId: string): ChatMessage[] {
    return this.threadMessages.get(threadId) || [];
  }

  getUnread(room: string): UnreadInfo {
    return {
      count: this.unreadCounts.get(room) || 0,
      mentions: this.mentionCounts.get(room) || 0,
    };
  }

  getUpdates(): ReadonlyMap<string, MessageUpdate> {
    return this.updates;
  }

  getReplyCounts(): ReadonlyMap<string, number> {
    return this.replyCounts;
  }

  setActiveRoom(room: string | null): void {
    this.activeRoom = room;
  }

  clearUnread(room: string): void {
    const hadUnread = (this.unreadCounts.get(room) || 0) > 0;
    const hadMentions = (this.mentionCounts.get(room) || 0) > 0;
    if (hadUnread) this.unreadCounts.delete(room);
    if (hadMentions) this.mentionCounts.delete(room);
    if (hadUnread || hadMentions) {
      this.emit('unreadChanged', room, 0, 0);
    }
  }

  // --- History ---

  async fetchHistory(room: string): Promise<void> {
    const nc = this.cm.nc;
    if (!nc) return;

    try {
      const memberKey = this.rm.roomToMemberKey(room);
      const { headers: hdr } = tracedHeaders('chat.history.request');
      const reply = await nc.request(
        `chat.history.${memberKey}`,
        sc.encode(JSON.stringify({ room })),
        { timeout: 5000, headers: hdr },
      );
      const data = JSON.parse(sc.decode(reply.data)) as {
        messages: ChatMessage[];
        hasMore: boolean;
      };

      // Store messages (apply dedup)
      const existing = this.messagesByRoom.get(room) || [];
      const existingKeys = new Set(existing.map(m => `${m.timestamp}-${m.user}`));
      const newMsgs = data.messages.filter(m => !existingKeys.has(`${m.timestamp}-${m.user}`));
      const merged = [...newMsgs, ...existing].slice(-MAX_MESSAGES_PER_ROOM);
      this.messagesByRoom.set(room, merged);

      // Extract reply counts from history messages
      for (const msg of data.messages) {
        if (msg.replyCount && msg.replyCount > 0) {
          const threadId = `${room}-${msg.timestamp}`;
          this.replyCounts.set(threadId, msg.replyCount);
          this.emit('replyCountChanged', threadId, msg.replyCount);
        }
      }

      this.emit('historyLoaded', room, merged, data.hasMore);
    } catch (err) {
      console.log('[MessageStore] History fetch failed:', err);
    }
  }

  async fetchThreadHistory(threadId: string): Promise<void> {
    const nc = this.cm.nc;
    if (!nc) return;

    // threadId format: "{room}-{timestamp}"
    const lastDash = threadId.lastIndexOf('-');
    if (lastDash < 0) return;
    const room = threadId.substring(0, lastDash);
    const parentTimestamp = threadId.substring(lastDash + 1);

    try {
      const memberKey = this.rm.roomToMemberKey(room);
      const { headers: hdr } = tracedHeaders('chat.history.thread.request');
      const reply = await nc.request(
        `chat.history.${memberKey}`,
        sc.encode(JSON.stringify({ room, threadId, parentTimestamp: Number(parentTimestamp) })),
        { timeout: 5000, headers: hdr },
      );
      const data = JSON.parse(sc.decode(reply.data)) as {
        messages: ChatMessage[];
        hasMore: boolean;
      };

      this.threadMessages.set(threadId, data.messages.slice(-MAX_MESSAGES_PER_ROOM));
      // Emit each as threadReply so listeners know about them
      for (const msg of data.messages) {
        this.emit('threadReply', threadId, msg);
      }
    } catch (err) {
      console.log('[MessageStore] Thread history fetch failed:', err);
    }
  }

  // --- Start / Stop ---

  /** Creates deliver.{user}.> subscription and wires up RoomManager events */
  start(): void {
    const nc = this.cm.nc;
    if (!nc) return;

    // Subscribe to deliver.{username}.>
    const deliverSubject = `deliver.${this.username}.>`;
    this.deliverSub = nc.subscribe(deliverSubject);

    // Process deliver messages
    this.processDeliverSubscription(nc, this.deliverSub);

    // Listen for rawNotification from RoomManager
    this.rawNotificationUnsub = this.rm.on('rawNotification', (room, data, _headers) => {
      this.handleRawNotification(nc, room, data);
    });
  }

  /** Clean up subscriptions and state */
  destroy(): void {
    if (this.deliverSub) {
      this.deliverSub.unsubscribe();
      this.deliverSub = null;
    }
    if (this.rawNotificationUnsub) {
      this.rawNotificationUnsub();
      this.rawNotificationUnsub = null;
    }
    this.messagesByRoom.clear();
    this.threadMessages.clear();
    this.unreadCounts.clear();
    this.mentionCounts.clear();
    this.updates.clear();
    this.replyCounts.clear();
    this.removeAllListeners();
  }

  // --- Internal: message processing ---

  /** Toggle a reaction on a reactions map (shared helper) */
  private toggleReaction(
    reactions: Record<string, string[]> | undefined,
    emoji: string,
    userId: string,
  ): Record<string, string[]> {
    const prev = reactions ? { ...reactions } : {};
    const users = prev[emoji] ? [...prev[emoji]] : [];
    const idx = users.indexOf(userId);
    if (idx >= 0) {
      users.splice(idx, 1);
      if (users.length === 0) {
        delete prev[emoji];
      } else {
        prev[emoji] = users;
      }
    } else {
      prev[emoji] = [...users, userId];
    }
    return prev;
  }

  /** Apply an edit/delete/react mutation or add a normal message */
  private processRoomChatMessage(data: ChatMessage, roomKey: string): void {
    // Handle edit
    if (data.action === 'edit') {
      const updateKey = `${data.timestamp}-${data.user}`;
      const update: MessageUpdate = { text: data.text, editedAt: data.timestamp };
      this.updates.set(updateKey, { ...this.updates.get(updateKey), ...update });
      this.applyUpdateToMessages(data.timestamp, data.user, (m) => ({
        ...m,
        text: data.text,
        editedAt: data.timestamp,
      }));
      this.applyUpdateToThreads(data.timestamp, data.user, (m) => ({
        ...m,
        text: data.text,
        editedAt: data.timestamp,
      }));
      this.emit('updated', roomKey, updateKey, update);
      return;
    }

    // Handle delete
    if (data.action === 'delete') {
      const updateKey = `${data.timestamp}-${data.user}`;
      const update: MessageUpdate = { isDeleted: true, text: '' };
      this.updates.set(updateKey, { ...this.updates.get(updateKey), ...update });
      this.applyUpdateToMessages(data.timestamp, data.user, (m) => ({
        ...m,
        isDeleted: true,
        text: '',
      }));
      this.applyUpdateToThreads(data.timestamp, data.user, (m) => ({
        ...m,
        isDeleted: true,
        text: '',
      }));
      this.emit('updated', roomKey, updateKey, update);
      return;
    }

    // Handle react
    if (data.action === 'react' && data.emoji && data.targetUser) {
      const updateKey = `${data.timestamp}-${data.targetUser}`;
      const existing = this.updates.get(updateKey);
      const newReactions = this.toggleReaction(existing?.reactions, data.emoji, data.user);
      const update: MessageUpdate = { ...existing, reactions: newReactions };
      this.updates.set(updateKey, update);
      this.applyUpdateToMessages(data.timestamp, data.targetUser, (m) => ({
        ...m,
        reactions: this.toggleReaction(m.reactions, data.emoji!, data.user),
      }));
      this.applyUpdateToThreads(data.timestamp, data.targetUser, (m) => ({
        ...m,
        reactions: this.toggleReaction(m.reactions, data.emoji!, data.user),
      }));
      this.emit('updated', roomKey, updateKey, update);
      return;
    }

    // Normal chat message -- dedup by timestamp+user
    const existing = this.messagesByRoom.get(roomKey) || [];
    const isDup = existing.some(
      (m) => m.timestamp === data.timestamp && m.user === data.user,
    );
    if (isDup) return;

    const updated = [...existing.slice(-(MAX_MESSAGES_PER_ROOM - 1)), data];
    this.messagesByRoom.set(roomKey, updated);
    this.emit('message', roomKey, data);

    // Increment unread count if not the active room
    if (roomKey !== this.activeRoom && data.user !== '__system__') {
      const newCount = (this.unreadCounts.get(roomKey) || 0) + 1;
      this.unreadCounts.set(roomKey, newCount);

      let newMentions = this.mentionCounts.get(roomKey) || 0;
      if (data.mentions?.includes(this.username)) {
        newMentions += 1;
        this.mentionCounts.set(roomKey, newMentions);
      }
      this.emit('unreadChanged', roomKey, newCount, newMentions);
    }
  }

  /** Apply a transform to matching messages across all rooms */
  private applyUpdateToMessages(
    timestamp: number,
    user: string,
    transform: (m: ChatMessage) => ChatMessage,
  ): void {
    for (const [room, msgs] of this.messagesByRoom) {
      let changed = false;
      const updated = msgs.map((m) => {
        if (m.timestamp === timestamp && m.user === user) {
          changed = true;
          return transform(m);
        }
        return m;
      });
      if (changed) {
        this.messagesByRoom.set(room, updated);
      }
    }
  }

  /** Apply a transform to matching messages across all threads */
  private applyUpdateToThreads(
    timestamp: number,
    user: string,
    transform: (m: ChatMessage) => ChatMessage,
  ): void {
    for (const [tid, msgs] of this.threadMessages) {
      let changed = false;
      const updated = msgs.map((m) => {
        if (m.timestamp === timestamp && m.user === user) {
          changed = true;
          return transform(m);
        }
        return m;
      });
      if (changed) {
        this.threadMessages.set(tid, updated);
      }
    }
  }

  /** Fetch full message content from the msg.get API */
  private async fetchMessageContent(
    nc: NatsConnection,
    notifyId: string,
    room: string,
  ): Promise<ChatMessage | null> {
    try {
      const payload = JSON.stringify({ notifyId, room });
      const { headers: fetchHdr } = tracedHeaders('msg.get.request');
      const reply = await nc.request('msg.get', sc.encode(payload), {
        timeout: 5000,
        headers: fetchHdr,
      });
      const data = JSON.parse(sc.decode(reply.data));
      if (data.error) {
        console.log('[MessageStore] msg.get error:', data.error);
        return null;
      }
      return data as ChatMessage;
    } catch (err) {
      console.log('[MessageStore] msg.get failed:', err);
      return null;
    }
  }

  /** Handle raw notification data from room.notify.{memberKey} */
  private async handleRawNotification(
    nc: NatsConnection,
    room: string,
    rawData: Uint8Array,
  ): Promise<void> {
    try {
      const notification = JSON.parse(sc.decode(rawData)) as {
        notifyId: string;
        room: string;
        action: string;
        user: string;
        timestamp?: number;
        threadId?: string;
        emoji?: string;
        targetUser?: string;
      };

      // Delete can be applied directly from notification
      if (notification.action === 'delete' && notification.timestamp && notification.user) {
        const deleteMsg: ChatMessage = {
          user: notification.user,
          text: '',
          timestamp: notification.timestamp,
          room: notification.room,
          action: 'delete',
        };
        if (notification.threadId) {
          const updateKey = `${notification.timestamp}-${notification.user}`;
          const update: MessageUpdate = { isDeleted: true, text: '' };
          this.updates.set(updateKey, { ...this.updates.get(updateKey), ...update });
          this.applyUpdateToThreads(notification.timestamp, notification.user, (m) => ({
            ...m,
            isDeleted: true,
            text: '',
          }));
          this.emit('updated', room, updateKey, update);
        } else {
          this.processRoomChatMessage(deleteMsg, room);
        }
        return;
      }

      // React can be applied directly from notification
      if (
        notification.action === 'react' &&
        notification.emoji &&
        notification.targetUser &&
        notification.timestamp
      ) {
        const reactMsg: ChatMessage = {
          user: notification.user,
          text: '',
          timestamp: notification.timestamp,
          room: notification.room,
          action: 'react',
          emoji: notification.emoji,
          targetUser: notification.targetUser,
        };
        if (notification.threadId) {
          const updateKey = `${notification.timestamp}-${notification.targetUser}`;
          const existing = this.updates.get(updateKey);
          const newReactions = this.toggleReaction(
            existing?.reactions,
            notification.emoji,
            notification.user,
          );
          const update: MessageUpdate = { ...existing, reactions: newReactions };
          this.updates.set(updateKey, update);
          this.applyUpdateToThreads(notification.timestamp, notification.targetUser, (m) => ({
            ...m,
            reactions: this.toggleReaction(m.reactions, notification.emoji!, notification.user),
          }));
          this.emit('updated', room, updateKey, update);
        } else {
          this.processRoomChatMessage(reactMsg, room);
        }
        return;
      }

      // Thread notifications: update reply count and fetch content
      if (notification.threadId && (notification.action === 'message' || !notification.action)) {
        const newCount = (this.replyCounts.get(notification.threadId) || 0) + 1;
        this.replyCounts.set(notification.threadId, newCount);
        this.emit('replyCountChanged', notification.threadId, newCount);

        const fullMsg = await this.fetchMessageContent(nc, notification.notifyId, room);
        if (fullMsg) {
          const existing = this.threadMessages.get(notification.threadId) || [];
          this.threadMessages.set(
            notification.threadId,
            [...existing.slice(-(MAX_MESSAGES_PER_ROOM - 1)), fullMsg],
          );
          this.emit('threadReply', notification.threadId, fullMsg);
        }
        return;
      }

      // All other actions: fetch full content then process
      const fullMsg = await this.fetchMessageContent(nc, notification.notifyId, room);
      if (fullMsg) {
        this.processRoomChatMessage(fullMsg, room);
      }
    } catch {
      // ignore malformed notification
    }
  }

  /** Handle DM notifications via deliver.{user}.notify.{room} */
  private async handleDmNotification(
    nc: NatsConnection,
    rawData: Uint8Array,
  ): Promise<void> {
    try {
      const notification = JSON.parse(sc.decode(rawData)) as {
        notifyId: string;
        room: string;
        action: string;
        user: string;
        timestamp?: number;
        threadId?: string;
        emoji?: string;
        targetUser?: string;
      };
      const dmRoom = notification.room;

      // Delete
      if (notification.action === 'delete' && notification.timestamp && notification.user) {
        const deleteMsg: ChatMessage = {
          user: notification.user,
          text: '',
          timestamp: notification.timestamp,
          room: dmRoom,
          action: 'delete',
        };
        if (notification.threadId) {
          const updateKey = `${notification.timestamp}-${notification.user}`;
          const update: MessageUpdate = { isDeleted: true, text: '' };
          this.updates.set(updateKey, { ...this.updates.get(updateKey), ...update });
          this.applyUpdateToThreads(notification.timestamp, notification.user, (m) => ({
            ...m,
            isDeleted: true,
            text: '',
          }));
          this.emit('updated', dmRoom, updateKey, update);
        } else {
          this.processRoomChatMessage(deleteMsg, dmRoom);
        }
        return;
      }

      // React
      if (
        notification.action === 'react' &&
        notification.emoji &&
        notification.targetUser &&
        notification.timestamp
      ) {
        const reactMsg: ChatMessage = {
          user: notification.user,
          text: '',
          timestamp: notification.timestamp,
          room: dmRoom,
          action: 'react',
          emoji: notification.emoji,
          targetUser: notification.targetUser,
        };
        if (notification.threadId) {
          const updateKey = `${notification.timestamp}-${notification.targetUser}`;
          const existing = this.updates.get(updateKey);
          const newReactions = this.toggleReaction(
            existing?.reactions,
            notification.emoji,
            notification.user,
          );
          const update: MessageUpdate = { ...existing, reactions: newReactions };
          this.updates.set(updateKey, update);
          this.applyUpdateToThreads(notification.timestamp, notification.targetUser, (m) => ({
            ...m,
            reactions: this.toggleReaction(m.reactions, notification.emoji!, notification.user),
          }));
          this.emit('updated', dmRoom, updateKey, update);
        } else {
          this.processRoomChatMessage(reactMsg, dmRoom);
        }
        return;
      }

      // Thread notifications
      if (notification.threadId && (notification.action === 'message' || !notification.action)) {
        const newCount = (this.replyCounts.get(notification.threadId) || 0) + 1;
        this.replyCounts.set(notification.threadId, newCount);
        this.emit('replyCountChanged', notification.threadId, newCount);

        const fullMsg = await this.fetchMessageContent(nc, notification.notifyId, dmRoom);
        if (fullMsg) {
          const existing = this.threadMessages.get(notification.threadId) || [];
          this.threadMessages.set(
            notification.threadId,
            [...existing.slice(-(MAX_MESSAGES_PER_ROOM - 1)), fullMsg],
          );
          this.emit('threadReply', notification.threadId, fullMsg);
        }
        return;
      }

      // All other: fetch full content
      const fullMsg = await this.fetchMessageContent(nc, notification.notifyId, dmRoom);
      if (fullMsg) {
        this.processRoomChatMessage(fullMsg, dmRoom);
      }
    } catch {
      // ignore malformed
    }
  }

  /** Process deliver.{user}.> subscription messages */
  private processDeliverSubscription(nc: NatsConnection, sub: Subscription): void {
    (async () => {
      try {
        for await (const msg of sub) {
          try {
            const parts = msg.subject.split('.');
            if (parts.length < 4) continue;
            const subjectType = parts[2]; // "chat", "admin", "translate", "app", "notify"

            // Skip legacy presence on deliver
            if (subjectType === 'presence') continue;

            // Translation responses: deliver.{userId}.translate.response
            if (subjectType === 'translate') {
              try {
                const translateData = JSON.parse(sc.decode(msg.data)) as {
                  translatedText: string;
                  targetLang: string;
                  msgKey: string;
                  done?: boolean;
                };
                if (translateData.msgKey) {
                  this.emit('translationReceived', translateData.msgKey, {
                    text: translateData.translatedText,
                    lang: translateData.targetLang,
                    done: translateData.done ?? true,
                  });
                }
              } catch {
                console.log('[MessageStore] Failed to parse translation response');
              }
              continue;
            }

            // App messages: deliver.{userId}.app.{appId}.{room}.{event...}
            if (subjectType === 'app') {
              if (parts.length >= 6) {
                const appId = parts[3];
                const appRoom = parts[4];
                const event = parts.slice(5).join('.');
                try {
                  const appData = JSON.parse(sc.decode(msg.data));
                  routeAppMessage(appId, appRoom, event, appData);
                } catch (e) {
                  console.error('[MessageStore] Failed to parse app message:', e);
                }
              }
              continue;
            }

            // DM notifications: deliver.{userId}.notify.{room}
            if (subjectType === 'notify') {
              await this.handleDmNotification(nc, msg.data);
              continue;
            }

            // Admin messages: deliver.{userId}.admin.{room}
            if (subjectType === 'admin') {
              const data = JSON.parse(sc.decode(msg.data)) as ChatMessage;
              this.processRoomChatMessage(data, '__admin__');
              continue;
            }

            // Unknown subject type — skip
          } catch {
            // Ignore malformed messages
          }
        }
      } catch (err) {
        console.log('[MessageStore] Deliver subscription ended:', err);
      }
    })();
  }
}
