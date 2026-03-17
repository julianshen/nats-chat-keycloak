import { ConnectionManager, sc } from './ConnectionManager';
import { RoomManager } from './RoomManager';
import { tracedHeaders } from '../../utils/tracing';

export class ReadReceiptManager {
  private cm: ConnectionManager;
  private rm: RoomManager;
  private username: string;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(cm: ConnectionManager, rm: RoomManager, username: string) {
    this.cm = cm;
    this.rm = rm;
    this.username = username;
  }

  markRead(room: string, timestamp: number): void {
    const existing = this.timers.get(room);
    if (existing) clearTimeout(existing);

    this.timers.set(room, setTimeout(() => {
      this.timers.delete(room);
      if (this.cm.nc) {
        const memberKey = this.rm.roomToMemberKey(room);
        this.cm.nc.publish(`read.update.${memberKey}`,
          sc.encode(JSON.stringify({ room, userId: this.username, timestamp })),
          { headers: tracedHeaders().headers }
        );
      }
    }, 3000));
  }

  async fetchReceipts(room: string): Promise<Array<{ userId: string; lastRead: number }>> {
    if (!this.cm.nc) return [];
    try {
      const memberKey = this.rm.roomToMemberKey(room);
      const reply = await this.cm.nc.request(`read.state.${memberKey}`,
        sc.encode(JSON.stringify({ room })),
        { timeout: 5000 }
      );
      return JSON.parse(sc.decode(reply.data));
    } catch { return []; }
  }

  destroy(): void {
    this.timers.forEach(t => clearTimeout(t));
    this.timers.clear();
  }
}
