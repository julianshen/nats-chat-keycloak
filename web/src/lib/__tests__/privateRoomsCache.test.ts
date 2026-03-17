import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadPrivateRooms, savePrivateRooms, PRIVATE_ROOMS_STORAGE_KEY } from '../privateRoomsCache';
import type { RoomInfo } from '../../types';

function makeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear() { data.clear(); },
    getItem(key: string) { return data.get(key) ?? null; },
    key(index: number) { return Array.from(data.keys())[index] ?? null; },
    removeItem(key: string) { data.delete(key); },
    setItem(key: string, value: string) { data.set(key, value); },
  };
}

describe('privateRoomsCache', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = makeStorage();
    vi.stubGlobal('localStorage', storage);
    storage.clear();
    vi.restoreAllMocks();
  });

  it('returns empty list when no cache is present', () => {
    expect(loadPrivateRooms()).toEqual([]);
  });

  it('filters out invalid cached values', () => {
    const valid: RoomInfo = {
      name: 'project-alpha',
      displayName: 'Project Alpha',
      creator: 'alice',
      type: 'private',
    };

    localStorage.setItem(PRIVATE_ROOMS_STORAGE_KEY, JSON.stringify([
      valid,
      { name: 'bad-missing-creator', type: 'private' },
      { name: '', creator: 'bob', type: 'private' },
      null,
    ]));

    expect(loadPrivateRooms()).toEqual([valid]);
  });

  it('returns empty list for invalid JSON', () => {
    localStorage.setItem(PRIVATE_ROOMS_STORAGE_KEY, '{bad-json');
    expect(loadPrivateRooms()).toEqual([]);
  });

  it('persists rooms using the expected storage key', () => {
    const rooms: RoomInfo[] = [
      { name: 'ops', creator: 'alice', type: 'private', displayName: 'Ops' },
    ];

    savePrivateRooms(rooms);

    expect(JSON.parse(localStorage.getItem(PRIVATE_ROOMS_STORAGE_KEY) || '[]')).toEqual(rooms);
  });
});
