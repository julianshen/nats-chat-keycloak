import type { ExcalidrawElement } from './types';

export function mergeElements(
  stored: ExcalidrawElement[],
  incoming: ExcalidrawElement[]
): ExcalidrawElement[] {
  const map = new Map<string, ExcalidrawElement>();
  for (const el of stored) {
    map.set(el.id, el);
  }
  for (const el of incoming) {
    const existing = map.get(el.id);
    if (!existing || el.version > existing.version) {
      map.set(el.id, el);
    }
  }
  return Array.from(map.values());
}
