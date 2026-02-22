import type { ExcalidrawElement } from './types.js';

/**
 * CRDT merge: last-writer-wins per element ID based on version number.
 * Returns [merged, changed] where changed contains only elements that
 * updated the stored state (for broadcasting to other clients).
 */
export function mergeElements(
  stored: ExcalidrawElement[],
  incoming: ExcalidrawElement[]
): [ExcalidrawElement[], ExcalidrawElement[]] {
  const map = new Map<string, ExcalidrawElement>();
  for (const el of stored) {
    map.set(el.id, el);
  }

  const changed: ExcalidrawElement[] = [];
  for (const el of incoming) {
    const existing = map.get(el.id);
    if (!existing || el.version > existing.version) {
      map.set(el.id, el);
      changed.push(el);
    }
  }

  return [Array.from(map.values()), changed];
}
