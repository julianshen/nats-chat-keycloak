/** Status indicator color classes used across multiple components. */
export const STATUS_COLORS: Record<string, string> = {
  online: 'bg-green-500',
  away: 'bg-amber-500',
  busy: 'bg-red-500',
  offline: 'bg-slate-500',
};

/** Format a Unix timestamp to a short time string (HH:MM). */
export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Avatar background colors for user-based hashing. */
const AVATAR_COLORS = [
  'bg-blue-500', 'bg-violet-500', 'bg-pink-500', 'bg-amber-500',
  'bg-emerald-500', 'bg-red-500', 'bg-cyan-500',
];

/** Avatar text color classes (matching the background variants above). */
const AVATAR_TEXT_COLORS = [
  'text-blue-600 dark:text-blue-400',
  'text-violet-600 dark:text-violet-400',
  'text-pink-600 dark:text-pink-400',
  'text-amber-600 dark:text-amber-400',
  'text-emerald-600 dark:text-emerald-400',
  'text-red-600 dark:text-red-400',
  'text-cyan-600 dark:text-cyan-400',
];

function hashName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return Math.abs(hash);
}

/** Get avatar background class for a username. */
export function getAvatarColor(name: string): string {
  return AVATAR_COLORS[hashName(name) % AVATAR_COLORS.length];
}

/** Get a text color class for a username (for display names). */
export function getNameColor(name: string): string {
  return AVATAR_TEXT_COLORS[hashName(name) % AVATAR_TEXT_COLORS.length];
}

/**
 * Extract the "other" username from a DM room key.
 * DM keys use format `dm-{user1}-{user2}` with sorted usernames.
 */
export function dmOtherUser(dmRoom: string, currentUser: string | undefined): string {
  const parts = dmRoom.replace('dm-', '').split('-');
  return parts.find((u) => u !== currentUser) || parts[1] || '';
}
