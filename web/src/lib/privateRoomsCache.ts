import type { RoomInfo } from '../types';

export const PRIVATE_ROOMS_STORAGE_KEY = 'private-rooms';

function isRoomInfo(value: unknown): value is RoomInfo {
  if (!value || typeof value !== 'object') return false;
  const room = value as Partial<RoomInfo>;
  return (
    typeof room.name === 'string'
    && room.name.length > 0
    && typeof room.creator === 'string'
    && room.creator.length > 0
    && typeof room.type === 'string'
    && room.type.length > 0
    && (room.displayName === undefined || typeof room.displayName === 'string')
  );
}

export function loadPrivateRooms(): RoomInfo[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(PRIVATE_ROOMS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRoomInfo);
  } catch {
    return [];
  }
}

export function savePrivateRooms(rooms: RoomInfo[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(PRIVATE_ROOMS_STORAGE_KEY, JSON.stringify(rooms));
}
