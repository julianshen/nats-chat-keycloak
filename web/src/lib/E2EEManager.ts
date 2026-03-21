/**
 * E2EE Manager — Core cryptographic operations for end-to-end encryption.
 *
 * Key hierarchy:
 *   User Identity Key (ECDH P-256) → per-user, stored in IndexedDB
 *   Per-Room Key (AES-256-GCM)     → per-room per-epoch, wrapped per-recipient
 *
 * Message encryption:
 *   IV (12 bytes) + AES-GCM(roomKey, plaintext, AAD={room, user, timestamp, epoch})
 *   Encoded as base64(IV || ciphertext_with_tag)
 */

const DB_NAME = 'nats-chat-e2ee';
const DB_VERSION = 1;
const IDENTITY_STORE = 'identity_keys';
const ROOM_KEYS_STORE = 'room_keys';

// HKDF info prefix for domain separation
const HKDF_INFO_PREFIX = 'nats-chat-e2ee';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDENTITY_STORE)) {
        db.createObjectStore(IDENTITY_STORE, { keyPath: 'username' });
      }
      if (!db.objectStoreNames.contains(ROOM_KEYS_STORE)) {
        const store = db.createObjectStore(ROOM_KEYS_STORE, { keyPath: ['room', 'epoch'] });
        store.createIndex('by_room', 'room', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

interface IdentityKeyEntry {
  username: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
  createdAt: number;
}

interface RoomKeyEntry {
  room: string;
  epoch: number;
  key: CryptoKey;
  receivedAt: number;
}

// --- Identity Key Management ---

export async function getOrCreateIdentityKey(username: string): Promise<{
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
}> {
  const db = await openDB();
  try {
    const existing = await idbGet<IdentityKeyEntry>(db, IDENTITY_STORE, username);
    if (existing) {
      return { privateKey: existing.privateKey, publicKey: existing.publicKey, publicKeyJwk: existing.publicKeyJwk };
    }

    // Generate new ECDH P-256 key pair
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false, // non-extractable private key
      ['deriveKey', 'deriveBits'],
    );

    const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);

    const entry: IdentityKeyEntry = {
      username,
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      publicKeyJwk,
      createdAt: Date.now(),
    };

    await idbPut(db, IDENTITY_STORE, entry);

    return { privateKey: keyPair.privateKey, publicKey: keyPair.publicKey, publicKeyJwk };
  } finally {
    db.close();
  }
}

/**
 * Compute a SHA-256 fingerprint of a JWK public key for out-of-band verification.
 * Returns hex string like "a1b2c3d4...".
 */
export async function computeKeyFingerprint(jwk: JsonWebKey): Promise<string> {
  // Canonical JSON: sort keys for deterministic output
  const canonical = JSON.stringify(jwk, Object.keys(jwk).sort());
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Format a fingerprint hex string into groups for display.
 * E.g., "a1b2c3d4e5f6..." → "A1B2 C3D4 E5F6 ..."
 */
export function formatFingerprint(hex: string): string {
  return hex.slice(0, 32).toUpperCase().match(/.{1,4}/g)?.join(' ') ?? hex;
}

export async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
}

// --- Room Key Cache (avoids IndexedDB round-trip per decrypt) ---

const roomKeyCache = new Map<string, CryptoKey>();
const ROOM_KEY_CACHE_MAX = 200;

function roomKeyCacheKey(room: string, epoch: number): string {
  return `${room}:${epoch}`;
}

function roomKeyCacheSet(room: string, epoch: number, key: CryptoKey): void {
  const k = roomKeyCacheKey(room, epoch);
  // Evict oldest if at capacity (simple FIFO via iteration order)
  if (roomKeyCache.size >= ROOM_KEY_CACHE_MAX && !roomKeyCache.has(k)) {
    const first = roomKeyCache.keys().next().value;
    if (first !== undefined) roomKeyCache.delete(first);
  }
  roomKeyCache.set(k, key);
}

export function clearRoomKeyCache(): void {
  roomKeyCache.clear();
}

// --- Room Key Management ---

export async function generateRoomKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable (needed for wrapping)
    ['encrypt', 'decrypt'],
  );
}

export async function storeRoomKey(room: string, epoch: number, key: CryptoKey): Promise<void> {
  roomKeyCacheSet(room, epoch, key);
  const db = await openDB();
  try {
    await idbPut(db, ROOM_KEYS_STORE, { room, epoch, key, receivedAt: Date.now() });
  } finally {
    db.close();
  }
  // Notify other tabs
  try {
    const bc = new BroadcastChannel('e2ee-key-updates');
    bc.postMessage({ type: 'room-key', room, epoch });
    bc.close();
  } catch (e) {
    if (!(e instanceof ReferenceError)) {
      console.warn('[E2EE] BroadcastChannel error:', e);
    }
  }
}

export async function getRoomKey(room: string, epoch: number): Promise<CryptoKey | null> {
  // Check in-memory cache first (avoids IndexedDB round-trip)
  const cached = roomKeyCache.get(roomKeyCacheKey(room, epoch));
  if (cached) return cached;

  const db = await openDB();
  try {
    const entry = await idbGet<RoomKeyEntry>(db, ROOM_KEYS_STORE, [room, epoch]);
    if (entry?.key) {
      roomKeyCacheSet(room, epoch, entry.key);
      return entry.key;
    }
    return null;
  } finally {
    db.close();
  }
}

/** Prune old epoch keys for a room, keeping only the last `keep` epochs. */
export async function pruneOldRoomKeys(room: string, currentEpoch: number, keep = 5): Promise<void> {
  const db = await openDB();
  try {
    const tx = db.transaction(ROOM_KEYS_STORE, 'readwrite');
    const store = tx.objectStore(ROOM_KEYS_STORE);
    const index = store.index('by_room');
    const range = IDBKeyRange.only(room);
    const req = index.openCursor(range);
    await new Promise<void>((resolve, reject) => {
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        const entry = cursor.value as RoomKeyEntry;
        if (entry.epoch < currentEpoch - keep) {
          cursor.delete();
          // Also evict from in-memory cache
          roomKeyCache.delete(roomKeyCacheKey(room, entry.epoch));
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Export a room key as base64-encoded raw bytes (for server-side decryption) */
export async function exportRoomKeyRaw(roomKey: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', roomKey);
  return arrayBufferToBase64(raw);
}

// --- Key Wrapping (ECDH + HKDF + AES-KW) ---

async function deriveWrappingKey(
  myPrivateKey: CryptoKey,
  recipientPublicKey: CryptoKey,
  room: string,
  epoch: number,
  salt: Uint8Array,
): Promise<CryptoKey> {
  // Step 1: ECDH to get shared bits
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: recipientPublicKey },
    myPrivateKey,
    256,
  );

  // Step 2: Import shared bits as HKDF key material
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    sharedBits,
    'HKDF',
    false,
    ['deriveKey'],
  );

  // Step 3: HKDF to derive AES-KW wrapping key with domain separation and random salt
  const info = new TextEncoder().encode(`${HKDF_INFO_PREFIX}|${room}|${epoch}`);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(salt), info },
    hkdfKey,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

/**
 * Wrap a room key for a recipient. Output format: base64(16-byte-salt || wrapped-key).
 * The salt strengthens HKDF against precomputation attacks.
 */
export async function wrapRoomKeyForRecipient(
  roomKey: CryptoKey,
  myPrivateKey: CryptoKey,
  recipientPublicKey: CryptoKey,
  room: string,
  epoch: number,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrappingKey = await deriveWrappingKey(myPrivateKey, recipientPublicKey, room, epoch, salt);
  const wrapped = await crypto.subtle.wrapKey('raw', roomKey, wrappingKey, 'AES-KW');
  // Concatenate: salt (16) || wrapped key
  const result = new Uint8Array(salt.length + wrapped.byteLength);
  result.set(salt, 0);
  result.set(new Uint8Array(wrapped), salt.length);
  return arrayBufferToBase64(result.buffer);
}

/**
 * Unwrap a room key. Input format: base64(16-byte-salt || wrapped-key).
 */
export async function unwrapRoomKey(
  wrappedKeyBase64: string,
  myPrivateKey: CryptoKey,
  senderPublicKey: CryptoKey,
  room: string,
  epoch: number,
): Promise<CryptoKey> {
  const data = new Uint8Array(base64ToArrayBuffer(wrappedKeyBase64));
  const salt = data.slice(0, 16);
  const wrappedKeyBuffer = data.slice(16).buffer;
  const wrappingKey = await deriveWrappingKey(myPrivateKey, senderPublicKey, room, epoch, salt);
  return crypto.subtle.unwrapKey(
    'raw',
    wrappedKeyBuffer,
    wrappingKey,
    'AES-KW',
    { name: 'AES-GCM', length: 256 },
    true, // extractable for future re-wrapping
    ['encrypt', 'decrypt'],
  );
}

// --- Message Encryption / Decryption ---

export async function encryptText(
  room: string,
  user: string,
  timestamp: number,
  epoch: number,
  plaintext: string,
  roomKey: CryptoKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(JSON.stringify({ room, user, timestamp, epoch }));
  const plaintextBytes = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    roomKey,
    plaintextBytes,
  );

  // Concatenate: IV (12) || ciphertext+tag
  const result = new Uint8Array(iv.length + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), iv.length);

  return arrayBufferToBase64(result.buffer);
}

export async function decryptText(
  room: string,
  user: string,
  timestamp: number,
  epoch: number,
  ciphertextBase64: string,
  roomKey: CryptoKey,
): Promise<string> {
  const data = base64ToArrayBuffer(ciphertextBase64);
  const dataBytes = new Uint8Array(data);

  const iv = dataBytes.slice(0, 12);
  const ciphertext = dataBytes.slice(12);
  const aad = new TextEncoder().encode(JSON.stringify({ room, user, timestamp, epoch }));

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    roomKey,
    ciphertext,
  );

  return new TextDecoder().decode(plaintext);
}

// --- Utilities ---

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
