import './tracing.js';
import { connect, StringCodec, type NatsConnection, type Msg } from 'nats';
import pg from 'pg';
import { mergeElements } from './merge.js';
import type {
  ExcalidrawElement,
  CreateRequest,
  LoadRequest,
  DeltaRequest,
  DeleteRequest,
  BoardSummary,
} from './types.js';

const sc = StringCodec();

const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';
const NATS_USER = process.env.NATS_USER || 'whiteboard-service';
const NATS_PASS = process.env.NATS_PASS || 'whiteboard-service-secret';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://chat:chat-secret@localhost:5432/chatdb?sslmode=disable';

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

async function connectNats(): Promise<NatsConnection> {
  for (let i = 0; i < 30; i++) {
    try {
      const nc = await connect({ servers: NATS_URL, user: NATS_USER, pass: NATS_PASS });
      console.log(`Connected to NATS at ${NATS_URL}`);
      return nc;
    } catch (err) {
      console.log(`NATS connection attempt ${i + 1}/30 failed, retrying in 2s...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('Failed to connect to NATS after 30 attempts');
}

async function connectDB(): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  for (let i = 0; i < 30; i++) {
    try {
      const client = await pool.connect();
      client.release();
      console.log('Connected to PostgreSQL');
      return pool;
    } catch (err) {
      console.log(`PostgreSQL connection attempt ${i + 1}/30 failed, retrying in 2s...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('Failed to connect to PostgreSQL after 30 attempts');
}

function parsePayload(msg: Msg): any {
  try {
    return JSON.parse(sc.decode(msg.data));
  } catch {
    return {};
  }
}

function reply(msg: Msg, data: unknown): void {
  if (msg.reply) {
    msg.respond(sc.encode(JSON.stringify(data)));
  }
}

function extractRoom(subject: string): string {
  // subject: app.whiteboard.{room}.{action}
  const parts = subject.split('.');
  return parts[2];
}

function extractAction(subject: string): string {
  const parts = subject.split('.');
  return parts[3];
}

async function handleList(msg: Msg, pool: pg.Pool): Promise<void> {
  const room = extractRoom(msg.subject);
  try {
    const result = await pool.query(
      'SELECT id, name, created_by, created_at FROM whiteboard_boards WHERE room = $1 ORDER BY created_at DESC',
      [room]
    );
    const boards: BoardSummary[] = result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdBy: r.created_by,
      createdAt: r.created_at,
    }));
    reply(msg, { boards });
  } catch (err) {
    console.error('handleList error:', err);
    reply(msg, { error: 'Failed to list boards' });
  }
}

async function handleCreate(msg: Msg, pool: pg.Pool): Promise<void> {
  const room = extractRoom(msg.subject);
  const payload = parsePayload(msg) as CreateRequest;
  const name = payload.name || 'Untitled';
  const user = payload.user || 'unknown';
  const id = generateId();

  try {
    await pool.query(
      'INSERT INTO whiteboard_boards (id, room, name, created_by) VALUES ($1, $2, $3, $4)',
      [id, room, name, user]
    );
    reply(msg, { id, name, createdBy: user });
  } catch (err) {
    console.error('handleCreate error:', err);
    reply(msg, { error: 'Failed to create board' });
  }
}

async function handleLoad(msg: Msg, pool: pg.Pool): Promise<void> {
  const room = extractRoom(msg.subject);
  const payload = parsePayload(msg) as LoadRequest;
  const boardId = payload.boardId;

  try {
    const result = await pool.query(
      'SELECT id, name, elements, created_by FROM whiteboard_boards WHERE id = $1 AND room = $2',
      [boardId, room]
    );
    if (result.rows.length === 0) {
      reply(msg, { error: 'Board not found' });
      return;
    }
    const row = result.rows[0];
    reply(msg, {
      id: row.id,
      name: row.name,
      elements: row.elements,
      createdBy: row.created_by,
    });
  } catch (err) {
    console.error('handleLoad error:', err);
    reply(msg, { error: 'Failed to load board' });
  }
}

async function handleDelta(msg: Msg, pool: pg.Pool, nc: NatsConnection): Promise<void> {
  const room = extractRoom(msg.subject);
  const payload = parsePayload(msg) as DeltaRequest;
  const { boardId, elements: incoming, user } = payload;

  if (!boardId || !incoming || !Array.isArray(incoming)) {
    reply(msg, { error: 'Invalid delta request' });
    return;
  }

  try {
    const result = await pool.query(
      'SELECT elements FROM whiteboard_boards WHERE id = $1 AND room = $2',
      [boardId, room]
    );
    if (result.rows.length === 0) {
      reply(msg, { error: 'Board not found' });
      return;
    }

    const stored: ExcalidrawElement[] = result.rows[0].elements || [];
    const [merged, changed] = mergeElements(stored, incoming);

    if (changed.length > 0) {
      await pool.query(
        'UPDATE whiteboard_boards SET elements = $1, updated_at = NOW() WHERE id = $2 AND room = $3',
        [JSON.stringify(merged), boardId, room]
      );

      // Broadcast changed elements to room
      const syncPayload = JSON.stringify({ boardId, elements: changed, sender: user });
      nc.publish(`app.whiteboard.${room}.sync`, sc.encode(syncPayload));
    }

    reply(msg, { ok: true });
  } catch (err) {
    console.error('handleDelta error:', err);
    reply(msg, { error: 'Failed to process delta' });
  }
}

async function handleDelete(msg: Msg, pool: pg.Pool): Promise<void> {
  const room = extractRoom(msg.subject);
  const payload = parsePayload(msg) as DeleteRequest;
  const { boardId } = payload;

  try {
    await pool.query(
      'DELETE FROM whiteboard_boards WHERE id = $1 AND room = $2',
      [boardId, room]
    );
    reply(msg, { ok: true });
  } catch (err) {
    console.error('handleDelete error:', err);
    reply(msg, { error: 'Failed to delete board' });
  }
}

async function main(): Promise<void> {
  console.log('Starting whiteboard-service...');

  const nc = await connectNats();
  const pool = await connectDB();

  const sub = nc.subscribe('app.whiteboard.>', { queue: 'whiteboard-workers' });
  console.log('Subscribed to app.whiteboard.> (queue: whiteboard-workers)');

  for await (const msg of sub) {
    const action = extractAction(msg.subject);
    switch (action) {
      case 'list':
        handleList(msg, pool).catch((e) => console.error('list handler error:', e));
        break;
      case 'create':
        handleCreate(msg, pool).catch((e) => console.error('create handler error:', e));
        break;
      case 'load':
        handleLoad(msg, pool).catch((e) => console.error('load handler error:', e));
        break;
      case 'delta':
        handleDelta(msg, pool, nc).catch((e) => console.error('delta handler error:', e));
        break;
      case 'delete':
        handleDelete(msg, pool).catch((e) => console.error('delete handler error:', e));
        break;
      case 'sync':
        // sync is a publish (fanout), not handled by this service
        break;
      default:
        console.log(`Unknown action: ${action}`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
